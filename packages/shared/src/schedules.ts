import { z } from "zod";
import { CronExpr } from "./agents.js";

// Schedules (screen 10): an agent gets a task at set times (OpenClaw cron jobs the panel manages).

export const ScheduleRunDto = z.object({
  at: z.number(),
  status: z.enum(["ok", "error", "skipped"]),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  summary: z.string().nullable(),
});
export type ScheduleRunDto = z.infer<typeof ScheduleRunDto>;

export const ScheduleDto = z.object({
  id: z.string(),
  agentId: z.string(),
  label: z.string(),
  prompt: z.string(),
  /** "M H * * DOW" when the panel can edit it; null for other OpenClaw schedule kinds. */
  cron: z.string().nullable(),
  /** Human text for non-cron kinds (e.g. "every 30 min"), computed by the panel. */
  everyMs: z.number().nullable(),
  at: z.string().optional(),
  tz: z.string().nullable(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastStatus: z.enum(["ok", "error", "skipped"]).nullable(),
  lastError: z.string().nullable(),
  deliversToTelegram: z.boolean(),
});
export type ScheduleDto = z.infer<typeof ScheduleDto>;

export const ScheduleListDto = z.object({
  schedules: z.array(ScheduleDto),
  /** OpenClaw's own housekeeping jobs, not shown. */
  systemJobs: z.number(),
  /** Time zone new schedules use by default (the panel's). */
  timeZone: z.string(),
});
export type ScheduleListDto = z.infer<typeof ScheduleListDto>;

export const CreateScheduleRequest = z.object({
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  label: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(4000),
  cron: CronExpr,
  tz: z.string().min(1).max(64),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>;

export const UpdateScheduleRequest = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).max(4000).optional(),
  cron: CronExpr.optional(),
  tz: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequest>;
