import {
  ApproveTelegramRequest,
  ConnectTelegramRequest,
  type ApiErrorDto,
  type ApproveTelegramResultDto,
  type TelegramPairingRequestDto,
  type TelegramStatusDto,
} from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { TelegramError, type TelegramService } from "../telegram/telegram-service.js";

const TestMessage = z.object({ text: z.string().trim().min(1).max(1000) });

export function registerTelegramRoutes(app: FastifyInstance, deps: { telegram: TelegramService }): void {
  app.get("/api/telegram", async (): Promise<TelegramStatusDto> => deps.telegram.status());

  app.post("/api/telegram/connect", async (request, reply): Promise<TelegramStatusDto | ApiErrorDto> => {
    const { token } = ConnectTelegramRequest.parse(request.body);
    return withTelegramErrors(reply, () => deps.telegram.connect(token));
  });

  app.post("/api/telegram/disconnect", async (_request, reply) => {
    await deps.telegram.disconnect();
    return reply.status(204).send();
  });

  app.get("/api/telegram/pairing", async (): Promise<TelegramPairingRequestDto[]> => deps.telegram.pairingRequests());

  app.post("/api/telegram/pairing/approve", async (request): Promise<ApproveTelegramResultDto> => {
    const { requestId, accountId } = ApproveTelegramRequest.parse(request.body);
    return deps.telegram.approve(requestId, accountId);
  });

  app.post("/api/telegram/test", async (request, reply) => {
    const { text } = TestMessage.parse(request.body);
    const res = await withTelegramErrors(reply, () => deps.telegram.sendTest(text));
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
