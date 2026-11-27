import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { BridgeError, type BridgeClient } from "../src/gateway/bridge-client.js";
import { registerChromeRoutes } from "../src/routes/chrome.js";

function appWith(bridge: Partial<BridgeClient>) {
  const app = Fastify();
  registerChromeRoutes(app, { bridge: bridge as BridgeClient });
  return app;
}

describe("the person's Chrome for agents", () => {
  it("reports the connection, and an install without the bridge as unavailable", async () => {
    const on = appWith({ chromeStatus: async () => ({ enabled: true, connected: true }) });
    expect((await on.inject("/api/chrome")).json()).toEqual({ available: true, connected: true });
    const down = appWith({ chromeStatus: async () => { throw new BridgeError("bridge_unavailable", "down"); } });
    expect((await down.inject("/api/chrome")).json()).toEqual({ available: false, connected: false });
  });

  it("pairs the extension with the address the panel is opened on", async () => {
    const asked: string[] = [];
    const app = appWith({ chromePair: async (url) => { asked.push(url); return { pairingString: "secret" }; } });
    const behindProxy = { "x-forwarded-host": "panel.example.com", "x-forwarded-proto": "https" };
    expect((await app.inject({ method: "POST", url: "/api/chrome/pairing", headers: behindProxy })).json()).toEqual({ pairingString: "secret" });
    await app.inject({ method: "POST", url: "/api/chrome/pairing", headers: { host: "127.0.0.1:18080" } });
    expect(asked).toEqual(["wss://panel.example.com", "ws://127.0.0.1:18080"]);

    const down = appWith({ chromePair: async () => { throw new BridgeError("chrome_unavailable", "x"); } });
    expect((await down.inject({ method: "POST", url: "/api/chrome/pairing" })).statusCode).toBe(503);
  });
});
