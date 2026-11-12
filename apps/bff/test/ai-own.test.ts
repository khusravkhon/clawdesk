import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiSetupService } from "../src/ai-setup/ai-setup-service.js";
import { followerIds } from "../src/ai-setup/model-chain.js";
import { openDb, type Db } from "../src/db/client.js";
import { agents } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

// A junior created with the main agent's AI that later gets its own stops following the main agent's models.

describe("own AI after creation", () => {
  let root: string, db: Db, close: () => void;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-own-ai-")); ({ db, close } = openDb(path.join(root, "panel.sqlite"))); });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("clears the followed model of a junior, never of the main agent", () => {
    db.insert(agents).values([{ id: "analyst", role: "specialist", displayName: "A", model: "openai/gpt-5" }, { id: "dev", role: "team_member", displayName: "D", model: "openai/gpt-5" }]).run();
    const service = new AiSetupService({} as GatewayService, pino({ level: "silent" }), db);
    expect(followerIds(db).sort()).toEqual(["analyst", "dev"]);
    expect(service.markOwnAi("analyst")).toBe(true);
    expect(followerIds(db)).toEqual(["dev"]);
    expect(service.markOwnAi("main")).toBe(false);
    expect(service.markOwnAi("ghost")).toBe(false);
  });

  it("a junior saved with its own model list stops following; one saved with the main list keeps following", async () => {
    db.insert(agents).values([{ id: "coach", role: "specialist", displayName: "C", model: "openai/gpt-5" }, { id: "cook", role: "specialist", displayName: "K", model: "openai/gpt-5" }]).run();
    const config = { agents: { entries: { main: { model: { primary: "openai/gpt-5", fallbacks: [] } }, coach: { model: { primary: "openai/gpt-5", fallbacks: [] } }, cook: { model: { primary: "openai/gpt-5", fallbacks: [] } } } } };
    const gateway = {
      request: async (method: string) => {
        if (method === "config.get") return { hash: "h", config };
        if (method === "models.list") return { models: [{ id: "gpt-5", provider: "openai" }, { id: "auto", provider: "freellmapi" }] };
        return {};
      },
    } as unknown as GatewayService;
    const service = new AiSetupService(gateway, pino({ level: "silent" }), db);
    await service.saveModelChain({ agentId: "coach", chain: ["freellmapi/auto", "openai/gpt-5"] });
    await service.saveModelChain({ agentId: "cook", chain: ["openai/gpt-5"] });
    expect(followerIds(db)).toEqual(["cook"]);
  });
});
