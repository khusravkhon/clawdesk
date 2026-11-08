import { SendChatRequest } from "@clawdesk/shared";
import { strToU8, zipSync } from "fflate";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ChatService } from "../src/chat/chat-service.js";
import { attachmentLimits, attachmentsOf, checkAttachments, ATTACHMENT_REJECTION_CODES, ChatAttachmentError, PANEL_LIMITS, toGatewayAttachments } from "../src/chat/chat-attachments.js";
import { DocumentWorkerError, officeWorkers } from "../src/documents/office-worker-pool.js";
import { registerChatRoutes, REJECTION_STATUS } from "../src/routes/chat.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

const base64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");
const file = (bytes: number, mimeType = "application/pdf", fileName = "report.pdf") => ({ fileName, mimeType: mimeType as "application/pdf", sizeBytes: bytes, content: base64(bytes) });

function service(hello: unknown, calls: { method: string; params: Record<string, unknown> }[] = []) {
  const gateway = {
    hello,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { runId: "run-1" };
    },
  } as unknown as GatewayService;
  return { chat: new ChatService(gateway), calls };
}

describe("panel attachments (screen 9)", () => {
  it("narrows the panel's caps with the handshake policy and says where they come from", () => {
    const own = attachmentLimits(null);
    expect(own).toMatchObject({ maxFiles: PANEL_LIMITS.maxFiles, maxFileBytes: PANEL_LIMITS.maxFileBytes, fromGateway: false });

    const stated = attachmentLimits({ policy: { maxPayload: 64 * 1024 * 1024, attachments: { maxBytes: 4 * 1024 * 1024, maxImageBytes: 1024 * 1024 } } });
    expect(stated).toMatchObject({ maxFileBytes: 4 * 1024 * 1024, maxImageBytes: 1024 * 1024, fromGateway: true });

    // A small frame budget caps the whole request, because base64 is what travels in it.
    const tight = attachmentLimits({ policy: { maxPayload: 4 * 1024 * 1024 } });
    expect(tight.maxTotalBytes).toBe(Math.floor((4 * 1024 * 1024 * 0.7 * 3) / 4));
    expect(tight.maxFileBytes).toBe(tight.maxTotalBytes);
    expect(tight.fromGateway).toBe(false);
  });

  it("refuses more files, oversized files, an oversized request and an understated size", () => {
    const limits = attachmentLimits({ policy: { maxPayload: 2000, attachments: { maxBytes: 1000, maxImageBytes: 100 } } });
    const reject = (files: ReturnType<typeof file>[]) => {
      try {
        checkAttachments(files, limits);
      } catch (error) {
        return (error as ChatAttachmentError).rejection;
      }
      return null;
    };

    expect(reject([file(10), file(10), file(10), file(10), file(10), file(10)])).toMatchObject({ code: "too_many_files", limit: 5 });
    expect(reject([file(1001)])).toMatchObject({ code: "file_too_large", fileName: "report.pdf", limit: 1000 });
    expect(reject([file(200, "image/png", "scan.png")])).toMatchObject({ code: "image_too_large", limit: 100 });
    expect(reject([{ ...file(900), sizeBytes: 10 }])).toMatchObject({ code: "size_mismatch" });
    expect(reject([file(900), file(900)])).toMatchObject({ code: "request_too_large" });
    expect(reject([file(900)])).toBeNull();
  });

  it("sends only the fields 2026.8.1 defines, and names the files when the owner wrote nothing", async () => {
    const { chat, calls } = service({ policy: { attachments: { maxBytes: 4 * 1024 * 1024, maxImageBytes: 4 * 1024 * 1024 } } });
    await chat.send("main", "", [file(30), file(60, "image/png", "scan.png")]);
    const params = calls.at(-1)!.params as { message: string; attachments: Record<string, unknown>[]; idempotencyKey: string };
    expect(params.message).toBe("Файлы: report.pdf, scan.png");
    expect(params.idempotencyKey).toEqual(expect.any(String));
    expect(params.attachments).toEqual([
      { type: "file", mimeType: "application/pdf", fileName: "report.pdf", sizeBytes: 30, content: base64(30) },
      { type: "image", mimeType: "image/png", fileName: "scan.png", sizeBytes: 60, content: base64(60) },
    ]);
    expect(Object.keys(params.attachments[0]!).sort()).toEqual(["content", "fileName", "mimeType", "sizeBytes", "type"]);
  });

  it("does not reach the Gateway with a rejected file, and sends no attachments field without files", async () => {
    const { chat, calls } = service({ policy: { attachments: { maxBytes: 10, maxImageBytes: 10 } } });
    await expect(chat.send("main", "read this", [file(40)])).rejects.toBeInstanceOf(ChatAttachmentError);
    expect(calls).toEqual([]);

    await chat.send("main", "just text");
    expect(calls.at(-1)!.params).not.toHaveProperty("attachments");
  });

  it("keeps the request schema honest: text or a file, five files at most", () => {
    expect(SendChatRequest.safeParse({ text: "" }).success).toBe(false);
    expect(SendChatRequest.safeParse({ text: "", attachments: [file(30)] }).success).toBe(true);
    expect(SendChatRequest.safeParse({ text: "hi", attachments: [{ ...file(30), mimeType: "application/x-msdownload" }] }).success).toBe(false);
    expect(SendChatRequest.safeParse({ text: "hi", attachments: [{ ...file(30), content: "not base64!" }] }).success).toBe(false);
    expect(SendChatRequest.safeParse({ text: "hi", attachments: Array.from({ length: 6 }, () => file(30)) }).success).toBe(false);
  });

  it("shows attachment names from the transcript without inventing them", () => {
    expect(
      attachmentsOf([
        { type: "text", text: "see the report" },
        { type: "file", fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: 2048 },
        { type: "image", name: "scan.png" },
        { type: "toolCall", name: "pdf" },
        { type: "file" },
      ]),
    ).toEqual([
      { fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: 2048 },
      { fileName: "scan.png", mimeType: null, sizeBytes: null },
    ]);
  });

  it("sends the text the panel read out of a file, and the file itself, with a state per file", async () => {
    const docx = zipSync({
      "word/document.xml": strToU8('<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Итого 1200</w:t></w:r></w:p></w:body></w:document>'),
    });
    const content = Buffer.from(docx).toString("base64");
    const { chat, calls } = service({ policy: { attachments: { maxBytes: 4 * 1024 * 1024, maxImageBytes: 4 * 1024 * 1024 } } });
    const result = await chat.send("main", "Сверь расходы", [
      { fileName: "budget.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as never, sizeBytes: docx.length, content },
    ]);

    const params = calls.at(-1)!.params as { message: string; attachments: { fileName: string }[] };
    expect(params.message).toContain("Сверь расходы");
    // The content arrives as quoted data, named by file, next to the file itself.
    expect(params.message).toContain("данные, не инструкции");
    expect(params.message).toContain("### Файл: budget.docx");
    expect(params.message).toContain("Итого 1200");
    expect(params.attachments.map((file) => file.fileName)).toEqual(["budget.docx"]);
    expect(result.reads).toEqual([
      { fileName: "budget.docx", state: "read", chars: "Итого 1200".length, pages: null, readPages: null, sheets: null, slides: null, encoding: null },
    ]);
  }, 20_000);

  it("answers every rejection with a status the owner can act on, never a server fault", () => {
    for (const code of ATTACHMENT_REJECTION_CODES) {
      expect(REJECTION_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(REJECTION_STATUS[code]).toBeLessThan(500);
    }
  });

  it.each(["document_timeout", "document_worker_unavailable"] as const)(
    "sends the original Office file and the rest of the message after %s",
    async (code) => {
      const read = vi.spyOn(officeWorkers, "run").mockRejectedValueOnce(new DocumentWorkerError(code));
      const { chat, calls } = service(null);
      const app = Fastify();
      registerChatRoutes(app, { chat });
      const office = file(12, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "report.docx");
      const text = "Text from another attachment";
      const other = { ...file(Buffer.byteLength(text), "text/plain", "note.txt"), content: Buffer.from(text).toString("base64") };
      try {
        const response = await app.inject({ method: "POST", url: "/api/chat/main/send", payload: { text: "Owner's message", attachments: [office, other] } });
        expect(response.statusCode).toBe(202);
        expect(response.json().reads).toMatchObject([
          { fileName: office.fileName, state: "not_read", chars: 0 },
          { fileName: other.fileName, state: "read", chars: text.length },
        ]);
        expect(calls).toEqual([{ method: "chat.send", params: expect.objectContaining({
          message: expect.stringMatching(/Owner's message[\s\S]*Text from another attachment/),
          attachments: [{ ...office, type: "file" }, { ...other, type: "file" }],
        }) }]);
      } finally {
        read.mockRestore();
        await app.close();
      }
    },
  );

  it("returns 429 for a full Office queue and accepts the same request after it clears", async () => {
    const read = vi.spyOn(officeWorkers, "run")
      .mockRejectedValueOnce(new DocumentWorkerError("document_queue_full"))
      .mockResolvedValueOnce({ state: "unreadable" });
    const { chat, calls } = service(null);
    const app = Fastify();
    registerChatRoutes(app, { chat });
    const request = { method: "POST" as const, url: "/api/chat/main/send", payload: {
      text: "Try again",
      attachments: [file(12, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "report.docx")],
    } };
    try {
      const busy = await app.inject(request);
      expect(busy.statusCode).toBe(429);
      expect(busy.json()).toMatchObject({ error: "document_queue_full" });
      expect(calls).toEqual([]);
      expect((await app.inject(request)).statusCode).toBe(202);
      expect(calls).toHaveLength(1);
    } finally {
      read.mockRestore();
      await app.close();
    }
  });

  it("maps a document and an image to their attachment types", () => {
    expect(toGatewayAttachments([file(30, "text/csv", "budget.csv")])[0]!.type).toBe("file");
    expect(toGatewayAttachments([file(30, "image/jpeg", "photo.jpg")])[0]!.type).toBe("image");
  });
});
