import Fastify from "fastify";
import { GatewayClientRequestError } from "@openclaw/gateway-client";
import type { GatewayStatusDto } from "@clawdesk/shared";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { AuthService } from "../src/auth/auth-service.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerGatewayRestartRoutes } from "../src/routes/gateway-restart.js";

function fixture() {
  const gateway = {
    status: { state: "connected", serverVersion: null, protocol: null, scopes: [], hint: null, lastError: null } as GatewayStatusDto,
    generation: 1,
    request: vi.fn(async () => ({})),
    waitForReconnect: vi.fn(async () => { gateway.generation++; }),
  };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.status(error instanceof ZodError ? 400 : 500).send({ error: "invalid_request" }));
  registerAuthRoutes(app, { auth: { check: (token: string) => token === "owner" ? {} : null } as unknown as AuthService });
  registerGatewayRestartRoutes(app, { gateway: gateway as unknown as GatewayService });
  const send = (payload: Record<string, unknown> = { confirm: true }, headers = { cookie: "clawdesk_session=owner" }) => app.inject({ method: "POST", url: "/api/system/gateway/restart", headers, payload });
  return { app, gateway, send };
}

describe("owner Gateway restart", () => {
  it("requires owner authentication, same origin and explicit confirmation", async () => {
    const { app, gateway, send } = fixture();
    try {
      expect((await send({ confirm: true }, { cookie: "" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/system/gateway/restart", headers: { cookie: "clawdesk_session=owner", origin: "https://another.example" }, payload: { confirm: true } })).statusCode).toBe(403);
      expect((await send({})).statusCode).toBe(400);
      expect((await send({ confirm: true, command: "arbitrary" })).statusCode).toBe(400);
      expect(gateway.request).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("sends one fixed RPC and confirms a new connection", async () => {
    const { app, gateway, send } = fixture();
    try {
      const result = await send();
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ restarted: true });
      expect(gateway.request).toHaveBeenCalledExactlyOnceWith("gateway.restart.request", { reason: "clawdesk: owner requested restart" }, { timeoutMs: 10_000 });
      expect(gateway.waitForReconnect).toHaveBeenCalledExactlyOnceWith(1, 90_000);
    } finally { await app.close(); }
  });

  it("allows a lost acknowledgement only when reconnection is confirmed", async () => {
    const { app, gateway, send } = fixture();
    try {
      gateway.request.mockRejectedValueOnce(new Error("socket closed"));
      expect((await send()).statusCode).toBe(200);
      gateway.request.mockRejectedValueOnce(new Error("socket closed"));
      gateway.waitForReconnect.mockRejectedValueOnce(new Error("timeout"));
      const result = await send();
      expect(result.statusCode).toBe(504);
      expect(result.json().error).toBe("gateway_restart_unconfirmed");
      expect(gateway.request).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });

  it("does not claim success if the connection drops again", async () => {
    const { app, gateway, send } = fixture();
    try {
      gateway.waitForReconnect.mockImplementationOnce(async () => { gateway.generation++; gateway.status.state = "disconnected"; });
      expect((await send()).statusCode).toBe(504);
    } finally { await app.close(); }
  });

  it("does not send commands to an offline Gateway or retry a rejection", async () => {
    const { app, gateway, send } = fixture();
    try {
      gateway.status.state = "disconnected";
      expect((await send()).statusCode).toBe(409);
      expect(gateway.request).not.toHaveBeenCalled();
      gateway.status.state = "connected";
      gateway.request.mockRejectedValueOnce(new GatewayClientRequestError({ code: "INVALID_REQUEST", message: "denied" }));
      expect((await send()).json().error).toBe("gateway_restart_rejected");
      expect(gateway.waitForReconnect).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("blocks overlapping restarts and unlocks after completion", async () => {
    const { app, gateway, send } = fixture();
    let finish!: () => void;
    const requested = new Promise<void>((resolve) => {
      gateway.waitForReconnect.mockImplementationOnce(() => { resolve(); return new Promise<void>((done) => { finish = done; }); });
    });
    try {
      const first = send();
      void first.then(() => undefined);
      await requested;
      expect((await send()).json().error).toBe("gateway_restart_busy");
      expect(gateway.request).toHaveBeenCalledTimes(1);
      gateway.generation++;
      finish();
      expect((await first).statusCode).toBe(200);
      expect((await send()).statusCode).toBe(200);
    } finally { finish?.(); await app.close(); }
  });
});
