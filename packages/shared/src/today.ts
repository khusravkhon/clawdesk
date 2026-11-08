import { z } from "zod";
import { LocalMemoryStatusDto } from "./assistant.js";
import { ReminderListDto } from "./reminders.js";
import { ScheduleListDto } from "./schedules.js";

const section = <T extends z.ZodType>(data: T) => z.object({
  state: z.enum(["available", "unknown"]),
  checkedAt: z.number().nullable(),
  data: data.nullable(),
});

export const TodayDto = z.object({
  generatedAt: z.number(),
  timeZone: z.string(),
  connection: section(z.object({ gateway: z.string(), telegram: z.array(z.object({ accountId: z.string(), running: z.boolean() })) })),
  approvals: section(z.object({ count: z.number().int().nonnegative() })),
  notes: section(z.object({ count: z.number().int().nonnegative(), pendingAgents: z.array(z.string()) })),
  search: section(LocalMemoryStatusDto),
  reminders: section(ReminderListDto),
  schedules: section(ScheduleListDto),
  activity: section(z.object({
    conversations: z.array(z.object({ agentId: z.string(), id: z.string().nullable(), title: z.string().nullable(), at: z.number() })),
    material: z.object({ id: z.string(), title: z.string(), at: z.number() }).nullable(),
  })),
  budget: section(z.object({
    dailyUsd: z.number().nonnegative(), monthlyUsd: z.number().nonnegative(),
    spentTodayUsd: z.number().nonnegative().nullable(), incomplete: z.boolean(), checkedAt: z.number().nullable(),
  })),
  backups: section(z.object({ available: z.boolean(), lastAt: z.number().nullable(), failed: z.boolean() })),
});
export type TodayDto = z.infer<typeof TodayDto>;
