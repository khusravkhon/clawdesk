import type { FastifyInstance } from "fastify";
import type { AgentListDto, AgentListItemDto } from "@clawdesk/shared";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import type { GatewayService } from "../gateway/gateway-service.js";

type GatewayAgentSummary = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string };
  model?: { primary?: string };
};
type AgentsListResult = { defaultId: string; agents: GatewayAgentSummary[] };

export function registerAgentRoutes(app: FastifyInstance, deps: { gateway: GatewayService; db: Db }): void {
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
        emoji: agent.identity?.emoji ?? null,
        model: agent.model?.primary ?? null,
        isDefault: agent.id === result.defaultId,
        role: row?.role ?? null,
        parentId: row?.parentId ?? null,
        status: row?.status ?? "ready",
      };
    });
    return { defaultId: result.defaultId, agents: items };
  });
}
