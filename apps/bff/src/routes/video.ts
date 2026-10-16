import { CreateVideoJobRequest, type VideoJobDto, type VideoJobsDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { VideoJobRejected, type VideoService } from "../video/video-service.js";

// Studying a video by link: queue it, watch it, stop it. The worker runs in the Gateway container,
// so these routes only ever carry the owner's link and the state of their own jobs.

const JobParams = z.object({ id: z.string().uuid() });

/** A refused link is the owner's to fix; a missing job is a 404. */
const STATUS: Record<string, number> = { invalid_url: 400, unsupported_host: 400, playlist_not_allowed: 400, too_long: 400, not_found: 404 };

export function registerVideoRoutes(app: FastifyInstance, deps: { video: VideoService }): void {
  app.get("/api/video/jobs", async (): Promise<VideoJobsDto> => deps.video.list());

  app.post("/api/video/jobs", async (request, reply): Promise<VideoJobDto | undefined> => {
    const body = CreateVideoJobRequest.parse(request.body);
    try {
      const job = deps.video.create(body);
      reply.status(202);
      return job;
    } catch (error) {
      if (!(error instanceof VideoJobRejected)) throw error;
      reply.status(STATUS[error.code] ?? 400).send({ error: "video_rejected", message: error.code, details: { code: error.code } });
      return undefined;
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
