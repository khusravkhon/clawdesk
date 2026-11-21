import pino from "pino";
import { expect, it } from "vitest";
import { AiSetupService } from "../src/ai-setup/ai-setup-service.js";
import type { Db } from "../src/db/client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

// 0.1.28: the main agent on a Claude plan has no Anthropic key, so models.authStatus says "missing" and every
// page but the dashboard and settings sent the owner back to the "connect AI" window.

function service(primary: string, signedIn: boolean) {
  const gateway = {
    request: async (method: string) => {
      if (method === "models.authStatus") return { providers: [{ provider: "anthropic", status: "missing" }] };
      if (method === "config.get") return { hash: "h", config: { agents: { entries: { main: { model: { primary, fallbacks: [] } } } } } };
      return {};
    },
  } as unknown as GatewayService;
  return new AiSetupService(gateway, pino({ level: "silent" }), {} as Db, async () => true, async () => signedIn);
}

it("a signed-in Claude plan counts as a connected AI for an Anthropic model", async () => {
  expect(await service("anthropic/claude-opus-5", true).status("main")).toMatchObject({ connected: true, providers: ["anthropic"] });
});

it("the model the plan's activation sets (claude-cli/…) counts too, so a reload keeps the owner in the panel", async () => {
  expect(await service("claude-cli/claude-opus-5", true).status("main")).toMatchObject({ connected: true, providers: ["anthropic"] });
  expect((await service("claude-cli/claude-opus-5", false).status("main")).connected).toBe(false);
});

it("no Claude login, or a model of another provider, is still not connected", async () => {
  expect((await service("anthropic/claude-opus-5", false).status("main")).connected).toBe(false);
  expect((await service("openai/gpt-5", true).status("main")).connected).toBe(false);
});
