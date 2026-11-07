import { describe, expect, it } from "vitest";
import { gatewayStale } from "../src/gateway/gateway-service.js";

// A frozen Gateway keeps its socket open but sends nothing; ticks normally arrive every tickIntervalMs.
describe("frozen Gateway detection", () => {
  it("gives up after two missed ticks plus a margin, never sooner than 25 seconds", () => {
    expect(gatewayStale(60_000, 0, 30_000)).toBe(false);
    expect(gatewayStale(65_000, 0, 30_000)).toBe(false);
    expect(gatewayStale(65_001, 0, 30_000)).toBe(true);
    expect(gatewayStale(25_000, 0, 1_000)).toBe(false);
    expect(gatewayStale(25_001, 0, 1_000)).toBe(true);
  });
});
