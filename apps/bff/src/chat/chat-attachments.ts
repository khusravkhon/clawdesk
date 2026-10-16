import { CHAT_ATTACHMENT_TYPES, type ChatAttachmentDto, type ChatAttachmentInput, type ChatAttachmentLimitsDto } from "@clawdesk/shared";

// Files the owner attaches in the panel. The panel never writes them to disk: the bytes go
// straight to the Gateway with chat.send, which stores non-image files itself (media://inbound).
// Admission is not comprehension: whether the agent can read a .docx depends on its own tools.

/** The panel's own caps, used as-is when the Gateway handshake states no attachment policy. */
export const PANEL_LIMITS = {
  maxFiles: 5,
  maxFileBytes: 20 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
} as const;

/** Of the Gateway's frame budget, what one chat.send may use: the rest carries the frame itself. */
const PAYLOAD_SHARE = 0.7;

type HelloPolicy = { policy?: { maxPayload?: number; attachments?: { maxBytes?: number; maxImageBytes?: number } } } | null;

/**
 * Effective limits: our caps narrowed by the handshake policy. `maxPayload` bounds the encoded
 * frame, so the share it allows is converted back to plain bytes before it caps a file.
 */
export function attachmentLimits(hello: HelloPolicy): ChatAttachmentLimitsDto {
  const policy = hello?.policy;
  const stated = policy?.attachments;
  const fromPayload = policy?.maxPayload ? Math.floor((policy.maxPayload * PAYLOAD_SHARE * 3) / 4) : Infinity;
  const maxTotalBytes = Math.max(1, Math.min(PANEL_LIMITS.maxTotalBytes, fromPayload));
  const maxFileBytes = Math.min(PANEL_LIMITS.maxFileBytes, stated?.maxBytes ?? Infinity, maxTotalBytes);
  return {
    maxFiles: PANEL_LIMITS.maxFiles,
    maxFileBytes,
    maxImageBytes: Math.min(PANEL_LIMITS.maxImageBytes, stated?.maxImageBytes ?? stated?.maxBytes ?? Infinity, maxFileBytes),
    maxTotalBytes,
    fromGateway: !!stated,
  };
}

/** Every reason a file can be refused; the route maps each one to a status, the panel to a sentence. */
export const ATTACHMENT_REJECTION_CODES = ["too_many_files", "unsupported_type", "size_mismatch", "file_too_large", "image_too_large", "request_too_large"] as const;
export type AttachmentRejectionCode = (typeof ATTACHMENT_REJECTION_CODES)[number];

export type AttachmentRejection =
  | { code: "too_many_files"; limit: number }
  | { code: "file_too_large"; fileName: string; limit: number }
  | { code: "image_too_large"; fileName: string; limit: number }
  | { code: "request_too_large"; limit: number }
  | { code: "size_mismatch"; fileName: string }
  | { code: "unsupported_type"; fileName: string };

export class ChatAttachmentError extends Error {
  constructor(readonly rejection: AttachmentRejection) {
    super(rejection.code);
    this.name = "ChatAttachmentError";
  }
}

const isImage = (mimeType: string) => mimeType.startsWith("image/");

/**
 * Checks each file against the effective limits and against its own declared size, so a browser
 * cannot understate a payload. Throws the first rejection; the panel shows its reason per file.
 */
export function checkAttachments(attachments: ChatAttachmentInput[], limits: ChatAttachmentLimitsDto): void {
  if (attachments.length > limits.maxFiles) throw new ChatAttachmentError({ code: "too_many_files", limit: limits.maxFiles });
  let total = 0;
  for (const file of attachments) {
    if (!(file.mimeType in CHAT_ATTACHMENT_TYPES)) throw new ChatAttachmentError({ code: "unsupported_type", fileName: file.fileName });
    // The decoded length is what the Gateway stores, so the declared size must match it.
    const padding = file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0;
    const decoded = (file.content.length / 4) * 3 - padding;
    if (file.content.length % 4 !== 0 || decoded !== file.sizeBytes) throw new ChatAttachmentError({ code: "size_mismatch", fileName: file.fileName });
    const limit = isImage(file.mimeType) ? limits.maxImageBytes : limits.maxFileBytes;
    if (file.sizeBytes > limit) throw new ChatAttachmentError({ code: isImage(file.mimeType) ? "image_too_large" : "file_too_large", fileName: file.fileName, limit });
    total += file.sizeBytes;
  }
  if (total > limits.maxTotalBytes) throw new ChatAttachmentError({ code: "request_too_large", limit: limits.maxTotalBytes });
}

/** Only the fields OpenClaw 2026.8.1 defines for an attachment; the file keeps its own name. */
export function toGatewayAttachments(attachments: ChatAttachmentInput[]): { type: string; mimeType: string; fileName: string; sizeBytes: number; content: string }[] {
  return attachments.map((file) => ({
    type: isImage(file.mimeType) ? "image" : "file",
    mimeType: file.mimeType,
    fileName: file.fileName,
    sizeBytes: file.sizeBytes,
    content: file.content,
  }));
}

/** With no text of its own, the message still says which files arrived, without inventing a task. */
export const attachmentOnlyMessage = (attachments: ChatAttachmentInput[]): string =>
  `Файлы: ${attachments.map((file) => file.fileName).join(", ")}`;

type RawPart = { type?: string; text?: string; name?: string; fileName?: string; mimeType?: string; mediaType?: string; sizeBytes?: number; size?: number };
const SPOKEN_PARTS = new Set(["text", "toolcall", "toolresult", "reasoning", "thinking"]);

/**
 * Attachment names as the transcript gives them. The exact part shape of 2026.8.1 is not verified,
 * so anything that is not a spoken part and carries a name counts, and nothing is invented.
 */
export function attachmentsOf(parts: RawPart[]): ChatAttachmentDto[] {
  const out: ChatAttachmentDto[] = [];
  for (const part of parts) {
    if (SPOKEN_PARTS.has(String(part.type ?? "").toLowerCase())) continue;
    const fileName = part.fileName ?? part.name;
    if (typeof fileName !== "string" || !fileName.trim()) continue;
    const mimeType = part.mimeType ?? part.mediaType;
    const sizeBytes = part.sizeBytes ?? part.size;
    out.push({
      fileName: fileName.slice(0, 200),
      mimeType: typeof mimeType === "string" ? mimeType.slice(0, 120) : null,
      sizeBytes: typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? sizeBytes : null,
    });
  }
  return out;
}
