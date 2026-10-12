import { describe, expect, it } from "vitest";
import { selectFlashModel, selectFlashModels } from "../src/ai-setup/gemini-free-tier.js";

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

  it("orders all candidates so a model unknown to the pinned OpenClaw can be skipped", () => {
    expect(
      selectFlashModels([
        { name: "models/gemini-3.8-flash", supportedGenerationMethods: gen },
        { name: "models/gemini-3.6-flash", supportedGenerationMethods: gen },
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: gen },
        { name: "models/gemini-3-flash-preview", supportedGenerationMethods: gen },
      ]),
    ).toEqual(["gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-3-flash-preview"]);
  });

  it("falls back to a preview Flash when no stable one exists, and to null when none", () => {
    expect(selectFlashModel([{ name: "models/gemini-3.1-flash-preview", supportedGenerationMethods: gen }])).toBe("gemini-3.1-flash-preview");
    expect(selectFlashModel([{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["embedContent"] }])).toBeNull();
    expect(selectFlashModel([{ name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: gen }])).toBeNull();
  });
});

describe("geminiFallbacks", () => {
  it("keeps the other Flash models of the key, then Google's aliases, never the primary twice", async () => {
    const { geminiFallbacks } = await import("../src/ai-setup/ai-setup-service.js");
    expect(geminiFallbacks("google/gemini-3.7-flash", ["gemini-3.5-flash", "gemini-flash-latest"])).toEqual([
      "google/gemini-3.5-flash",
      "google/gemini-flash-latest",
      "google/gemini-flash-lite-latest",
    ]);
    expect(geminiFallbacks("google/gemini-flash-latest", [])).toEqual(["google/gemini-flash-lite-latest"]);
  });
});
