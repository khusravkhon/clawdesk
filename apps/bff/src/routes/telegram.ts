import {
  ApproveTelegramRequest,
  ConnectTelegramRequest,
  AssignTelegramAgentRequest,
  TelegramAccountId,
  LinkAgentTopicsRequest,
  TelegramApprovalsRequest,
  TelegramVoiceKeyRequest,
  TelegramVoiceSettingsRequest,
  type ApiErrorDto,
  type AgentTopicsDto,
  type ApproveTelegramResultDto,
  type TelegramPairingRequestDto,
  type TelegramStatusDto,
  type TelegramBotDto,
} from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { TelegramError, type TelegramService } from "../telegram/telegram-service.js";

const TestMessage = z.object({ text: z.string().trim().min(1).max(1000) });
const AccountQuery = z.object({ accountId: TelegramAccountId.default("default") });

export function registerTelegramRoutes(app: FastifyInstance, deps: { telegram: TelegramService }): void {
  app.get("/api/telegram/voice", async () => deps.telegram.voiceStatus());
  app.put("/api/telegram/voice/key", async (request, reply) => {
    const parsed = TelegramVoiceKeyRequest.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.some((issue) => issue.message === "audio_model_unavailable") ? "audio_model_unavailable" : "audio_key_provider_mismatch", message: "Check the selected audio provider, model and API key format." });
    const { apiKey, provider, model } = parsed.data;
    return withTelegramErrors(reply, () => deps.telegram.saveVoiceKey(apiKey, provider, model));
  });
  app.put("/api/telegram/voice", async (request, reply) => {
    const { enabled, provider, model } = TelegramVoiceSettingsRequest.parse(request.body);
    return withTelegramErrors(reply, () => deps.telegram.setVoice(enabled, provider, model));
  });
  app.get("/api/telegram", async (request): Promise<TelegramStatusDto> => deps.telegram.status(AccountQuery.parse(request.query).accountId));

  app.get("/api/telegram/accounts", async (): Promise<TelegramBotDto[]> => deps.telegram.accounts());
  app.post("/api/telegram/accounts", async (request, reply) => {
    const { token, agentId } = ConnectTelegramRequest.parse(request.body);
    return withTelegramErrors(reply, () => deps.telegram.addBot(token, agentId));
  });
  app.put("/api/telegram/accounts/:accountId/agent", async (request, reply) => {
    const { accountId } = z.object({ accountId: TelegramAccountId }).parse(request.params);
    const { agentId } = AssignTelegramAgentRequest.parse(request.body);
    return withTelegramErrors(reply, () => deps.telegram.assignAgent(accountId, agentId));
  });

  app.post("/api/telegram/connect", async (request, reply): Promise<TelegramStatusDto | ApiErrorDto> => {
    const { token, agentId } = ConnectTelegramRequest.parse(request.body);
    return withTelegramErrors(reply, () => deps.telegram.connect(token, agentId, AccountQuery.parse(request.query).accountId));
  });

  app.post("/api/telegram/disconnect", async (request, reply) => {
    await deps.telegram.disconnect(AccountQuery.parse(request.query).accountId);
    return reply.status(204).send();
  });

  app.get("/api/telegram/pairing", async (request): Promise<TelegramPairingRequestDto[]> => deps.telegram.pairingRequests(AccountQuery.parse(request.query).accountId));

  app.post("/api/telegram/pairing/approve", async (request, reply): Promise<ApproveTelegramResultDto | ApiErrorDto> => {
    const { requestId, accountId } = ApproveTelegramRequest.parse(request.body);
    return withTelegramErrors(reply, () => deps.telegram.approve(requestId, accountId));
  });

  app.post("/api/telegram/approvals", async (request, reply): Promise<TelegramStatusDto | ApiErrorDto> => {
    const { enabled } = TelegramApprovalsRequest.parse(request.body);
    return withTelegramErrors(reply, () => deps.telegram.setApprovals(enabled, AccountQuery.parse(request.query).accountId));
  });

  // A topic per agent in the owner's group.
  app.get("/api/telegram/topics", async (request): Promise<AgentTopicsDto> => deps.telegram.agentTopics(AccountQuery.parse(request.query).accountId));

  app.put("/api/telegram/topics", async (request, reply): Promise<AgentTopicsDto | ApiErrorDto> => {
    const { topics } = LinkAgentTopicsRequest.parse(request.body);
    return withTelegramErrors(reply, () => deps.telegram.linkAgentTopics(topics, AccountQuery.parse(request.query).accountId));
  });

  app.delete("/api/telegram/topics", async (request): Promise<AgentTopicsDto> => deps.telegram.unlinkAgentTopics(AccountQuery.parse(request.query).accountId));

  app.post("/api/telegram/test", async (request, reply) => {
    const { text } = TestMessage.parse(request.body);
    const res = await withTelegramErrors(reply, () => deps.telegram.sendToOwner(text, AccountQuery.parse(request.query).accountId));
    return res === undefined ? reply.status(204).send() : res;
  });
}

async function withTelegramErrors<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | ApiErrorDto> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TelegramError) {
      reply.status(error.code === "telegram_unreachable" ? 502 : 400);
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}
