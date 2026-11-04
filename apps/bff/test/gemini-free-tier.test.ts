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

describe("storeKeyWithModelViaWizard", () => {
  // The step sequence of OpenClaw 2026.8.1's setup wizard for a Google key (recorded on a live Gateway).
  const steps = [
    { type: "note", title: "OpenClaw setup" },
    { type: "confirm", message: "I understand this is personal-by-default… Continue?" },
    { type: "select", message: "Help make OpenClaw better?", options: [{ value: false }, { value: true }] },
    { type: "select", message: "Setup mode", options: [{ value: "quickstart" }, { value: "advanced" }] },
    { type: "select", message: "Model/auth provider", options: [{ value: "openai" }, { value: "google" }] },
    { type: "text", message: "Enter Google AI Studio API key", sensitive: true },
    { type: "note", title: "Model configured" },
    { type: "select", message: "Default model", options: [{ value: "__keep__" }, { value: "__manual__" }] },
    { type: "text", message: "Default model" },
    { type: "confirm", message: "Test AI access now with a live completion?" },
    { type: "note", title: "How channels work" },
  ];

  function fakeGateway() {
    const answers: { message: string; value: unknown }[] = [];
    let at = 0;
    const step = () => (at < steps.length ? { done: false, step: { id: `s${at}`, ...steps[at] } } : { done: true });
    const gateway = {
      request: async (method: string, params: { answer?: { stepId: string; value?: unknown } }) => {
        if (method === "wizard.start") return { sessionId: "w1", ...step() };
        if (method === "wizard.next") {
          answers.push({ message: steps[at]!.message ?? steps[at]!.title ?? "", value: params.answer?.value });
          at++;
          return step();
        }
        if (method === "wizard.cancel") return {};
        throw new Error(method);
      },
    };
    return { gateway, answers, position: () => at };
  }

  it("answers the live-test offer (where OpenClaw persists key and model) before cancelling", async () => {
    const { storeKeyWithModelViaWizard } = await import("../src/ai-setup/gemini-free-tier.js");
    const { gateway, answers, position } = fakeGateway();
    const logger = { info: () => undefined } as never;
    await storeKeyWithModelViaWizard(gateway as never, logger, { provider: "google", apiKey: "AIza-test", modelRef: "google/gemini-2.5-flash" });
    expect(answers.find((a) => a.message === "Default model" && a.value === "google/gemini-2.5-flash")).toBeTruthy();
    expect(answers.at(-1)).toEqual({ message: "Test AI access now with a live completion?", value: false });
    expect(steps[position()]?.title).toBe("How channels work");
  });
});

describe("wizardLeftovers", () => {
  it("removes only what the wizard wrote for the tried Flash models", async () => {
    const { wizardLeftovers } = await import("../src/ai-setup/ai-setup-service.js");
    expect(
      wizardLeftovers(
        {
          agents: { defaults: { model: { primary: "google/gemini-2.5-flash" }, models: { "google/gemini-2.5-flash": {}, "openai/gpt-5": {} } } },
          auth: { profiles: { "google:default": { provider: "google" }, "openai:default": { provider: "openai" } } },
        },
        ["gemini-3.8-flash", "gemini-2.5-flash"],
      ),
    ).toEqual({ agents: { defaults: { model: null, models: { "google/gemini-2.5-flash": null } } }, auth: { profiles: { "google:default": null } } });
  });

  it("keeps a default model it did not set and returns null when nothing is left", async () => {
    const { wizardLeftovers } = await import("../src/ai-setup/ai-setup-service.js");
    expect(wizardLeftovers({ agents: { defaults: { model: { primary: "openai/gpt-5" } } } }, ["gemini-2.5-flash"])).toBeNull();
    expect(wizardLeftovers({}, ["gemini-2.5-flash"])).toBeNull();
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
