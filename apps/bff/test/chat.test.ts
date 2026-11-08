import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SendChatRequest } from "@clawdesk/shared";
import { describe, expect, it, vi } from "vitest";
import { ChatService, toChatMessages, toStreamEvent } from "../src/chat/chat-service.js";
import { openDb } from "../src/db/client.js";
import { GatewayUnavailableError, type GatewayService } from "../src/gateway/gateway-service.js";
import { LibraryService } from "../src/library/library-service.js";

describe("toChatMessages", () => {
  it("folds tool calls into the reply and hides tool results", () => {
    const out = toChatMessages([
      { role: "user", content: "Что в папке files?", timestamp: 1 },
      { role: "assistant", stopReason: "toolUse", timestamp: 2, content: [{ type: "toolCall", name: "exec" }, { type: "text", text: "" }] },
      { role: "toolResult", timestamp: 3, content: [{ type: "text", text: "README.txt" }] },
      { role: "assistant", stopReason: "stop", timestamp: 4, content: [{ type: "thinking" }, { type: "text", text: "Там README.txt." }] },
    ]);
    expect(out.map((m) => [m.role, m.text, m.tools, m.status])).toEqual([
      ["user", "Что в папке files?", [], "ok"],
      ["assistant", "Там README.txt.", ["exec"], "ok"],
    ]);
  });

  it("turns OpenClaw's failure placeholder into one error bubble, however often it retried", () => {
    const failed = { role: "assistant", stopReason: "error", content: [{ type: "text", text: "The agent run failed before producing a reply." }] };
    const out = toChatMessages([{ role: "user", content: "Привет", timestamp: 1 }, { ...failed, timestamp: 2 }, { ...failed, timestamp: 3 }, { ...failed, timestamp: 4 }]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: "assistant", text: "", status: "error", at: 4 });
  });

  it("marks stopped turns as aborted", () => {
    const out = toChatMessages([{ role: "assistant", stopReason: "aborted", content: [], timestamp: 5 }]);
    expect(out[0]).toMatchObject({ status: "aborted", text: "" });
  });
});

describe("toStreamEvent", () => {
  const key = "agent:main:main";
  const chat = (payload: Record<string, unknown>) => toStreamEvent({ event: "chat", payload: { sessionKey: key, runId: "r1", seq: 1, ...payload } }, key);

  it("maps run phases, text deltas and the end of a turn", () => {
    expect(chat({ state: "status", phase: "preparing_context" })).toEqual({ type: "status", runId: "r1", phase: "preparing" });
    expect(chat({ state: "status", phase: "starting_model" })).toEqual({ type: "status", runId: "r1", phase: "thinking" });
    expect(chat({ state: "delta", deltaText: "Да," })).toEqual({ type: "delta", runId: "r1", text: "Да,", replace: false });
    expect(chat({ state: "final" })).toEqual({ type: "final", runId: "r1" });
    expect(chat({ state: "error", errorMessage: "LLM idle timeout" })).toEqual({ type: "error", runId: "r1", message: "LLM idle timeout" });
  });

  it("ignores other sessions and events it does not draw", () => {
    expect(toStreamEvent({ event: "chat", payload: { sessionKey: "agent:coach:main", runId: "r", state: "final" } }, key)).toBeNull();
    expect(toStreamEvent({ event: "tick", payload: {} }, key)).toBeNull();
    expect(toStreamEvent({ event: "agent", payload: { sessionKey: key, runId: "r1", stream: "lifecycle", data: {} } }, key)).toBeNull();
  });

  it("reports a tool once, when it starts", () => {
    const tool = (data: Record<string, unknown>) => toStreamEvent({ event: "agent", payload: { sessionKey: key, runId: "r1", stream: "tool", data } }, key);
    expect(tool({ name: "read", phase: "start" })).toEqual({ type: "tool", runId: "r1", name: "read" });
    expect(tool({ name: "read", phase: "result" })).toBeNull();
  });
});

describe("SendChatRequest", () => {
  it("trims and refuses empty messages", () => {
    expect(SendChatRequest.parse({ text: "  привет " }).text).toBe("привет");
    expect(SendChatRequest.safeParse({ text: "   " }).success).toBe(false);
  });
});

describe("chat sends and conversations", () => {
  function fixture(onCleanup: (cleanup: () => void) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-chat-"));
    const dbPath = path.join(dir, "panel.sqlite");
    let opened = openDb(dbPath);
    onCleanup(() => { opened.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const request = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>();
    const listeners = new Set<(event: unknown) => void>();
    const gateway = {
      request,
      onEvent: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    } as unknown as GatewayService;
    const service = () => new ChatService(gateway, new LibraryService(opened.db), opened.db);
    return {
      service, request, listeners,
      restart: () => { opened.close(); opened = openDb(dbPath); return service(); },
      library: () => new LibraryService(opened.db),
    };
  }

  const attachment = { fileName: "note.txt", mimeType: "text/plain" as const, sizeBytes: 4, content: "dGV4dA==" };

  it("shares concurrent sends and returns the accepted result after an HTTP response is lost", async ({ onTestFinished }) => {
    const { service, request, restart, library } = fixture(onTestFinished);
    const chat = service();
    const id = randomUUID();
    request.mockResolvedValue({ runId: id });
    const first = chat.send("main", "Read", [attachment], id);
    const retry = chat.send("main", "Read", [attachment], id);
    await expect(chat.send("main", "Different", [attachment], id)).rejects.toMatchObject({ code: "send_conflict" });
    const result = await first;
    expect(await retry).toEqual(result);
    expect(await restart().send("main", "Read", [attachment], id)).toEqual(result);
    expect(request).toHaveBeenCalledExactlyOnceWith("chat.send", expect.objectContaining({ idempotencyKey: id }));
    expect(library().recent()).toHaveLength(1);
  });

  it("recovers a lost Gateway acknowledgment by the exact run and never sends again without evidence", async ({ onTestFinished }) => {
    const { service, request, restart, library } = fixture(onTestFinished);
    const id = randomUUID();
    request.mockRejectedValueOnce(new Error("socket closed after dispatch"));
    await expect(service().send("main", "Read", [attachment], id)).rejects.toMatchObject({ code: "send_unknown" });
    const chat = restart();
    request.mockResolvedValueOnce({ inFlightRun: { runId: "other" }, messages: [{ role: "user", content: "Read" }] });
    await expect(chat.send("main", "Read", [attachment], id)).rejects.toMatchObject({ code: "send_unknown" });
    request.mockResolvedValueOnce({ messages: [{ role: "user", content: "Read", __openclaw: { idempotencyKey: `${id}:user` } }] });
    await expect(chat.history("main", 60, undefined, id)).resolves.toMatchObject({ acceptedSend: true, running: false });
    await expect(chat.send("main", "Read", [attachment], id)).resolves.toMatchObject({ runId: id });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.send", "chat.history", "chat.history"]);
    expect(library().recent()).toHaveLength(1);
  });

  it("allows the same content and identifier to be retried after a known rejection before dispatch", async ({ onTestFinished }) => {
    const { service, request, library } = fixture(onTestFinished);
    const id = randomUUID();
    const chat = service();
    request.mockRejectedValueOnce(new GatewayUnavailableError({ state: "disconnected", serverVersion: null, protocol: null, scopes: [], hint: null, lastError: null }));
    await expect(chat.send("main", "Read", [attachment], id)).rejects.toMatchObject({ code: "send_rejected" });
    request.mockResolvedValueOnce({ runId: id });
    await expect(chat.send("main", "Read", [attachment], id)).resolves.toMatchObject({ runId: id });
    expect(request.mock.calls.map(([method, params]) => [method, params.idempotencyKey])).toEqual([["chat.send", id], ["chat.send", id]]);
    expect(library().recent()).toHaveLength(1);
  });

  it("keeps named conversation history, events and aborts separate from the main session", async ({ onTestFinished }) => {
    const { service, request, listeners, restart } = fixture(onTestFinished);
    request.mockImplementation(async (method, params) => method === "sessions.create" ? { key: params.key } : {});
    const created = await service().createConversation("main", "Travel");
    const chat = restart();
    expect(chat.conversations("main")).toEqual([created]);
    expect(chat.conversations("coach")).toEqual([]);
    await expect(chat.history("coach", 60, created.id)).rejects.toMatchObject({ code: "conversation_missing" });
    const key = `agent:main:clawdesk-chat-${created.id}`;
    const [main, topic] = [vi.fn(), vi.fn()];
    chat.subscribe("main", main);
    chat.subscribe("main", topic, created.id);
    for (const sessionKey of [key, "agent:main:main"]) {
      for (const listener of listeners) listener({ event: "chat", payload: { sessionKey, state: "final", runId: sessionKey } });
    }
    expect(topic).toHaveBeenCalledExactlyOnceWith({ type: "final", runId: key });
    expect(main).toHaveBeenCalledExactlyOnceWith({ type: "final", runId: "agent:main:main" });
    await chat.history("main", 60, created.id);
    await chat.abort("main", created.id);
    expect(request.mock.calls.map(([method, params]) => [method, params.sessionKey ?? params.key])).toEqual([
      ["sessions.create", key], ["chat.history", key], ["chat.abort", key],
    ]);
  });
});
