import { AssistantProfile, SetMemoryRequest, LocalMemoryActionRequest, LocalMemoryStatusDto, LocalMemorySearchRequest, LocalMemorySearchDto, type AssistantDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import type { AssistantService } from "../assistant/assistant-service.js";
import { BridgeError, type BridgeClient } from "../gateway/bridge-client.js";
import type { SpaceService } from "../space/space-service.js";

export function registerAssistantRoutes(app: FastifyInstance, deps: { assistant: AssistantService; bridge?: BridgeClient; space?: SpaceService }): void {
  app.post("/api/assistant/local-memory/search", async (request, reply) => {
    const { agentId, query } = LocalMemorySearchRequest.parse(request.body);
    if (!deps.bridge) return reply.status(503).send({ error: "bridge_unavailable", message: "bridge_unavailable" });
    try { return LocalMemorySearchDto.parse(await deps.bridge.localMemorySearch(agentId, query)); }
    catch (error) {
      if (error instanceof BridgeError) return reply.status(503).send({ error: error.code, message: error.code });
      throw error;
    }
  });
  const memory = async (reply: import("fastify").FastifyReply, run: (bridge: BridgeClient) => Promise<LocalMemoryStatusDto>) => {
    if (!deps.bridge) return reply.status(503).send({ error: "bridge_unavailable", message: "bridge_unavailable" });
    try { return LocalMemoryStatusDto.parse(await run(deps.bridge)); }
    catch (error) {
      if (error instanceof BridgeError) return reply.status(503).send({ error: error.code, message: error.code });
      throw error;
    }
  };
  app.get("/api/assistant/local-memory", async (_request, reply) => memory(reply, (bridge) => bridge.localMemoryStatus()));
  app.post("/api/assistant/local-memory", async (request, reply) => {
    const { action, consent } = LocalMemoryActionRequest.parse(request.body);
    if (action === "setup" && !consent) return reply.status(400).send({ error: "consent_required", message: "consent_required" });
    return memory(reply, (bridge) => bridge.localMemoryAction(action, consent));
  });
  app.get("/api/assistant", async (): Promise<AssistantDto> => deps.assistant.get());

  app.put("/api/assistant", async (request): Promise<AssistantDto> => {
    const profile = AssistantProfile.parse(request.body);
    return deps.assistant.save(profile);
  });

  app.post("/api/assistant/memory", async (request): Promise<AssistantDto> => {
    const { provider } = SetMemoryRequest.parse(request.body);
    return deps.assistant.setMemory(provider);
  });
}
