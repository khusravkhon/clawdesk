import { CreateScheduleRequest, UpdateScheduleRequest, type ApiErrorDto, type ScheduleListDto, type ScheduleRunDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ScheduleError, type ScheduleService } from "../schedules/schedule-service.js";

const IdParams = z.object({ id: z.string().min(1).max(200) });

export function registerScheduleRoutes(app: FastifyInstance, deps: { schedules: ScheduleService }): void {
  app.get("/api/schedules", async (): Promise<ScheduleListDto> => deps.schedules.list());

  app.post("/api/schedules", async (request, reply): Promise<ScheduleListDto> => {
    const body = CreateScheduleRequest.parse(request.body);
    reply.status(201);
    return deps.schedules.create(body);
  });

  app.patch("/api/schedules/:id", async (request, reply): Promise<ScheduleListDto | ApiErrorDto> => {
    const { id } = IdParams.parse(request.params);
    const body = UpdateScheduleRequest.parse(request.body);
    try {
      return await deps.schedules.update(id, body);
    } catch (error) {
      if (error instanceof ScheduleError) {
        reply.status(error.code === "not_found" ? 404 : 400);
        return { error: error.code, message: error.message };
      }
      throw error;
    }
  });

  app.delete("/api/schedules/:id", async (request): Promise<ScheduleListDto> => {
    const { id } = IdParams.parse(request.params);
    return deps.schedules.remove(id);
  });

  app.post("/api/schedules/:id/run", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await deps.schedules.runNow(id);
    return reply.status(202).send({ ok: true });
  });

  app.get("/api/schedules/:id/runs", async (request): Promise<ScheduleRunDto[]> => {
    const { id } = IdParams.parse(request.params);
    return deps.schedules.runs(id);
  });
}
