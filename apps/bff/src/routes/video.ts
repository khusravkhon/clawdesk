import { CreateVideoJobRequest, type VideoJobDto, type VideoJobsDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BudgetExceededError, BudgetUsageUnavailableError, type BudgetService } from "../budget/budget-service.js";
import { VideoJobRejected, type VideoService } from "../video/video-service.js";

// Studying a video by link: queue it, watch it, stop it. The worker runs in the Gateway container,
// so these routes only ever carry the owner's link and the state of their own jobs.

const JobParams = z.object({ id: z.string().uuid() });

/** A refused link is the owner's to fix; a missing job is a 404. */
const STATUS: Record<string, number> = { invalid_url: 400, unsupported_host: 400, playlist_not_allowed: 400, too_long: 400, downloads_unavailable: 409, not_found: 404 };

export function registerVideoRoutes(app: FastifyInstance, deps: { video: VideoService; budget: BudgetService }): void {
  app.get("/api/video/jobs", async (): Promise<VideoJobsDto> => deps.video.list());

  app.post("/api/video/jobs", async (request, reply): Promise<VideoJobDto | undefined> => {
    const body = CreateVideoJobRequest.parse(request.body);
    try {
      // Studying a video costs an agent turn on top of the download, so it waits for the limit.
      await deps.budget.guard(Intl.DateTimeFormat().resolvedOptions().timeZone);
      const job = deps.video.create(body);
      reply.status(202);
      return job;
    } catch (error) {
      if (error instanceof BudgetUsageUnavailableError) {
        reply.status(503).send({ error: "budget_usage_unavailable", message: "budget_usage_unavailable" });
        return undefined;
      }
      if (error instanceof BudgetExceededError) {
        reply.status(409).send({ error: "budget_exceeded", message: error.reason, details: { reason: error.reason } });
        return undefined;
      }
      if (!(error instanceof VideoJobRejected)) throw error;
      reply.status(STATUS[error.code] ?? 400).send({ error: "video_rejected", message: error.code, details: { code: error.code } });
      return undefined;
    }
  });

  // The kept original, streamed from the panel's video directory (never from an agent's folder).
  app.get("/api/video/jobs/:id/file", async (request, reply) => {
    const { id } = JobParams.parse(request.params);
    try {
      const { stream, fileName, bytes } = deps.video.file(id);
      reply
        .header("content-type", "application/octet-stream")
        .header("content-length", String(bytes))
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
        .header("cache-control", "no-store");
      return reply.send(stream);
    } catch (error) {
      if (!(error instanceof VideoJobRejected)) throw error;
      return reply.status(STATUS[error.code] ?? 404).send({ error: "video_rejected", message: error.code, details: { code: error.code } });
    }
  });

  app.post("/api/video/jobs/:id/cancel", async (request, reply): Promise<VideoJobDto | undefined> => {
    const { id } = JobParams.parse(request.params);
    try {
      return await deps.video.cancel(id);
    } catch (error) {
      if (!(error instanceof VideoJobRejected)) throw error;
      reply.status(STATUS[error.code] ?? 400).send({ error: "video_rejected", message: error.code, details: { code: error.code } });
      return undefined;
    }
  });
}
