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
    const generation = gateway.generation;
    try {
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
      // OpenClaw 2026.8.35+: the patch is saved and applied, and the Gateway restarts itself to recover; the
      // write succeeded once it is back and its config holds the patched values.
      if (isRecoveryRestart(error)) {
        await gateway.waitForReconnect(generation);
        const after = await gateway.request<ConfigGetResult>("config.get", {});
        if (after.hash && after.hash === current.hash) throw error;
        return resolved;
      }
      throw error;
    }
  }
}

export async function getConfig<T = Record<string, unknown>>(gateway: GatewayService): Promise<{ hash: string | undefined; config: T }> {
  const result = await gateway.request<ConfigGetResult>("config.get", {});
  return { hash: result.hash, config: (result.config ?? {}) as T };
}

/** "config.patch persisted and updated the active Gateway, but a recovery restart is required". */
export function isRecoveryRestart(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("recovery restart is required") || message.includes("persisted and updated the active gateway");
}

function isStaleHash(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("config changed since last load")) return true;
  return message.includes("hash") && (message.includes("stale") || message.includes("mismatch") || message.includes("changed"));
}
