import { z } from "zod";

// Telegram screen (6): connect a bot, approve the owner, route schedules to Telegram.
// The bot token only travels browser → BFF → Gateway secret store; it never comes back.

export const TelegramStatusDto = z.object({
  /** A bot token is configured and the channel is enabled. */
  connected: z.boolean(),
  /** The Gateway reports the Telegram account as running. */
  running: z.boolean(),
  bot: z.object({ id: z.number(), username: z.string(), name: z.string() }).nullable(),
  /** The approved owner (direct chat with the bot). */
  owner: z.object({ id: z.string(), label: z.string().nullable() }).nullable(),
  /** Approval requests (commands of the agents) come to the owner's chat with Allow / Deny buttons. */
  approvals: z.boolean(),
  lastError: z.string().nullable(),
});
export type TelegramStatusDto = z.infer<typeof TelegramStatusDto>;

export const ConnectTelegramRequest = z.object({
  token: z
    .string()
    .trim()
    .regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, "this does not look like a Telegram bot token"),
});
export type ConnectTelegramRequest = z.infer<typeof ConnectTelegramRequest>;

export const TelegramPairingRequestDto = z.object({
  requestId: z.string(),
  accountId: z.string(),
  senderId: z.string(),
  senderLabel: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type TelegramPairingRequestDto = z.infer<typeof TelegramPairingRequestDto>;

export const ApproveTelegramRequest = z.object({
  requestId: z.string().min(1),
  accountId: z.string().min(1),
});
export type ApproveTelegramRequest = z.infer<typeof ApproveTelegramRequest>;

export const ApproveTelegramResultDto = z.object({
  ownerId: z.string(),
  /** Panel schedules switched to deliver into the owner's Telegram chat. */
  schedulesRouted: z.number(),
});
export type ApproveTelegramResultDto = z.infer<typeof ApproveTelegramResultDto>;

export const TelegramApprovalsRequest = z.object({ enabled: z.boolean() });
export type TelegramApprovalsRequest = z.infer<typeof TelegramApprovalsRequest>;
