import { describe, expect, it } from "vitest";
import { allowPluginPatch, pluginAllowPatch } from "../src/provision/plugin-allowlist.js";

// Shapes of plugins.list (OpenClaw 2026.8.35): bundled plugins, two installed from the registry, ours from load paths.
const listed = [
  { id: "telegram", origin: "bundled", installed: true },
  { id: "memory-core", origin: "bundled", installed: true },
  { id: "codex", origin: "bundled", installed: true }, // disabled, still listed: allow only gates
  { id: "groq", origin: "global", installed: true },
  { id: "llama-cpp", origin: "global", installed: true },
  { id: "clawdesk-schedule-guard", origin: "config", installed: true },
  { id: "notion", origin: "official", installed: false }, // catalog only: never listed
];

describe("trusted plugin list", () => {
  it("without a list, trusts what is installed now and nothing from the catalog", () => {
    expect(pluginAllowPatch({}, listed)).toEqual({ plugins: { allow: ["clawdesk-schedule-guard", "codex", "groq", "llama-cpp", "memory-core", "telegram"] } });
  });

  it("an existing list keeps its entries and gains only bundled plugins a newer OpenClaw ships", () => {
    const config = { plugins: { allow: ["telegram", "groq"] } };
    expect(pluginAllowPatch(config, listed)).toEqual({ plugins: { allow: ["telegram", "groq", "codex", "memory-core"] } });
  });

  it("changes nothing when the list is complete", () => {
    const allow = ["clawdesk-schedule-guard", "codex", "groq", "llama-cpp", "memory-core", "telegram"];
    expect(pluginAllowPatch({ plugins: { allow } }, listed)).toBeNull();
  });

  it("a plugin the panel installs joins an existing list; without a list there is nothing to add to", () => {
    expect(allowPluginPatch({ plugins: { allow: ["telegram"] } }, "groq")).toEqual({ plugins: { allow: ["telegram", "groq"] } });
    expect(allowPluginPatch({ plugins: { allow: ["telegram", "groq"] } }, "groq")).toBeNull();
    expect(allowPluginPatch({}, "groq")).toBeNull();
  });
});
