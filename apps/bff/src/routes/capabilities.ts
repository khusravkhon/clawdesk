import type { FastifyInstance } from "fastify";
import { CapabilitiesService } from "../system/capabilities-service.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { SpaceService } from "../space/space-service.js";
import type { TelegramService } from "../telegram/telegram-service.js";

// P0: what this installation can do now (see CapabilitiesService).
export function registerCapabilityRoutes(app: FastifyInstance, deps: { gateway: GatewayService; bridge: BridgeClient; telegram: TelegramService; space: SpaceService; sandboxEnabled: boolean }): void {
  const service = new CapabilitiesService({ gateway: deps.gateway, bridge: deps.bridge, telegramOwner: () => deps.telegram.ownerUserId(), sandboxEnabled: deps.sandboxEnabled, companyMode: () => deps.space.mode() === "company" });
  app.get("/api/system/capabilities", () => service.check());
}
