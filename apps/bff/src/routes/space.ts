import { CreateSpaceRequest, SwitchSpaceModeRequest, UpdateSpaceRequest, type ApiErrorDto, type SpaceDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import type { AssistantService } from "../assistant/assistant-service.js";
import { syncRequestTools } from "../company/work-requests-config.js";
import type { Db } from "../db/client.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { SpaceExistsError, type SpaceService } from "../space/space-service.js";

export function registerSpaceRoutes(app: FastifyInstance, deps: { space: SpaceService; assistant: AssistantService; gateway: GatewayService; db: Db }): void {
  app.get("/api/space", async (): Promise<{ space: SpaceDto | null }> => ({ space: deps.space.get() }));
  app.patch("/api/space", async (request, reply) => {
    const space = deps.space.update(UpdateSpaceRequest.parse(request.body));
    return space ?? reply.status(404).send({ error: "personal_space_missing", message: "personal space not configured" });
  });

  app.post("/api/space/mode", async (request, reply) => {
    const space = deps.space.setMode(SwitchSpaceModeRequest.parse(request.body).mode);
    if (!space) return reply.status(404).send({ error: "space_missing", message: "the mode is not chosen yet" });
    // The same two repairs the panel runs at start; a failure here is retried on the next start.
    const results = await Promise.allSettled([
      deps.assistant.refreshInstructions(),
      syncRequestTools({ gateway: deps.gateway, db: deps.db, companyMode: space.mode === "company" }),
    ]);
    for (const r of results) if (r.status === "rejected") request.log.warn({ err: r.reason }, "mode switched; agent settings will follow on the next start");
    return space;
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
