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

  it("groups key methods by brand and marks subscription tokens", () => {
    expect(byId.anthropic?.methods.map((m) => [m.authChoice, m.input])).toEqual([
      ["apiKey", "api_key"],
      ["setup-token", "token"],
    ]);
    expect(byId.openai?.installPluginId).toBeNull();
  });

  it("offers official, not-yet-installed provider plugins as installable", () => {
    expect(byId.deepseek).toMatchObject({ label: "DeepSeek", installPluginId: "deepseek", methods: [] });
    expect(byId.qwen?.installPluginId).toBe("qwen");
    expect(byId.evil).toBeUndefined();
    expect(byId["diagnostics-otel"]).toBeUndefined();
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
