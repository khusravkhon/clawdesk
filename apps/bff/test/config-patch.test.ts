import { describe, expect, it } from "vitest";
import { patchConfig } from "../src/gateway/config-patch.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

describe("serialized config mutations", () => {
  it("resolves concurrent additions from fresh snapshots and keeps both IDs", async () => {
    let ids = ["main"];
    const order: string[] = [];
    const gateway = { request: async (method: string, params: { raw?: string }) => {
      order.push(method);
      if (method === "config.get") return { hash: String(ids.length), config: { ids: [...ids] } };
      ids = JSON.parse(params.raw!).ids;
      return {};
    } } as unknown as GatewayService;
    await Promise.all(["trainer", "dietitian"].map((id) => patchConfig(gateway, (snapshot) => ({ ids: [...(snapshot as { ids: string[] }).ids, id] }))));
    expect(ids).toEqual(["main", "trainer", "dietitian"]);
    expect(order).toEqual(["config.get", "config.patch", "config.get", "config.patch"]);
  });

  it("recomputes a removal and replacePaths after a stale hash", async () => {
    let reads = 0, writes = 0;
    const gateway = { request: async (method: string, params: { raw?: string; replacePaths?: string[] }) => {
      if (method === "config.get") return { hash: String(++reads), config: { ids: reads === 1 ? ["gone", "main"] : ["gone", "main", "new"] } };
      if (++writes === 1) throw new Error("config changed since last load");
      expect(JSON.parse(params.raw!).ids).toEqual(["main", "new"]);
      expect(params.replacePaths).toEqual(["ids"]);
      return {};
    } } as unknown as GatewayService;
    await patchConfig(gateway, (snapshot) => ({ ids: (snapshot as { ids: string[] }).ids.filter((id) => id !== "gone") }), {
      replacePaths: (_snapshot, patch) => Object.keys(patch),
    });
    expect([reads, writes]).toEqual([2, 2]);
  });

  it("does not write on no-op and does not retry validation errors or poison the queue", async () => {
    let writes = 0;
    const gateway = { request: async (method: string) => {
      if (method === "config.get") return { config: {} };
      if (++writes === 1) throw new Error("invalid config");
      return {};
    } } as unknown as GatewayService;
    expect(await patchConfig(gateway, () => null)).toBeNull();
    await expect(patchConfig(gateway, { enabled: true })).rejects.toThrow("invalid config");
    expect(writes).toBe(1);
    await patchConfig(gateway, { enabled: false });
    expect(writes).toBe(2);
  });

  it("keeps separate gateways independent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = { request: async (method: string) => { if (method === "config.get") { await gate; return { config: {} }; } return {}; } } as unknown as GatewayService;
    const fast = { request: async () => ({ config: {} }) } as unknown as GatewayService;
    const waiting = patchConfig(slow, { one: true });
    try { expect(await patchConfig(fast, { two: true })).toEqual({ two: true }); }
    finally { release(); await waiting; }
  });

  it("waits for an acknowledged scheduled restart before the next queued snapshot", async () => {
    const order: string[] = [];
    let writes = 0;
    const gateway = { generation: 7, request: async (method: string) => {
      order.push(method);
      if (method === "config.get") return { config: {} };
      return ++writes === 1 ? { sentinel: { payload: { stats: { requiresRestart: true } } } } : {};
    }, waitForReconnect: async (generation: number) => { expect(generation).toBe(7); order.push("reconnected"); } } as unknown as GatewayService;
    await Promise.all([patchConfig(gateway, { first: true }), patchConfig(gateway, { second: true })]);
    expect(order).toEqual(["config.get", "config.patch", "reconnected", "config.get", "config.patch"]);
  });
});
