import { z } from "zod";
import { AgentId } from "./domain.js";

// Skills and MCP servers the owner adds once and hands out per agent ("Навыки и MCP" screen,
// checkboxes on an agent's page). A skill is installed into each chosen agent's own workspace;
// an MCP server is shared, and agents without access have its tools denied.

const AgentIds = z.array(AgentId).max(100);

// --- skills ---

/** Folder name of a skill in an agent's workspace (skills/<slug>), as OpenClaw accepts it. */
export const SkillSlug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

export const SkillDto = z.object({
  id: z.string(),
  /** clawhub: from the ClawHub catalog; own: uploaded or written in the panel. */
  kind: z.enum(["clawhub", "own"]),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** ClawHub reference used to install it (`@owner/slug`). */
  installRef: z.string().nullable(),
  /** Written in the panel (a single SKILL.md the owner can edit), not an uploaded archive. */
  editable: z.boolean(),
  /** Agents that have it in their workspace now. */
  agents: z.array(z.string()),
  createdAt: z.number(),
});
export type SkillDto = z.infer<typeof SkillDto>;

export const SkillsDto = z.object({ skills: z.array(SkillDto) });
export type SkillsDto = z.infer<typeof SkillsDto>;

export const ClawHubSkillDto = z.object({
  installRef: z.string(),
  slug: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
  /** ClawHub did not scan this one (mirrored from GitHub); the screen warns before adding it. */
  notScanned: z.boolean(),
});
export type ClawHubSkillDto = z.infer<typeof ClawHubSkillDto>;

export const ClawHubSearchDto = z.object({ results: z.array(ClawHubSkillDto) });
export type ClawHubSearchDto = z.infer<typeof ClawHubSearchDto>;

export const AddClawHubSkillRequest = z.object({
  installRef: z.string().trim().min(1).max(300),
  name: z.string().trim().min(1).max(120),
  summary: z.string().max(2000).nullable().optional(),
  agentIds: AgentIds,
});
export type AddClawHubSkillRequest = z.infer<typeof AddClawHubSkillRequest>;

/** A skill written in the panel: becomes a SKILL.md with this name, description and text. */
export const OwnSkillRequest = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(40_000),
  agentIds: AgentIds,
});
export type OwnSkillRequest = z.infer<typeof OwnSkillRequest>;

export const OwnSkillContentDto = z.object({ name: z.string(), description: z.string(), instructions: z.string() });
export type OwnSkillContentDto = z.infer<typeof OwnSkillContentDto>;

/** A SKILL.md file or a .zip of a skill folder, as base64. */
export const UploadSkillRequest = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1).max(7_000_000),
  agentIds: AgentIds,
});
export type UploadSkillRequest = z.infer<typeof UploadSkillRequest>;

export const SetAgentsRequest = z.object({ agentIds: AgentIds });
export type SetAgentsRequest = z.infer<typeof SetAgentsRequest>;

// --- MCP servers ---

/** Name of an MCP server in OpenClaw's config; also the prefix of its tools (`<name>__tool`). */
export const McpServerName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

export const McpServerDto = z.object({
  name: z.string(),
  url: z.string().nullable(),
  auth: z.enum(["oauth", "token", "none"]),
  /** OAuth servers: whether OpenClaw holds a sign-in now (null when unknown). */
  signedIn: z.boolean().nullable(),
  /** Added on this screen; others (Notion from data sources) are only shared out here. */
  managed: z.boolean(),
  agents: z.array(z.string()),
});
export type McpServerDto = z.infer<typeof McpServerDto>;

export const McpServersDto = z.object({ servers: z.array(McpServerDto) });
export type McpServersDto = z.infer<typeof McpServersDto>;

export const AddMcpServerRequest = z.object({
  name: McpServerName,
  url: z
    .string()
    .trim()
    .url()
    .max(500)
    .refine((u) => u.startsWith("https://"), "only https:// addresses"),
  auth: z.enum(["oauth", "token", "none"]),
  /** For auth "token": sent as `Authorization: Bearer <token>`. Never returned. */
  token: z.string().trim().min(1).max(4096).optional(),
  agentIds: AgentIds,
});
export type AddMcpServerRequest = z.infer<typeof AddMcpServerRequest>;

export const StartMcpLoginResultDto = z.object({ authorizationUrl: z.string().nullable(), signedIn: z.boolean() });
export type StartMcpLoginResultDto = z.infer<typeof StartMcpLoginResultDto>;
