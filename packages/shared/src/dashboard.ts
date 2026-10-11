import { z } from "zod";
import { GatewayConnectionState } from "./api.js";
import { AgentRole } from "./domain.js";

// Dashboard (overview screen): usage, agent activity, schedules and system health in one call.
// Each section is independent: a section the Gateway could not answer comes back null
// with its reason in `errors`, the rest still renders.

export const DashboardRange = z.enum(["7d", "30d", "90d"]);
export type DashboardRange = z.infer<typeof DashboardRange>;

export const UsageDayDto = z.object({
  /** YYYY-MM-DD in the panel's time zone. */
  date: z.string(),
  tokens: z.number(),
  cost: z.number(),
  messages: z.number(),
  errors: z.number(),
});
export type UsageDayDto = z.infer<typeof UsageDayDto>;

export const DashboardUsageDto = z.object({
  totals: z.object({
    tokens: z.number(),
    cost: z.number(),
    messages: z.number(),
    toolCalls: z.number(),
    errors: z.number(),
    sessions: z.number(),
  }),
  /** Every day of the range, zeros included, oldest first. */
  daily: z.array(UsageDayDto),
  byAgent: z.array(z.object({ agentId: z.string(), tokens: z.number(), cost: z.number() })),
  byModel: z.array(z.object({ provider: z.string(), model: z.string(), tokens: z.number(), cost: z.number(), calls: z.number() })),
  /** Some calls had no price (free or unknown models): the cost total is a lower bound. */
  costIncomplete: z.boolean(),
});
export type DashboardUsageDto = z.infer<typeof DashboardUsageDto>;

export const DashboardAgentState = z.enum(["working", "idle", "failed"]);
export type DashboardAgentState = z.infer<typeof DashboardAgentState>;

export const DashboardAgentDto = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().nullable(),
  role: AgentRole.nullable(),
  model: z.string().nullable(),
  state: DashboardAgentState,
  sessions: z.number(),
  lastActivityAt: z.number().nullable(),
  lastError: z.string().nullable(),
  tokens: z.number(),
});
export type DashboardAgentDto = z.infer<typeof DashboardAgentDto>;

export const CronRunStatus = z.enum(["ok", "error", "skipped"]);
export type CronRunStatus = z.infer<typeof CronRunStatus>;

export const DashboardSchedulesDto = z.object({
  upcoming: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      agentId: z.string().nullable(),
      enabled: z.boolean(),
      nextRunAt: z.number().nullable(),
      lastStatus: CronRunStatus.nullable(),
    }),
  ),
  runs: z.object({ ok: z.number(), error: z.number(), skipped: z.number() }),
  daily: z.array(z.object({ date: z.string(), ok: z.number(), error: z.number(), skipped: z.number() })),
  recent: z.array(
    z.object({
      jobName: z.string(),
      agentId: z.string().nullable(),
      status: CronRunStatus,
      at: z.number(),
      durationMs: z.number().nullable(),
      error: z.string().nullable(),
    }),
  ),
  /** OpenClaw's own housekeeping jobs (heartbeat, memory) — counted, not listed. */
  systemJobs: z.number(),
});
export type DashboardSchedulesDto = z.infer<typeof DashboardSchedulesDto>;

export const HealthLevel = z.enum(["ok", "warning", "error", "off"]);
export type HealthLevel = z.infer<typeof HealthLevel>;

export const DashboardHealthDto = z.object({
  gateway: GatewayConnectionState,
  gatewayVersion: z.string().nullable(),
  ai: HealthLevel,
  aiProviders: z.array(z.string()),
  telegram: HealthLevel,
  telegramBot: z.string().nullable(),
  freeModels: HealthLevel,
});
export type DashboardHealthDto = z.infer<typeof DashboardHealthDto>;

export const DashboardDto = z.object({
  range: DashboardRange,
  timeZone: z.string(),
  generatedAt: z.number(),
  usage: DashboardUsageDto.nullable(),
  agents: z.array(DashboardAgentDto).nullable(),
  schedules: DashboardSchedulesDto.nullable(),
  health: DashboardHealthDto,
  errors: z.object({ usage: z.string().optional(), agents: z.string().optional(), schedules: z.string().optional() }),
});
export type DashboardDto = z.infer<typeof DashboardDto>;
