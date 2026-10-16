import { randomUUID } from "node:crypto";
import type { ChatAttachmentInput, ChatAttachmentLimitsDto, ChatHistoryDto, ChatMessageDto, ChatRunPhase, ChatStreamEvent, SendChatResultDto } from "@clawdesk/shared";
import { documentsBlock, extractDocuments } from "../documents/extract.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { attachmentLimits, attachmentOnlyMessage, attachmentsOf, checkAttachments, toGatewayAttachments } from "./chat-attachments.js";

// Chat with an agent's main session: chat.send / chat.history / chat.abort, and the Gateway's
// `chat` + `agent` events reduced to what the chat screen draws.

type RawPart = { type: string; text?: string; name?: string; fileName?: string; mimeType?: string; sizeBytes?: number };
export type RawChatMessage = { role: string; content?: string | RawPart[]; timestamp?: number; stopReason?: string };

/** OpenClaw's placeholder when a turn ended without any reply text. */
const FAILED_PLACEHOLDER = "The agent run failed before producing a reply.";

export const mainSessionKey = (agentId: string) => `agent:${agentId}:main`;

const partsOf = (m: RawChatMessage): RawPart[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []));
const textOf = (m: RawChatMessage) =>
  partsOf(m)
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
    .trim();

/**
 * Transcript → chat bubbles. Tool calls and their results are folded into the reply that follows
 * them; repeated failure placeholders (OpenClaw retries) collapse into one.
 */
export function toChatMessages(raw: RawChatMessage[]): ChatMessageDto[] {
  const out: ChatMessageDto[] = [];
  let pendingTools: string[] = [];
  raw.forEach((m, index) => {
    const id = `${m.timestamp ?? 0}-${index}`;
    const at = m.timestamp ?? null;
    if (m.role === "user") {
      const text = textOf(m);
      const attachments = attachmentsOf(partsOf(m));
      if (text || attachments.length) out.push({ id, role: "user", text, tools: [], attachments, at, status: "ok" });
      pendingTools = [];
      return;
    }
    if (m.role !== "assistant") return; // toolResult and system entries are not bubbles
    const tools = partsOf(m)
      .filter((p) => p.type === "toolCall" && p.name)
      .map((p) => p.name!);
    let text = textOf(m);
    if (m.stopReason === "toolUse" && !text) {
      pendingTools.push(...tools);
      return;
    }
    const failed = m.stopReason === "error" || text === FAILED_PLACEHOLDER;
    if (text === FAILED_PLACEHOLDER) text = "";
    const status: ChatMessageDto["status"] = failed ? "error" : m.stopReason === "aborted" ? "aborted" : "ok";
    const prev = out.at(-1);
    if (status !== "ok" && !text && prev?.role === "assistant" && prev.status === status && !prev.text) {
      prev.at = at; // the same failure retried
      return;
    }
    out.push({ id, role: "assistant", text, tools: [...pendingTools, ...tools], attachments: [], at, status });
    pendingTools = [];
  });
  return out;
}

const STARTUP_PHASE: Record<string, ChatRunPhase> = {
  preparing_workspace: "preparing",
  naming_worktree: "preparing",
  creating_worktree: "preparing",
  running_setup: "preparing",
  provisioning_environment: "preparing",
  preparing_context: "preparing",
  starting_model: "thinking",
};

type GatewayEvent = { event: string; payload?: unknown };

/** One Gateway event → the chat stream event for `sessionKey`, or null when it is not ours / not drawn. */
export function toStreamEvent(event: GatewayEvent, sessionKey: string): ChatStreamEvent | null {
  const p = (event.payload ?? {}) as Record<string, unknown> & { sessionKey?: string; runId?: string };
  if (p.sessionKey !== sessionKey || typeof p.runId !== "string") return null;
  const runId = p.runId;
  if (event.event === "chat") {
    switch (p.state) {
      case "status":
        return { type: "status", runId, phase: STARTUP_PHASE[String(p.phase)] ?? "thinking" };
      case "delta":
        return { type: "delta", runId, text: String(p.deltaText ?? ""), replace: p.replace === true };
      case "final":
        return { type: "final", runId };
      case "error":
        return { type: "error", runId, message: typeof p.errorMessage === "string" ? p.errorMessage : null };
      case "aborted":
        return { type: "aborted", runId };
      default:
        return null;
    }
  }
  if (event.event === "agent" && p.stream === "tool") {
    const data = (p.data ?? {}) as { name?: unknown; toolName?: unknown; phase?: unknown };
    const name = typeof data.name === "string" ? data.name : typeof data.toolName === "string" ? data.toolName : null;
    // One line per tool call, when it starts.
    if (name && (data.phase === undefined || data.phase === "start")) return { type: "tool", runId, name };
  }
  return null;
}

export class ChatService {
  constructor(private readonly gateway: GatewayService) {}

  async history(agentId: string, limit = 60): Promise<ChatHistoryDto> {
    const res = await this.gateway.request<{ messages?: RawChatMessage[]; inFlightRun?: unknown }>("chat.history", {
      sessionKey: mainSessionKey(agentId),
      agentId,
      limit,
    });
    return { agentId, messages: toChatMessages(res.messages ?? []), running: !!res.inFlightRun, attachments: this.attachmentLimits() };
  }

  /** What this Gateway accepts for attachments right now (empty handshake: the panel's own caps). */
  attachmentLimits(): ChatAttachmentLimitsDto {
    return attachmentLimits(this.gateway.hello as Parameters<typeof attachmentLimits>[0]);
  }

  async send(agentId: string, text: string, attachments: ChatAttachmentInput[] = []): Promise<SendChatResultDto> {
    if (attachments.length) checkAttachments(attachments, this.attachmentLimits());
    // The panel reads what it can out of the files and adds that text to the message; the files
    // themselves still travel to the Gateway, so a tool of the agent can read them its own way.
    const documents = attachments.length
      ? await extractDocuments(attachments.map((file) => ({ fileName: file.fileName, mimeType: file.mimeType, bytes: Buffer.from(file.content, "base64") })))
      : [];
    const block = documentsBlock(documents);
    const message = [text || attachmentOnlyMessage(attachments), block].filter(Boolean).join("\n\n");
    const res = await this.gateway.request<{ runId?: string }>("chat.send", {
      sessionKey: mainSessionKey(agentId),
      agentId,
      message,
      idempotencyKey: randomUUID(),
      ...(attachments.length ? { attachments: toGatewayAttachments(attachments) } : {}),
    });
    return { runId: res.runId ?? null, reads: documents.map((document) => document.read) };
  }

  async abort(agentId: string): Promise<void> {
    await this.gateway.request("chat.abort", { sessionKey: mainSessionKey(agentId), agentId });
  }

  /** Streams this agent's turn events until the returned function is called. */
  subscribe(agentId: string, listener: (event: ChatStreamEvent) => void): () => void {
    const sessionKey = mainSessionKey(agentId);
    return this.gateway.onEvent((event) => {
      const mapped = toStreamEvent(event as GatewayEvent, sessionKey);
      if (mapped) listener(mapped);
    });
  }
}
