import {
  ActivateApiKeyRequest,
  AgentId,
  type ActivateResultDto,
  type AiCatalogDto,
  type AiStatusDto,
  type ApiErrorDto,
  type InstallProviderResultDto,
} from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AiSetupError, type AiSetupService } from "../ai-setup/ai-setup-service.js";

const AgentQuery = z.object({ agentId: AgentId.default("main") });
const PluginParams = z.object({ pluginId: z.string().regex(/^[a-z0-9-]{1,64}$/) });

export function registerAiRoutes(app: FastifyInstance, deps: { aiSetup: AiSetupService }): void {
  app.get("/api/ai/status", async (request): Promise<AiStatusDto> => {
    const { agentId } = AgentQuery.parse(request.query);
    return deps.aiSetup.status(agentId);
  });

  app.get("/api/ai/catalog", async (request): Promise<AiCatalogDto> => {
    const { agentId } = AgentQuery.parse(request.query);
    return deps.aiSetup.catalog(agentId);
  });

  app.post("/api/ai/providers/:pluginId/install", async (request, reply): Promise<InstallProviderResultDto | ApiErrorDto> => {
    const { pluginId } = PluginParams.parse(request.params);
    try {
      return await deps.aiSetup.installProvider(pluginId);
    } catch (error) {
      if (error instanceof AiSetupError) {
        reply.status(error.code === "unknown_provider" ? 404 : 502);
        return { error: error.code, message: error.message };
      }
      throw error;
    }
  });

  app.post("/api/ai/activate", async (request): Promise<ActivateResultDto> => {
    const body = ActivateApiKeyRequest.parse(request.body);
    return deps.aiSetup.activateApiKey(body);
  });
}
