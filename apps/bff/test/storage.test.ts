import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerStorageRoutes } from "../src/routes/storage.js";
import { BridgeError, type BridgeClient } from "../src/gateway/bridge-client.js";
import type { SpaceService } from "../src/space/space-service.js";

const usage = { available: true, bytes: 8, files: 1, retainedFiles: 0, retainedNames: [] };
const status = { videos: usage, history: usage, videoQuotaBytes: null, reservedBytes: 0, activeDownloads: 0, freeBytes: 1024 };
function appFor(bridge: Partial<BridgeClient>, mode = "personal") {
  const app = Fastify();
  registerStorageRoutes(app, { bridge: bridge as BridgeClient, space: { mode: () => mode } as SpaceService });
  return app;
}
describe("personal storage endpoints", () => {
  it("is unavailable in company mode and does not reach the bridge", async () => {
    const app = appFor({ storageStatus: async () => { throw new Error("must not call"); } }, "company");
    try {
      expect((await app.inject({ url: "/api/system/storage" })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/system/storage/quota", payload: { videoQuotaBytes: null } })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it("requires a bounded valid quota and explicit confirmation of a preview token", async () => {
    const calls: unknown[] = [];
    const app = appFor({ storageQuota: async (bytes) => { calls.push(bytes); return status; }, storageCleanup: async (token) => { calls.push(token); return { deleted: 1, bytes: 8, skipped: 0, retainedCount: 0, retained: [] }; } });
    try {
      expect((await app.inject({ method: "POST", url: "/api/system/storage/quota", payload: { videoQuotaBytes: -1 } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/system/storage/cleanup", payload: { token: "10000000-0000-4000-8000-000000000001" } })).statusCode).toBe(400);
      expect(calls).toEqual([]);
      expect((await app.inject({ method: "POST", url: "/api/system/storage/quota", payload: { videoQuotaBytes: 1024 ** 2 } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/system/storage/cleanup", payload: { token: "10000000-0000-4000-8000-000000000001", confirm: true, path: "/private" } })).statusCode).toBe(200);
      expect(calls).toEqual([1024 ** 2, "10000000-0000-4000-8000-000000000001"]);
    } finally { await app.close(); }
  });
  it("strips unrelated diagnostics and never returns bridge error text", async () => {
    const app = appFor({ storageStatus: async () => ({ ...status, private: "PRIVATE" }), storagePreview: async () => { throw new BridgeError("bridge_unavailable", "PRIVATE filesystem details"); } });
    try {
      expect((await app.inject({ url: "/api/system/storage" })).body).not.toContain("PRIVATE");
      const response = await app.inject({ method: "POST", url: "/api/system/storage/preview", payload: { category: "videos" } });
      expect(response.statusCode).toBe(503); expect(response.body).not.toContain("PRIVATE");
      expect(response.json().error).toBe("storage_unavailable");
    } finally { await app.close(); }
  });
});
