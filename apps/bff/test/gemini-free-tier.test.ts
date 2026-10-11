import { describe, expect, it } from "vitest";
import { selectFlashModel } from "../src/ai-setup/gemini-free-tier.js";

const gen = ["generateContent", "countTokens"];

describe("selectFlashModel", () => {
  it("prefers the newest stable Flash chat model", () => {
    expect(
      selectFlashModel([
        { name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: gen },
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: gen },
        { name: "models/gemini-3-flash", supportedGenerationMethods: gen },
        { name: "models/gemini-3.1-flash-preview", supportedGenerationMethods: gen },
        { name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: gen },
        { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: gen },
        { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: gen },
      ]),
    ).toBe("gemini-3-flash");
  });

  it("falls back to a preview Flash when no stable one exists, and to null when none", () => {
    expect(selectFlashModel([{ name: "models/gemini-3.1-flash-preview", supportedGenerationMethods: gen }])).toBe("gemini-3.1-flash-preview");
    expect(selectFlashModel([{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["embedContent"] }])).toBeNull();
    expect(selectFlashModel([{ name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: gen }])).toBeNull();
  });
});
