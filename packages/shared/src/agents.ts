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
  /** Suggested name of the agent's own folder; null when the template does not use one. */
  folder: LocalizedText.nullable(),
  /** Saved by the owner from one of their agents ("My templates"); can be deleted. */
  own: z.boolean(),
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

/**
 * A folder inside the shared files folder. It ends up in a Docker bind ("src:dst:rw") and in paths,
 * so no slashes, colons or commas, and no leading dot.
 */
export const FolderName = z
  .string()
  .trim()
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u,"use letters, digits, spaces, dots, dashes; up to 60 characters");
export type FolderName = z.infer<typeof FolderName>;

export const CreateAgentRequest = z.object({
  templateId: z.string().regex(/^[a-z0-9-]+$/),
  mode: SpaceMode,
  /** Values for the template fields (agentName, goal, …). */
  values: z.record(z.string(), z.string().max(8000)),
  canAskMain: z.boolean(),
  /**
   * inherit: the main agent's model and credentials; own: connect a key/subscription right after
   * creation; free: pooled free models (personal mode only, never the main agent).
   */
  ai: z.enum(["inherit", "own", "free"]),
  schedules: z.array(ScheduleInput).max(10),
  /** IANA timezone for schedules, from the person's browser. */
  timezone: z.string().min(1).max(64),
  /** Deliver schedule results to the owner's Telegram chat (only when Telegram is connected). */
  deliverToTelegram: z.boolean().default(false),
  /** The agent's own folder (read and write); everything else it asks the main agent for. Null: none. */
  folder: FolderName.nullable().default(null),
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

// --- Editing an agent and saving it as a template ("My templates") ---

/** Workspace files the owner can edit: who the agent is, what it knows about the owner, how it works with data. */
export const AgentFiles = z.object({
  soul: z.string().max(20000),
  user: z.string().max(20000),
  agents: z.string().max(20000),
});
export type AgentFiles = z.infer<typeof AgentFiles>;

export const AgentProfileDto = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().nullable(),
  role: AgentRole,
  folder: z.string().nullable(),
  files: AgentFiles,
});
export type AgentProfileDto = z.infer<typeof AgentProfileDto>;

export const SaveAgentProfileRequest = z.object({
  name: z.string().trim().min(1).max(60),
  emoji: z.string().trim().max(8).nullable(),
  files: AgentFiles,
});
export type SaveAgentProfileRequest = z.infer<typeof SaveAgentProfileRequest>;

export const SaveAsTemplateRequest = z.object({
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(""),
});
export type SaveAsTemplateRequest = z.infer<typeof SaveAsTemplateRequest>;
