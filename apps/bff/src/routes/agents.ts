import {
  CreateAgentRequest,
  SaveAgentProfileRequest,
  SaveAsTemplateRequest,
  type AgentListDto,
  type AgentListItemDto,
  type AgentProfileDto,
  type ApiErrorDto,
  type CreateAgentResultDto,
  type TemplateDto,
} from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { AgentProfileError, readProfile, saveAsTemplate, saveProfile } from "../provision/agent-profile.js";
import { CreateAgentError, createJuniorAgent, deleteJuniorAgent } from "../provision/create-agent.js";
import { SagaError } from "../provision/saga.js";
import type { TelegramService } from "../telegram/telegram-service.js";
import type { FreeModelsService } from "../free-models/free-models-service.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import type { SpaceService } from "../space/space-service.js";
import { agentSourceGrants, dataSources } from "../db/schema.js";
import { eq } from "drizzle-orm";

type GatewayAgentSummary = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string };
  model?: { primary?: string };
};
type AgentsListResult = { defaultId: string; agents: GatewayAgentSummary[] };

const AgentParams = z.object({ agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) });

export type AgentRouteDeps = {
  gateway: GatewayService;
  db: Db;
  logger: Logger;
  sandboxEnabled: boolean;
  telegram: TelegramService;
  freeModels: FreeModelsService;
  bridge: BridgeClient;
  space: SpaceService;
  /** A new agent gets no MCP server until the owner grants one ("Навыки и MCP"). */
  mcp?: { syncAccess(): Promise<void> };
  /** Stage 4: puts the saved charter back into AGENTS.md after a raw edit of the files. */
  charters?: { apply(agentId: string): Promise<boolean> };
};

// OpenClaw is the source of truth for which agents exist; our rows add role/parent.
// An agent in OpenClaw without a panel row is shown with role null (created outside the panel).
export async function listAgents(deps: { gateway: GatewayService; db: Db; sandboxEnabled: boolean }): Promise<AgentListDto> {
  const result = await deps.gateway.request<AgentsListResult>("agents.list", {});
  const meta = new Map(deps.db.select().from(agents).all().map((row) => [row.id, row]));
  const folders = new Map(
    deps.db
      .select({ agentId: agentSourceGrants.agentId, name: dataSources.connectorRef })
      .from(agentSourceGrants)
      .innerJoin(dataSources, eq(agentSourceGrants.sourceId, dataSources.id))
      .where(eq(dataSources.kind, "folder"))
      .all()
      .map((g) => [g.agentId, g.name]),
  );
  const items: AgentListItemDto[] = result.agents.map((agent) => {
    const row = meta.get(agent.id);
    const gatewayName = agent.identity?.name ?? agent.name;
    return {
      id: agent.id,
      name: (agent.id === "main" ? gatewayName ?? row?.displayName : row?.displayName ?? gatewayName) ?? agent.id,
      emoji: agent.identity?.emoji ?? row?.avatar ?? null,
      model: agent.model?.primary ?? null,
      isDefault: agent.id === result.defaultId,
      role: agent.id === "main" ? "main" : (row?.role ?? null),
      parentId: row?.parentId ?? null,
      status: row?.status ?? "ready",
      purpose: row?.purpose ?? null,
      canAskMain: row?.canAskMain ?? null,
      sandbox: row?.sandbox ?? null,
      folder: folders.get(agent.id) ?? null,
    };
  });
  return { defaultId: result.defaultId, agents: items, sandboxEnabled: deps.sandboxEnabled };
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  app.get("/api/agents", (): Promise<AgentListDto> => listAgents(deps));

  app.post("/api/agents", async (request, reply): Promise<CreateAgentResultDto | ApiErrorDto> => {
    const body = CreateAgentRequest.parse(request.body);
    if (body.mode !== deps.space.mode()) {
      reply.status(400);
      return { error: "wrong_mode", message: `this install is in ${deps.space.mode()} mode` };
    }
    if (body.ai === "free" && !(await deps.freeModels.status()).ready) {
      reply.status(400);
      return { error: "free_models_not_ready", message: "add at least one free provider key first" };
    }
    try {
      const result = await createJuniorAgent({ ...deps, telegramDelivery: deps.telegram.ownerDelivery(), folders: deps.bridge }, body);
      await deps.mcp?.syncAccess().catch((error: Error) => deps.logger.warn({ err: error, agentId: result.agentId }, "could not apply MCP access to the new agent"));
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

  // --- Editing an agent after creation, and saving it as one of the owner's templates ---

  app.get("/api/agents/:agentId/profile", async (request, reply): Promise<AgentProfileDto | ApiErrorDto> => {
    const { agentId } = AgentParams.parse(request.params);
    return withProfileErrors(reply, () => readProfile(deps, agentId));
  });

  app.put("/api/agents/:agentId/profile", async (request, reply): Promise<AgentProfileDto | ApiErrorDto> => {
    const { agentId } = AgentParams.parse(request.params);
    const body = SaveAgentProfileRequest.parse(request.body);
    // The owner's raw edit may drop or change the charter block: the saved charter goes back in.
    return withProfileErrors(reply, async () => {
      const saved = await saveProfile(deps, agentId, body);
      return (await deps.charters?.apply(agentId).catch(() => false)) ? readProfile(deps, agentId) : saved;
    });
  });

  app.post("/api/agents/:agentId/template", async (request, reply): Promise<TemplateDto | ApiErrorDto> => {
    const { agentId } = AgentParams.parse(request.params);
    const body = SaveAsTemplateRequest.parse(request.body);
    return withProfileErrors(reply, async () => {
      const template = await saveAsTemplate({ ...deps, mode: deps.space.mode() }, agentId, body);
      reply.status(201);
      return template;
    });
  });

  app.delete("/api/agents/:agentId", async (request, reply) => {
    const { agentId } = AgentParams.parse(request.params);
    const bots = await deps.telegram.accounts();
    const topics = bots.map((bot) => ({ accountId: bot.accountId, before: deps.telegram.agentTopics(bot.accountId) }));
    try {
      await deleteJuniorAgent(deps, agentId);
    } catch (error) {
      if (error instanceof CreateAgentError) return reply.status(400).send({ error: error.code, message: error.message } satisfies ApiErrorDto);
      throw error;
    }
    // Its Telegram topic (if any) must not keep pointing at an agent that is gone.
    for (const topic of topics) {
      await deps.telegram.forgetAgentTopic(topic.before, agentId, topic.accountId).catch((error: Error) => deps.logger.warn({ err: error, agentId }, "could not free the agent's Telegram topic"));
    }
    for (const bot of bots.filter((b) => b.agentId === agentId)) {
      await deps.telegram.assignAgent(bot.accountId, "main").catch((error: Error) => deps.logger.warn({ err: error, agentId }, "could not restore the bot's main agent"));
    }
    return reply.status(204).send();
  });
}

async function withProfileErrors<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | ApiErrorDto> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AgentProfileError) {
      reply.status(error.code === "not_editable" ? 400 : 404);
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}
