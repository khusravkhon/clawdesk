// Files staged for the next chat message: read in the browser, sent with chat.send, never stored by the panel.
// The checks here mirror the server's limits so the owner hears about a problem before sending.
import { CHAT_ATTACHMENT_ACCEPT, type ChatAttachmentInput, type ChatAttachmentLimitsDto } from "@clawdesk/shared";

const SUPPORTED = CHAT_ATTACHMENT_ACCEPT.split(",");

/** What is wrong with a file, as the i18n key under chat.attach and the number it names. */
export type AttachmentProblem =
  | { key: "tooMany"; count: number }
  | { key: "unsupported" }
  | { key: "tooLarge"; limit: number }
  | { key: "tooMuch"; limit: number }
  | { key: "rejected" };

export type AttachmentCheck =
  | { ok: true; mimeType: ChatAttachmentInput["mimeType"] }
  /** stop: later files cannot fit either, so the picker stops at this one. */
  | { ok: false; problem: AttachmentProblem; stop: boolean };

/** Whether one more file fits next to the files already staged. No limits yet (history not loaded): only the type counts. */
export function checkAttachment(file: { size: number; type: string }, staged: { sizeBytes: number }[], limits: ChatAttachmentLimitsDto | null): AttachmentCheck {
  if (limits && staged.length >= limits.maxFiles) return { ok: false, problem: { key: "tooMany", count: limits.maxFiles }, stop: true };
  const mimeType = file.type as ChatAttachmentInput["mimeType"];
  if (!SUPPORTED.includes(mimeType)) return { ok: false, problem: { key: "unsupported" }, stop: false };
  const limit = limits ? (mimeType.startsWith("image/") ? limits.maxImageBytes : limits.maxFileBytes) : Number.POSITIVE_INFINITY;
  if (file.size > limit) return { ok: false, problem: { key: "tooLarge", limit }, stop: false };
  if (limits && staged.reduce((sum, item) => sum + item.sizeBytes, 0) + file.size > limits.maxTotalBytes) {
    return { ok: false, problem: { key: "tooMuch", limit: limits.maxTotalBytes }, stop: true };
  }
  return { ok: true, mimeType };
}

/** The server's reason code for a rejected file, in the same terms as checkAttachment. */
export function rejectedAttachment(details: { code?: string; limit?: number } | undefined): AttachmentProblem | null {
  if (!details?.code) return null;
  switch (details.code) {
    case "too_many_files":
      return { key: "tooMany", count: details.limit ?? 0 };
    case "unsupported_type":
      return { key: "unsupported" };
    case "file_too_large":
    case "image_too_large":
      return { key: "tooLarge", limit: details.limit ?? 0 };
    case "request_too_large":
      return { key: "tooMuch", limit: details.limit ?? 0 };
    default:
      return { key: "rejected" };
  }
}

export function newSendId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const data = crypto.getRandomValues(new Uint8Array(16));
  data[6] = (data[6]! & 0x0f) | 0x40;
  data[8] = (data[8]! & 0x3f) | 0x80;
  const hex = Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export async function toBase64(file: Blob): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In chunks: one spread of a whole file would overflow the argument list.
  for (let i = 0; i < buffer.length; i += 8192) binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
  return btoa(binary);
}
