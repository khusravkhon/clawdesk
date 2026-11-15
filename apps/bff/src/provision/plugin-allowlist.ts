import { patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";

// OpenClaw loads any plugin it discovers while plugins.allow is not set, and its security audit warns about
// that (plugins.extensions_no_allowlist). The panel keeps the list: the plugins installed now, and later every
// plugin the panel installs. plugins.allow is only a gate — a listed plugin that is disabled stays disabled.

type ListedPlugin = { id: string; origin?: string; installed: boolean };
type PluginsConfig = { plugins?: { allow?: string[] } };

/**
 * No list yet: everything installed now (what this install already trusts). A list already set (by the panel or
 * the owner) only gains the bundled plugins a newer OpenClaw ships, so an update does not silently lose them.
 * Only installed ids: a listed id without a plugin is an audit warning of its own.
 */
export function pluginAllowPatch(config: PluginsConfig, plugins: ListedPlugin[]): { plugins: { allow: string[] } } | null {
  const installed = plugins.filter((plugin) => plugin.installed);
  const current = config.plugins?.allow;
  const wanted = current ? installed.filter((plugin) => plugin.origin === "bundled") : installed;
  const missing = [...new Set(wanted.map((plugin) => plugin.id))].filter((id) => !current?.includes(id)).sort();
  return missing.length ? { plugins: { allow: [...(current ?? []), ...missing] } } : null;
}

/** A plugin the panel just installed: on the list, if there is a list. */
export function allowPluginPatch(config: PluginsConfig, pluginId: string): { plugins: { allow: string[] } } | null {
  const current = config.plugins?.allow;
  return current && !current.includes(pluginId) ? { plugins: { allow: [...current, pluginId] } } : null;
}

export async function repairPluginAllowlist(deps: { gateway: GatewayService }): Promise<void> {
  const { plugins } = await deps.gateway.request<{ plugins: ListedPlugin[] }>("plugins.list", {});
  await patchConfig(deps.gateway, (config) => pluginAllowPatch(config as PluginsConfig, plugins), { replacePaths: ["plugins.allow"], note: "clawdesk: trusted plugins only" });
}

export async function allowInstalledPlugin(gateway: GatewayService, pluginId: string): Promise<void> {
  await patchConfig(gateway, (config) => allowPluginPatch(config as PluginsConfig, pluginId), { replacePaths: ["plugins.allow"], note: `clawdesk: trust installed plugin ${pluginId}` });
}
