import type {
  AgentListItemDto,
  CronRunStatus,
  DashboardAgentDto,
  DashboardDto,
  DashboardHealthDto,
  DashboardRange,
  DashboardSchedulesDto,
  DashboardUsageDto,
  HealthLevel,
} from "@clawdesk/shared";
import type { AiSetupService } from "../ai-setup/ai-setup-service.js";
import type { Db } from "../db/client.js";
import type { FreeModelsService } from "../free-models/free-models-service.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { listAgents } from "../routes/agents.js";
import type { TelegramService } from "../telegram/telegram-service.js";
import { isSystemJob } from "../schedules/job-policy.js";

// Raw Gateway shapes (OpenClaw 2026.8.1), only the fields the dashboard reads.

type CostTotals = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; totalCost?: number; missingCostEntries?: number };

export type RawSessionsUsage = {
  sessions?: unknown[];
  totals?: CostTotals;
  aggregates?: {
    sessionCount?: number;
    messages?: { total?: number; toolCalls?: number; errors?: number };
    byAgent?: { agentId: string; totals?: CostTotals }[];
    byModel?: { provider?: string; model?: string; count?: number; totals?: CostTotals }[];
    daily?: { date: string; tokens?: number; cost?: number; messages?: number; errors?: number }[];
  };
};

export type RawSession = {
  agentId?: string;
  updatedAt?: number;
  status?: string;
  lastRunError?: string;
  hasActiveRun?: boolean;
  archived?: boolean;
  totalTokens?: number;
};

export type RawCronJob = {
  id: string;
  agentId?: string;
  name?: string;
  displayName?: string;
  declarationKey?: string;
  payload?: { kind?: string };
  enabled?: boolean;
  nextRunAtMs?: number;
  state?: { nextRunAtMs?: number; lastRunStatus?: string };
};

export type RawCronRun = {
  ts: number;
  jobId: string;
  status?: string;
  error?: string;
  durationMs?: number;
  jobName?: string;
};

const RANGE_DAYS: Record<DashboardRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** YYYY-MM-DD of `ms` in `timeZone`. */
export function dayKey(ms: number, timeZone: string): string {
  // en-CA formats as ISO date.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** Every day of the range ending today, oldest first. */
export function rangeDays(range: DashboardRange, now: number, timeZone: string): string[] {
  const days: string[] = [];
  for (let i = RANGE_DAYS[range] - 1; i >= 0; i--) days.push(dayKey(now - i * 86_400_000, timeZone));
  // DST shifts can repeat a key; keep each day once.
  return [...new Set(days)];
}

const num = (v: number | undefined) => (Number.isFinite(v) ? (v as number) : 0);

export function buildUsage(raw: RawSessionsUsage, days: string[]): DashboardUsageDto {
  const agg = raw.aggregates ?? {};
  const byDay = new Map((agg.daily ?? []).map((d) => [d.date, d]));
  return {
    totals: {
      tokens: num(raw.totals?.totalTokens),
      tokenBreakdown: raw.totals && [raw.totals.input, raw.totals.output, raw.totals.cacheRead, raw.totals.cacheWrite].some((v) => Number.isFinite(v))
        ? { input: num(raw.totals.input), output: num(raw.totals.output), cacheRead: num(raw.totals.cacheRead), cacheWrite: num(raw.totals.cacheWrite) }
        : null,
      modelCalls: agg.byModel?.some((m) => Number.isFinite(m.count)) ? agg.byModel.reduce((sum, m) => sum + num(m.count), 0) : null,
      cost: num(raw.totals?.totalCost),
      messages: num(agg.messages?.total),
      toolCalls: num(agg.messages?.toolCalls),
      errors: num(agg.messages?.errors),
      sessions: num(agg.sessionCount ?? raw.sessions?.length),
    },
    daily: days.map((date) => {
      const d = byDay.get(date);
      return { date, tokens: num(d?.tokens), cost: num(d?.cost), messages: num(d?.messages), errors: num(d?.errors) };
    }),
    byAgent: (agg.byAgent ?? [])
      .map((a) => ({ agentId: a.agentId, tokens: num(a.totals?.totalTokens), cost: num(a.totals?.totalCost) }))
      .sort((a, b) => b.tokens - a.tokens),
    byModel: (agg.byModel ?? [])
      .map((m) => ({
        provider: m.provider ?? "unknown",
        model: m.model ?? "unknown",
        tokens: num(m.totals?.totalTokens),
        cost: num(m.totals?.totalCost),
        calls: num(m.count),
      }))
      .sort((a, b) => b.tokens - a.tokens),
    costIncomplete: num(raw.totals?.missingCostEntries) > 0,
  };
}

// Provider names as they appear in model refs, with the words their errors carry (hosts, ids).
const PROVIDER_MARKERS: Record<string, string[]> = {
  openai: ["api.openai.com", 'provider "openai"', "openai/"],
  anthropic: ["api.anthropic.com", 'provider "anthropic"', "anthropic/"],
  google: ["generativelanguage.googleapis.com", 'provider "google"', "google/"],
  xai: ["api.x.ai", 'provider "xai"', "xai/"],
  openrouter: ["openrouter.ai", 'provider "openrouter"', "openrouter/"],
  freellmapi: ['provider "freellmapi"', "freellmapi/"],
};

/**
 * A failure from a provider the agent no longer uses (e.g. OpenClaw's default OpenAI model
 * before the user connected Google) says nothing about the agent today.
 */
export function isStaleFailure(error: string | undefined, currentModel: string | null): boolean {
  if (!error || !currentModel) return false;
  const current = currentModel.split("/")[0]!;
  const text = error.toLowerCase();
  return Object.entries(PROVIDER_MARKERS).some(([provider, markers]) => provider !== current && markers.some((m) => text.includes(m)));
}

export function buildAgents(agents: AgentListItemDto[], sessions: RawSession[], usage: DashboardUsageDto | null): DashboardAgentDto[] {
  const tokensByAgent = new Map((usage?.byAgent ?? []).map((a) => [a.agentId, a.tokens]));
  return agents.map((agent) => {
    const own = sessions.filter((s) => s.agentId === agent.id && !s.archived);
    const latest = own.reduce<RawSession | undefined>((acc, s) => (num(s.updatedAt) > num(acc?.updatedAt) ? s : acc), undefined);
    const working = own.some((s) => s.hasActiveRun);
    const failed = !working && latest?.status === "failed" && !isStaleFailure(latest.lastRunError, agent.model);
    return {
      id: agent.id,
      name: agent.name,
      emoji: agent.emoji,
      role: agent.role,
      model: agent.model,
      state: working ? "working" : failed ? "failed" : "idle",
      sessions: own.length,
      lastActivityAt: latest?.updatedAt ?? null,
      lastError: failed ? (latest?.lastRunError ?? null) : null,
      tokens: tokensByAgent.get(agent.id) ?? own.reduce((sum, s) => sum + num(s.totalTokens), 0),
    };
  });
}

const runStatus = (s: string | undefined): CronRunStatus | null => (s === "ok" || s === "error" || s === "skipped" ? s : null);

/** OpenClaw declares its own housekeeping jobs (heartbeat, memory, skill review); user jobs may also have declaration keys. */

export function buildSchedules(jobs: RawCronJob[], runs: RawCronRun[], days: string[], timeZone: string): DashboardSchedulesDto {
  const userJobs = jobs.filter((j) => !isSystemJob(j));
  const userIds = new Map(userJobs.map((j) => [j.id, j]));
  const firstDay = days[0] ?? "";
  const inRange = runs.filter((r) => userIds.has(r.jobId) && dayKey(r.ts, timeZone) >= firstDay);

  const daily = new Map(days.map((date) => [date, { date, ok: 0, error: 0, skipped: 0 }]));
  const totals = { ok: 0, error: 0, skipped: 0 };
  for (const run of inRange) {
    const status = runStatus(run.status);
    if (!status) continue;
    totals[status] += 1;
    const day = daily.get(dayKey(run.ts, timeZone));
    if (day) day[status] += 1;
  }

  const nextRun = (j: RawCronJob) => j.nextRunAtMs ?? j.state?.nextRunAtMs ?? null;
  return {
    upcoming: userJobs
      .map((j) => ({
        id: j.id,
        name: j.displayName ?? j.name ?? j.id,
        agentId: j.agentId ?? null,
        enabled: j.enabled !== false,
        nextRunAt: j.enabled === false ? null : nextRun(j),
        lastStatus: runStatus(j.state?.lastRunStatus),
      }))
      .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)),
    runs: totals,
    daily: [...daily.values()],
    recent: inRange
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 8)
      .flatMap((r) => {
        const status = runStatus(r.status);
        if (!status) return [];
        const job = userIds.get(r.jobId);
        return [
          {
            jobName: job?.displayName ?? job?.name ?? r.jobName ?? r.jobId,
            agentId: job?.agentId ?? null,
            status,
            at: r.ts,
            durationMs: r.durationMs ?? null,
            error: r.error ?? null,
          },
        ];
      }),
    systemJobs: jobs.length - userJobs.length,
  };
}

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export type DashboardDeps = {
  gateway: GatewayService;
  db: Db;
  sandboxEnabled: boolean;
  aiSetup: AiSetupService;
  telegram: TelegramService;
  freeModels: FreeModelsService;
};

export class DashboardService {
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  constructor(private readonly deps: DashboardDeps) {}

  async get(range: DashboardRange, timeZone = this.timeZone): Promise<DashboardDto> {
    const now = Date.now();
    const days = rangeDays(range, now, timeZone);
    const { gateway } = this.deps;

    const [usageRes, agentsRes, sessionsRes, jobsRes, runsRes, health] = await Promise.allSettled([
      gateway.request<RawSessionsUsage>("sessions.usage", {
        agentScope: "all",
        startDate: days[0],
        endDate: days[days.length - 1],
        mode: "specific",
        timeZone,
        limit: 500,
      }),
      listAgents(this.deps),
      gateway.request<{ sessions?: RawSession[] }>("sessions.list", { limit: 500 }),
      gateway.request<{ jobs?: RawCronJob[] }>("cron.list", {}),
      gateway.request<{ entries?: RawCronRun[] }>("cron.runs", { scope: "all", limit: 500, sortDir: "desc" }),
      this.#health(),
    ]);

    const errors: DashboardDto["errors"] = {};
    const usage = usageRes.status === "fulfilled" ? buildUsage(usageRes.value, days) : null;
    if (usageRes.status === "rejected") errors.usage = errorText(usageRes.reason);

    let agents: DashboardAgentDto[] | null = null;
    if (agentsRes.status === "fulfilled") {
      agents = buildAgents(agentsRes.value.agents, sessionsRes.status === "fulfilled" ? (sessionsRes.value.sessions ?? []) : [], usage);
    } else errors.agents = errorText(agentsRes.reason);

    let schedules: DashboardSchedulesDto | null = null;
    if (jobsRes.status === "fulfilled") {
      schedules = buildSchedules(jobsRes.value.jobs ?? [], runsRes.status === "fulfilled" ? (runsRes.value.entries ?? []) : [], days, timeZone);
    } else errors.schedules = errorText(jobsRes.reason);

    return {
      range,
      timeZone,
      generatedAt: now,
      usage,
      agents,
      schedules,
      health: health.status === "fulfilled" ? health.value : this.#offlineHealth(),
      errors,
    };
  }

  #offlineHealth(): DashboardHealthDto {
    const gw = this.deps.gateway.status;
    return { gateway: gw.state, gatewayVersion: gw.serverVersion, ai: "off", aiProviders: [], telegram: "off", telegramBot: null, freeModels: "off" };
  }

  async #health(): Promise<DashboardHealthDto> {
    const gw = this.deps.gateway.status;
    if (gw.state !== "connected") return this.#offlineHealth();
    const [ai, tg, free] = await Promise.allSettled([this.deps.aiSetup.status("main"), this.deps.telegram.status(), this.deps.freeModels.status()]);

    const aiLevel: HealthLevel = ai.status === "rejected" ? "error" : ai.value.connected ? "ok" : "warning";
    let telegram: HealthLevel = "error";
    if (tg.status === "fulfilled") telegram = !tg.value.connected ? "off" : tg.value.lastError ? "error" : tg.value.running ? "ok" : "warning";
    let freeModels: HealthLevel = "error";
    if (free.status === "fulfilled") freeModels = free.value.ready ? "ok" : free.value.available ? "off" : "warning";

    return {
      gateway: gw.state,
      gatewayVersion: gw.serverVersion,
      ai: aiLevel,
      aiProviders: ai.status === "fulfilled" ? ai.value.providers : [],
      telegram,
      telegramBot: tg.status === "fulfilled" && tg.value.bot ? `@${tg.value.bot.username}` : null,
      freeModels,
    };
  }
}
