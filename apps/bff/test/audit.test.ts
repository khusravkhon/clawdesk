import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "../src/audit/audit-service.js";
import { AuthService } from "../src/auth/auth-service.js";
import { openDb } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { registerAuthRoutes } from "../src/routes/auth.js";

describe("action log", () => {
  let dir: string;
  let close: () => void;
  let db: ReturnType<typeof openDb>["db"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-audit-"));
    ({ db, close } = openDb(path.join(dir, "panel.sqlite")));
  });
  afterEach(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records changes and sign-ins with their outcome, never request bodies or plain reads", async () => {
    const gateway = {
      request: async () => ({
        events: [
          { eventId: "e2", occurredAt: 2, agentId: "main", action: "tool.action.finished", status: "failed", toolName: "exec", errorCode: "denied" },
          { eventId: "e1", occurredAt: 1, agentId: "main", action: "agent.run.started", status: "started" },
        ],
        nextCursor: "1",
      }),
    } as unknown as GatewayService;
    const audit = new AuditService({ db, gateway, logger: pino({ level: "silent" }) });
    const auth = new AuthService({ db, dataDir: dir, logger: pino({ level: "silent" }) });
    const { token } = await auth.setOwnerPassword(auth.ownerCodeForFirstRun()!, "owner password 1", "ip", "ua");
    const cookie = `clawdesk_session=${token}`;
    const app = Fastify();
    audit.attach(app);
    registerAuthRoutes(app, { auth });
    app.post("/api/agents", async () => ({ ok: true }));
    app.delete("/api/agents/:agentId", async (_req, reply) => reply.status(502).send({ error: "x" }));
    app.get("/api/agents", async () => ({ agents: [] }));
    await app.ready();

    await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong password" } });
    await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload: { token: "ntn_SECRETSECRETSECRETSECRET" } });
    await app.inject({ method: "DELETE", url: "/api/agents/dietitian", headers: { cookie } });
    await app.inject({ method: "GET", url: "/api/agents", headers: { cookie } });
    await app.inject({ method: "POST", url: "/api/agents" }); // no session: the guard's 401 is not an action

    const page = await audit.page({});
    expect(page.panel.map((e) => [e.actor, e.action, e.target, e.result, e.detail])).toEqual([
      ["owner", "agent.delete", "dietitian", "error", "502"],
      ["owner", "agent.create", null, "ok", null],
      ["anonymous", "auth.login", null, "error", "401"],
    ]);
    expect(JSON.stringify(page)).not.toContain("SECRET");
    // Agents' log: outcomes only.
    expect(page.agents).toEqual([{ id: "e2", at: 2, agentId: "main", action: "tool.action.finished", status: "failed", toolName: "exec", errorCode: "denied" }]);
    expect(page.nextAgents).toBe("1");
    await app.close();
  });

  it("stores only allowlisted failure codes and generated request IDs, never response bodies", async () => {
    const gateway = { request: async () => ({ events: [] }) } as unknown as GatewayService;
    const audit = new AuditService({ db, gateway, logger: pino({ level: "silent" }) });
    const app = Fastify();
    audit.attach(app);
    app.post("/api/known", async (_req, reply) => reply.status(504).send({ error: "gateway_timeout", message: "SECRET upstream token", details: { apiKey: "SECRET key" } }));
    app.post("/api/unknown", async (_req, reply) => reply.status(500).send({ error: "SECRET arbitrary code", message: "SECRET body" }));
    try {
      await app.inject({ method: "POST", url: "/api/known", payload: { password: "SECRET password" } });
      await app.inject({ method: "POST", url: "/api/unknown" });
      const page = await audit.page({});
      expect(page.panel.map((row) => [row.detail, row.diagnostics?.code])).toEqual([["500", "http_error"], ["504", "gateway_timeout"]]);
      expect(page.panel.every((row) => /^req-/.test(row.diagnostics?.requestId ?? ""))).toBe(true);
      expect(JSON.stringify(page)).not.toContain("SECRET");
      expect(JSON.stringify(db.select().from(auditEvents).all())).not.toContain("SECRET");
    } finally { await app.close(); }
  });

  it("keeps old HTTP-only rows readable and rejects damaged structured details", async () => {
    const gateway = { request: async () => ({ events: [] }) } as unknown as GatewayService;
    const audit = new AuditService({ db, gateway, logger: pino({ level: "silent" }) });
    for (const detail of ["502", '{"version":1,"status":"500","code":"SECRET","requestId":"req-1"}', "{broken SECRET"]) {
      audit.record({ actor: "owner", action: "agent.create", target: null, result: "error", detail });
    }
    const page = await audit.page({});
    expect(page.panel.map((row) => row.detail)).toEqual([null, null, "502"]);
    expect(page.panel.every((row) => row.diagnostics === undefined)).toBe(true);
    expect(JSON.stringify(page)).not.toContain("SECRET");
  });

  it("records OAuth denial and errors despite their successful HTTP redirect", async () => {
    const gateway = { request: async () => ({ events: [] }) } as unknown as GatewayService;
    const audit = new AuditService({ db, gateway, logger: pino({ level: "silent" }) });
    const app = Fastify();
    audit.attach(app);
    app.get("/api/sources/notion/callback", async () => { throw new Error("not used"); });
    app.get("/api/sources/google/callback", async (_req, reply) => reply.redirect("/sources?google=error&reason=SECRET"));
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.startsWith("/api/sources/notion/callback")) return reply.redirect("/sources?notion=denied");
    });
    try {
      await app.inject({ method: "GET", url: "/api/sources/notion/callback?code=SECRET" });
      await app.inject({ method: "GET", url: "/api/sources/google/callback" });
      const page = await audit.page({});
      expect(page.panel.map((row) => [row.result, row.detail, row.diagnostics?.code])).toEqual([
        ["error", "302", "oauth_error"], ["error", "302", "oauth_denied"],
      ]);
      expect(JSON.stringify(db.select().from(auditEvents).all())).not.toContain("SECRET");
    } finally { await app.close(); }
  });
});
