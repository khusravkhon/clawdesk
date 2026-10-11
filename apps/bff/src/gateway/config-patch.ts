import type { GatewayService } from "./gateway-service.js";

type ConfigGetResult = { hash?: string; config?: unknown };

export type PatchConfigOptions = {
  /** Array paths the patch intentionally replaces (e.g. "agents.entries.*.skills"). */
  replacePaths?: string[];
  note?: string;
};

/**
 * Applies a JSON merge patch to the OpenClaw config (objects merge, null
 * deletes). Uses the current hash as baseHash and retries once if another
 * writer got in between.
 */
export async function patchConfig(gateway: GatewayService, patch: Record<string, unknown>, opts: PatchConfigOptions = {}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const current = await gateway.request<ConfigGetResult>("config.get", {});
    try {
      await gateway.request("config.patch", {
        raw: JSON.stringify(patch),
        ...(current.hash ? { baseHash: current.hash } : {}),
        ...(opts.replacePaths?.length ? { replacePaths: opts.replacePaths } : {}),
        ...(opts.note ? { note: opts.note } : {}),
      });
      return;
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
  return message.includes("hash") && (message.includes("stale") || message.includes("mismatch") || message.includes("changed"));
}
