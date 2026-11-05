import crypto from "node:crypto";
import type { SignInAnswerRequest, SignInPromptDto, SignInStateDto } from "@clawdesk/shared";
import type { Logger } from "pino";
import type { ClaudeLoginStatus } from "../gateway/bridge-client.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { assertRoomForBackup, keepAsBackup, readChain, writeChain } from "./model-chain.js";
import { getConfig } from "../gateway/config-patch.js";

// Subscription sign-in (ChatGPT, Copilot, xAI, OpenRouter, MiniMax…) runs as a
// Gateway wizard: openclaw.setup.auth.start, then wizard.next until done.
// Gateway-side steps (progress) and informational notes are acknowledged here;
// only steps that need the person (paste a URL, confirm, choose) are handed to
// the browser, which polls this session's state.
//
// A Claude plan is the exception: Anthropic lets it drive other programs only
// through its own Claude Code, so the person first signs in to Claude Code in
// the Gateway (link, then the code the page shows), and only then the Gateway's
// "claude-cli" activation switches the agent to Claude on that login (and checks it answers).

/** Sign-in option id for a Claude plan (Pro/Max) through Claude Code in the Gateway. */
export const CLAUDE_PLAN_CHOICE = "claude-plan";

/** Claude Code's sign-in in the Gateway (the ClawDesk bridge). */
export type ClaudeCodeLogin = {
  claudeStatus(): Promise<ClaudeLoginStatus>;
  claudeLoginStart(): Promise<{ authorizationUrl: string }>;
  claudeLoginComplete(code: string): Promise<ClaudeLoginStatus>;
};

type WizardStep = {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
  title?: string;
  message?: string;
  options?: { value: unknown; label: string }[];
  sensitive?: boolean;
  externalUrl?: string;
  deviceCode?: { code: string; expiresInMinutes?: number; message?: string };
};
type ActivateResult = { ok: boolean; status?: string; modelRef?: string; error?: string };
type WizardNext = {
  done: boolean;
  step?: WizardStep;
  status?: "running" | "done" | "cancelled" | "error";
  error?: string;
  preparedModelRef?: string;
  modelActivation?: { modelRef: string };
};

const KEEP_FINISHED_MS = 10 * 60_000;
const MAX_IDLE_MS = 30 * 60_000;
const BUSY_RETRIES = 4;
const FINISH = Symbol("finish");

/** OpenClaw's answer while another setup still holds its lock (details code SETUP_ADMISSION_BUSY). */
export function isSetupBusy(error: unknown): boolean {
  const details = (error as { details?: { code?: unknown } } | null)?.details;
  return details?.code === "SETUP_ADMISSION_BUSY" || /setup is already in progress/i.test(String((error as Error | null)?.message ?? ""));
}

class SignInSession {
  state: SignInStateDto;
  lastTouched = Date.now();
  cancelled = false;
  pendingAnswer: { stepId: string; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  /** Set when the main agent signs in through the setup wizard (shared store); tracks the wizard's own steps. */
  shared: { authChoice: string; provider: boolean; method: boolean; testDeclined: boolean; first: WizardNext | null } | null = null;

  constructor(
    sessionId: string,
    agentId: string,
    /** The agent's model chain before sign-in, when the new model joins it as a backup. */
    readonly backupOf: string[] | null,
  ) {
    this.state = {
      sessionId,
      agentId,
      status: "running",
      progress: null,
      url: null,
      paste: null,
      deviceCode: null,
      note: null,
      prompt: null,
      modelRef: null,
      error: null,
      errorCode: null,
    };
  }
}

export class SignInError extends Error {
  constructor(
    readonly code: "not_found" | "stale_step" | "not_waiting",
    message: string,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

export class SignInSessionManager {
  readonly #sessions = new Map<string, SignInSession>();

  constructor(
    private readonly gateway: GatewayService,
    private readonly logger: Logger,
    /** Called after a sign-in changed the main agent's models (juniors follow them). */
    private readonly onMainModelsChanged: () => Promise<void> = async () => {},
    private readonly claude: ClaudeCodeLogin | null = null,
    private readonly busyRetryMs = 1_500,
  ) {}

  /** A Claude plan can be offered only when this Gateway carries Claude Code. */
  async claudePlanAvailable(): Promise<boolean> {
    if (!this.claude) return false;
    try {
      return (await this.claude.claudeStatus()).installed;
    } catch {
      return false;
    }
  }

  async start(agentId: string, authChoice: string, asBackup = false): Promise<SignInStateDto> {
    this.#sweep();
    const backupOf = asBackup ? await readChain(this.gateway, agentId) : null;
    if (backupOf) assertRoomForBackup(backupOf);
    const sessionId = crypto.randomUUID();
    if (authChoice === CLAUDE_PLAN_CHOICE) return this.#startClaudePlan(sessionId, agentId, backupOf);
    // OpenClaw runs one setup at a time. "Try again" in the panel used to leave the previous sign-in of
    // this agent waiting for its OAuth page, which blocked every new attempt; it is replaced instead.
    for (const [id, previous] of this.#sessions) {
      if (previous.state.agentId === agentId && ["running", "waiting_for_user"].includes(previous.state.status)) await this.cancel(id);
    }
    // The main agent signs in through OpenClaw's setup wizard: it saves the credential in the shared auth
    // store, which every other agent reads through. openclaw.setup.auth.start keeps it in the main agent's
    // own store instead, so juniors "with the main agent's AI" had no credential (OpenClaw 2026.8.1 once
    // the shared store lives in state SQLite). A backup sign-in keeps the agent-scoped route.
    const viaWizard = agentId === "main" && !backupOf;
    const first = viaWizard ? await this.#startWizard() : (await this.#startInGateway({ sessionId, agentId, authChoice }), null);
    const session = new SignInSession(first?.sessionId ?? sessionId, agentId, backupOf);
    if (viaWizard) session.shared = { authChoice, provider: false, method: false, testDeclined: false, first };
    this.#sessions.set(session.state.sessionId, session);
    this.logger.info({ sessionId: session.state.sessionId, agentId, authChoice, asBackup, viaWizard }, "subscription sign-in started");
    void this.#drive(session);
    return session.state;
  }

  async #startWizard(): Promise<WizardNext & { sessionId: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.gateway.request<WizardNext & { sessionId?: string }>("wizard.start", { mode: "local", flow: "setup" });
        if (!res.sessionId) throw new Error("setup wizard did not start");
        return res as WizardNext & { sessionId: string };
      } catch (error) {
        if (attempt >= BUSY_RETRIES || !isSetupBusy(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.busyRetryMs));
      }
    }
  }

  /**
   * The wizard's own questions that are not the person's: answered here. undefined = ask the person,
   * "finish" = the credential and model are saved (the live-test offer was declined), stop the wizard.
   */
  #wizardAnswer(session: SignInSession, step: WizardStep): unknown {
    const shared = session.shared!;
    const has = (value: unknown) => step.options?.some((option) => option.value === value) ?? false;
    const text = `${step.title ?? ""} ${step.message ?? ""}`;
    if (shared.testDeclined) return FINISH;
    if (!shared.provider) {
      if (step.type === "confirm") return true;
      if (step.type === "select" && has("quickstart")) return "quickstart";
      if (step.type === "select" && has(false) && has(true)) return false;
      if (step.type === "select") {
        const provider = step.options?.find((option) => option.value === shared.authChoice || (typeof option.value === "string" && shared.authChoice.startsWith(`${option.value}-`)))?.value;
        if (provider === undefined) throw new Error(`the setup wizard does not offer ${shared.authChoice}`);
        shared.provider = true;
        return provider;
      }
      return undefined;
    }
    if (!shared.method && step.type === "select" && has(shared.authChoice)) { shared.method = true; return shared.authChoice; }
    // Channels come after auth and model are saved (a sign-in may skip the live-test offer): stop there.
    if (shared.method && /channel/i.test(text)) return FINISH;
    if (step.type === "select" && has("__keep__")) return "__keep__";
    if (step.type === "confirm" && /test/i.test(text)) { shared.testDeclined = true; return false; }
    return undefined;
  }

  /** After a wizard sign-in: the main agent and its followers use the shared credential (no pinned profile). */
  async #adoptSharedModel(): Promise<string | null> {
    const { config } = await getConfig<{ agents?: { defaults?: { model?: { primary?: string } | string } } }>(this.gateway);
    const setting = config.agents?.defaults?.model;
    const primary = (typeof setting === "string" ? setting : setting?.primary)?.replace(/@.*$/, "") ?? null;
    if (!primary) return null;
    const chain = (await readChain(this.gateway, "main")).map((ref) => ref.replace(/@.*$/, "")).filter((ref) => ref !== primary);
    await writeChain(this.gateway, "main", [primary, ...chain], "clawdesk: main agent uses the shared sign-in");
    return primary;
  }

  /** A cancelled setup frees OpenClaw's setup lock a moment later (about 1–2 s); wait for it briefly. */
  async #startInGateway(params: { sessionId: string; agentId: string; authChoice: string }): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.gateway.request("openclaw.setup.auth.start", params);
        return;
      } catch (error) {
        if (attempt >= BUSY_RETRIES || !isSetupBusy(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.busyRetryMs));
      }
    }
  }

  async #startClaudePlan(sessionId: string, agentId: string, backupOf: string[] | null): Promise<SignInStateDto> {
    if (!this.claude) throw new SignInError("not_found", "Claude Code is not available in this Gateway");
    const status = await this.claude.claudeStatus();
    if (!status.installed) throw new SignInError("not_found", "Claude Code is not available in this Gateway");
    const session = new SignInSession(sessionId, agentId, backupOf);
    this.#sessions.set(sessionId, session);
    this.logger.info({ sessionId, agentId, signedIn: status.loggedIn }, "Claude plan sign-in started");
    if (!status.loggedIn) {
      const { authorizationUrl } = await this.claude.claudeLoginStart();
      session.state = { ...session.state, url: authorizationUrl, paste: "code" };
    }
    void this.#driveClaudePlan(session, status.loggedIn);
    return session.state;
  }

  /** Claude Code login (when needed), then the Gateway's own "claude-cli" activation. */
  async #driveClaudePlan(session: SignInSession, signedIn: boolean): Promise<void> {
    const { sessionId, agentId } = session.state;
    try {
      while (!signedIn) {
        const code = await this.#ask(session, { id: "claude-code", type: "text", sensitive: true });
        if (session.cancelled) return;
        session.state = { ...session.state, progress: null };
        try {
          signedIn = (await this.claude!.claudeLoginComplete(String(code))).loggedIn;
        } catch (error) {
          // One code per sign-in: a wrong or old code needs a fresh link.
          this.#finish(session, { status: "error", error: (error as Error).message, errorCode: "claude_code_rejected" });
          return;
        }
      }
      if (session.cancelled) return;
      session.state = { ...session.state, url: null, paste: null };
      // Sets the agent's model on the Claude CLI runtime and makes one test call through it.
      const res = await this.gateway.request<ActivateResult>("openclaw.setup.activate", { agentId, kind: "claude-cli" }, { timeoutMs: 180_000 });
      this.logger.info({ sessionId, agentId, ok: res.ok, status: res.status }, "Claude plan activation");
      if (session.cancelled) return;
      if (!res.ok) {
        this.#finish(session, { status: "error", error: res.error ?? res.status ?? "Claude did not answer", errorCode: res.status === "auth" ? "claude_auth" : null });
        return;
      }
      let modelRef = res.modelRef ?? null;
      if (session.backupOf) modelRef = (await keepAsBackup(this.gateway, agentId, session.backupOf)) ?? modelRef;
      if (agentId === "main") await this.onMainModelsChanged();
      this.#finish(session, { status: "done", modelRef });
    } catch (error) {
      if (session.cancelled) return;
      this.logger.warn({ sessionId, err: error }, "Claude plan sign-in failed");
      this.#finish(session, { status: "error", error: (error as Error).message });
    }
  }

  get(sessionId: string): SignInStateDto {
    const session = this.#require(sessionId);
    session.lastTouched = Date.now();
    return session.state;
  }

  answer(sessionId: string, answer: SignInAnswerRequest): SignInStateDto {
    const session = this.#require(sessionId);
    const pending = session.pendingAnswer;
    if (!pending) throw new SignInError("not_waiting", "sign-in is not waiting for an answer");
    if (pending.stepId !== answer.stepId) throw new SignInError("stale_step", "this step is no longer current");
    session.pendingAnswer = null;
    session.state = { ...session.state, status: "running", prompt: null };
    pending.resolve(answer.value);
    return session.state;
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.cancelled = true;
    session.pendingAnswer?.reject(new Error("cancelled"));
    session.pendingAnswer = null;
    if (session.state.status === "running" || session.state.status === "waiting_for_user") {
      session.state = { ...session.state, status: "cancelled", prompt: null };
      await this.gateway.request("wizard.cancel", { sessionId }).catch((error: Error) => this.logger.debug({ err: error }, "wizard.cancel failed"));
    }
  }

  async #drive(session: SignInSession): Promise<void> {
    const { sessionId } = session.state;
    let answer: { stepId: string; value?: unknown } | undefined;
    try {
      while (!session.cancelled) {
        // Unbounded: a device-code step legitimately waits until the person approves (up to ~15 min).
        const first = session.shared?.first;
        if (session.shared) session.shared.first = null;
        const next = first ?? await this.gateway.request<WizardNext>("wizard.next", { sessionId, ...(answer ? { answer } : {}) }, { timeoutMs: null });
        answer = undefined;
        if (session.cancelled) return;
        if (next.status === "error" || next.error) {
          this.#finish(session, { status: "error", error: next.error ?? "sign-in failed" });
          return;
        }
        if (next.done || next.status === "done" || next.status === "cancelled") {
          let modelRef = next.modelActivation?.modelRef ?? next.preparedModelRef ?? null;
          if (next.status !== "cancelled" && session.backupOf) modelRef = (await keepAsBackup(this.gateway, session.state.agentId, session.backupOf)) ?? modelRef;
          if (next.status !== "cancelled" && session.state.agentId === "main") await this.onMainModelsChanged();
          this.#finish(session, { status: next.status === "cancelled" ? "cancelled" : "done", modelRef });
          return;
        }
        const step = next.step;
        if (!step) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }
        if (session.shared) {
          const auto = this.#wizardAnswer(session, step);
          if (auto === FINISH) {
            await this.gateway.request("wizard.cancel", { sessionId }).catch(() => undefined);
            const modelRef = await this.#adoptSharedModel();
            await this.onMainModelsChanged();
            this.#finish(session, { status: "done", modelRef });
            return;
          }
          if (auto !== undefined) { answer = { stepId: step.id, value: auto }; continue; }
        }
        if (step.type === "progress" || step.type === "action") {
          session.state = { ...session.state, progress: step.message ?? session.state.progress };
          answer = { stepId: step.id };
          continue;
        }
        if (step.type === "note") {
          session.state = {
            ...session.state,
            // The setup wizard puts the sign-in link only in the note text.
            url: step.externalUrl ?? /https:\/\/\S+/.exec(step.message ?? "")?.[0] ?? session.state.url,
            deviceCode: step.deviceCode ? { code: step.deviceCode.code, expiresInMinutes: step.deviceCode.expiresInMinutes ?? null } : session.state.deviceCode,
            note: step.message ?? session.state.note,
          };
          answer = { stepId: step.id };
          continue;
        }
        const value = await this.#ask(session, step);
        answer = { stepId: step.id, value };
      }
    } catch (error) {
      if (session.cancelled) return;
      this.logger.warn({ sessionId, err: error }, "subscription sign-in failed");
      this.#finish(session, { status: "error", error: (error as Error).message });
    }
  }

  #ask(session: SignInSession, step: WizardStep): Promise<unknown> {
    const prompt: SignInPromptDto = {
      stepId: step.id,
      kind: step.type === "confirm" ? "confirm" : step.type === "text" ? "text" : "select",
      message: step.message ?? step.title ?? null,
      sensitive: step.sensitive ?? false,
      options: (step.options ?? []).map((o) => ({ value: o.value, label: o.label })),
    };
    session.state = { ...session.state, status: "waiting_for_user", prompt };
    return new Promise((resolve, reject) => {
      session.pendingAnswer = { stepId: step.id, resolve, reject };
    });
  }

  #finish(session: SignInSession, patch: Partial<SignInStateDto>): void {
    session.state = { ...session.state, prompt: null, ...patch };
    session.lastTouched = Date.now();
    this.logger.info({ sessionId: session.state.sessionId, status: session.state.status }, "subscription sign-in finished");
  }

  #require(sessionId: string): SignInSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new SignInError("not_found", "sign-in session not found or expired");
    return session;
  }

  #sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      const finished = !["running", "waiting_for_user"].includes(session.state.status);
      if ((finished && now - session.lastTouched > KEEP_FINISHED_MS) || now - session.lastTouched > MAX_IDLE_MS) {
        void this.cancel(id);
        this.#sessions.delete(id);
      }
    }
  }
}
