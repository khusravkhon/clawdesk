import type { ApiErrorDto, ChromePairingDto, ChromeStatusDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { BridgeError, type BridgeClient } from "../gateway/bridge-client.js";
import { panelOrigin } from "./sources.js";

/** Agents work in the person's own Chrome through the OpenClaw extension; it connects to the panel's address (extension-relay.ts). */
export function registerChromeRoutes(app: FastifyInstance, deps: { bridge: BridgeClient }): void {
  app.get("/api/chrome", async (): Promise<ChromeStatusDto> => {
    try {
      const status = await deps.bridge.chromeStatus();
      return { available: status.enabled, connected: status.connected };
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      return { available: false, connected: false };
    }
  });

  app.post("/api/chrome/pairing", async (request, reply): Promise<ChromePairingDto | ApiErrorDto> => {
    try {
      // http(s)://host → ws(s)://host: the extension opens a WebSocket to the address the panel is opened on.
      return await deps.bridge.chromePair(panelOrigin(request).replace(/^http/, "ws"));
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      reply.status(503);
      return { error: "chrome_unavailable", message: "chrome_unavailable" };
    }
  });
}
