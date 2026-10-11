import { CreateAgentRequest, type AgentListDto, type AgentListItemDto, type ApiErrorDto, type CreateAgentResultDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { CreateAgentError, createJuniorAgent, deleteJuniorAgent } from "../provision/create-agent.js";
import { SagaError } from "../provision/saga.js";
import type { TelegramService } from "../telegram/telegram-service.js";

type GatewayAgentSummary = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string };
  model?: { primary?: string };
};
type AgentsListResult = { defaultId: string; agents: GatewayAgentSummary[] };

const AgentParams = z.object({ agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) });

export type AgentRouteDeps = { gateway: GatewayService; db: Db; logger: Logger; sandboxEnabled: boolean; telegram: TelegramService };

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  // OpenClaw is the source of truth for which agents exist; our rows add role/parent.
  // An agent in OpenClaw without a panel row is shown with role null (created outside the panel).
  app.get("/api/agents", async (): Promise<AgentListDto> => {
    const result = await deps.gateway.request<AgentsListResult>("agents.list", {});
    const meta = new Map(deps.db.select().from(agents).all().map((row) => [row.id, row]));
    const items: AgentListItemDto[] = result.agents.map((agent) => {
      const row = meta.get(agent.id);
      return {
        id: agent.id,
        name: row?.displayName ?? agent.identity?.name ?? agent.name ?? agent.id,
        emoji: agent.identity?.emoji ?? row?.avatar ?? null,
        model: agent.model?.primary ?? null,
        isDefault: agent.id === result.defaultId,
        role: agent.id === "main" ? "main" : (row?.role ?? null),
        parentId: row?.parentId ?? null,
        status: row?.status ?? "ready",
        purpose: row?.purpose ?? null,
        canAskMain: row?.canAskMain ?? null,
        sandbox: row?.sandbox ?? null,
      };
    });
    return { defaultId: result.defaultId, agents: items, sandboxEnabled: deps.sandboxEnabled };
  });

  app.post("/api/agents", async (request, reply): Promise<CreateAgentResultDto | ApiErrorDto> => {
    const body = CreateAgentRequest.parse(request.body);
    try {
      const result = await createJuniorAgent({ ...deps, telegramDelivery: deps.telegram.ownerDelivery() }, body);
      reply.status(201);
      return result;
    } catch (error) {
      if (error instanceof CreateAgentError) {
        reply.status(400);
        return { error: error.code, message: error.message };
      }
      if (error instanceof SagaError) {
        reply.status(502);
        return { error: "create_failed", message: error.message, details: { failedStep: error.failedStep, rolledBack: error.rollbackErrors.length === 0 } };
      }
      throw error;
    }
  });

  app.delete("/api/agents/:agentId", async (request, reply) => {
    const { agentId } = AgentParams.parse(request.params);
    try {
      await deleteJuniorAgent(deps, agentId);
    } catch (error) {
      if (error instanceof CreateAgentError) return reply.status(400).send({ error: error.code, message: error.message } satisfies ApiErrorDto);
      throw error;
    }
    return reply.status(204).send();
  });
}
