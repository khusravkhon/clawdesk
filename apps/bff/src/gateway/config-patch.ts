import type { GatewayService } from "./gateway-service.js";

type ConfigGetResult = { hash?: string; config?: unknown };
type ConfigPatch = Record<string, unknown>;
export type ConfigPatchResolver = (config: unknown) => ConfigPatch | null;
const queues = new WeakMap<GatewayService, Promise<void>>();

export type PatchConfigOptions = {
  /** Array paths the patch intentionally replaces; a resolver is re-run for each current snapshot. */
  replacePaths?: string[] | ((config: unknown, patch: ConfigPatch) => string[]);
  note?: string;
};

/**
 * Applies a JSON merge patch to the OpenClaw config (objects merge, null
 * deletes). Uses the current hash as baseHash and retries once if another
 * writer got in between. Per-Gateway serialization includes snapshot resolution.
 */
export async function patchConfig(gateway: GatewayService, patch: ConfigPatch | ConfigPatchResolver, opts: PatchConfigOptions = {}): Promise<ConfigPatch | null> {
  const action = (queues.get(gateway) ?? Promise.resolve()).then(() => applyPatch(gateway, patch, opts));
  const settled = action.then(() => {}, () => {});
  queues.set(gateway, settled);
  try { return await action; } finally {
    if (queues.get(gateway) === settled) queues.delete(gateway);
  }
}

async function applyPatch(gateway: GatewayService, patch: ConfigPatch | ConfigPatchResolver, opts: PatchConfigOptions): Promise<ConfigPatch | null> {
  for (let attempt = 0; ; attempt++) {
    const current = await gateway.request<ConfigGetResult>("config.get", {});
    const resolved = typeof patch === "function" ? patch(current.config ?? {}) : patch;
    if (resolved === null) return null;
    const replacePaths = typeof opts.replacePaths === "function" ? opts.replacePaths(current.config, resolved) : opts.replacePaths;
    try {
      const generation = gateway.generation;
      const result = await gateway.request<{ sentinel?: { payload?: { stats?: { requiresRestart?: boolean } } } }>("config.patch", {
        raw: JSON.stringify(resolved),
        ...(current.hash ? { baseHash: current.hash } : {}),
        ...(replacePaths?.length ? { replacePaths } : {}),
        ...(opts.note ? { note: opts.note } : {}),
      });
      if (result.sentinel?.payload?.stats?.requiresRestart === true) await gateway.waitForReconnect(generation);
      return resolved;
    } catch (error) {
      if (attempt === 0 && isStaleHash(error)) continue;
      throw error;
    }
  }
}

export async function getConfig<T = Record<string, unknown>>(gateway: GatewayService): Promise<{ hash: string | undefined; config: T }> {
  const result = await gateway.request<ConfigGetResult>("config.get", {});
  return { hash: result.hash, config: (result.config ?? {}) as T };
}

function isStaleHash(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("config changed since last load")) return true;
  return message.includes("hash") && (message.includes("stale") || message.includes("mismatch") || message.includes("changed"));
}
