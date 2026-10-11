import { z } from "zod";
import { AgentRole, AgentStatus } from "./domain.js";

// DTOs exchanged between apps/web and apps/bff. Secrets never appear here:
// write-only inputs go in, only statuses come back.

export const GatewayConnectionState = z.enum([
  "idle",
  "connecting",
  "connected",
  "pairing_required",
  "auth_failed",
  "disconnected",
]);
export type GatewayConnectionState = z.infer<typeof GatewayConnectionState>;

export const GatewayStatusDto = z.object({
  state: GatewayConnectionState,
  serverVersion: z.string().nullable(),
  protocol: z.number().int().nullable(),
  scopes: z.array(z.string()),
  /** Non-null when the operator has to act (e.g. approve pairing on the host). */
  hint: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type GatewayStatusDto = z.infer<typeof GatewayStatusDto>;

export const HealthDto = z.object({
  ok: z.boolean(),
  version: z.string(),
  gateway: GatewayStatusDto,
});
export type HealthDto = z.infer<typeof HealthDto>;

export const AgentListItemDto = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().nullable(),
  model: z.string().nullable(),
  isDefault: z.boolean(),
  /** Panel metadata; null when the agent exists only in OpenClaw. */
  role: AgentRole.nullable(),
  parentId: z.string().nullable(),
  status: AgentStatus,
});
export type AgentListItemDto = z.infer<typeof AgentListItemDto>;

export const AgentListDto = z.object({
  defaultId: z.string(),
  agents: z.array(AgentListItemDto),
});
export type AgentListDto = z.infer<typeof AgentListDto>;

export const ApiErrorDto = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiErrorDto = z.infer<typeof ApiErrorDto>;
