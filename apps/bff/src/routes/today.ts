import { LocalMemoryStatusDto } from "@clawdesk/shared";
import { like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import type { BudgetService } from "../budget/budget-service.js";
import type { ChatService } from "../chat/chat-service.js";
import { memoryNotes, settings } from "../db/schema.js";
import type { MemoryNoteService } from "../library/memory-note-service.js";
import type { LibraryService } from "../library/library-service.js";
import { ScheduleService } from "../schedules/schedule-service.js";
import { TodayService } from "../today/today-service.js";

export function registerTodayRoutes(app: FastifyInstance, deps: AppDeps & { notes: MemoryNoteService; chat: ChatService; library: LibraryService; budget: BudgetService }): void {
  const timeZone = () => deps.space.get()?.timezone ?? "UTC";
  const schedules = new ScheduleService({ ...deps, timeZone });
  const today = new TodayService({
    connection: async () => {
      if (deps.gateway.status.state !== "connected") throw new Error("gateway_unavailable");
      const accounts = await deps.telegram.connectionStatus();
      return { gateway: deps.gateway.status.state, telegram: accounts };
    },
    approvals: async () => {
      return { count: await deps.approvals.pendingCount() };
    },
    notes: () => {
      const ids = new Set(deps.db.selectDistinct({ agentId: memoryNotes.agentId }).from(memoryNotes).all().map((n) => n.agentId));
      for (const row of deps.db.select({ key: settings.key }).from(settings).where(like(settings.key, "memory.notes.applied.%")).all()) ids.add(row.key.slice("memory.notes.applied.".length));
      const notes = [...ids].map((id) => deps.notes.list(id));
      return { count: notes.reduce((sum, n) => sum + n.notes.length, 0), pendingAgents: notes.filter((n) => !n.applied).map((n) => n.agentId) };
    },
    search: async () => {
      if (deps.gateway.status.state !== "connected") throw new Error("gateway_unavailable");
      return LocalMemoryStatusDto.parse(await deps.bridge.localMemoryStatus());
    },
    reminders: () => {
      if (!deps.reminders) throw new Error("reminders_unavailable");
      return deps.reminders.list();
    },
    schedules: () => schedules.list(),
    activity: () => {
      const material = deps.library.recent(undefined, 1)[0];
      return { conversations: deps.chat.recentConversations(), material: material ? { id: material.id, title: material.title, at: material.at } : null };
    },
    budget: () => deps.budget.observation(timeZone()),
    backups: () => {
      const status = deps.backups.status();
      return { available: status.available, lastAt: status.backups.length ? Date.parse(status.backups[0]!.createdAt) : null, failed: !!status.lastError };
    },
  }, timeZone);
  app.get("/api/today", async (_request, reply) => {
    if (deps.space.mode() !== "personal") return reply.status(404).send({ error: "not_found", message: "personal mode only" });
    return today.get();
  });
}
