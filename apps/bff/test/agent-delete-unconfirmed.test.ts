import { expect, it } from "vitest";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { deleteAgentInGateway, juniorWorkspace } from "../src/provision/create-agent.js";

// OpenClaw 2026.11.6 right after a Gateway restart (e.g. when a team's Telegram group was just unlinked).
const unconfirmed = Object.assign(new Error("Agent configuration was saved but its application to the active Gateway was not confirmed (unclaimed); run config.get, then apply the saved config or restart the Gateway."), { gatewayCode: "UNAVAILABLE" });

function gateway(listed: string[]): GatewayService {
  return {
    request: async (method: string) => {
      if (method === "agents.delete") throw unconfirmed;
      if (method === "agents.list") return { agents: listed.map((id) => ({ id })) };
      return {};
    },
  } as unknown as GatewayService;
}

it("a saved but unconfirmed deletion counts as done when the agent is gone", async () => {
  await expect(deleteAgentInGateway(gateway(["main"]), "team-pm")).resolves.toEqual({});
});

it("still fails when the agent is listed, or on any other error", async () => {
  await expect(deleteAgentInGateway(gateway(["main", "team-pm"]), "team-pm")).rejects.toThrow(/not confirmed/);
  const other = { request: async () => { throw new Error("agent \"x\" not found"); } } as unknown as GatewayService;
  await expect(deleteAgentInGateway(other, "x")).rejects.toThrow(/not found/);
});

it("a junior's workspace sits beside the main one, so agents.delete can remove it", () => {
  expect(juniorWorkspace("/var/lib/clawdesk/openclaw/workspace", "team-pm")).toBe("/var/lib/clawdesk/openclaw/workspace-team-pm");
  expect(juniorWorkspace("/var/lib/clawdesk/openclaw/workspace/", "x")).toBe("/var/lib/clawdesk/openclaw/workspace-x");
});
