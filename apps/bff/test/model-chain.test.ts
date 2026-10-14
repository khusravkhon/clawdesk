import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FREE_MODEL_REF } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { assertRoomForBackup, baseRef, chainFromSetting, choicesFor, followerIds, ModelChainError, syncFollowers, toOptions, validateChain, withBackup } from "../src/ai-setup/model-chain.js";
import { openDb } from "../src/db/client.js";
import { agents } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

const catalog = [
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", provider: "google", available: true },
  { id: "gemini-flash-latest", name: "Gemini Flash Latest", provider: "google", available: true },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek", available: true },
  { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai", available: false },
  { id: "auto", name: "Free models", provider: "freellmapi", available: true },
];

describe("model chain", () => {
  it("reads both config shapes, primary first, without duplicates", () => {
    expect(chainFromSetting(undefined)).toEqual([]);
    expect(chainFromSetting("google/gemini-3.7-flash")).toEqual(["google/gemini-3.7-flash"]);
    expect(chainFromSetting({ primary: "a/x", fallbacks: ["b/y", "a/x@a:default", "c/z"] })).toEqual(["a/x", "b/y", "c/z"]);
  });

  it("strips a pinned auth profile", () => {
    expect(baseRef("deepseek/deepseek-v4-flash@deepseek:default")).toBe("deepseek/deepseek-v4-flash");
    expect(baseRef("google/gemini-3.7-flash")).toBe("google/gemini-3.7-flash");
  });

  it("a new backup goes last and never replaces the main model", () => {
    const before = ["google/gemini-3.7-flash", "google/gemini-flash-latest"];
    expect(withBackup(before, "deepseek/deepseek-v4-flash@deepseek:default")).toEqual([...before, "deepseek/deepseek-v4-flash@deepseek:default"]);
    expect(withBackup(before, "google/gemini-flash-latest")).toEqual(before);
  });

  it("refuses a fifth model", () => {
    expect(() => assertRoomForBackup(["a/1", "a/2", "a/3"])).not.toThrow();
    expect(() => assertRoomForBackup(["a/1", "a/2", "a/3", "a/4"])).toThrow(ModelChainError);
  });

  it("labels models from the catalog; unknown ones keep their id and are not ready", () => {
    expect(toOptions(["deepseek/deepseek-v4-flash@deepseek:default", "zai/glm-5.3-flash"], catalog)).toEqual([
      { ref: "deepseek/deepseek-v4-flash@deepseek:default", label: "DeepSeek V4 Flash", provider: "deepseek", ready: true },
      { ref: "zai/glm-5.3-flash", label: "glm-5.3-flash", provider: "zai", ready: false },
    ]);
  });

  it("offers usable models not yet in the chain; never free models to the main agent", () => {
    const chain = ["google/gemini-3.7-flash"];
    expect(choicesFor("main", chain, catalog).map((c) => c.ref)).toEqual(["google/gemini-flash-latest", "deepseek/deepseek-v4-flash"]);
    expect(choicesFor("helper", chain, catalog).map((c) => c.ref)).toContain("freellmapi/auto");
  });

  it("validates a chain before saving", () => {
    const current = ["google/gemini-3.7-flash", "custom/kept-from-config"];
    expect(validateChain("main", ["deepseek/deepseek-v4-flash", "google/gemini-3.7-flash"], catalog, current)).toBeNull();
    expect(validateChain("main", ["custom/kept-from-config"], catalog, current)).toBeNull();
    expect(validateChain("main", [], catalog, current)).toMatch(/required/);
    expect(validateChain("main", ["google/gemini-3.7-flash", "google/gemini-3.7-flash@google:default"], catalog, current)).toMatch(/twice/);
    expect(validateChain("main", ["nope/model"], catalog, current)).toMatch(/unknown/);
    expect(validateChain("main", ["google/gemini-3.7-flash", "freellmapi/auto"], catalog, current)).toMatch(/main agent/);
    expect(validateChain("main", ["a/1", "a/2", "a/3", "a/4", "a/5"], catalog, current)).toMatch(/at most/);
  });
});

describe("juniors follow the main agent's models", () => {
  it("copies the main chain only to 'same as main' juniors that differ, and only if they still exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-chain-"));
    const { db, close } = openDb(path.join(dir, "panel.sqlite"));
    const row = { role: "specialist" as const, parentId: "main", displayName: "x", status: "ready" as const };
    db.insert(agents)
      .values([
        { ...row, id: "diet", model: "google/gemini-3.7-flash" }, // same as main, old copy without backups
        { ...row, id: "coach", model: null }, // own key
        { ...row, id: "free", model: FREE_MODEL_REF }, // free models
        { ...row, id: "team-dev", role: "team_member", model: "google/gemini-3.7-flash" }, // already in sync
        { ...row, id: "gone", model: "google/gemini-3.7-flash" }, // removed outside the panel
      ])
      .run();
    const main = { primary: "google/gemini-3.7-flash", fallbacks: ["deepseek/deepseek-v4-flash"] };
    const patches: { raw: string; replacePaths?: string[] }[] = [];
    const gateway = {
      request: async (method: string, params: { raw: string; replacePaths?: string[] }) => {
        if (method === "config.get") return { hash: "h", config: { agents: { entries: { main: { model: main }, diet: { model: "google/gemini-3.7-flash" }, coach: { model: "openai/gpt-6-luna" }, free: { model: FREE_MODEL_REF }, "team-dev": { model: main } } } } };
        if (method === "config.patch") patches.push(params);
        return { ok: true };
      },
    } as unknown as GatewayService;
    try {
      expect(followerIds(db).sort()).toEqual(["diet", "gone", "team-dev"]);
      expect(await syncFollowers(gateway, db)).toEqual(["diet"]);
      expect(JSON.parse(patches[0]!.raw)).toEqual({ agents: { entries: { diet: { model: main } } } });
      expect(patches[0]!.replacePaths).toEqual(["agents.entries.diet.model.fallbacks"]);
      expect(patches).toHaveLength(1);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
