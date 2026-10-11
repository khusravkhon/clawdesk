import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { loadOrCreateDeviceIdentity } from "./gateway/device-identity.js";
import { GatewayService } from "./gateway/gateway-service.js";
import { DeviceTokenStore } from "./gateway/token-store.js";
import { PANEL_VERSION } from "./version.js";

/** Builds the gateway connection the same way for the server and for CLI spikes. */
export function createGatewayService(config: AppConfig, logger: Logger, opts: { retryPairing?: boolean } = {}): GatewayService {
  const identity = loadOrCreateDeviceIdentity(config.dataDir);
  const tokens = new DeviceTokenStore(config.dataDir);
  return new GatewayService({
    url: config.gateway.url,
    sharedToken: config.gateway.sharedToken,
    identity,
    tokens,
    clientVersion: PANEL_VERSION,
    logger: logger.child({ component: "gateway" }),
    ...(opts.retryPairing ? { retryPairingEveryMs: 10_000 } : {}),
  });
}
