import { z } from "zod";

// Action log (screen 14): what people did in the panel, and what agents did (OpenClaw's audit ledger).

export const AuditEventDto = z.object({
  id: z.number(),
  at: z.number(),
  /** "owner", or "anonymous" for sign-in attempts. */
  actor: z.string(),
  /** A known key (agent.create, auth.login, …) or "METHOD /api/route" for anything else. */
  action: z.string(),
  /** What it was done to (agent id, team id, backup name), never a secret. */
  target: z.string().nullable(),
  result: z.enum(["ok", "error"]),
  /** HTTP status of a failed action. */
  detail: z.string().nullable(),
});
export type AuditEventDto = z.infer<typeof AuditEventDto>;

export const AgentAuditEventDto = z.object({
  id: z.string(),
  at: z.number(),
  agentId: z.string().nullable(),
  /** agent.run.started|finished, tool.action.started|finished */
  action: z.string(),
  status: z.string(),
  toolName: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export type AgentAuditEventDto = z.infer<typeof AgentAuditEventDto>;

export const AuditPageDto = z.object({
  panel: z.array(AuditEventDto),
  agents: z.array(AgentAuditEventDto),
  /** Pass back as `before` (panel) or `cursor` (agents) for older entries; null at the end. */
  nextPanel: z.number().nullable(),
  nextAgents: z.string().nullable(),
});
export type AuditPageDto = z.infer<typeof AuditPageDto>;
