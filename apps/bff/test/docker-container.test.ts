import { describe, expect, it } from "vitest";
import { gatewayContainerId } from "../src/scripts/_docker.js";

const token = "fixture-token";
const container = (Id: string, secret = token) => ({ Id, Config: { Hostname: "clawdesk-gateway", Labels: { "com.docker.compose.service": "gateway" }, Env: [`OPENCLAW_GATEWAY_TOKEN=${secret}`] } });
const command = (items: ReturnType<typeof container>[]) => (args: string[]): string => {
  if (args[0] === "ps") return items.map((item) => item.Id).join("\n");
  expect(args).toEqual(["inspect", ...items.map((item) => item.Id)]);
  return JSON.stringify(items);
};

describe("diagnostic Gateway selection", () => {
  it("selects its configured installation regardless of container names and hostname", () => {
    expect(gatewayContainerId(token, command([container("foreign", "foreign-token"), container("local-gateway-1")]))).toBe("local-gateway-1");
  });
  it("rejects missing identities, foreign, absent and ambiguous containers", () => {
    expect(() => gatewayContainerId(undefined, command([]))).toThrow();
    for (const items of [[], [container("foreign", "other")], [container("one"), container("two")]]) {
      expect(() => gatewayContainerId(token, command(items))).toThrow();
    }
  });
});
