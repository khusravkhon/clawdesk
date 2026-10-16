import { TELEGRAM_AUDIO_PROVIDERS, type TelegramAudioProvider } from "@clawdesk/shared";

type ToolPolicy = { allow?: string[]; alsoAllow?: string[]; deny?: string[] };
export type MediaConfig = {
  tools?: ToolPolicy & {
    sandbox?: { tools?: ToolPolicy };
    message?: { crossContext?: { allowWithinProvider?: boolean; allowAcrossProviders?: boolean } };
    media?: { models?: { capabilities?: string[]; [key: string]: unknown }[]; audio?: { enabled?: boolean; [key: string]: unknown } };
  };
};

function includesMessage(names: string[] = []): boolean {
  return names.some((name) => ["*", "message", "group:messaging", "group:openclaw"].includes(name.toLowerCase()));
}

function extendPolicy(policy: ToolPolicy = {}): Record<string, unknown> {
  if (includesMessage(policy.deny)) return {};
  const key = policy.allow?.length ? "allow" : "alsoAllow";
  const current = policy[key] ?? [];
  return includesMessage(current) ? {} : { ...(policy.allow?.length === 0 ? { allow: null } : {}), [key]: [...current, "message"] };
}

/** Add only messaging; never remove an explicit deny or replace the coding profile. */
export function telegramMediaPatch(config: MediaConfig): Record<string, unknown> | null {
  const tools = config.tools ?? {};
  const patch: Record<string, unknown> = { ...extendPolicy(tools) };
  const sandbox = extendPolicy(tools.sandbox?.tools);
  if (Object.keys(sandbox).length) patch.sandbox = { tools: sandbox };
  const crossContext = tools.message?.crossContext;
  if (crossContext?.allowWithinProvider !== false || crossContext?.allowAcrossProviders !== false) {
    patch.message = { crossContext: { allowWithinProvider: false, allowAcrossProviders: false } };
  }
  if (tools.media?.audio?.enabled === undefined && !tools.media?.models?.some((model) => model.capabilities?.includes("audio"))) {
    patch.media = { audio: { enabled: false } };
  }
  return Object.keys(patch).length ? { tools: patch } : null;
}

export const AUDIO_PROFILE = "openai:clawdesk-audio";
export const AUDIO_MODEL = "gpt-4o-mini-transcribe";

export function cloudAudioPatch(config: MediaConfig, enabled: boolean, provider: TelegramAudioProvider = "openai", model: string = TELEGRAM_AUDIO_PROVIDERS[provider].models[0]): Record<string, unknown> {
  if (!enabled) return { tools: { media: { audio: { enabled: false } } } };
  const models = config.tools?.media?.models ?? [];
  const selected = TELEGRAM_AUDIO_PROVIDERS[provider];
  const profiles: readonly string[] = Object.values(TELEGRAM_AUDIO_PROVIDERS).map((item) => item.profile);
  return { tools: { media: {
    // Each native provider gets its own key, endpoint and explicit audio profile.
    models: [{ provider, model, profile: selected.profile, baseUrl: selected.baseUrl, capabilities: ["audio"], maxBytes: 20 * 1024 * 1024, timeoutSeconds: 90 }, ...models.filter((m) => !profiles.includes(String(m.profile)))],
    audio: { enabled: true, maxBytes: 20 * 1024 * 1024, maxChars: 12000, preferredModel: `${provider}/${model}` },
  } } };
}
