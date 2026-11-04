// Creates a junior agent with its own folder (the builder's code path), prints how OpenClaw will mount it
// into the sandbox, then deletes the agent. No model call: the sandbox is only explained, not started.
//
//   pnpm --filter @clawdesk/bff folder-probe [--folder Питание] [--keep]
import { execFileSync } from "node:child_process";
import { CreateAgentRequest } from "@clawdesk/shared";
import pino from "pino";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { BridgeClient } from "../gateway/bridge-client.js";
import { createJuniorAgent, deleteJuniorAgent } from "../provision/create-agent.js";
import { connectForScript, flagValue } from "./_cli.js";
import { gatewayContainerId } from "./_docker.js";

import fs from "node:fs";
if (fs.existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const folder = flagValue("folder") ?? "Питание";
const keep = process.argv.includes("--keep");
const logger = pino({ level: "warn" });
const containerId = gatewayContainerId(config.gateway.sharedToken);
const { db, close } = openDb(config.dbPath);
const { gateway, done } = await connectForScript();
let agentId: string | null = null;
try {
  const res = await createJuniorAgent(
    { gateway, db, logger, sandboxEnabled: config.sandboxEnabled, folders: new BridgeClient(config.bridgeUrl, config.gateway.sharedToken) },
    CreateAgentRequest.parse({ templateId: "dietitian", mode: "personal", values: { goal: "probe" }, canAskMain: true, ai: "inherit", schedules: [], timezone: "UTC", folder }),
  );
  agentId = res.agentId;
  console.log(`✓ created ${agentId} (sandbox: ${res.sandboxApplied})`);
  const explain = execFileSync("docker", ["exec", containerId, "node", "dist/index.js", "sandbox", "explain", "--agent", agentId], { encoding: "utf8" });
  console.log(explain.split("\n").filter((l) => /mount|bind|workspace|folders|runtime/i.test(l)).join("\n"));
} finally {
  if (agentId && !keep) {
    await deleteJuniorAgent({ gateway, db, logger }, agentId);
    console.log(`✓ deleted ${agentId}`);
  }
  await done();
  close();
}
