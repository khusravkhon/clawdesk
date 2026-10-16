import { describe, expect, it } from "vitest";
import { patchConfig } from "../src/gateway/config-patch.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { telegramReplacePaths } from "../src/telegram/config-replace-paths.js";

describe("Telegram array replacement intent", () => {
  it("includes exact nested deletions, explicit replacements and empty arrays, but not untouched arrays", () => {
    const current = { channels: { telegram: {
      allowFrom: [], groupAllowFrom: ["owner"],
      execApprovals: { approvers: ["owner"] },
      groups: { "-100": { topics: { "7": { skills: ["memory"] } } } },
    }, other: { allowFrom: ["untouched"] } } };
    const patch = { channels: { telegram: {
      allowFrom: null, groupAllowFrom: ["new-owner"], execApprovals: null, groups: { "-100": null },
    } } };
    expect(telegramReplacePaths(current, patch)).toEqual([
      "channels.telegram.allowFrom", "channels.telegram.groupAllowFrom",
      "channels.telegram.execApprovals.approvers", "channels.telegram.groups.-100.topics.7.skills",
    ]);
    expect(telegramReplacePaths(current, { channels: { telegram: { enabled: false } } })).toEqual([]);
  });

  it("keeps replacement intent for bindings and media models", () => {
    expect(telegramReplacePaths({}, { bindings: [], tools: { media: { models: [] } } })).toEqual(["bindings", "tools.media.models"]);
  });

  it("recomputes exact deleted arrays after a native stale-config response", async () => {
    const writes: Record<string, any>[] = [];
    let reads = 0;
    const gateway = { request: async (method: string, params: Record<string, any>) => {
      if (method === "config.get") return { hash: `h${++reads}`, config: { channels: { telegram: { execApprovals: reads === 1 ? {} : { approvers: ["owner"] } } } } };
      writes.push(params);
      if (writes.length === 1) throw new Error("config changed since last load; re-run config.get and retry");
      return { ok: true };
    } } as unknown as GatewayService;
    const patch = { channels: { telegram: { execApprovals: null } } };
    await patchConfig(gateway, patch, { replacePaths: (current) => telegramReplacePaths(current, patch) });
    expect(reads).toBe(2);
    expect(writes[0]!.replacePaths).toBeUndefined();
    expect(writes[1]).toMatchObject({ baseHash: "h2", replacePaths: ["channels.telegram.execApprovals.approvers"] });
  });

  it("does not retry validation failures or silently confirm removals for unrelated callers", async () => {
    const writes: Record<string, any>[] = [];
    const gateway = { request: async (method: string, params: Record<string, any>) => {
      if (method === "config.get") return { hash: "h", config: {} };
      writes.push(params);
      throw new Error("config.patch would remove entries from array path(s): channels.other.allowFrom");
    } } as unknown as GatewayService;
    await expect(patchConfig(gateway, { channels: { other: null } })).rejects.toThrow(/would remove entries/);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.replacePaths).toBeUndefined();
  });
});
