import { CreateChatConversation, SendChatRequest, type ChatAttachmentLimitsDto, type ChatHistoryDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ChatAttachmentError, type AttachmentRejectionCode } from "../chat/chat-attachments.js";
import { ChatSendError, type ChatService } from "../chat/chat-service.js";
import { DocumentWorkerError } from "../documents/office-worker-pool.js";

const AgentParams = z.object({ agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) });
const ConversationQuery = z.object({ conversationId: z.uuid().optional() });
const HistoryQuery = ConversationQuery.extend({ sendId: z.uuid().optional() });

/** Base64 attachments inflate by a third; the body cap sits above the largest allowed request. */
const SEND_BODY_LIMIT = 48 * 1024 * 1024;
/** A file the panel will not take is the owner's problem to fix, not a server fault. */
export const REJECTION_STATUS: Record<AttachmentRejectionCode, number> = {
  too_many_files: 400,
  unsupported_type: 415,
  size_mismatch: 400,
  file_too_large: 413,
  image_too_large: 413,
  request_too_large: 413,
};

export function registerChatRoutes(app: FastifyInstance, deps: { chat: ChatService; personal?: () => boolean }): void {
  const requirePersonal = () => {
    if (!deps.personal?.()) throw new ChatSendError("conversation_missing", "conversations are available in personal mode");
  };
  const checkConversation = (id?: string) => {
    if (id) requirePersonal();
    return id;
  };
  app.get("/api/chat/:agentId/conversations", async (request) => {
    requirePersonal();
    return { conversations: deps.chat.conversations(AgentParams.parse(request.params).agentId) };
  });
  app.post("/api/chat/:agentId/conversations", async (request, reply) => {
    requirePersonal();
    const { title } = CreateChatConversation.parse(request.body);
    const created = await deps.chat.createConversation(AgentParams.parse(request.params).agentId, title);
    return reply.status(201).send(created);
  });
  app.get("/api/chat/:agentId/history", async (request): Promise<ChatHistoryDto> => {
    const { agentId } = AgentParams.parse(request.params);
    const { conversationId, sendId } = HistoryQuery.parse(request.query);
    return deps.chat.history(agentId, 60, checkConversation(conversationId), sendId);
  });

  app.get("/api/chat/attachments/limits", async (): Promise<ChatAttachmentLimitsDto> => deps.chat.attachmentLimits());

  app.post("/api/chat/:agentId/send", { bodyLimit: SEND_BODY_LIMIT }, async (request, reply) => {
    const { agentId } = AgentParams.parse(request.params);
    const { text, attachments, sendId } = SendChatRequest.parse(request.body);
    const conversationId = checkConversation(ConversationQuery.parse(request.query).conversationId);
    try {
      const result = await deps.chat.send(agentId, text, attachments ?? [], sendId, conversationId);
      reply.status(202);
      return result;
    } catch (error) {
      if (error instanceof DocumentWorkerError && error.code === "document_queue_full") {
        return reply.status(429).send({ error: error.code, message: error.message });
      }
      if (!(error instanceof ChatAttachmentError)) throw error;
      // The reason travels as a code: the panel writes it in the owner's language.
      return reply.status(REJECTION_STATUS[error.rejection.code]).send({
        error: "attachment_rejected",
        message: error.rejection.code,
        details: error.rejection,
      });
    }
  });

  app.post("/api/chat/:agentId/abort", async (request, reply) => {
    const { agentId } = AgentParams.parse(request.params);
    await deps.chat.abort(agentId, checkConversation(ConversationQuery.parse(request.query).conversationId));
    return reply.status(204).send();
  });

  // Server-sent events for the agent's running turns; the browser keeps one open while the chat is visible.
  app.get("/api/chat/:agentId/events", async (request, reply) => {
    const { agentId } = AgentParams.parse(request.params);
    const conversationId = checkConversation(ConversationQuery.parse(request.query).conversationId);
    const res = reply.raw;
    const unsubscribe = deps.chat.subscribe(agentId, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`), conversationId);
    reply.hijack();
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": connected\n\n");
    // Comments keep proxies from closing an idle stream.
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    res.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}
