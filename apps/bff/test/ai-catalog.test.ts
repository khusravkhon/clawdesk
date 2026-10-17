import { describe, expect, it } from "vitest";
import { buildCatalog, type DetectResult, type PluginEntry } from "../src/ai-setup/catalog.js";

// Shapes taken from a live OpenClaw 2026.8.1 Gateway (openclaw.setup.detect, plugins.list).
const detect: DetectResult = {
  candidates: [],
  setupComplete: false,
  manualProviders: [
    { id: "openai-api-key", brandId: "openai", groupLabel: "OpenAI", label: "OpenAI API Key", hint: "Use your OpenAI API key directly" },
    { id: "apiKey", brandId: "anthropic", groupLabel: "Anthropic", label: "Anthropic API key" },
    { id: "setup-token", brandId: "anthropic", groupLabel: "Anthropic", label: "Anthropic setup-token" },
    { id: "lmstudio", brandId: "lmstudio", groupLabel: "LM Studio", label: "LM Studio" },
    { id: "minimax-cn-api", brandId: "minimax", groupLabel: "MiniMax", label: "MiniMax CN" },
    { id: "gemini-api-key", brandId: "google", groupLabel: "Google", label: "Gemini API key", website: "https://ai.google.dev/" },
  ],
  authOptions: [
    { id: "openai", brandId: "openai", label: "ChatGPT Login", kind: "oauth", featured: true },
    { id: "github-copilot", brandId: "github-copilot", groupLabel: "Copilot", label: "GitHub Copilot", kind: "device-code", featured: false },
  ],
};
const plugins: PluginEntry[] = [
  { id: "deepseek", name: "OpenClaw DeepSeek Provider", packageName: "@openclaw/deepseek-provider", origin: "official", installed: false },
  { id: "qwen", name: "OpenClaw Qwen Provider", packageName: "@openclaw/qwen-provider", origin: "official", installed: false },
  { id: "openai", packageName: "@openclaw/openai-provider", origin: "bundled", installed: true },
  { id: "evil", packageName: "@someone/evil-provider", origin: "clawhub", installed: false },
  { id: "diagnostics-otel", packageName: "@openclaw/diagnostics-otel", origin: "official", installed: true },
];

describe("buildCatalog", () => {
  const catalog = buildCatalog("main", detect, plugins);
  const byId = Object.fromEntries(catalog.providers.map((p) => [p.id, p]));

  it("groups key methods by brand; Anthropic's setup-token is never offered", () => {
    expect(byId.anthropic?.methods.map((m) => [m.authChoice, m.input])).toEqual([["apiKey", "api_key"]]);
    expect(byId.openai?.installPluginId).toBeNull();
  });

  it("offers a Claude plan sign-in first only when the Gateway carries Claude Code", () => {
    expect(catalog.signIn.map((s) => s.id)).not.toContain("claude-plan");
    const withClaude = buildCatalog("main", { ...detect, authOptions: [...detect.authOptions!, { id: "anthropic-cli", brandId: "anthropic", label: "Claude CLI", kind: "oauth", featured: true }] }, plugins, { claudePlan: true });
    expect(withClaude.signIn.map((s) => s.id)).toEqual(["claude-plan", "openai", "github-copilot"]);
    expect(withClaude.signIn[0]).toMatchObject({ providerId: "anthropic", kind: "oauth" });
  });

  it("offers official, not-yet-installed provider plugins as installable", () => {
    expect(byId.deepseek).toMatchObject({ label: "DeepSeek", installPluginId: "deepseek", methods: [] });
    expect(byId.qwen?.installPluginId).toBe("qwen");
    expect(byId.evil).toBeUndefined();
    expect(byId["diagnostics-otel"]).toBeUndefined();
  });

  it("links straight to the API key page, not the provider home page", () => {
    expect(byId.google?.website).toBe("https://aistudio.google.com/apikey");
    expect(byId.openai?.website).toBe("https://platform.openai.com/api-keys");
  });

  it("drops methods that need more than a pasted key", () => {
    expect(byId.lmstudio).toBeUndefined();
  });

  it("puts popular providers first in a fixed order", () => {
    expect(catalog.providers.map((p) => p.id).slice(0, 4)).toEqual(["anthropic", "openai", "deepseek", "qwen"]);
    expect(catalog.providers.map((p) => p.id).slice(-2)).toEqual(["minimax", "github-copilot"]);
  });

  it("passes sign-in options through and gives sign-in-only brands a card", () => {
    expect(catalog.signIn).toEqual([
      { id: "openai", providerId: "openai", label: "ChatGPT Login", hint: null, kind: "oauth" },
      { id: "github-copilot", providerId: "github-copilot", label: "GitHub Copilot", hint: null, kind: "device-code" },
    ]);
    expect(byId["github-copilot"]).toMatchObject({ label: "Copilot", methods: [], installPluginId: null });
  });
});
