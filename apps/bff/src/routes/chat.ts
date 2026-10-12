import { SendChatRequest, type ChatHistoryDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChatService } from "../chat/chat-service.js";

const AgentParams = z.object({ agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) });

export function registerChatRoutes(app: FastifyInstance, deps: { chat: ChatService }): void {
  app.get("/api/chat/:agentId/history", async (request): Promise<ChatHistoryDto> => {
    const { agentId } = AgentParams.parse(request.params);
    return deps.chat.history(agentId);
  });

  app.post("/api/chat/:agentId/send", async (request, reply) => {
    const { agentId } = AgentParams.parse(request.params);
    const { text } = SendChatRequest.parse(request.body);
    reply.status(202);
    return deps.chat.send(agentId, text);
  });

  app.post("/api/chat/:agentId/abort", async (request, reply) => {
    const { agentId } = AgentParams.parse(request.params);
    await deps.chat.abort(agentId);
    return reply.status(204).send();
  });

  // Server-sent events for the agent's running turns; the browser keeps one open while the chat is visible.
  app.get("/api/chat/:agentId/events", async (request, reply) => {
    const { agentId } = AgentParams.parse(request.params);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": connected\n\n");
    const unsubscribe = deps.chat.subscribe(agentId, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    // Comments keep proxies from closing an idle stream.
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}
