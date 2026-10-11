import type { AiCatalogDto, AiConnectMethod, AiProvider, AiSignInOption } from "@clawdesk/shared";

// Turns the Gateway's raw setup data into the provider list the UI shows.
// Pure functions: no I/O, so the merge rules are unit-tested.

export type DetectResult = {
  candidates: { kind: string; label: string; modelRef: string; recommended: boolean }[];
  manualProviders: { id: string; brandId?: string; groupLabel?: string; label: string; hint?: string; website?: string }[];
  authOptions?: {
    id: string;
    brandId?: string;
    groupLabel?: string;
    label: string;
    hint?: string;
    website?: string;
    kind: "oauth" | "device-code";
    featured: boolean;
  }[];
  configuredModel?: string;
  setupComplete: boolean;
};

export type PluginEntry = {
  id: string;
  name?: string;
  packageName?: string;
  origin?: string;
  installed?: boolean;
  state?: string;
};

/** Shown first, in this order; everything else follows alphabetically. */
const POPULAR = ["anthropic", "openai", "deepseek", "qwen", "moonshot", "kimi", "zai", "google", "minimax", "xai", "openrouter"];

/**
 * The exact page where a person creates an API key. Preferred over the Gateway's
 * provider website, which is usually a product home page (a person lands in a
 * playground and does not find the key).
 */
const KEY_PAGES: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  google: "https://aistudio.google.com/apikey",
  deepseek: "https://platform.deepseek.com/api_keys",
  moonshot: "https://platform.moonshot.ai/console/api-keys",
  zai: "https://z.ai/manage-apikey/apikey-list",
  xai: "https://console.x.ai/",
  openrouter: "https://openrouter.ai/keys",
};

/**
 * Auth choices that need more than a pasted secret (base URL, local server,
 * device login) are left to later screens; the first window only pastes a key or token.
 */
const NEEDS_MORE_THAN_A_KEY = new Set(["lmstudio", "github-copilot", "litellm-api-key"]);

const PROVIDER_PACKAGE = /^@openclaw\/([a-z0-9-]+)-provider$/;

export function providerPluginId(plugin: PluginEntry): string | null {
  const match = plugin.packageName ? PROVIDER_PACKAGE.exec(plugin.packageName) : null;
  return match && plugin.origin === "official" ? match[1]! : null;
}

export function buildCatalog(agentId: string, detect: DetectResult, plugins: PluginEntry[]): AiCatalogDto {
  const providers = new Map<string, AiProvider>();

  for (const manual of detect.manualProviders) {
    if (NEEDS_MORE_THAN_A_KEY.has(manual.id)) continue;
    const id = manual.brandId ?? manual.id;
    const provider = providers.get(id) ?? newProvider(id, manual.groupLabel ?? manual.label, manual.website ?? null, null);
    provider.methods.push(toMethod(manual));
    providers.set(id, provider);
  }

  for (const plugin of plugins) {
    const pluginId = providerPluginId(plugin);
    if (!pluginId || plugin.installed || providers.has(pluginId)) continue;
    providers.set(pluginId, newProvider(pluginId, cleanPluginName(plugin.name ?? pluginId), null, pluginId));
  }

  const signIn: AiSignInOption[] = (detect.authOptions ?? []).map((o) => ({
    id: o.id,
    providerId: o.brandId ?? o.id,
    label: o.label,
    hint: o.hint ?? null,
    kind: o.kind,
  }));

  // Brands reachable only by subscription sign-in (e.g. GitHub Copilot) still get a card.
  for (const option of detect.authOptions ?? []) {
    const id = option.brandId ?? option.id;
    if (!providers.has(id)) providers.set(id, newProvider(id, option.groupLabel ?? option.label, option.website ?? null, null));
  }

  return {
    agentId,
    configuredModel: detect.configuredModel ?? null,
    connected: detect.setupComplete,
    providers: [...providers.values()].sort(byPopularity),
    signIn,
  };
}

function newProvider(id: string, label: string, website: string | null, installPluginId: string | null): AiProvider {
  return { id, label, website: KEY_PAGES[id] ?? website ?? null, popular: POPULAR.includes(id), installPluginId, methods: [] };
}

function toMethod(manual: DetectResult["manualProviders"][number]): AiConnectMethod {
  const isToken = /token/i.test(manual.id);
  return { authChoice: manual.id, label: manual.label, hint: manual.hint ?? null, input: isToken ? "token" : "api_key" };
}

function cleanPluginName(name: string): string {
  return name.replace(/^OpenClaw\s+/i, "").replace(/\s+Provider$/i, "").trim();
}

function byPopularity(a: AiProvider, b: AiProvider): number {
  const ia = POPULAR.indexOf(a.id);
  const ib = POPULAR.indexOf(b.id);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  return a.label.localeCompare(b.label);
}
