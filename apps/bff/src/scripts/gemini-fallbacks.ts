// One-off for installs connected before fallbacks existed: give the main agent's Gemini Flash
// model the other Flash models of the same key as fallbacks.
//
//   pnpm --filter @clawdesk/bff gemini-fallbacks

import { geminiFallbacks } from "../ai-setup/ai-setup-service.js";
import { patchConfig } from "../gateway/config-patch.js";
import { connectForScript, short } from "./_cli.js";

const { gateway, done } = await connectForScript();
try {
  const { config } = await gateway.request<{ config: { agents?: { entries?: Record<string, { model?: unknown; models?: Record<string, unknown> }> } } }>("config.get", {});
  const main = config.agents?.entries?.main;
  const primary = typeof main?.model === "string" ? main.model : (main?.model as { primary?: string } | undefined)?.primary;
  if (!primary?.startsWith("google/")) throw new Error(`main agent is not on Google (${primary ?? "no model"})`);
  // Without the key at hand, only the aliases Google keeps on free-tier Flash models.
  const fallbacks = geminiFallbacks(primary, []);
  await patchConfig(gateway, { agents: { entries: { main: { model: { primary, fallbacks } } } } }, { replacePaths: ["agents.entries.main.model.fallbacks"], note: "clawdesk: gemini fallbacks" });
  console.log(`main model: ${short({ primary, fallbacks })}`);
} finally {
  await done();
}
