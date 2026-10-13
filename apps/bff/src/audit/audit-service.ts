import type { AgentAuditEventDto, AuditEventDto, AuditPageDto } from "@clawdesk/shared";
import { desc, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import type { GatewayService } from "../gateway/gateway-service.js";

// Action log (screen 14). Panel actions are recorded by one hook after every changing /api request:
// which action, on what (route params only), and whether it worked. Request bodies — where tokens and
// passwords travel — are never recorded. Agents' own actions come from OpenClaw's audit ledger.

/** Changing routes worth a readable name; anything else is logged as "METHOD /route". */
const ACTIONS: Record<string, string> = {
  "POST /api/auth/setup": "auth.setup",
  "POST /api/auth/login": "auth.login",
  "POST /api/auth/logout": "auth.logout",
  "POST /api/auth/telegram/send": "auth.telegramCode",
  "POST /api/auth/telegram/reset": "auth.telegramReset",
  "POST /api/space": "space.create",
  "POST /api/agents": "agent.create",
  "DELETE /api/agents/:agentId": "agent.delete",
  "POST /api/ai/activate": "ai.connect",
  "POST /api/ai/signin": "ai.signIn",
  "POST /api/ai/providers/:pluginId/install": "ai.installProvider",
  "PUT /api/assistant": "assistant.save",
  "POST /api/assistant/memory": "assistant.memory",
  "POST /api/approvals/:id/resolve": "approval.resolve",
  "POST /api/approvals/mode": "approval.mode",
  "POST /api/approvals/allowed/remove": "approval.allowedRemove",
  "POST /api/schedules": "schedule.create",
  "PATCH /api/schedules/:id": "schedule.update",
  "DELETE /api/schedules/:id": "schedule.delete",
  "POST /api/schedules/:id/run": "schedule.run",
  "POST /api/telegram/connect": "telegram.connect",
  "POST /api/telegram/disconnect": "telegram.disconnect",
  "POST /api/telegram/pairing/approve": "telegram.approveOwner",
  "POST /api/telegram/approvals": "telegram.approvals",
  "POST /api/sources/notion/token": "source.notionConnect",
  "POST /api/sources/notion/oauth": "source.notionSignIn",
  "GET /api/sources/notion/callback": "source.notionSignedIn",
  "POST /api/sources/notion/disconnect": "source.notionDisconnect",
  "POST /api/sources/google/client": "source.googleClient",
  "POST /api/sources/google/complete": "source.googleConnect",
  "GET /api/sources/google/callback": "source.googleConnect",
  "POST /api/sources/google/remove": "source.googleRemove",
  "POST /api/free-models/keys": "freeModels.addKey",
  "DELETE /api/free-models/keys/:platform": "freeModels.removeKey",
  "POST /api/system/backups": "backup.create",
  "POST /api/system/backups/:name/download": "backup.download",
  "POST /api/system/reset": "system.reset",
  "POST /api/teams": "team.create",
  "DELETE /api/teams/:teamId": "team.delete",
  "POST /api/teams/:teamId/fetch": "team.fetch",
  "POST /api/teams/:teamId/push": "team.push",
  "POST /api/teams/:teamId/telegram": "team.telegram",
};

/** Too frequent to be worth a line each; their effects show in the agents' log. */
const SKIP = new Set(["POST /api/chat/:agentId/send", "POST /api/chat/:agentId/abort", "POST /api/ai/signin/:sessionId/answer", "DELETE /api/ai/signin/:sessionId"]);

const KEEP_ROWS = 20_000;
const PAGE = 50;

type RawAuditEvent = {
  eventId: string;
  occurredAt: number;
  agentId?: string;
  action: string;
  status: string;
  toolName?: string;
  errorCode?: string;
};

export class AuditService {
  #writes = 0;

  constructor(private readonly deps: { db: Db; gateway: GatewayService; logger: Logger }) {}

  /** Registers the recording hook; call once, before the routes. */
  attach(app: FastifyInstance): void {
    app.addHook("onResponse", async (request, reply) => {
      const route = request.routeOptions.url;
      if (!route?.startsWith("/api/")) return;
      const key = `${request.method} ${route}`;
      const isChange = request.method !== "GET" || key in ACTIONS;
      // 401 outside sign-in is the guard turning away an expired session: noise. Failed sign-ins are kept.
      if (!isChange || SKIP.has(key) || (reply.statusCode === 401 && !route.startsWith("/api/auth/"))) return;
      const params = (request.params ?? {}) as Record<string, string>;
      const target = Object.values(params).join(" ") || null;
      // OAuth return trips redirect either way; the outcome is in the address they redirect to.
      const failedRedirect = /[?&]w+=(error|denied)/.test(String(reply.getHeader("location") ?? ""));
      const ok = reply.statusCode < 400 && !failedRedirect;
      this.record({
        actor: route.startsWith("/api/auth/") ? "anonymous" : "owner",
        action: ACTIONS[key] ?? key,
        target,
        result: ok ? "ok" : "error",
        detail: ok ? null : String(reply.statusCode),
      });
    });
  }

  record(event: Omit<AuditEventDto, "id" | "at">): void {
    try {
      this.deps.db.insert(auditEvents).values(event).run();
      // Bounded: drop the oldest rows now and then.
      if (++this.#writes % 500 === 0) {
        this.deps.db.run(sql`DELETE FROM audit_events WHERE id <= (SELECT id FROM audit_events ORDER BY id DESC LIMIT 1 OFFSET ${KEEP_ROWS})`);
      }
    } catch (error) {
      this.deps.logger.warn({ err: error }, "could not write the action log");
    }
  }

  async page(opts: { before?: number; cursor?: string }): Promise<AuditPageDto> {
    const rows = this.deps.db
      .select()
      .from(auditEvents)
      .where(opts.before ? lt(auditEvents.id, opts.before) : undefined)
      .orderBy(desc(auditEvents.id))
      .limit(PAGE)
      .all();
    const panel = rows.map((r) => ({ id: r.id, at: r.at.getTime(), actor: r.actor, action: r.action, target: r.target, result: r.result, detail: r.detail }));

    let agents: AgentAuditEventDto[] = [];
    let nextAgents: string | null = null;
    try {
      // Finished runs and tool calls carry the outcome; their "started" twins add nothing to read.
      const res = await this.deps.gateway.request<{ events: RawAuditEvent[]; nextCursor?: string }>("audit.list", { limit: PAGE, ...(opts.cursor ? { cursor: opts.cursor } : {}) });
      agents = res.events
        .filter((e) => e.action.endsWith(".finished"))
        .map((e) => ({ id: e.eventId, at: e.occurredAt, agentId: e.agentId ?? null, action: e.action, status: e.status, toolName: e.toolName ?? null, errorCode: e.errorCode ?? null }));
      nextAgents = res.nextCursor ?? null;
    } catch (error) {
      this.deps.logger.debug({ err: error }, "agents' audit log unavailable");
    }
    return { panel, agents, nextPanel: rows.length === PAGE ? rows.at(-1)!.id : null, nextAgents };
  }
}
