import { AssistantProfile } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { memoryBroken, memoryChoices, upsertBlock } from "../src/assistant/assistant-service.js";

describe("upsertBlock", () => {
  it("adds the panel's block once and replaces it on the next save", () => {
    const openclaw = "# AGENTS.md\n\nOpenClaw rules.\n";
    const first = upsertBlock(openclaw, "## Juniors\nv1", "bottom");
    expect(first.startsWith("# AGENTS.md")).toBe(true);
    expect(first).toContain("v1");
    const second = upsertBlock(first, "## Juniors\nv2", "bottom");
    expect(second).toContain("OpenClaw rules.");
    expect(second).toContain("v2");
    expect(second).not.toContain("v1");
    expect(second.match(/clawdesk:start/g)).toHaveLength(1);
  });

  it("keeps what the assistant learned around the block", () => {
    const learned = upsertBlock("## Directives\n- Prefer short answers.", "# О владельце\nКусрав", "top");
    const updated = upsertBlock(learned, "# О владельце\nХусрав, Душанбе", "top");
    expect(updated.indexOf("Хусрав")).toBeLessThan(updated.indexOf("Prefer short answers"));
    expect(updated).toContain("- Prefer short answers.");
  });
});

describe("memory", () => {
  it("offers what works with the connected AI, keyword search always", () => {
    expect(memoryChoices(["google"])).toEqual({ options: ["gemini", "none"], recommended: "gemini" });
    expect(memoryChoices(["anthropic"])).toEqual({ options: ["none"], recommended: "none" });
  });

  it("OpenClaw's default (OpenAI) is broken without an OpenAI key", () => {
    expect(memoryBroken(null, ["google"])).toBe(true);
    expect(memoryBroken("gemini", ["google"])).toBe(false);
    expect(memoryBroken("none", [])).toBe(false);
    expect(memoryBroken("openai", ["openai"])).toBe(false);
  });
});

describe("AssistantProfile", () => {
  it("requires a name and keeps reply length sane", () => {
    const base = { name: "Ася", emoji: "🧭", character: "", aboutUser: "", summaryMaxLines: "10" };
    expect(AssistantProfile.parse(base).summaryMaxLines).toBe(10);
    expect(AssistantProfile.safeParse({ ...base, name: " " }).success).toBe(false);
    expect(AssistantProfile.safeParse({ ...base, summaryMaxLines: 500 }).success).toBe(false);
  });
});
