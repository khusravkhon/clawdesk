import { describe, expect, it } from "vitest";
import { CapabilitiesService } from "../src/system/capabilities-service.js";

// P0: each capability is read where it is used; anything unreachable is "unknown", never "ok".

const config = {
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.5", fallbacks: [] } } },
  plugins: { entries: { "clawdesk-requests": { enabled: true } } },
  skills: { entries: { gog: { enabled: true, env: { GOG_ACCOUNT: "owner@example.com" } } } },
};
const service = (patch: { state?: string; config?: unknown; probes?: unknown; owner?: string | null; sandbox?: boolean; company?: boolean } = {}) => new CapabilitiesService({
  gateway: { status: { state: patch.state ?? "connected" }, request: (async () => ({ config: patch.config ?? config })) as never },
  bridge: { capabilities: async () => { if (patch.probes === "down") throw new Error("down"); return (patch.probes ?? { openclaw: "2026.8.1", docker: "29.0.1", git: "git version 2.39.5", gog: "v0.42.0" }) as never; } },
  telegramOwner: () => patch.owner === undefined ? "4242" : patch.owner, sandboxEnabled: patch.sandbox ?? true, companyMode: () => patch.company ?? true, now: () => 7,
});
const states = async (patch: Parameters<typeof service>[0] = {}) => Object.fromEntries((await service(patch).check()).items.map((item) => [item.id, [item.state, item.value]]));

describe("installation capabilities", () => {
  it("reports a complete installation", async () => {
    expect(await states()).toEqual({
      gateway: ["ok", "connected"], openclaw: ["ok", "2026.8.1"], company_mode: ["ok", null], model: ["ok", "openai-codex/gpt-5.5"], sandbox: ["ok", null], docker: ["ok", "29.0.1"],
      requests_plugin: ["ok", null], telegram: ["ok", null], google: ["ok", "owner@example.com"], git: ["ok", "git version 2.39.5"],
    });
  });

  it("tells missing, switched off and unknown apart", async () => {
    const result = await states({ config: { plugins: { entries: { "clawdesk-requests": { enabled: false } } } }, probes: { openclaw: "2026.8.1", docker: null, git: null, gog: null }, owner: null, sandbox: false, company: false });
    expect(result).toMatchObject({ model: ["missing", null], requests_plugin: ["off", null], docker: ["missing", null], git: ["missing", null], google: ["missing", null], telegram: ["missing", null], sandbox: ["off", null], company_mode: ["off", null] });
    // Gateway away and the bridge silent: nothing about them reads as working.
    const offline = await states({ state: "reconnecting", probes: "down" });
    expect(offline).toMatchObject({ gateway: ["missing", "reconnecting"], openclaw: ["unknown", null], docker: ["unknown", null], model: ["unknown", null], requests_plugin: ["unknown", null], google: ["unknown", null] });
  });
});
