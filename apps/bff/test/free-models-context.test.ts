import { describe, expect, it } from "vitest";
import { autoContextWindow, DEFAULT_CONTEXT_WINDOW } from "../src/free-models/free-models-service.js";

describe("the free models' context window OpenClaw is told", () => {
  it("is what FreeLLMAPI reports for auto, within sane bounds", () => {
    expect(autoContextWindow({ data: [{ id: "gemini-2.5-flash", context_window: 1_048_576 }, { id: "auto", context_window: 65_536 }] })).toBe(65_536);
    expect(autoContextWindow({ data: [{ id: "auto", context_length: 1_048_576 }] })).toBe(131_072);
    expect(autoContextWindow({ data: [{ id: "auto", context_window: 4096 }] })).toBe(8192);
  });

  it("stays at the safe default when FreeLLMAPI cannot say", () => {
    for (const body of [null, {}, { data: [] }, { data: [{ id: "auto" }] }, { data: [{ id: "auto", context_window: "big" }] }]) {
      expect(autoContextWindow(body)).toBe(DEFAULT_CONTEXT_WINDOW);
    }
  });
});
