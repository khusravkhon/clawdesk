import { CreateSpaceRequest, UpdateSpaceRequest, type ApiErrorDto, type SpaceDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { SpaceExistsError, type SpaceService } from "../space/space-service.js";

export function registerSpaceRoutes(app: FastifyInstance, deps: { space: SpaceService }): void {
  app.get("/api/space", async (): Promise<{ space: SpaceDto | null }> => ({ space: deps.space.get() }));
  app.patch("/api/space", async (request, reply) => {
    const space = deps.space.update(UpdateSpaceRequest.parse(request.body));
    return space ?? reply.status(404).send({ error: "personal_space_missing", message: "personal space not configured" });
  });

  app.post("/api/space", async (request, reply): Promise<SpaceDto | ApiErrorDto> => {
    const body = CreateSpaceRequest.parse(request.body);
    try {
      return deps.space.create(body);
    } catch (error) {
      if (!(error instanceof SpaceExistsError)) throw error;
      reply.status(409);
      return { error: "space_exists", message: error.message };
    }
  });
}
