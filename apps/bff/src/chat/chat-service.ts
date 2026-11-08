import { createHash, randomUUID } from "node:crypto";
import type { ChatAttachmentInput, ChatAttachmentLimitsDto, ChatConversation, ChatHistoryDto, ChatMessageDto, ChatRunPhase, ChatStreamEvent, SendChatResultDto } from "@clawdesk/shared";
import { panelChatSessionKey } from "@clawdesk/shared";
import { GatewayClientRequestError } from "@openclaw/gateway-client";
import { and, desc, eq, max, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { chatConversations, chatSends } from "../db/schema.js";
import { documentsBlock, extractDocuments } from "../documents/extract.js";
import { GatewayUnavailableError, type GatewayService } from "../gateway/gateway-service.js";
import type { NewLibraryItem } from "../library/library-service.js";
import { attachmentLimits, attachmentOnlyMessage, attachmentsOf, checkAttachments, toGatewayAttachments } from "./chat-attachments.js";

// Chat with an agent's main session: chat.send / chat.history / chat.abort, and the Gateway's
// `chat` + `agent` events reduced to what the chat screen draws.

type RawPart = { type: string; text?: string; name?: string; fileName?: string; mimeType?: string; sizeBytes?: number };
export type RawChatMessage = { role: string; content?: string | RawPart[]; timestamp?: number; stopReason?: string; __openclaw?: { idempotencyKey?: string } };

/** OpenClaw's placeholder when a turn ended without any reply text. */
const FAILED_PLACEHOLDER = "The agent run failed before producing a reply.";

export const mainSessionKey = (agentId: string) => panelChatSessionKey(agentId);

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

type RawHistory = {
  messages?: RawChatMessage[];
  inFlightRun?: { runId?: string };
  inputReceipts?: { runId: string; state: string }[];
};

export class ChatSendError extends Error {
  constructor(readonly code: "send_conflict" | "send_unknown" | "send_rejected" | "conversation_missing", message: string) {
    super(message);
  }
}

export class ChatService {
  readonly #pending = new Map<string, { fingerprint: string; result: Promise<SendChatResultDto> }>();

  constructor(
    private readonly gateway: GatewayService,
    /** Keeps what the panel read out of a file, so the owner can find it again later. */
    private readonly library?: { add(item: NewLibraryItem): string | null },
    private readonly db?: Db,
  ) {}

  #sessionKey(agentId: string, conversationId?: string): string {
    if (!conversationId) return mainSessionKey(agentId);
    const row = this.db?.select({ id: chatConversations.id }).from(chatConversations)
      .where(and(eq(chatConversations.id, conversationId), eq(chatConversations.agentId, agentId))).get();
    if (!row) throw new ChatSendError("conversation_missing", "no such conversation for this agent");
    return panelChatSessionKey(agentId, row.id);
  }

  conversations(agentId: string): ChatConversation[] {
    return this.db!.select({ id: chatConversations.id, title: chatConversations.title }).from(chatConversations)
      .where(eq(chatConversations.agentId, agentId)).orderBy(desc(chatConversations.createdAt), desc(chatConversations.id)).all();
  }

  recentConversations(): { agentId: string; id: string | null; title: string | null; at: number }[] {
    const db = this.db!;
    const last = max(chatSends.acceptedAt);
    return db.select({ key: chatSends.sessionKey, at: last }).from(chatSends)
      .where(eq(chatSends.state, "accepted")).groupBy(chatSends.sessionKey).orderBy(desc(last)).limit(5).all()
      .flatMap(({ key, at }) => {
        const [, agentId, id] = /^agent:([^:]+):(?:main|clawdesk-chat-(.+))$/.exec(key) ?? [];
        if (!agentId || at === null) return [];
        const title = id ? db.select({ title: chatConversations.title }).from(chatConversations).where(eq(chatConversations.id, id)).get()?.title : null;
        return [{ agentId, id: id ?? null, title: title ?? null, at }];
      });
  }

  async createConversation(agentId: string, title: string): Promise<ChatConversation> {
    const id = randomUUID();
    const key = panelChatSessionKey(agentId, id);
    const created = await this.gateway.request<{ key: string }>("sessions.create", { key, agentId, label: title });
    if (created.key !== key) throw new Error("Gateway returned an unexpected conversation key");
    this.db!.insert(chatConversations).values({ id, agentId, title, createdAt: Date.now() }).run();
    return { id, title };
  }

  #readHistory(agentId: string, sessionKey: string, limit: number, sendId?: string): Promise<RawHistory> {
    return this.gateway.request<RawHistory>("chat.history", {
      sessionKey,
      agentId,
      limit,
      ...(sendId ? { inputRunIds: [sendId] } : {}),
    });
  }

  async history(agentId: string, limit = 60, conversationId?: string, sendId?: string): Promise<ChatHistoryDto> {
    const sessionKey = this.#sessionKey(agentId, conversationId);
    const res = await this.#readHistory(agentId, sessionKey, limit, sendId);
    const row = sendId ? this.db?.select().from(chatSends).where(eq(chatSends.id, sendId)).get() : undefined;
    const acceptedSend = row?.sessionKey === sessionKey && (row.state === "accepted" || this.#acceptFromHistory(row, res));
    return {
      agentId, messages: toChatMessages(res.messages ?? []), running: !!res.inFlightRun, runId: res.inFlightRun?.runId ?? null,
      attachments: this.attachmentLimits(), ...(sendId ? { acceptedSend: !!acceptedSend } : {}),
    };
  }

  #acceptFromHistory(row: typeof chatSends.$inferSelect, history: RawHistory): boolean {
    const accepted = history.inFlightRun?.runId === row.id
      || history.inputReceipts?.some((receipt) => receipt.runId === row.id && receipt.state === "consumed")
      || history.messages?.some((msg) => msg.role === "user" && msg.__openclaw?.idempotencyKey === `${row.id}:user`);
    if (accepted) this.#accept(row.id, row.result);
    return !!accepted;
  }

  #accept(id: string, result: SendChatResultDto): void {
    this.db!.update(chatSends).set({ state: "accepted", result, acceptedAt: Date.now() })
      .where(and(eq(chatSends.id, id), ne(chatSends.state, "accepted"))).run();
  }

  /** What this Gateway accepts for attachments right now (empty handshake: the panel's own caps). */
  attachmentLimits(): ChatAttachmentLimitsDto {
    return attachmentLimits(this.gateway.hello as Parameters<typeof attachmentLimits>[0]);
  }

  async send(agentId: string, text: string, attachments: ChatAttachmentInput[] = [], sendId?: string, conversationId?: string): Promise<SendChatResultDto> {
    const sessionKey = this.#sessionKey(agentId, conversationId);
    if (!sendId || !this.db) return this.#send(agentId, sessionKey, text, attachments, randomUUID());
    const fileMetadata = attachments.map(({ fileName, mimeType, sizeBytes }) => [fileName, mimeType, sizeBytes]);
    const hash = createHash("sha256").update(JSON.stringify([sessionKey, text, fileMetadata]));
    for (const file of attachments) hash.update("\0").update(file.content);
    const fingerprint = hash.digest("hex");
    const pending = this.#pending.get(sendId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new ChatSendError("send_conflict", "this send identifier is already used with different content");
      return pending.result;
    }
    const result = this.#send(agentId, sessionKey, text, attachments, sendId, fingerprint);
    this.#pending.set(sendId, { fingerprint, result });
    try {
      return await result;
    } finally {
      this.#pending.delete(sendId);
    }
  }

  async #send(agentId: string, sessionKey: string, text: string, attachments: ChatAttachmentInput[], sendId: string, fingerprint?: string): Promise<SendChatResultDto> {
    const db = fingerprint ? this.db! : undefined;
    const row = db?.select().from(chatSends).where(eq(chatSends.id, sendId)).get();
    if (row && row.fingerprint !== fingerprint) throw new ChatSendError("send_conflict", "this send identifier is already used with different content");
    if (row?.state === "accepted") return row.result;
    if (row?.state === "dispatched") {
      // A lost response is not permission to launch again. Ask for positive evidence of this exact run.
      const history = await this.#readHistory(agentId, sessionKey, 60, sendId).catch(() => null);
      if (history && this.#acceptFromHistory(row, history)) return row.result;
      throw new ChatSendError("send_unknown", "the Gateway has not confirmed this send");
    }
    if (attachments.length) checkAttachments(attachments, this.attachmentLimits());
    // The panel reads what it can out of the files and adds that text to the message; the files
    // themselves still travel to the Gateway, so a tool of the agent can read them its own way.
    const documents = attachments.length
      ? await extractDocuments(attachments.map((file) => ({ fileName: file.fileName, mimeType: file.mimeType, bytes: Buffer.from(file.content, "base64") })))
      : [];
    const block = documentsBlock(documents);
    const reads = documents.map((document) => document.read);
    const saveDocuments = () => {
      for (const document of documents) {
        const read = document.read;
        if (read.state === "image") continue;
        const locator = read.pages !== null ? "страница" : read.sheets !== null ? "лист" : read.slides !== null ? "слайд" : null;
        this.library?.add({ agentId, kind: "document", title: read.fileName, source: read.fileName, locator, text: document.text, processing: read.state });
      }
    };
    if (db && fingerprint) {
      if (!row) {
        const inserted = db.transaction(() => {
          const insert = db.insert(chatSends).values({ id: sendId, sessionKey, fingerprint, state: "ready", result: { runId: sendId, reads } })
            .onConflictDoNothing().run();
          if (!insert.changes) return false;
          saveDocuments();
          return true;
        });
        if (!inserted) throw new ChatSendError("send_unknown", "the send is being processed; check its status");
      }
      const claimed = db.update(chatSends).set({ state: "dispatched" })
        .where(and(eq(chatSends.id, sendId), eq(chatSends.state, "ready"))).run();
      if (!claimed.changes) throw new ChatSendError("send_unknown", "the send is being processed; check its status");
    } else {
      saveDocuments();
    }
    const message = [text || attachmentOnlyMessage(attachments), block].filter(Boolean).join("\n\n");
    let res: { runId?: string };
    try {
      res = await this.gateway.request("chat.send", {
        sessionKey,
        agentId,
        message,
        idempotencyKey: sendId,
        ...(attachments.length ? { attachments: toGatewayAttachments(attachments) } : {}),
      });
    } catch (error) {
      if (!db) throw error;
      if (error instanceof GatewayUnavailableError || (error instanceof GatewayClientRequestError && error.gatewayCode === "INVALID_REQUEST")) {
        db.update(chatSends).set({ state: "ready" }).where(and(eq(chatSends.id, sendId), eq(chatSends.state, "dispatched"))).run();
        throw new ChatSendError("send_rejected", error.message);
      }
      throw new ChatSendError("send_unknown", "the Gateway has not confirmed this send");
    }
    const result = { runId: res.runId ?? (db ? sendId : null), reads };
    if (db) this.#accept(sendId, result);
    return result;
  }

  /**
   * Sends an audio track with a message, for the agent's own speech recognition (the owner's
   * configured provider). The panel does not transcribe it and does not claim that it did.
   */
  async sendAudio(agentId: string, text: string, audio: { mimeType: string; fileName: string; content: string; durationMs: number | null }): Promise<{ runId: string | null }> {
    const res = await this.gateway.request<{ runId?: string }>("chat.send", {
      sessionKey: mainSessionKey(agentId),
      agentId,
      message: text,
      idempotencyKey: randomUUID(),
      attachments: [
        {
          type: "audio",
          mimeType: audio.mimeType,
          fileName: audio.fileName,
          content: audio.content,
          sizeBytes: Math.floor((audio.content.length / 4) * 3),
          ...(audio.durationMs ? { durationMs: audio.durationMs } : {}),
        },
      ],
    });
    return { runId: res.runId ?? null };
  }

  /**
   * Sends images with a message — sampled video frames, for an agent whose model can read them.
   * The panel does not look at them itself and claims nothing about what they show.
   */
  async sendImages(agentId: string, text: string, images: { mimeType: string; fileName: string; content: string }[]): Promise<{ runId: string | null }> {
    const res = await this.gateway.request<{ runId?: string }>("chat.send", {
      sessionKey: mainSessionKey(agentId),
      agentId,
      message: text,
      idempotencyKey: randomUUID(),
      attachments: images.map((image) => ({ type: "image", mimeType: image.mimeType, fileName: image.fileName, content: image.content, sizeBytes: Math.floor((image.content.length / 4) * 3) })),
    });
    return { runId: res.runId ?? null };
  }

  async abort(agentId: string, conversationId?: string): Promise<void> {
    await this.gateway.request("chat.abort", { sessionKey: this.#sessionKey(agentId, conversationId), agentId });
  }

  /** Streams this agent's turn events until the returned function is called. */
  subscribe(agentId: string, listener: (event: ChatStreamEvent) => void, conversationId?: string): () => void {
    const sessionKey = this.#sessionKey(agentId, conversationId);
    return this.gateway.onEvent((event) => {
      const mapped = toStreamEvent(event as GatewayEvent, sessionKey);
      if (mapped) listener(mapped);
    });
  }
}
