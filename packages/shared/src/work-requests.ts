import { z } from "zod";

// Stage 6: requests up the company structure. An agent files a request (clawdesk_request_up); the panel
// routes it: department manager → main agent → owner, skipping levels that do not exist or are not
// running. The current addressee answers, denies, asks to clarify or passes it up; an agent addressee
// replies with clawdesk_request_reply, the owner here. A text answer never grants access.

/** access: the agent needs a resource (a shared folder or an MCP server); only the owner grants it (stage 5). */
export type WorkRequestKind = "question" | "decision" | "access";
/** open: waiting for the addressee; clarify: waiting for the requester's reply. */
export type WorkRequestStatus = "open" | "clarify" | "answered" | "denied" | "expired" | "cancelled";
export type WorkRequestLevelKind = "lead" | "manager" | "main" | "owner";
export type WorkRequestLevelDto = { kind: WorkRequestLevelKind; agentId: string | null; name: string };
export type WorkRequestEventKind = "created" | "routed" | "skipped" | "escalated" | "clarify" | "reply" | "answered" | "denied" | "expired" | "cancelled" | "refused" | "granted" | "notified";
export type WorkRequestEventDto = { kind: WorkRequestEventKind; actor: string; text: string; at: number; delivery: "none" | "pending" | "delivered" | "failed"; channel: "agent" | "telegram" | null };
export type WorkRequestDto = {
  id: string;
  code: string;
  from: { agentId: string; name: string };
  kind: WorkRequestKind;
  subject: string;
  details: string;
  taskRef: string;
  /** For an access request: "folder:<name>" or "mcp:<server>", and the level asked for. */
  resource: string | null;
  access: ResourceAccess | null;
  status: WorkRequestStatus;
  revision: number;
  /** The route as computed when the request was filed; `level` is the current addressee. */
  route: WorkRequestLevelDto[];
  level: number;
  /** `by`: the agent ID or "owner"; `name`: how to show it. */
  answer: { by: string; name: string; text: string } | null;
  deadlineAt: number;
  createdAt: number;
  updatedAt: number;
  events: WorkRequestEventDto[];
};
export type WorkRequestsDto = { requests: WorkRequestDto[] };

/** The owner's action; the owner is the last level, so there is no "escalate" here. */
export const OwnerRequestAction = z.object({
  requestId: z.uuid(),
  revision: z.number().int().min(0),
  /** grant: only for an access request — the panel applies and checks the access, then closes the request. */
  action: z.enum(["answer", "deny", "clarify", "cancel", "grant"]),
  text: z.string().trim().max(4000).default(""),
}).refine((value) => value.action === "cancel" || value.action === "grant" || value.text.length > 0, { message: "text required", path: ["text"] });
export type OwnerRequestAction = z.infer<typeof OwnerRequestAction>;

// Stage 5: what each company agent can actually reach, and the owner's grants and revocations.
export type ResourceAccess = "read" | "write";
/** folder: a shared folder synchronized into the agent's workspace; team-docs: its team's docs (same mechanism, fixed folder);
 *  mcp: an MCP server's tools; team-repo / project-copy: given by team membership, changed with the team, not here. */
export type AgentResourceKind = "folder" | "team-docs" | "mcp" | "team-repo" | "project-copy" | "gdoc";
export type AgentResourceDto = {
  kind: AgentResourceKind;
  /** Folder or server name; the team's name for team resources. */
  name: string;
  access: ResourceAccess;
  /** Where the agent finds it inside its sandbox, if it is a folder. */
  path: string | null;
  state: "ready" | "partial" | "pending" | "error" | "granted";
  revocable: boolean;
  /** Stage 7, a Google Doc's copy: its title and the version the copy holds. */
  title?: string;
  version?: string | null;
  copiedAt?: number;
};
export type AgentAccessDto = { agentId: string; name: string; role: "main" | "specialist" | "team_member"; sandboxed: boolean; resources: AgentResourceDto[] };
export type ResourceGrantDto = { id: string; agentId: string; resource: string; access: ResourceAccess; grantedBy: string; createdAt: number; revokedAt: number | null };
export type CompanyAccessDto = { agents: AgentAccessDto[]; folders: string[]; servers: string[]; history: ResourceGrantDto[] };
/** "folder:<shared folder>" (the bridge's folder name rule), "mcp:<server>" (McpServerName) or "gdoc:<Google Doc ID>". */
export const ResourceRef = z.string().regex(/^(?:folder:[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}|mcp:[a-z][a-z0-9-]{0,39}|gdoc:[A-Za-z0-9_-]{20,128})$/u);
/** An agent may name a Google Doc by its link: "gdoc:https://docs.google.com/document/d/<id>/edit" → "gdoc:<id>". */
export function normalizeResourceRef(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith("gdoc:")) return value;
  const id = /\/document\/d\/([A-Za-z0-9_-]{20,128})/.exec(value)?.[1];
  return id ? `gdoc:${id}` : value.trim();
}
export const GrantResourceRequest = z.object({ agentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/), resource: ResourceRef, access: z.enum(["read", "write"]) });
export type GrantResourceRequest = z.infer<typeof GrantResourceRequest>;
export const RevokeResourceRequest = z.object({ agentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/), resource: z.string().regex(/^(?:folder:[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}|mcp:[a-z][a-z0-9-]{0,39}|team-docs:[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}|gdoc:[A-Za-z0-9_-]{20,128})$/u) });
/** Stage 7: export a granted Google Doc again; the agent is told when its version changed. */
export const RefreshResourceRequest = z.object({ agentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/), resource: z.string().regex(/^gdoc:[A-Za-z0-9_-]{20,128}$/) });
export type RefreshResourceRequest = z.infer<typeof RefreshResourceRequest>;
export type RevokeResourceRequest = z.infer<typeof RevokeResourceRequest>;
