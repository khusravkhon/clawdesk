import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { GatewayClientRequestError, GatewayClientRequestTimeoutError } from "@openclaw/gateway-client";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { ZodError } from "zod";
import type { ApiErrorDto } from "@clawdesk/shared";
import type { AiSetupService } from "./ai-setup/ai-setup-service.js";
import type { ApprovalsService } from "./approvals/approvals-service.js";
import type { AssistantService } from "./assistant/assistant-service.js";
import type { AuthService } from "./auth/auth-service.js";
import type { BackupService } from "./backups/backup-service.js";
import type { BridgeClient } from "./gateway/bridge-client.js";
import type { SpaceService } from "./space/space-service.js";
import { CompanyService } from "./company/company-service.js";
import { registerCompanyRoutes } from "./routes/company.js";
import type { TeamService } from "./teams/team-service.js";
import type { AuditService } from "./audit/audit-service.js";
import type { SignInSessionManager } from "./ai-setup/signin-sessions.js";
import { ChatService } from "./chat/chat-service.js";
import { VideoService } from "./video/video-service.js";
import { BudgetService } from "./budget/budget-service.js";
import { LibraryService } from "./library/library-service.js";
import { MemoryNoteService } from "./library/memory-note-service.js";
import { DashboardService } from "./dashboard/dashboard-service.js";
import { ScheduleService } from "./schedules/schedule-service.js";
import { ReminderService } from "./schedules/reminder-service.js";
import { registerReminderRoutes } from "./routes/reminders.js";
import type { Db } from "./db/client.js";
import { GatewayUnavailableError, type GatewayService } from "./gateway/gateway-service.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerAssistantRoutes } from "./routes/assistant.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerVideoRoutes } from "./routes/video.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerTodayRoutes } from "./routes/today.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerGatewayRestartRoutes } from "./routes/gateway-restart.js";
import type { FreeModelsService } from "./free-models/free-models-service.js";
import { registerFreeModelRoutes } from "./routes/free-models.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerExtensionRoutes } from "./routes/extensions.js";
import type { McpService } from "./skills/mcp-service.js";
import type { SkillsService } from "./skills/skills-service.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerStorageRoutes } from "./routes/storage.js";
import { registerSpaceRoutes } from "./routes/space.js";
import { registerTeamRoutes } from "./routes/teams.js";
import { registerWorkRequestRoutes } from "./routes/work-requests.js";
import type { WorkRequestsService } from "./company/work-requests-service.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { UsageService } from "./dashboard/usage-service.js";
import { registerTelegramRoutes } from "./routes/telegram.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import type { SourcesService } from "./sources/sources-service.js";
import type { TelegramService } from "./telegram/telegram-service.js";

export type AppDeps = {
  logger: Logger;
  gateway: GatewayService;
  db: Db;
  aiSetup: AiSetupService;
  signIn: SignInSessionManager;
  sandboxEnabled: boolean;
  telegram: TelegramService;
  freeModels: FreeModelsService;
  sources: SourcesService;
  skills: SkillsService;
  mcp: McpService;
  approvals: ApprovalsService;
  assistant: AssistantService;
  auth: AuthService;
  backups: BackupService;
  bridge: BridgeClient;
  /** Studying videos by link; the panel passes its own instance so startup can recover jobs. */
  video?: VideoService;
  /** Kept video originals, read-only for the panel; absent when this install keeps none. */
  videoDir?: string | undefined;
  /** The owner's library of read materials; the panel passes its own instance. */
  library?: LibraryService;
  /** Spending limits; the panel passes its own instance so startup can apply them. */
  budget?: BudgetService;
  notes?: MemoryNoteService;
  reminders?: ReminderService;
  space: SpaceService;
  teams: TeamService;
  /** Stage 6 requests up the company structure; absent in tests that do not need them. */
  requests?: WorkRequestsService;
  audit: AuditService;
  webDist: string | undefined;
  /** Fastify trustProxy: client address and HTTPS come from the proxy's headers (Caddy). */
  trustProxy?: string | false;
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.logger as FastifyBaseLogger, trustProxy: deps.trustProxy ?? false });

  app.setErrorHandler((error, request, reply) => {
    const send = (status: number, body: ApiErrorDto) => reply.status(status).send(body);
    if (error instanceof ZodError) return send(400, { error: "invalid_request", message: "request validation failed", details: error.issues });
    if (error instanceof GatewayUnavailableError) {
      return send(503, { error: "gateway_unavailable", message: error.message, details: { state: error.status.state, hint: error.status.hint } });
    }
    if (error instanceof GatewayClientRequestTimeoutError) return send(504, { error: "gateway_timeout", message: `gateway did not answer ${error.method} in time` });
    if (error instanceof GatewayClientRequestError) {
      request.log.warn({ code: error.gatewayCode, msg: error.message }, "gateway rejected request");
      return send(502, { error: "gateway_error", message: error.message, details: { code: error.gatewayCode } });
    }
    const status = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, "unhandled error");
    return send(status, { error: status >= 500 ? "internal_error" : "request_error", message: status >= 500 ? "internal error" : (error as Error).message });
  });

  deps.audit.attach(app);
  // First: its guard stands in front of every other /api route.
  registerAuthRoutes(app, deps);
  registerHealthRoutes(app, deps);
  registerGatewayRestartRoutes(app, deps);
  registerAgentRoutes(app, deps);
  registerAiRoutes(app, deps);
  registerTemplateRoutes(app, deps);
  registerTelegramRoutes(app, deps);
  registerFreeModelRoutes(app, deps);
  registerSourceRoutes(app, deps);
  registerExtensionRoutes(app, deps);
  registerApprovalRoutes(app, deps);
  registerAssistantRoutes(app, deps);
  registerStorageRoutes(app, deps);
  registerScheduleRoutes(app, { schedules: new ScheduleService(deps) });
  const reminders = deps.reminders ?? new ReminderService({ db: deps.db, gateway: deps.gateway, telegram: deps.telegram, mode: () => deps.space.mode(), timeZone: () => deps.space.get()?.timezone ?? "UTC" });
  registerReminderRoutes(app, { reminders });
  const library = deps.library ?? new LibraryService(deps.db);
  const budget = deps.budget ?? new BudgetService({ gateway: deps.gateway, db: deps.db, logger: deps.logger.child({ component: "budget" }) });
  const chat = new ChatService(deps.gateway, library);
  registerChatRoutes(app, { chat });

  const notes = deps.notes ?? new MemoryNoteService({ db: deps.db, gateway: deps.gateway, logger: deps.logger.child({ component: "memory-notes" }) });
  registerLibraryRoutes(app, { library, notes, budget });
  registerTodayRoutes(app, { ...deps, notes, reminders });
  registerVideoRoutes(app, { video: deps.video ?? new VideoService({ db: deps.db, bridge: deps.bridge, chat, logger: deps.logger.child({ component: "video" }), videoDir: deps.videoDir, library }), budget });
  registerDashboardRoutes(app, { dashboard: new DashboardService(deps) });
  registerSystemRoutes(app, deps);
  registerSpaceRoutes(app, deps);
  registerTeamRoutes(app, deps);
  registerWorkRequestRoutes(app, deps);
  registerCompanyRoutes(app, new CompanyService(deps));
  registerAuditRoutes(app, deps);
  registerUsageRoutes(app, { usage: new UsageService(deps) });

  if (deps.webDist && fs.existsSync(path.join(deps.webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: deps.webDist, wildcard: false });
    // SPA fallback: any non-API GET serves index.html so client-side routes work on reload.
    app.setNotFoundHandler((request, reply) => {
      // A file of an older build (a tab open across an update) is gone: 404, so the page can reload itself.
      if (request.method === "GET" && !request.url.startsWith("/api/") && !request.url.startsWith("/assets/")) return reply.sendFile("index.html");
      return reply.status(404).send({ error: "not_found", message: `${request.method} ${request.url} not found` } satisfies ApiErrorDto);
    });
  }

  return app;
}
