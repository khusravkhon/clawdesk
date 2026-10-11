import fs from "node:fs";
import { AiSetupService } from "./ai-setup/ai-setup-service.js";
import { SignInSessionManager } from "./ai-setup/signin-sessions.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/client.js";
import { createLogger } from "./lib/logger.js";
import { createGatewayService } from "./runtime.js";
import { TelegramService } from "./telegram/telegram-service.js";

// Host development reads apps/bff/.env (written by init.sh --dev); containers get real env vars.
if (process.env.NODE_ENV !== "production" && fs.existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const logger = createLogger(config.logLevel);

const { db, close: closeDb } = openDb(config.dbPath);
const gateway = createGatewayService(config, logger, { retryPairing: true });
const aiSetup = new AiSetupService(gateway, logger.child({ component: "ai-setup" }));
const signIn = new SignInSessionManager(gateway, logger.child({ component: "signin" }));
const telegram = new TelegramService(gateway, db, logger.child({ component: "telegram" }));
const app = await buildApp({ logger, gateway, db, aiSetup, signIn, telegram, sandboxEnabled: config.sandboxEnabled, webDist: config.webDist });

gateway.start();
await app.listen({ host: config.host, port: config.port });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  await app.close();
  await gateway.stop();
  closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
