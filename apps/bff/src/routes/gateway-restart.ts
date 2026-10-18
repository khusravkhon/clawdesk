import { GatewayClientRequestError } from "@openclaw/gateway-client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GatewayService } from "../gateway/gateway-service.js";

const RestartRequest = z.object({ confirm: z.literal(true) }).strict();

export function registerGatewayRestartRoutes(app: FastifyInstance, deps: { gateway: Pick<GatewayService, "status" | "generation" | "request" | "waitForReconnect"> }): void {
  let restarting = false;
  app.post("/api/system/gateway/restart", async (request, reply) => {
    RestartRequest.parse(request.body);
    if (restarting) return reply.status(409).send({ error: "gateway_restart_busy", message: "Gateway restart is already in progress" });
    const gateway = deps.gateway;
    if (gateway.status.state !== "connected") return reply.status(409).send({ error: "gateway_unavailable", message: "Gateway is not connected" });
    restarting = true;
    const generation = gateway.generation;
    try {
      try {
        await gateway.request("gateway.restart.request", { reason: "clawdesk: owner requested restart" }, { timeoutMs: 10_000 });
      } catch (error) {
        if (error instanceof GatewayClientRequestError && error.gatewayCode !== "UNAVAILABLE") {
          return reply.status(502).send({ error: "gateway_restart_rejected", message: "Gateway rejected the restart request" });
        }
        // A restart can close the socket before acknowledging the request. Never resend it automatically.
        request.log.info("Gateway restart request was not acknowledged; waiting for reconnection");
      }
      try {
        await gateway.waitForReconnect(generation, 90_000);
        if (gateway.status.state !== "connected") throw new Error("Gateway disconnected again");
      } catch {
        return reply.status(504).send({ error: "gateway_restart_unconfirmed", message: "Gateway reconnection was not confirmed" });
      }
      return { restarted: true };
    } finally {
      restarting = false;
    }
  });
}
