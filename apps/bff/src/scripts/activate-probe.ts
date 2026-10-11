// Stage 0: can one agent get its OWN model credential over RPC, for any provider?
// Creates a throwaway agent, calls openclaw.setup.activate with a deliberately
// invalid key, reports what the Gateway answered and what it persisted, then
// deletes the agent. Never uses a real key.
//
//   pnpm --filter @clawdesk/bff activate-probe [--auth-choice deepseek-api-key]

import { getConfig } from "../gateway/config-patch.js";
import { connectForScript, flagValue, short } from "./_cli.js";

const authChoice = flagValue("auth-choice") ?? "deepseek-api-key";
const FAKE_KEY = "sk-clawdesk-invalid-probe-0000000000000000";

const { gateway, done } = await connectForScript();
let agentId: string | undefined;
try {
  const mainBefore = await gateway.request("models.authStatus", { agentId: "main" });

  const created = await gateway.request<{ agentId: string }>("agents.create", { name: `clawdesk-auth-probe-${Date.now().toString(36)}` });
  agentId = created.agentId;
  console.log(`temp agent: ${agentId}`);

  const t0 = performance.now();
  const res = await gateway.request("openclaw.setup.activate", { agentId, kind: "api-key", authChoice, apiKey: FAKE_KEY }, { timeoutMs: 90_000 }).catch((e: Error & { gatewayCode?: string; details?: unknown }) => ({
    rpcError: e.message,
    code: e.gatewayCode,
    details: e.details,
  }));
  console.log(`\nopenclaw.setup.activate {kind:"api-key", authChoice:"${authChoice}"} (${Math.round(performance.now() - t0)}ms):\n${short(res, 1500)}`);

  const status = await gateway.request("models.authStatus", { agentId });
  console.log(`\nmodels.authStatus {agentId:"${agentId}"} providers:\n${short((status as { providers?: unknown }).providers, 1500)}`);

  const { config } = await getConfig<{ agents?: { entries?: Record<string, { model?: unknown }> } }>(gateway);
  console.log(`\nagents.entries.${agentId}.model = ${short(config.agents?.entries?.[agentId]?.model ?? null, 300)}`);

  const mainAfter = await gateway.request("models.authStatus", { agentId: "main" });
  const mainChanged = JSON.stringify((mainBefore as { providers?: unknown }).providers) !== JSON.stringify((mainAfter as { providers?: unknown }).providers);
  console.log(`\nmain agent auth changed by this probe: ${mainChanged ? "YES (credential leaked to shared store)" : "no"}`);
} finally {
  if (agentId) {
    await gateway.request("agents.delete", { agentId, deleteFiles: true }).then(
      () => console.log(`\ncleanup: deleted ${agentId}`),
      (e: Error) => console.log(`\ncleanup failed: ${e.message}`),
    );
  }
  await done();
}
