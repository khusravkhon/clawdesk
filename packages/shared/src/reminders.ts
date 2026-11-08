import { z } from "zod";

const TimeZone = z.string().min(1).max(80).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
});
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const ReminderPreferences = z.object({ quietHours: z.object({ enabled: z.boolean(), start: Clock, end: Clock, timeZone: TimeZone }) });
export type ReminderPreferences = z.infer<typeof ReminderPreferences>;
const Weekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7)
  .refine((days) => new Set(days).size === days.length).transform((days) => [...days].sort((a, b) => a - b));
export const CreateReminderRequest = z.object({ requestId: z.string().uuid(), text: z.string().trim().min(1).max(2000), dueAt: z.number().int().nonnegative(), timeZone: TimeZone, repeatDays: Weekdays.optional() });
export type CreateReminderRequest = z.infer<typeof CreateReminderRequest>;
export const ReminderActionRequest = z.object({ requestId: z.string().uuid(), action: z.enum(["done", "skip", "snooze", "stop_repeat"]), snoozeMinutes: z.number().int().min(5).max(1440).optional() });
export type ReminderActionRequest = z.infer<typeof ReminderActionRequest>;
export const ReminderDto = z.object({
  id: z.string(), requestId: z.string(), text: z.string(), dueAt: z.number(), timeZone: z.string(),
  delivery: z.enum(["pending", "deferred", "sending", "sent", "unknown", "expired"]),
  action: z.enum(["open", "done", "skipped", "snoozed"]),
  sentAt: z.number().nullable(), messageId: z.string().nullable(), parentId: z.string().nullable(), reason: z.string().nullable(),
  seriesId: z.string().nullable().optional(),
});
export type ReminderDto = z.infer<typeof ReminderDto>;
export const ReminderListDto = z.object({
  reminders: z.array(ReminderDto), preferences: ReminderPreferences, partial: z.boolean(), telegramConfigured: z.boolean().optional(),
  series: z.array(z.object({ id: z.string(), text: z.string(), timeZone: z.string(), days: z.array(z.number()), nextAt: z.number() })).optional(),
});
export type ReminderListDto = z.infer<typeof ReminderListDto>;
