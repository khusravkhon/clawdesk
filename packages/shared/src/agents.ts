import { z } from "zod";
import { AgentRole, SpaceMode } from "./domain.js";

// Junior-agent builder: template → about → schedule → AI access → create.

export const LocalizedText = z.object({ ru: z.string(), en: z.string(), tg: z.string().optional() });
export type LocalizedText = z.infer<typeof LocalizedText>;

export const TemplateDto = z.object({
  id: z.string(),
  mode: SpaceMode,
  role: AgentRole,
  title: LocalizedText,
  description: LocalizedText,
  emoji: z.string().nullable(),
  fields: z.array(
    z.object({
      key: z.string(),
      type: z.enum(["text", "textarea"]),
      label: LocalizedText,
      required: z.boolean(),
      default: z.string().nullable(),
    }),
  ),
  cronPresets: z.array(z.object({ id: z.string(), label: LocalizedText, cron: z.string(), prompt: z.string() })),
  canAskMain: z.boolean(),
  sandbox: z.boolean(),
});
export type TemplateDto = z.infer<typeof TemplateDto>;

/** 5-field cron limited to what the builder edits: minute, hour, any day-of-month/month, day-of-week list. */
export const CronExpr = z
  .string()
  .regex(/^([0-5]?\d) ([01]?\d|2[0-3]) \* \* (\*|[0-6](,[0-6])*)$/, "unsupported schedule");

export const ScheduleInput = z.object({
  presetId: z.string().max(64).nullable(),
  label: z.string().min(1).max(120),
  cron: CronExpr,
  prompt: z.string().min(1).max(4000),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;

export const CreateAgentRequest = z.object({
  templateId: z.string().regex(/^[a-z0-9-]+$/),
  mode: SpaceMode,
  /** Values for the template fields (agentName, goal, …). */
  values: z.record(z.string(), z.string().max(8000)),
  canAskMain: z.boolean(),
  /** inherit: use the main agent's model and credentials; own: connect a key/subscription right after creation. */
  ai: z.enum(["inherit", "own"]),
  schedules: z.array(ScheduleInput).max(10),
  /** IANA timezone for schedules, from the person's browser. */
  timezone: z.string().min(1).max(64),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

export const CreateAgentResultDto = z.object({
  agentId: z.string(),
  displayName: z.string(),
  model: z.string().nullable(),
  cronJobIds: z.array(z.string()),
  sandboxApplied: z.boolean(),
});
export type CreateAgentResultDto = z.infer<typeof CreateAgentResultDto>;
