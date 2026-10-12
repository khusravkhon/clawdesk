import { AssistantProfile, SetMemoryRequest, type AssistantDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import type { AssistantService } from "../assistant/assistant-service.js";

export function registerAssistantRoutes(app: FastifyInstance, deps: { assistant: AssistantService }): void {
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
