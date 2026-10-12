import { z } from "zod";

// Data sources screen (5): what the main agent can read. Secrets go in, only statuses come back.

export const NotionMethod = z.enum(["token", "oauth"]);
export type NotionMethod = z.infer<typeof NotionMethod>;

export const NotionSourceDto = z.object({
  connected: z.boolean(),
  method: NotionMethod.nullable(),
  /** Notion workspace the integration belongs to. */
  workspace: z.string().nullable(),
  /** Integration (bot) name as Notion shows it. */
  integration: z.string().nullable(),
  /** Sign-in through Notion's own page (MCP OAuth) is possible on this server. */
  oauthAvailable: z.boolean(),
  error: z.string().nullable(),
});
export type NotionSourceDto = z.infer<typeof NotionSourceDto>;

export const FolderFileDto = z.object({ name: z.string(), size: z.number(), modifiedAt: z.number(), isDir: z.boolean() });
export type FolderFileDto = z.infer<typeof FolderFileDto>;

export const FolderSourceDto = z.object({
  /** The shared folder is mounted into the Gateway. */
  available: z.boolean(),
  /** Where the person puts files on their own computer. */
  hostPath: z.string().nullable(),
  /** Path the agent uses inside its workspace. */
  agentPath: z.string(),
  files: z.array(FolderFileDto),
  total: z.number(),
});
export type FolderSourceDto = z.infer<typeof FolderSourceDto>;

export const SourcesDto = z.object({
  notion: NotionSourceDto,
  folder: FolderSourceDto,
});
export type SourcesDto = z.infer<typeof SourcesDto>;

export const ConnectNotionTokenRequest = z.object({
  token: z
    .string()
    .trim()
    .regex(/^(ntn_|secret_)[A-Za-z0-9]{20,}$/, "this does not look like a Notion integration secret"),
});
export type ConnectNotionTokenRequest = z.infer<typeof ConnectNotionTokenRequest>;

export const StartNotionOAuthResultDto = z.object({
  /** Open this Notion page; null when the server already had a valid sign-in. */
  authorizationUrl: z.string().nullable(),
  connected: z.boolean(),
});
export type StartNotionOAuthResultDto = z.infer<typeof StartNotionOAuthResultDto>;
