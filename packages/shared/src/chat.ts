import { z } from "zod";

// Chat with an agent (screen 9). The panel talks to the agent's main session; replies stream
// to the browser as server-sent events.

export const ChatMessageDto = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  /** Tools the agent used before this reply, in order. */
  tools: z.array(z.string()),
  at: z.number().nullable(),
  status: z.enum(["ok", "error", "aborted"]),
});
export type ChatMessageDto = z.infer<typeof ChatMessageDto>;

export const ChatHistoryDto = z.object({
  agentId: z.string(),
  messages: z.array(ChatMessageDto),
  /** A turn is still being worked on (e.g. the page was reloaded mid-answer). */
  running: z.boolean(),
});
export type ChatHistoryDto = z.infer<typeof ChatHistoryDto>;

export const SendChatRequest = z.object({ text: z.string().trim().min(1).max(8000) });
export type SendChatRequest = z.infer<typeof SendChatRequest>;

export const ChatRunPhase = z.enum(["preparing", "thinking", "tool", "writing"]);
export type ChatRunPhase = z.infer<typeof ChatRunPhase>;

/** One server-sent event of a running turn. */
export type ChatStreamEvent =
  | { type: "status"; runId: string; phase: ChatRunPhase }
  | { type: "tool"; runId: string; name: string }
  | { type: "delta"; runId: string; text: string; replace: boolean }
  | { type: "final"; runId: string }
  | { type: "error"; runId: string; message: string | null }
  | { type: "aborted"; runId: string };
