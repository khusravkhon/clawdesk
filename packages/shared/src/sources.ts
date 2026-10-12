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

export const GoogleService = z.enum(["gmail", "drive", "docs", "sheets", "calendar"]);
export type GoogleService = z.infer<typeof GoogleService>;

export const GoogleSourceDto = z.object({
  /** The gog tool and the ClawDesk bridge are in the Gateway image. */
  available: z.boolean(),
  /** An OAuth client (the person's own Google Cloud project) is stored. */
  clientConfigured: z.boolean(),
  clientId: z.string().nullable(),
  accounts: z.array(z.object({ email: z.string(), services: z.array(z.string()) })),
  error: z.string().nullable(),
});
export type GoogleSourceDto = z.infer<typeof GoogleSourceDto>;

export const SourcesDto = z.object({
  notion: NotionSourceDto,
  folder: FolderSourceDto,
  google: GoogleSourceDto,
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

/** client_secret_….json of a "Desktop app" OAuth client, as Google offers it for download. */
export const UploadGoogleClientRequest = z.object({ json: z.string().min(20).max(20_000) });
export type UploadGoogleClientRequest = z.infer<typeof UploadGoogleClientRequest>;

const GoogleEmail = z.string().trim().toLowerCase().email().max(254);

export const StartGoogleLoginRequest = z.object({
  email: GoogleEmail,
  services: z.array(GoogleService).min(1),
  /** Read-only scopes unless the owner lets the assistant send mail and edit files. */
  readonly: z.boolean().default(true),
});
export type StartGoogleLoginRequest = z.infer<typeof StartGoogleLoginRequest>;

export const StartGoogleLoginResultDto = z.object({
  authorizationUrl: z.string(),
  /** Google returns straight to this panel; otherwise the person pastes the address. */
  returnsToPanel: z.boolean(),
});
export type StartGoogleLoginResultDto = z.infer<typeof StartGoogleLoginResultDto>;

/** After consent Google sends the browser to a localhost address that does not open; the person pastes it. */
export const CompleteGoogleLoginRequest = z.object({
  redirectUrl: z
    .string()
    .trim()
    .max(4000)
    .regex(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/.*[?&]code=/, "paste the whole address from the browser, it starts with http://localhost"),
});
export type CompleteGoogleLoginRequest = z.infer<typeof CompleteGoogleLoginRequest>;
