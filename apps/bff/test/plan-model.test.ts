import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreateAgentRequest } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { expect, it } from "vitest";
import { withClaudePlanModels } from "../src/ai-setup/model-chain.js";
import { openDb } from "../src/db/client.js";
import { agents } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { createJuniorAgent } from "../src/provision/create-agent.js";

it("a Claude plan also offers Sonnet, which OpenClaw does not list", () => {
  const opus = { id: "claude-opus-5", provider: "claude-cli", available: true };
  expect(withClaudePlanModels([opus]).map((m) => `${m.provider}/${m.id}:${m.available}`)).toEqual(["claude-cli/claude-opus-5:true", "claude-cli/claude-sonnet-5:true"]);
  expect(withClaudePlanModels([{ id: "gemini-flash-latest", provider: "google", available: true }])).toHaveLength(1);
});

it("a junior on the main agent's Claude plan can run Sonnet, with its own chain", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-plan-"));
  const { db, close } = openDb(path.join(dir, "panel.sqlite"));
  const patches: string[] = [];
  const gateway = {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "agents.list") return { agents: [{ id: "main" }] };
      if (method === "agents.create") return { agentId: params.name };
      if (method === "models.list") return { models: [{ id: "claude-opus-5", provider: "claude-cli", available: true }] };
      if (method === "config.get") return { hash: "h", config: { agents: { entries: { main: { model: { primary: "claude-cli/claude-opus-5", fallbacks: ["google/gemini-flash-latest"] } } } } } };
      if (method === "config.patch") patches.push(params.raw as string);
      return { ok: true };
    },
  } as unknown as GatewayService;
  const base = { templateId: "dietitian", mode: "personal", values: { goal: "x" }, canAskMain: true, ai: "inherit", schedules: [], timezone: "Asia/Dushanbe" };
  try {
    const deps = { gateway, db, logger: pino({ level: "silent" }), sandboxEnabled: false };
    const res = await createJuniorAgent(deps, CreateAgentRequest.parse({ ...base, model: "claude-cli/claude-sonnet-5" }));
    const entry = patches.map((raw) => JSON.parse(raw).agents?.entries?.[res.agentId]).find((e) => e?.model);
    expect(entry.model).toEqual({ primary: "claude-cli/claude-sonnet-5", fallbacks: ["claude-cli/claude-opus-5", "google/gemini-flash-latest"] });
    // Its own models: the main agent's changes are not copied over it.
    expect(db.select().from(agents).where(eq(agents.id, res.agentId)).get()!.model).toBeNull();
    await expect(createJuniorAgent(deps, CreateAgentRequest.parse({ ...base, model: "openai/gpt-5" }))).rejects.toThrow(/unknown model/);
  } finally {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
