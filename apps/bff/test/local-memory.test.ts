import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAssistantRoutes } from "../src/routes/assistant.js";
import type { AssistantService } from "../src/assistant/assistant-service.js";
import { BridgeError, type BridgeClient } from "../src/gateway/bridge-client.js";
import type { SpaceService } from "../src/space/space-service.js";

describe("local memory endpoints", () => {
  const status = { job: { state: "idle", percent: null, error: null, updatedAt: null }, checkedAt: null, agents: [], error: null };
  it("requires download consent and forwards the fixed operation to the bridge", async () => {
    const calls: unknown[] = [];
    const bridge = { localMemoryAction: async (...args: unknown[]) => { calls.push(args); return status; } } as unknown as BridgeClient;
    const app = Fastify();
    registerAssistantRoutes(app, { bridge, assistant: {} as AssistantService });
    try {
      expect((await app.inject({ method: "POST", url: "/api/assistant/local-memory", payload: { action: "setup" } })).statusCode).toBe(400);
      expect(calls).toHaveLength(0);
      expect((await app.inject({ method: "POST", url: "/api/assistant/local-memory", payload: { action: "setup", consent: true } })).json()).toEqual(status);
      expect(calls).toEqual([["setup", true]]);
    } finally { await app.close(); }
  });

  it.each(["personal", "company"] as const)("supports status, setup, reindex and agent search in %s mode", async (mode) => {
    const calls: unknown[] = [];
    const search = { stale: false, results: [{ path: "memory/project.md", snippet: "project fact" }] };
    const bridge = {
      localMemoryStatus: async () => status,
      localMemoryAction: async (...args: unknown[]) => { calls.push(args); return status; },
      localMemorySearch: async (...args: unknown[]) => { calls.push(args); return search; },
    } as unknown as BridgeClient;
    const app = Fastify();
    registerAssistantRoutes(app, { assistant: {} as AssistantService, bridge, space: { mode: () => mode } as SpaceService });
    try {
      expect((await app.inject({ url: "/api/assistant/local-memory" })).json()).toEqual(status);
      expect((await app.inject({ method: "POST", url: "/api/assistant/local-memory", payload: { action: "setup" } })).statusCode).toBe(400);
      expect(calls).toEqual([]);
      for (const action of ["setup", "check", "reindex"]) {
        expect((await app.inject({ method: "POST", url: "/api/assistant/local-memory", payload: { action, consent: true } })).json()).toEqual(status);
      }
      expect((await app.inject({ method: "POST", url: "/api/assistant/local-memory/search", payload: { agentId: "developer", query: "project" } })).json()).toEqual(search);
      expect(calls).toEqual([["setup", true], ["check", true], ["reindex", true], ["developer", "project"]]);
    } finally { await app.close(); }
  });

  it("strips extra diagnostic fields and does not expose bridge error messages", async () => {
    const bridge = {
      localMemoryStatus: async () => ({ ...status, secret: "PRIVATE" }),
      localMemorySearch: async () => { throw new BridgeError("bridge_unavailable", "PRIVATE upstream log"); },
    } as unknown as BridgeClient;
    const app = Fastify();
    registerAssistantRoutes(app, { bridge, assistant: {} as AssistantService });
    try {
      expect((await app.inject({ url: "/api/assistant/local-memory" })).body).not.toContain("PRIVATE");
      const res = await app.inject({ method: "POST", url: "/api/assistant/local-memory/search", payload: { agentId: "main", query: "note" } });
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain("PRIVATE");
    } finally { await app.close(); }
  });
});
