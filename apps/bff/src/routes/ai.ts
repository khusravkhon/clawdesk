import {
  ActivateApiKeyRequest,
  AgentId,
  SignInAnswerRequest,
  StartSignInRequest,
  type ActivateResultDto,
  type AiCatalogDto,
  type AiStatusDto,
  type ApiErrorDto,
  type InstallProviderResultDto,
  type SignInStateDto,
} from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AiSetupError, type AiSetupService } from "../ai-setup/ai-setup-service.js";
import { SignInError, type SignInSessionManager } from "../ai-setup/signin-sessions.js";

const AgentQuery = z.object({ agentId: AgentId.default("main") });
const PluginParams = z.object({ pluginId: z.string().regex(/^[a-z0-9-]{1,64}$/) });
const SessionParams = z.object({ sessionId: z.string().uuid() });

export function registerAiRoutes(app: FastifyInstance, deps: { aiSetup: AiSetupService; signIn: SignInSessionManager }): void {
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

  // --- subscription sign-in ---

  app.post("/api/ai/signin", async (request): Promise<SignInStateDto> => {
    const body = StartSignInRequest.parse(request.body);
    return deps.signIn.start(body.agentId, body.authChoice);
  });

  app.get("/api/ai/signin/:sessionId", async (request, reply): Promise<SignInStateDto | ApiErrorDto> => {
    const { sessionId } = SessionParams.parse(request.params);
    return withSignInErrors(reply, () => deps.signIn.get(sessionId));
  });

  app.post("/api/ai/signin/:sessionId/answer", async (request, reply): Promise<SignInStateDto | ApiErrorDto> => {
    const { sessionId } = SessionParams.parse(request.params);
    const body = SignInAnswerRequest.parse(request.body);
    return withSignInErrors(reply, () => deps.signIn.answer(sessionId, body));
  });

  app.delete("/api/ai/signin/:sessionId", async (request, reply) => {
    const { sessionId } = SessionParams.parse(request.params);
    await deps.signIn.cancel(sessionId);
    return reply.status(204).send();
  });
}

function withSignInErrors<T>(reply: FastifyReply, fn: () => T): T | ApiErrorDto {
  try {
    return fn();
  } catch (error) {
    if (error instanceof SignInError) {
      reply.status(error.code === "not_found" ? 404 : 409);
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}
