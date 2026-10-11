import { z } from "zod";
import { AgentId } from "./domain.js";

// Connecting an AI model to one agent. Used by the first-run window (main agent)
// and by the junior-agent builder (each agent may have its own access).
// Secrets only travel browser → BFF → Gateway in ActivateApiKeyRequest; nothing
// here ever carries a key back.

export const AiConnectMethod = z.object({
  /** OpenClaw auth choice id, e.g. "deepseek-api-key", "apiKey", "setup-token". */
  authChoice: z.string(),
  label: z.string(),
  hint: z.string().nullable(),
  /** api_key: paste a key; token: paste a subscription/setup token (same input, different wording). */
  input: z.enum(["api_key", "token"]),
});
export type AiConnectMethod = z.infer<typeof AiConnectMethod>;

export const AiProvider = z.object({
  /** Stable brand id: "anthropic", "openai", "deepseek", … */
  id: z.string(),
  label: z.string(),
  website: z.string().nullable(),
  popular: z.boolean(),
  /** Non-null when support must be installed first (OpenClaw provider plugin id). */
  installPluginId: z.string().nullable(),
  methods: z.array(AiConnectMethod),
});
export type AiProvider = z.infer<typeof AiProvider>;

export const AiSignInOption = z.object({
  id: z.string(),
  providerId: z.string().nullable(),
  label: z.string(),
  hint: z.string().nullable(),
  kind: z.enum(["oauth", "device-code"]),
});
export type AiSignInOption = z.infer<typeof AiSignInOption>;

export const AiCatalogDto = z.object({
  agentId: z.string(),
  /** provider/model the agent uses now, if any. */
  configuredModel: z.string().nullable(),
  connected: z.boolean(),
  providers: z.array(AiProvider),
  signIn: z.array(AiSignInOption),
});
export type AiCatalogDto = z.infer<typeof AiCatalogDto>;

export const AiStatusDto = z.object({
  agentId: z.string(),
  /** True when the agent has at least one usable model credential (own or inherited). */
  connected: z.boolean(),
  providers: z.array(z.string()),
});
export type AiStatusDto = z.infer<typeof AiStatusDto>;

export const ActivateApiKeyRequest = z.object({
  agentId: AgentId,
  authChoice: z.string().min(1).max(100),
  apiKey: z.string().trim().min(8).max(4096),
});
export type ActivateApiKeyRequest = z.infer<typeof ActivateApiKeyRequest>;

export const ActivateResultDto = z.object({
  ok: z.boolean(),
  /** Gateway probe bucket: ok | auth | rate_limit | billing | timeout | format | unavailable | unknown */
  status: z.string(),
  modelRef: z.string().nullable(),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
  /** The provider default was not usable on this key; a model that is (e.g. Gemini Flash on a free key) was chosen. */
  switchedModel: z.boolean(),
});
export type ActivateResultDto = z.infer<typeof ActivateResultDto>;

// --- Subscription sign-in (OAuth / device code), driven step by step by the Gateway ---

export const StartSignInRequest = z.object({
  agentId: AgentId,
  /** Id from AiCatalogDto.signIn, e.g. "openai-device-code", "github-copilot". */
  authChoice: z.string().min(1).max(100),
});
export type StartSignInRequest = z.infer<typeof StartSignInRequest>;

/** What the person has to do right now. Only Gateway-issued links/codes, never secrets. */
export const SignInPromptDto = z.object({
  stepId: z.string(),
  kind: z.enum(["text", "confirm", "select"]),
  message: z.string().nullable(),
  sensitive: z.boolean(),
  options: z.array(z.object({ value: z.unknown(), label: z.string() })),
});
export type SignInPromptDto = z.infer<typeof SignInPromptDto>;

export const SignInStateDto = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  status: z.enum(["running", "waiting_for_user", "done", "error", "cancelled"]),
  /** Latest progress line from the Gateway ("Waiting for device authorization…"). */
  progress: z.string().nullable(),
  /** Link to open in the person's own browser. */
  url: z.string().nullable(),
  deviceCode: z.object({ code: z.string(), expiresInMinutes: z.number().nullable() }).nullable(),
  /** Informational text the Gateway showed with the link or code. */
  note: z.string().nullable(),
  prompt: SignInPromptDto.nullable(),
  modelRef: z.string().nullable(),
  error: z.string().nullable(),
});
export type SignInStateDto = z.infer<typeof SignInStateDto>;

export const SignInAnswerRequest = z.object({
  stepId: z.string(),
  value: z.unknown(),
});
export type SignInAnswerRequest = z.infer<typeof SignInAnswerRequest>;

export const InstallProviderResultDto = z.object({
  ok: z.literal(true),
  pluginId: z.string(),
  version: z.string(),
  restarted: z.boolean(),
});
export type InstallProviderResultDto = z.infer<typeof InstallProviderResultDto>;
