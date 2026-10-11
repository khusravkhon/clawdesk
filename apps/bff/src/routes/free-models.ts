import { AddFreeKeyRequest, type ApiErrorDto, type FreeModelsStatusDto } from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { FreeModelsError, type FreeModelsService } from "../free-models/free-models-service.js";

const PlatformParams = z.object({ platform: z.string().regex(/^[a-z0-9-]{1,40}$/) });

export function registerFreeModelRoutes(app: FastifyInstance, deps: { freeModels: FreeModelsService }): void {
  app.get("/api/free-models", async (): Promise<FreeModelsStatusDto> => deps.freeModels.status());

  app.post("/api/free-models/keys", async (request, reply): Promise<FreeModelsStatusDto | ApiErrorDto> => {
    const { platform, key } = AddFreeKeyRequest.parse(request.body);
    return withErrors(reply, () => deps.freeModels.addKey(platform, key));
  });

  app.delete("/api/free-models/keys/:platform", async (request, reply): Promise<FreeModelsStatusDto | ApiErrorDto> => {
    const { platform } = PlatformParams.parse(request.params);
    return withErrors(reply, () => deps.freeModels.removeKeys(platform));
  });
}

async function withErrors<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | ApiErrorDto> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof FreeModelsError) {
      reply.status(error.code === "unavailable" ? 503 : 400);
      return { error: `free_models_${error.code}`, message: error.message };
    }
    throw error;
  }
}
