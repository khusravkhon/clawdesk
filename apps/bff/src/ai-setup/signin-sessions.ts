import crypto from "node:crypto";
import type { SignInAnswerRequest, SignInPromptDto, SignInStateDto } from "@clawdesk/shared";
import type { Logger } from "pino";
import type { GatewayService } from "../gateway/gateway-service.js";
import { assertRoomForBackup, keepAsBackup, readChain } from "./model-chain.js";

// Subscription sign-in (ChatGPT, Copilot, xAI, OpenRouter, MiniMax…) runs as a
// Gateway wizard: openclaw.setup.auth.start, then wizard.next until done.
// Gateway-side steps (progress) and informational notes are acknowledged here;
// only steps that need the person (paste a URL, confirm, choose) are handed to
// the browser, which polls this session's state.

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

class SignInSession {
  state: SignInStateDto;
  lastTouched = Date.now();
  cancelled = false;
  pendingAnswer: { stepId: string; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;

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
      deviceCode: null,
      note: null,
      prompt: null,
      modelRef: null,
      error: null,
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
  ) {}

  async start(agentId: string, authChoice: string, asBackup = false): Promise<SignInStateDto> {
    this.#sweep();
    const backupOf = asBackup ? await readChain(this.gateway, agentId) : null;
    if (backupOf) assertRoomForBackup(backupOf);
    const sessionId = crypto.randomUUID();
    await this.gateway.request("openclaw.setup.auth.start", { sessionId, agentId, authChoice });
    const session = new SignInSession(sessionId, agentId, backupOf);
    this.#sessions.set(sessionId, session);
    this.logger.info({ sessionId, agentId, authChoice, asBackup }, "subscription sign-in started");
    void this.#drive(session);
    return session.state;
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
        const next = await this.gateway.request<WizardNext>("wizard.next", { sessionId, ...(answer ? { answer } : {}) }, { timeoutMs: null });
        answer = undefined;
        if (session.cancelled) return;
        if (next.status === "error" || next.error) {
          this.#finish(session, { status: "error", error: next.error ?? "sign-in failed" });
          return;
        }
        if (next.done || next.status === "done" || next.status === "cancelled") {
          let modelRef = next.modelActivation?.modelRef ?? next.preparedModelRef ?? null;
          if (next.status !== "cancelled" && session.backupOf) modelRef = (await keepAsBackup(this.gateway, session.state.agentId, session.backupOf)) ?? modelRef;
          this.#finish(session, { status: next.status === "cancelled" ? "cancelled" : "done", modelRef });
          return;
        }
        const step = next.step;
        if (!step) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }
        if (step.type === "progress" || step.type === "action") {
          session.state = { ...session.state, progress: step.message ?? session.state.progress };
          answer = { stepId: step.id };
          continue;
        }
        if (step.type === "note") {
          session.state = {
            ...session.state,
            url: step.externalUrl ?? session.state.url,
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
