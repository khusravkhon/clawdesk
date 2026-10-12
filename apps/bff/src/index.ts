import fs from "node:fs";
import { AiSetupService } from "./ai-setup/ai-setup-service.js";
import { SignInSessionManager } from "./ai-setup/signin-sessions.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/client.js";
import { createLogger } from "./lib/logger.js";
import { createGatewayService } from "./runtime.js";
import { ApprovalsService } from "./approvals/approvals-service.js";
import { AssistantService } from "./assistant/assistant-service.js";
import { getSetting, putSetting } from "./db/settings.js";
import { BridgeClient } from "./gateway/bridge-client.js";
import { SourcesService } from "./sources/sources-service.js";
import { TelegramService } from "./telegram/telegram-service.js";
import { FreeModelsService } from "./free-models/free-models-service.js";

// Host development reads apps/bff/.env (written by init.sh --dev); containers get real env vars.
if (process.env.NODE_ENV !== "production" && fs.existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const logger = createLogger(config.logLevel);

const { db, close: closeDb } = openDb(config.dbPath);
const gateway = createGatewayService(config, logger, { retryPairing: true });
const aiSetup = new AiSetupService(gateway, logger.child({ component: "ai-setup" }));
const signIn = new SignInSessionManager(gateway, logger.child({ component: "signin" }));
const telegram = new TelegramService(gateway, db, logger.child({ component: "telegram" }));
const freeModels = new FreeModelsService(gateway, logger.child({ component: "free-models" }), { ...config.freeModels, dataDir: config.dataDir });
const sources = new SourcesService({ gateway, db, logger: logger.child({ component: "sources" }), files: config.files, bridge: new BridgeClient(config.bridgeUrl, config.gateway.sharedToken) });
const approvals = new ApprovalsService(gateway, logger.child({ component: "approvals" }));
const assistant = new AssistantService({ gateway, db, logger: logger.child({ component: "assistant" }) });
const app = await buildApp({ logger, gateway, db, aiSetup, signIn, telegram, freeModels, sources, approvals, assistant, sandboxEnabled: config.sandboxEnabled, webDist: config.webDist });

gateway.start();
await app.listen({ host: config.host, port: config.port });

// Main agent: commands on the server need the owner's approval (applied once, then the owner decides).
const EXEC_DEFAULT_SETTING = "approvals.mainDefaultApplied";
void gateway
  .waitUntilConnected(120_000)
  .then(() => approvals.ensureDefault(getSetting<boolean>(db, EXEC_DEFAULT_SETTING) === true))
  .then((applied) => applied && putSetting(db, EXEC_DEFAULT_SETTING, true))
  .catch((error: Error) => logger.warn({ err: error }, "could not apply the default exec approval mode"));

// Memory search: OpenClaw defaults to OpenAI embeddings even without an OpenAI key; use what works.
void gateway
  .waitUntilConnected(120_000)
  .then(() => assistant.ensureMemoryWorks())
  .catch((error: Error) => logger.warn({ err: error }, "could not check the memory provider"));

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
