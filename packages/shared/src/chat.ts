import { z } from "zod";

// Chat with an agent (screen 9). The panel talks to the agent's main session; replies stream
// to the browser as server-sent events.

/** File types the panel passes on to the agent; anything else is refused before the upload. */
export const CHAT_ATTACHMENT_TYPES = {
  "text/plain": [".txt", ".log"],
  "text/markdown": [".md"],
  "text/csv": [".csv"],
  "text/tab-separated-values": [".tsv"],
  "application/json": [".json"],
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-powerpoint": [".ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
} as const;
export type ChatAttachmentMime = keyof typeof CHAT_ATTACHMENT_TYPES;
export const CHAT_ATTACHMENT_ACCEPT = Object.entries(CHAT_ATTACHMENT_TYPES)
  .flatMap(([mime, extensions]) => [mime, ...extensions])
  .join(",");

/** One file the owner picked in the panel; `content` is its bytes in base64. */
export const ChatAttachmentInput = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(Object.keys(CHAT_ATTACHMENT_TYPES) as [ChatAttachmentMime, ...ChatAttachmentMime[]]),
  sizeBytes: z.number().int().positive(),
  content: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/, "content must be base64"),
});
export type ChatAttachmentInput = z.infer<typeof ChatAttachmentInput>;

/** Shown next to a message: what was attached, never the bytes. */
export const ChatAttachmentDto = z.object({ fileName: z.string(), mimeType: z.string().nullable(), sizeBytes: z.number().nullable() });
export type ChatAttachmentDto = z.infer<typeof ChatAttachmentDto>;

export const ChatMessageDto = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  /** Tools the agent used before this reply, in order. */
  tools: z.array(z.string()),
  /** Files sent with this message, as far as the transcript names them. */
  attachments: z.array(ChatAttachmentDto),
  at: z.number().nullable(),
  status: z.enum(["ok", "error", "aborted"]),
});
export type ChatMessageDto = z.infer<typeof ChatMessageDto>;

/** What this Gateway accepts right now: the panel's own caps narrowed by the handshake policy. */
export const ChatAttachmentLimitsDto = z.object({
  maxFiles: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  maxImageBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  /** false when the Gateway handshake did not state its attachment policy; the panel's own caps apply. */
  fromGateway: z.boolean(),
});
export type ChatAttachmentLimitsDto = z.infer<typeof ChatAttachmentLimitsDto>;

export const ChatHistoryDto = z.object({
  agentId: z.string(),
  messages: z.array(ChatMessageDto),
  /** A turn is still being worked on (e.g. the page was reloaded mid-answer). */
  running: z.boolean(),
  attachments: ChatAttachmentLimitsDto,
});
export type ChatHistoryDto = z.infer<typeof ChatHistoryDto>;

export const SendChatRequest = z.object({
  text: z.string().trim().max(8000),
  attachments: z.array(ChatAttachmentInput).max(5).optional(),
}).refine(({ text, attachments }) => text.length > 0 || (attachments?.length ?? 0) > 0, { message: "a message needs text or a file" });
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
