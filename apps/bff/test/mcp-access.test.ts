import { describe, expect, it } from "vitest";
import { mcpAccessPatch, mcpAccessReplacePaths, type McpAccessConfig } from "../src/skills/mcp-access.js";

const grants = (entries: Record<string, string[]>) => new Map(Object.entries(entries).map(([server, agents]) => [server, new Set(agents)]));

describe("MCP access per agent", () => {
  const config: McpAccessConfig = {
    mcp: { servers: { notion: {}, linear: {} } },
    tools: { sandbox: { tools: { alsoAllow: ["message"] } } },
    agents: { entries: { finance: { tools: { deny: ["sessions_list", "notion__*"] } } } },
  };

  it("denies each server to agents without a grant and keeps other deny entries", () => {
    const patch = mcpAccessPatch(config, ["main", "finance", "social"], grants({ notion: ["main"], linear: ["main", "social"] }));
    expect(patch).toEqual({
      agents: { entries: { finance: { tools: { deny: ["sessions_list", "notion__*", "linear__*"] } }, social: { tools: { deny: ["notion__*"] } } } },
      tools: { sandbox: { tools: { alsoAllow: ["message", "bundle-mcp"] } } },
    });
    expect(mcpAccessReplacePaths(config, patch!)).toEqual(["agents.entries.finance.tools.deny", "agents.entries.social.tools.deny", "tools.sandbox.tools.alsoAllow"]);
  });

  it("a new grant lifts the deny; a removed server leaves no deny behind", () => {
    const now: McpAccessConfig = { ...config, mcp: { servers: { linear: {} } }, tools: { sandbox: { tools: { alsoAllow: ["bundle-mcp"] } } } };
    expect(mcpAccessPatch(now, ["finance"], grants({ linear: ["finance"] }))).toEqual({ agents: { entries: { finance: { tools: { deny: ["sessions_list"] } } } } });
  });

  it("changes nothing when everything is already in place", () => {
    const settled: McpAccessConfig = { ...config, tools: { sandbox: { tools: { alsoAllow: ["bundle-mcp"] } } } };
    expect(mcpAccessPatch(settled, ["main", "finance"], grants({ notion: ["main"], linear: ["main", "finance"] }))).toBeNull();
  });

  it("opens the sandbox gate in an explicit allow list, but never against the owner's deny", () => {
    expect(mcpAccessPatch({ mcp: { servers: { a: {} } }, tools: { sandbox: { tools: { allow: ["read"] } } } }, [], new Map())).toEqual({ tools: { sandbox: { tools: { allow: ["read", "bundle-mcp"] } } } });
    expect(mcpAccessPatch({ mcp: { servers: { a: {} } }, tools: { sandbox: { tools: { deny: ["bundle-mcp"] } } } }, [], new Map())).toBeNull();
    expect(mcpAccessPatch({}, ["main"], new Map())).toBeNull();
  });
});
