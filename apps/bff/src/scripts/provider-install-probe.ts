// Stage 0: full path for a provider that is not bundled (e.g. DeepSeek, Qwen, Kimi):
//   plugins.install (official) → capability review → gateway restart → openclaw.setup.activate
// The activation uses a deliberately invalid key on a throwaway agent; a provider
// "auth" rejection proves the whole path works without a real key.
//
//   pnpm --filter @clawdesk/bff provider-install-probe [--plugin deepseek] [--auth-choice deepseek-api-key]

import { connectForScript, flagValue, short } from "./_cli.js";

const pluginId = flagValue("plugin") ?? "deepseek";
const authChoice = flagValue("auth-choice") ?? `${pluginId}-api-key`;
const FAKE_KEY = "sk-clawdesk-invalid-probe-0000000000000000";
// --version pins a ClawHub release matching the Gateway (official installs always take the latest).
const version = flagValue("version");
const installSpec = version
  ? { source: "clawhub", packageName: `@openclaw/${pluginId}-provider`, version }
  : { source: "official", pluginId };

type InstallError = Error & { gatewayCode?: string; details?: unknown };

const { gateway, done } = await connectForScript();
let agentId: string | undefined;
try {
  // 1. install, answering a capability review if the Gateway asks for one
  let installed: unknown;
  try {
    installed = await gateway.request("plugins.install", installSpec, { timeoutMs: 300_000 });
  } catch (error) {
    const e = error as InstallError;
    console.log(`plugins.install needs review: ${e.message}\ncode=${e.gatewayCode}\ndetails=${short(e.details, 2000)}`);
    const reviewToken = findReviewToken(e.details);
    if (!reviewToken) throw error;
    installed = await gateway.request(
      "plugins.install",
      { ...installSpec, acknowledgeCapabilities: { reviewToken }, acknowledgeInstallPolicyWarning: true },
      { timeoutMs: 300_000 },
    );
  }
  console.log(`\n✓ plugins.install ${pluginId}:\n${short(installed, 1200)}`);

  // 2. restart if required, then reconnect
  if ((installed as { restartRequired?: boolean }).restartRequired) {
    const t0 = performance.now();
    await gateway.request("gateway.restart.request", { reason: `clawdesk: installed ${pluginId}` }).catch((e: Error) => console.log(`restart request: ${e.message}`));
    await new Promise((r) => setTimeout(r, 3_000));
    await gateway.waitUntilConnected(120_000);
    console.log(`✓ gateway restarted and reconnected in ${Math.round(performance.now() - t0)}ms`);
  }

  // 3. activate with an invalid key on a throwaway agent
  const created = await gateway.request<{ agentId: string }>("agents.create", { name: `clawdesk-auth-probe-${Date.now().toString(36)}` });
  agentId = created.agentId;
  const res = await gateway.request("openclaw.setup.activate", { agentId, kind: "api-key", authChoice, apiKey: FAKE_KEY }, { timeoutMs: 90_000 });
  console.log(`\nopenclaw.setup.activate {authChoice:"${authChoice}"} on ${agentId}:\n${short(res, 1000)}`);
} catch (error) {
  console.error(`✗ ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  if (agentId) await gateway.request("agents.delete", { agentId, deleteFiles: true }).catch(() => undefined);
  await done();
}

function findReviewToken(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  for (const [key, value] of Object.entries(details)) {
    if (key === "reviewToken" && typeof value === "string") return value;
    const nested = findReviewToken(value);
    if (nested) return nested;
  }
  return undefined;
}
