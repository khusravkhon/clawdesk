import type { AllowedCommandDto, ApprovalDecision, ApprovalHistoryItemDto, ApprovalsDto, ExecMode, PendingApprovalDto } from "@clawdesk/shared";
import type { Logger } from "pino";
import type { GatewayService } from "../gateway/gateway-service.js";

// Approvals (screen 12). OpenClaw runs a command only when its config policy and the host's
// approvals document both allow it (the stricter wins). The panel tightens the main agent in the
// approvals document: "ask" = allowlist + ask on miss, refused when nobody answers in time.

type RawPending = {
  id: string;
  approvalKind?: "exec" | "plugin";
  createdAtMs?: number;
  expiresAtMs?: number;
  request?: { command?: string; commandArgv?: string[]; cwd?: string | null; warningText?: string | null; agentId?: string | null; sessionKey?: string | null; title?: string; description?: string };
};

type RawHistoryItem = {
  id: string;
  status: string;
  decision?: string;
  resolvedAtMs?: number;
  source?: { agentId?: string };
  presentation?: { kind?: string; commandText?: string; title?: string };
};

type AgentPolicy = { allowlist?: { id?: string; pattern: string; lastUsedAt?: number }[]; security?: string; ask?: string; askFallback?: string; autoAllowSkills?: boolean };
type ApprovalsFile = { version: 1; socket?: unknown; defaults?: Record<string, unknown>; agents?: Record<string, AgentPolicy> };
type ApprovalsSnapshot = { hash: string; file: ApprovalsFile };

export const MAIN = "main";

/** The main agent's entry for a mode; the allowlist is kept as it is. */
export function applyMode(current: AgentPolicy | undefined, mode: ExecMode): AgentPolicy {
  const { security: _s, ask: _a, askFallback: _f, ...rest } = current ?? {};
  if (mode === "full") return rest;
  if (mode === "deny") return { ...rest, security: "deny", ask: "off", askFallback: "deny" };
  return { ...rest, security: "allowlist", ask: "on-miss", askFallback: "deny" };
}

export function modeOf(policy: AgentPolicy | undefined): ExecMode {
  if (policy?.security === "deny") return "deny";
  if (policy?.security === "allowlist" || policy?.ask === "on-miss" || policy?.ask === "always") return "ask";
  return "full";
}

export function toPending(raw: RawPending): PendingApprovalDto {
  const r = raw.request ?? {};
  const command = r.command ?? (r.commandArgv?.length ? r.commandArgv.join(" ") : (r.title ?? r.description ?? "—"));
  return {
    id: raw.id,
    kind: raw.approvalKind === "plugin" ? "plugin" : "exec",
    command,
    cwd: r.cwd ?? null,
    warning: r.warningText ?? null,
    agentId: r.agentId ?? null,
    sessionKey: r.sessionKey ?? null,
    createdAt: raw.createdAtMs ?? Date.now(),
    expiresAt: raw.expiresAtMs ?? Date.now(),
  };
}

const STATUSES = new Set(["allowed", "denied", "expired", "cancelled"]);
const DECISIONS = new Set(["allow-once", "allow-always", "deny"]);

export function toHistoryItem(raw: RawHistoryItem): ApprovalHistoryItemDto | null {
  if (!STATUSES.has(raw.status)) return null;
  return {
    id: raw.id,
    command: raw.presentation?.commandText ?? raw.presentation?.title ?? "—",
    agentId: raw.source?.agentId ?? null,
    status: raw.status as ApprovalHistoryItemDto["status"],
    decision: raw.decision && DECISIONS.has(raw.decision) ? (raw.decision as ApprovalDecision) : null,
    resolvedAt: raw.resolvedAtMs ?? null,
  };
}

export class ApprovalsService {
  constructor(
    private readonly gateway: GatewayService,
    private readonly logger: Logger,
  ) {}

  /** Daily view must distinguish an unavailable queue from an empty one. */
  async pendingCount(): Promise<number> {
    const queues = await Promise.all([
      this.gateway.request<RawPending[]>("exec.approval.list", {}),
      this.gateway.request<RawPending[]>("plugin.approval.list", {}),
    ]);
    if (queues.some((queue) => !Array.isArray(queue))) throw new Error("invalid_approvals");
    return queues.reduce((count, queue) => count + queue.length, 0);
  }

  async list(): Promise<ApprovalsDto> {
    const [exec, plugin, history, policy] = await Promise.all([
      this.gateway.request<RawPending[]>("exec.approval.list", {}),
      this.gateway.request<RawPending[]>("plugin.approval.list", {}).catch(() => [] as RawPending[]),
      this.gateway.request<{ items?: RawHistoryItem[] }>("approval.history", { limit: 20 }).catch(() => ({ items: [] })),
      this.#snapshot(),
    ]);
    const main = policy.file.agents?.[MAIN];
    return {
      pending: [...exec.map((p) => toPending({ ...p, approvalKind: "exec" })), ...plugin.map((p) => toPending({ ...p, approvalKind: "plugin" }))].sort(
        (a, b) => a.createdAt - b.createdAt,
      ),
      history: (history.items ?? []).map(toHistoryItem).filter((h) => h !== null),
      mainMode: modeOf(main),
      allowed: (main?.allowlist ?? []).map((a): AllowedCommandDto => ({ id: a.id ?? null, pattern: a.pattern, lastUsedAt: a.lastUsedAt ?? null })),
    };
  }

  async resolve(id: string, kind: "exec" | "plugin", decision: ApprovalDecision): Promise<void> {
    await this.gateway.request(kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve", { id, decision });
    this.logger.info({ id, kind, decision }, "approval resolved");
  }

  async setMainMode(mode: ExecMode): Promise<void> {
    await this.#update((file) => ({ ...file, agents: { ...file.agents, [MAIN]: applyMode(file.agents?.[MAIN], mode) } }));
    this.logger.info({ mode }, "main agent exec mode set");
  }

  async removeAllowed(pattern: string): Promise<void> {
    await this.#update((file) => {
      const main = file.agents?.[MAIN] ?? {};
      return { ...file, agents: { ...file.agents, [MAIN]: { ...main, allowlist: (main.allowlist ?? []).filter((a) => a.pattern !== pattern) } } };
    });
  }

  /**
   * Architecture rule: the main agent runs commands on the server only with approval.
   * Applied once per install; the owner can change the mode afterwards.
   */
  async ensureDefault(alreadyApplied: boolean): Promise<boolean> {
    if (alreadyApplied) return false;
    const snap = await this.#snapshot();
    if (modeOf(snap.file.agents?.[MAIN]) !== "full") return true;
    await this.setMainMode("ask");
    return true;
  }

  #snapshot(): Promise<ApprovalsSnapshot> {
    return this.gateway.request<ApprovalsSnapshot>("exec.approvals.get", {});
  }

  async #update(change: (file: ApprovalsFile) => ApprovalsFile): Promise<void> {
    const snap = await this.#snapshot();
    await this.gateway.request("exec.approvals.set", { file: change(snap.file), baseHash: snap.hash });
  }
}
