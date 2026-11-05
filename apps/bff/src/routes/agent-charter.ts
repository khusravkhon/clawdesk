import { RepairAgentCharterRequest, RestoreAgentCharterRequest, SaveAgentCharterRequest } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { AgentCharterError, type AgentCharterService } from "../company/agent-charter-service.js";

// Stage 4: an agent's charter and its versions (see AgentCharterService).

const Params = z.object({ agentId: z.string().min(1).max(80) });

export function registerAgentCharterRoutes(app: FastifyInstance, charters: AgentCharterService): void {
  app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.status(400).send({ error: "invalid_request", message: "request validation failed" });
      if (!(error instanceof AgentCharterError)) throw error;
      const status = error.code === "agent_missing" || error.code === "version_missing" ? 404 : error.code === "gateway_unavailable" ? 503 : 409;
      return reply.status(status).send({ error: error.code, message: error.code });
    });
    scope.get("/api/agents/:agentId/charter", (request) => charters.get(Params.parse(request.params).agentId));
    scope.put("/api/agents/:agentId/charter", (request) => charters.save(Params.parse(request.params).agentId, SaveAgentCharterRequest.parse(request.body)));
    scope.post("/api/agents/:agentId/charter/restore", (request) => charters.restore(Params.parse(request.params).agentId, RestoreAgentCharterRequest.parse(request.body)));
    scope.post("/api/agents/:agentId/charter/repair", (request) => charters.repair(Params.parse(request.params).agentId, RepairAgentCharterRequest.parse(request.body)));
  });
}
