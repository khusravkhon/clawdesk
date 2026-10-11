import { z } from "zod";

// Domain enums shared by web, bff and (later) desktop.
// OpenClaw config is the source of truth for how agents run; these describe
// only what the panel adds on top (see docs/architecture.md, "Модель данных").

export const Locale = z.enum(["ru", "en", "tg"]);
export type Locale = z.infer<typeof Locale>;

export const SpaceMode = z.enum(["personal", "company"]);
export type SpaceMode = z.infer<typeof SpaceMode>;

export const PanelUserRole = z.enum(["owner", "member"]);
export type PanelUserRole = z.infer<typeof PanelUserRole>;

export const AgentRole = z.enum(["main", "specialist", "team_member"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentStatus = z.enum(["provisioning", "ready", "error", "drift"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const DataSourceKind = z.enum(["notion", "gmail", "gdrive", "github", "figma", "folder"]);
export type DataSourceKind = z.infer<typeof DataSourceKind>;

export const SourceAccess = z.enum(["read", "write"]);
export type SourceAccess = z.infer<typeof SourceAccess>;

export const CredentialMethod = z.enum(["api_key", "setup_token", "oauth"]);
export type CredentialMethod = z.infer<typeof CredentialMethod>;

/** OpenClaw agent ids are slugs; we use the same id as our primary key. */
export const AgentId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "agent id must be a lowercase slug");
export type AgentId = z.infer<typeof AgentId>;
