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
});
export type TodayDto = z.infer<typeof TodayDto>;
