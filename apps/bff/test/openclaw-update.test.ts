import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { AuthService } from "../src/auth/auth-service.js";
import { BridgeError } from "../src/gateway/bridge-client.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerOpenClawUpdateRoutes } from "../src/routes/openclaw-update.js";

function fixture({ available = true } = {}) {
  const bridge = {
    openclawUpdate: vi.fn(async () => ({ running: "2026.8.35", supported: ["2026.8.35", "2026.11.2"], offer: { version: "2026.11.2", newLine: true }, status: null })),
    startOpenclawUpdate: vi.fn(async (version: string) => ({ started: true as const, version })),
  };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.status(error instanceof ZodError ? 400 : 500).send({ error: "invalid_request" }));
  registerAuthRoutes(app, { auth: { check: (token: string) => (token === "owner" ? {} : null) } as unknown as AuthService });
  registerOpenClawUpdateRoutes(app, { bridge, backups: { available } });
  const headers = { cookie: "clawdesk_session=owner" };
  const get = () => app.inject({ method: "GET", url: "/api/system/openclaw", headers });
  const start = (payload: Record<string, unknown>, h: Record<string, string> = headers) => app.inject({ method: "POST", url: "/api/system/openclaw/update", headers: h, payload });
  return { app, bridge, get, start };
}

describe("OpenClaw update from the panel", () => {
  it("shows the running version and the verified offer", async () => {
    const { app, get } = fixture();
    try {
      const res = await get();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ available: true, running: "2026.8.35", offer: { version: "2026.11.2", newLine: true }, status: null });
    } finally { await app.close(); }
  });

  it("starts only for the owner, with confirmation and a version", async () => {
    const { app, bridge, start } = fixture();
    try {
      expect((await start({ version: "2026.11.2", confirm: true }, { cookie: "" })).statusCode).toBe(401);
      expect((await start({ version: "2026.11.2" })).statusCode).toBe(400);
      expect((await start({ version: "latest", confirm: true })).statusCode).toBe(400);
      expect((await start({ version: "2026.11.2", confirm: true, image: "evil" })).statusCode).toBe(400);
      expect(bridge.startOpenclawUpdate).not.toHaveBeenCalled();
      const res = await start({ version: "2026.11.2", confirm: true });
      expect(res.statusCode).toBe(200);
      expect(bridge.startOpenclawUpdate).toHaveBeenCalledExactlyOnceWith("2026.11.2");
    } finally { await app.close(); }
  });

  it("passes the bridge's refusals on; outside the installed panel there is nothing to update", async () => {
    const { app, bridge, start, get } = fixture();
    try {
      bridge.startOpenclawUpdate.mockRejectedValueOnce(new BridgeError("not_verified", "OpenClaw 2026.12.1 is not verified"));
      expect((await start({ version: "2026.12.1", confirm: true })).statusCode).toBe(409);
      bridge.openclawUpdate.mockRejectedValueOnce(new BridgeError("bridge_unavailable", "restarting"));
      expect((await get()).statusCode).toBe(503);
    } finally { await app.close(); }
    const dev = fixture({ available: false });
    try {
      expect((await dev.get()).json()).toEqual({ available: false, running: null, offer: null, status: null });
      expect((await dev.start({ version: "2026.11.2", confirm: true })).statusCode).toBe(409);
      expect(dev.bridge.openclawUpdate).not.toHaveBeenCalled();
    } finally { await dev.app.close(); }
  });
});
