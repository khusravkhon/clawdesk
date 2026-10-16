import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { agents } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { agentCommunicationPatch, mainPluginPatch, personalAgentTools, repairAgentCommunication, ASK_MAIN_PLUGIN, ASK_MAIN_TOOL, CROSS_SESSION_TOOLS, type CommunicationConfig } from "../src/provision/agent-communication.js";

function merge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const child = target[key];
      if (!child || typeof child !== "object" || Array.isArray(child)) target[key] = {};
      merge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else target[key] = value;
  }
}

describe("permitted agent communication", () => {
  it("keeps main-to-junior delivery but permanently denies juniors native cross-session tools", () => {
    const patch = agentCommunicationPatch({ tools: { agentToAgent: { allow: ["main", "team-dev"] } }, agents: { entries: { trainer: {}, finance: {}, "team-dev": {} } } }, [{ id: "trainer", canAskMain: true }, { id: "finance", canAskMain: false }], new Set(["main", "trainer", "finance", "team-dev"]))!;
    expect(patch.tools?.agentToAgent).toEqual({ enabled: true, allow: ["main", "team-dev", "trainer", "finance"] });
    expect(patch.agents?.entries.trainer?.tools.deny).toEqual(CROSS_SESSION_TOOLS);
    expect(patch.agents?.entries.trainer?.tools.alsoAllow).toEqual([ASK_MAIN_TOOL]);
    expect(patch.agents?.entries.finance?.tools.deny).toContain(ASK_MAIN_TOOL);
    expect(patch.agents?.entries["team-dev"]).toBeUndefined();
  });

  it("isolates an agent the Gateway lists but the config does not describe yet", () => {
    const patch = agentCommunicationPatch({ agents: { entries: { main: {} } } }, [{ id: "trainer", canAskMain: true }], new Set(["main", "trainer"]))!;
    expect(patch.agents?.entries.trainer?.tools.deny).toEqual(CROSS_SESSION_TOOLS);
    expect(patch.agents?.entries.trainer?.tools.alsoAllow).toEqual([ASK_MAIN_TOOL]);
    expect(patch.tools?.agentToAgent?.allow).toEqual(["main", "trainer"]);
    // An agent our rows know but the Gateway no longer has gets no entry and no reachability.
    expect(agentCommunicationPatch({ agents: { entries: { main: {} } } }, [{ id: "gone", canAskMain: true }], new Set(["main"]))).toBeNull();
  });

  it("preserves explicit owner deny and allow lists", () => {
    const tools = personalAgentTools({ deny: ["exec", ASK_MAIN_TOOL], allow: ["read"] }, true);
    expect(tools.deny).toContain("exec");
    expect(tools.deny).toContain(ASK_MAIN_TOOL);
    expect(tools.allow).toEqual(["read", ASK_MAIN_TOOL]);
    expect(tools.alsoAllow).toBeUndefined();
  });

  it("does not configure a plugin on company-only installs; grants exclude deleted or forbidden agents", () => {
    expect(mainPluginPatch({}, [], new Set())).toBeNull();
    const patch = mainPluginPatch({ plugins: { allow: ["telegram"], load: { paths: ["/trusted/other"] } }, agents: { entries: { trainer: {}, finance: {} } } }, [{ id: "trainer", canAskMain: true }, { id: "gone", canAskMain: true }, { id: "finance", canAskMain: false }], new Set(["trainer", "finance"]))!;
    expect(patch.plugins.allow).toEqual(["telegram", ASK_MAIN_PLUGIN]);
    expect(patch.plugins.entries[ASK_MAIN_PLUGIN].config.allowedAgentIds).toEqual(["trainer"]);
  });

  it("repairs only existing permitted agents and does not write again once repaired", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-communication-"));
    const { db, close } = openDb(path.join(dir, "panel.sqlite"));
    let config: CommunicationConfig = { agents: { entries: { main: {}, trainer: {}, finance: {} } } };
    const patches: unknown[] = [];
    const gateway = { request: async (method: string, params: Record<string, unknown>) => {
      if (method === "agents.list") return { agents: [{ id: "main" }, { id: "trainer" }, { id: "finance" }] };
      if (method === "config.get") return { hash: "current", config };
      if (method === "config.patch") {
        expect(params.baseHash).toBe("current");
        const patch = JSON.parse(params.raw as string);
        patches.push(patch);
        merge(config as Record<string, unknown>, patch);
      }
      return {};
    } } as unknown as GatewayService;
    try {
      for (const [id, canAskMain] of [["trainer", true], ["deleted", true], ["finance", false]] as const) {
        db.insert(agents).values({ id, displayName: id, role: "specialist", canAskMain, status: "ready" }).run();
      }
      await repairAgentCommunication({ gateway, db });
      expect(config.tools?.agentToAgent?.allow).toEqual(["main", "trainer", "finance"]);
      expect(config.plugins?.entries?.[ASK_MAIN_PLUGIN]?.config?.allowedAgentIds).toEqual(["trainer"]);
      expect(config.agents?.entries?.finance?.tools?.deny).toContain(ASK_MAIN_TOOL);
      await repairAgentCommunication({ gateway, db });
      expect(patches).toHaveLength(2);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
