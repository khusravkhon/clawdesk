import { z } from "zod";
import { DashboardRange, DashboardUsageDto } from "./dashboard.js";
import { AgentRole } from "./domain.js";

// Usage screen (13): tokens and cost per agent per day.

export const UsageAgentDto = z.object({
  agentId: z.string(),
  name: z.string(),
  emoji: z.string().nullable(),
  role: AgentRole.nullable(),
  tokens: z.number().nullable(),
  cost: z.number().nullable(),
  checkedAt: z.number().nullable(),
  available: z.boolean(),
  /** Tokens per day, aligned with UsageDto.days. */
  daily: z.array(z.number()),
});
export type UsageAgentDto = z.infer<typeof UsageAgentDto>;

export const UsageDto = z.object({
  range: DashboardRange,
  /** YYYY-MM-DD, oldest first. */
  days: z.array(z.string()),
  usage: DashboardUsageDto.nullable(),
  checkedAt: z.number().nullable(),
  agents: z.array(UsageAgentDto),
});
export type UsageDto = z.infer<typeof UsageDto>;
