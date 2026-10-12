import { SendChatRequest } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { toChatMessages, toStreamEvent } from "../src/chat/chat-service.js";

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
