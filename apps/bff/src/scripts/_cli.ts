import fs from "node:fs";
import { loadConfig } from "../config.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { createLogger } from "../lib/logger.js";
import { createGatewayService } from "../runtime.js";

// Shared bootstrap for stage-0 spike scripts: load apps/bff/.env, connect,
// and explain pairing if the gateway has not approved this device yet.

export async function connectForScript(): Promise<{ gateway: GatewayService; done: () => Promise<void> }> {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const logger = createLogger(process.env.LOG_LEVEL ?? "warn");
  const gateway = createGatewayService(config, logger);
  console.log(`→ connecting to ${config.gateway.url} as device ${gateway.deviceId.slice(0, 12)}…`);
  gateway.start();
  try {
    await gateway.waitUntilConnected(30_000);
  } catch (error) {
    const status = gateway.status;
    console.error(`✗ not connected: ${(error as Error).message}`);
    if (status.state === "pairing_required") {
      console.error("  The gateway has to approve this panel once. On the gateway host run:");
      console.error("    docker compose -f deploy/docker-compose.yml exec gateway node dist/index.js devices list");
      console.error("    docker compose -f deploy/docker-compose.yml exec gateway node dist/index.js devices approve <requestId>");
      if (status.hint) console.error(`  (${status.hint})`);
    }
    await gateway.stop();
    process.exit(2);
  }
  const hello = gateway.hello;
  console.log(`✓ connected: OpenClaw ${hello?.server.version}, protocol ${hello?.protocol}, scopes ${status(gateway)}`);
  return { gateway, done: () => gateway.stop() };
}

function status(gateway: GatewayService): string {
  return gateway.status.scopes.join(", ") || "(none)";
}

export function short(value: unknown, max = 600): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
