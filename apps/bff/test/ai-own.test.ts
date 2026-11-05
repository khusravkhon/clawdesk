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
});
