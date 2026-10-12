import { z } from "zod";

// Approvals (screen 12): commands an agent wants to run on the server wait for the owner.

export const ApprovalDecision = z.enum(["allow-once", "allow-always", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const PendingApprovalDto = z.object({
  id: z.string(),
  kind: z.enum(["exec", "plugin"]),
  /** What will run, as the agent asked for it. */
  command: z.string(),
  cwd: z.string().nullable(),
  /** OpenClaw's own warning (e.g. obfuscated or inline code). */
  warning: z.string().nullable(),
  agentId: z.string().nullable(),
  sessionKey: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type PendingApprovalDto = z.infer<typeof PendingApprovalDto>;

export const ApprovalHistoryItemDto = z.object({
  id: z.string(),
  command: z.string(),
  agentId: z.string().nullable(),
  status: z.enum(["allowed", "denied", "expired", "cancelled"]),
  decision: ApprovalDecision.nullable(),
  resolvedAt: z.number().nullable(),
});
export type ApprovalHistoryItemDto = z.infer<typeof ApprovalHistoryItemDto>;

/**
 * How the main agent's commands on the server are handled:
 * ask — known commands run, anything else waits for the owner (refused if nobody answers);
 * full — everything runs; deny — nothing runs.
 */
export const ExecMode = z.enum(["ask", "full", "deny"]);
export type ExecMode = z.infer<typeof ExecMode>;

export const AllowedCommandDto = z.object({ id: z.string().nullable(), pattern: z.string(), lastUsedAt: z.number().nullable() });
export type AllowedCommandDto = z.infer<typeof AllowedCommandDto>;

export const ApprovalsDto = z.object({
  pending: z.array(PendingApprovalDto),
  history: z.array(ApprovalHistoryItemDto),
  mainMode: ExecMode,
  allowed: z.array(AllowedCommandDto),
});
export type ApprovalsDto = z.infer<typeof ApprovalsDto>;

export const ResolveApprovalRequest = z.object({ kind: z.enum(["exec", "plugin"]), decision: ApprovalDecision });
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequest>;

export const SetExecModeRequest = z.object({ mode: ExecMode });
export type SetExecModeRequest = z.infer<typeof SetExecModeRequest>;
