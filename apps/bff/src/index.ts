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
import { AuthService } from "./auth/auth-service.js";
import { BackupService } from "./backups/backup-service.js";
import { SpaceService } from "./space/space-service.js";
import { TeamService } from "./teams/team-service.js";
import { AuditService } from "./audit/audit-service.js";
import { getSetting, putSetting } from "./db/settings.js";
import { BridgeClient } from "./gateway/bridge-client.js";
import { McpService } from "./skills/mcp-service.js";
import { SkillsService } from "./skills/skills-service.js";
import { SourcesService } from "./sources/sources-service.js";
import { TelegramService } from "./telegram/telegram-service.js";
import { FreeModelsService } from "./free-models/free-models-service.js";
import { ChatService } from "./chat/chat-service.js";
import { VideoService } from "./video/video-service.js";
import { BudgetService } from "./budget/budget-service.js";
import { LibraryService } from "./library/library-service.js";
import { MemoryNoteService } from "./library/memory-note-service.js";
import { ReminderService } from "./schedules/reminder-service.js";
import { repairAgentFolders } from "./provision/agent-folders.js";
import { liveAgentIds, repairAgentCommunication } from "./provision/agent-communication.js";
import { WorkRequestsService } from "./company/work-requests-service.js";
import { AccessService } from "./company/access-service.js";
import { getConfig } from "./gateway/config-patch.js";
import { syncRequestTools } from "./company/work-requests-config.js";
import { mainSessionKey } from "./chat/chat-service.js";

// Host development reads apps/bff/.env (written by init.sh --dev); containers get real env vars.
if (process.env.NODE_ENV !== "production" && fs.existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const logger = createLogger(config.logLevel);

const { db, close: closeDb } = openDb(config.dbPath);
const gateway = createGatewayService(config, logger, { retryPairing: true });
const bridge = new BridgeClient(config.bridgeUrl, config.gateway.sharedToken);
const signIn: SignInSessionManager = new SignInSessionManager(gateway, logger.child({ component: "signin" }), (): Promise<void> => aiSetup.syncFollowers(), bridge);
const aiSetup: AiSetupService = new AiSetupService(gateway, logger.child({ component: "ai-setup" }), db, (): Promise<boolean> => signIn.claudePlanAvailable());
const telegram = new TelegramService(gateway, db, logger.child({ component: "telegram" }), undefined, bridge, async (provider) => {
  if (provider !== "groq") return;
  const result = await gateway.request<{ plugins: { id: string; installed?: boolean }[] }>("plugins.list", {});
  if (!result.plugins.some((plugin) => plugin.id === "groq" && plugin.installed)) await aiSetup.installProvider("groq");
});
const freeModels = new FreeModelsService(gateway, logger.child({ component: "free-models" }), {
  ...config.freeModels,
  dataDir: config.dataDir,
  accountSecret: config.gateway.sharedToken,
  bridge,
});
const sources = new SourcesService({ gateway, db, logger: logger.child({ component: "sources" }), files: config.files, bridge });
const skills = new SkillsService({ gateway, db, bridge, logger: logger.child({ component: "skills" }) });
const mcp = new McpService({ gateway, db, bridge, logger: logger.child({ component: "mcp" }) });
const space = new SpaceService({ db, logger: logger.child({ component: "space" }) });
const approvals = new ApprovalsService(gateway, logger.child({ component: "approvals" }));
const assistant = new AssistantService({ gateway, db, logger: logger.child({ component: "assistant" }), mode: () => space.mode() });
const auth = new AuthService({ db, dataDir: config.dataDir, logger: logger.child({ component: "auth" }), telegram });
const backups = new BackupService({ bridge, dir: config.backupDir, logger: logger.child({ component: "backups" }) });
const teams = new TeamService({ gateway, db, logger: logger.child({ component: "teams" }), bridge, space, telegram, sandboxEnabled: config.sandboxEnabled });
const audit = new AuditService({ db, gateway, logger: logger.child({ component: "audit" }) });
// Studying videos by link: one queue for the whole panel, so a restart can mark what it left running.
const library = new LibraryService(db);
const budget = new BudgetService({ gateway, db, logger: logger.child({ component: "budget" }) });
const notes = new MemoryNoteService({ gateway, db, logger: logger.child({ component: "memory-notes" }) });
const video = new VideoService({ db, bridge, chat: new ChatService(gateway, library), logger: logger.child({ component: "video" }), videoDir: config.videoDir, library, waitUntilReady: () => gateway.waitUntilConnected(120_000) });
video.recover();
const reminders = new ReminderService({ db, gateway, telegram, mode: () => space.mode(), timeZone: () => space.get()?.timezone ?? "UTC" });
reminders.recover();
// Stage 5: what company agents can reach; grants are applied and checked where they are enforced.
const access = new AccessService({
  db, bridge, companyMode: () => space.mode() === "company",
  setMcpAgents: (server, agentIds) => mcp.setAgents(server, agentIds),
  config: async () => (await getConfig<Record<string, never>>(gateway)).config,
});
// Stage 6: requests up the company structure, filed by agents through the clawdesk-requests plugin.
const requests = new WorkRequestsService({
  db, bridge, companyMode: () => space.mode() === "company", liveAgents: () => liveAgentIds(gateway),
  // Stage 8: requests that reach the owner go to the owner's Telegram too, with buttons the plugin hands back.
  telegram, grant: (request, by) => access.grant(request, by),
  send: async (agentId, message, idempotencyKey) => { await gateway.request("chat.send", { sessionKey: mainSessionKey(agentId), agentId, message, idempotencyKey }); },
});

const app = await buildApp({ logger, gateway, db, aiSetup, signIn, telegram, freeModels, sources, skills, mcp, approvals, assistant, auth, backups, bridge, space, teams, audit, video, videoDir: config.videoDir, library, budget, notes, reminders, requests, access, sandboxEnabled: config.sandboxEnabled, webDist: config.webDist, trustProxy: config.trustProxy });

gateway.start();
await app.listen({ host: config.host, port: config.port });
backups.startSchedule();

// First run: nobody can claim the panel without this code (a new one: cli/owner-code).
const ownerCode = auth.ownerCodeForFirstRun();
if (ownerCode) logger.warn(`No panel owner yet. Open the panel at /setup?code=${ownerCode} to set the password.`);

// Main agent: commands on the server need the owner's approval (applied once, then the owner decides).
const EXEC_DEFAULT_SETTING = "approvals.mainDefaultApplied";
async function repairDefaultApprovals(): Promise<void> {
  const applied = await approvals.ensureDefault(getSetting<boolean>(db, EXEC_DEFAULT_SETTING) === true);
  if (applied) putSetting(db, EXEC_DEFAULT_SETTING, true);
}

// Juniors with the main agent's AI: bring them onto its current models and backups
// (also covers juniors created before backups existed, which copied only the main model).
const repairFollowerModels = () => aiSetup.syncFollowers();

// Memory search: OpenClaw defaults to OpenAI embeddings even without an OpenAI key; use what works.
const repairMemory = () => assistant.ensureMemoryWorks();

let shuttingDown = false;
async function repairStartup(): Promise<void> {
  const repairs: [string, () => Promise<unknown>][] = [
    ["personal agent session policy and restricted ask-main configuration (tool availability unverified)", () => repairAgentCommunication({ gateway, db })],
    ["managed agent folders", () => repairAgentFolders({ gateway, db, bridge, logger })],
    // GitHub teams made before OpenClaw refused binds into /workspace: members get copies in their workspaces.
    ["team repository copies", () => teams.repairWorkspaces()],
    ["company request tools", () => syncRequestTools({ gateway, db, companyMode: space.mode() === "company" })],
    ["default exec approval mode", repairDefaultApprovals],
    ["junior models", repairFollowerModels],
    ["memory provider", repairMemory],
    ["pending memory notes", () => notes.retryPending()],
    // MCP servers added elsewhere (Notion on the data sources screen) stay with the main agent.
    ["MCP access per agent", () => mcp.syncAccess()],
    ["Telegram files and voice messages", () => telegram.ensureMedia()],
    // Last: the limit may pause scheduled jobs, and that should happen after they are in place.
    ["spending limits", () => budget.enforce(Intl.DateTimeFormat().resolvedOptions().timeZone)],
  ];
  for (const [name, repair] of repairs) {
    if (shuttingDown) return;
    const generation = gateway.generation;
    try {
      await gateway.waitUntilConnected(120_000);
      if (shuttingDown) return;
      await repair();
    } catch (error) {
      logger.warn({ err: error, repair: name }, "startup repair failed; continuing with remaining repairs");
    }
    if (!shuttingDown && gateway.status.state !== "connected") {
      try { await gateway.waitForReconnect(generation); }
      catch (error) { logger.warn({ err: error, repair: name }, "Gateway has not reconnected after startup repair"); }
    }
  }
}
void repairStartup();

// Spending limits are checked on a timer as well: a day rolls over and a paused schedule must come
// back by itself, without the owner opening the panel.
const BUDGET_INTERVAL_MS = 15 * 60_000;
const budgetTimer = setInterval(() => {
  void budget
    .enforce(Intl.DateTimeFormat().resolvedOptions().timeZone)
    .catch((error: Error) => logger.warn({ err: error }, "could not apply the spending limits"));
}, BUDGET_INTERVAL_MS);
budgetTimer.unref();

const notesTimer = setInterval(() => {
  if (!shuttingDown && gateway.status.state === "connected") {
    void notes.retryPending().catch((error: Error) => logger.warn({ err: error }, "could not retry memory note synchronization"));
  }
}, 60_000);
notesTimer.unref();

const reminderTimer = setInterval(() => {
  if (!shuttingDown) void reminders.tick().catch((error: Error) => logger.warn({ err: error }, "could not process fixed reminders"));
}, 15_000);
reminderTimer.unref();

// Requests: new spool entries, deadlines and messages every few seconds; tools for new agents every minute.
const requestsTimer = setInterval(() => {
  if (!shuttingDown && gateway.status.state === "connected") void requests.tick().catch((error: Error) => logger.warn({ err: error }, "could not process company requests"));
}, 5_000);
requestsTimer.unref();
const requestToolsTimer = setInterval(() => {
  if (!shuttingDown && gateway.status.state === "connected" && space.mode() === "company") void syncRequestTools({ gateway, db, companyMode: true }).catch((error: Error) => logger.warn({ err: error }, "could not give company agents the request tools"));
}, 60_000);
requestToolsTimer.unref();

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  backups.stopSchedule();
  video.stopQueue();
  clearInterval(budgetTimer);
  clearInterval(notesTimer);
  clearInterval(reminderTimer);
  clearInterval(requestsTimer);
  clearInterval(requestToolsTimer);
  await reminders.stop();
  await app.close();
  await notes.drain();
  await gateway.stop();
  closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
