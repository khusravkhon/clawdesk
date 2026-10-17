import { CreateReminderRequest, ReminderActionRequest, ReminderPreferences } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ReminderError, type ReminderService } from "../schedules/reminder-service.js";

export function registerReminderRoutes(app: FastifyInstance, deps: { reminders: ReminderService }): void {
  const execute = (action: () => unknown, reply: { code: (status: number) => unknown }) => {
    try { return action(); } catch (error) {
      if (!(error instanceof ReminderError)) throw error;
      reply.code(error.code === "not_found" ? 404 : error.code === "personal_only" ? 403 : 409);
      return { error: error.code, message: error.message };
    }
  };
  app.get("/api/reminders", async (_, reply) => execute(() => deps.reminders.list(), reply));
  app.post("/api/reminders", async (request, reply) => execute(() => deps.reminders.create(CreateReminderRequest.parse(request.body)), reply));
  app.put("/api/reminders/preferences", async (request, reply) => execute(() => deps.reminders.savePreferences(ReminderPreferences.parse(request.body)), reply));
  app.post("/api/reminders/:id/action", async (request, reply) => execute(() => deps.reminders.action(z.object({ id: z.string().uuid() }).parse(request.params).id, ReminderActionRequest.parse(request.body)), reply));
}
