import type { FastifyInstance } from "fastify";
import type { HealthDto } from "@clawdesk/shared";
import type { GatewayService } from "../gateway/gateway-service.js";
import { PANEL_VERSION } from "../version.js";

export function registerHealthRoutes(app: FastifyInstance, deps: { gateway: GatewayService }): void {
  // Liveness of the panel itself; gateway state is reported, not required.
  app.get("/api/health", async (): Promise<HealthDto> => {
    const gateway = deps.gateway.status;
    return { ok: true, version: PANEL_VERSION, gateway };
  });
}
