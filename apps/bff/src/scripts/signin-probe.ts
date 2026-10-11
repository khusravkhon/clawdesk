// Stage 0: how does subscription sign-in (OAuth / device code) run over RPC?
// Starts openclaw.setup.auth.start for one agent, prints the steps the Gateway
// asks the UI to show (URL, device code, paste-back field), then cancels.
// Nothing is completed: no account is linked.
//
//   pnpm --filter @clawdesk/bff signin-probe [--choice openai-device-code] [--agent main]

import crypto from "node:crypto";
import { connectForScript, flagValue, short } from "./_cli.js";

const authChoice = flagValue("choice") ?? "openai-device-code";
const agentId = flagValue("agent") ?? "main";

const { gateway, done } = await connectForScript();
const sessionId = crypto.randomUUID();
try {
  const t0 = performance.now();
  const res = await gateway.request("openclaw.setup.auth.start", { sessionId, agentId, authChoice }, { timeoutMs: 60_000 });
  console.log(`openclaw.setup.auth.start {authChoice:"${authChoice}"} (${Math.round(performance.now() - t0)}ms):\n${short(res, 3000)}`);
  // Steps are pulled with wizard.next; informational steps are acknowledged, and
  // the walk stops at anything that needs the person (link, code, pasted URL).
  type Step = { id: string; type: string; title?: string; message?: string; externalUrl?: string; deviceCode?: unknown; sensitive?: boolean; placeholder?: string; executor?: string };
  let answer: { stepId: string } | undefined;
  for (let i = 0; i < 6; i++) {
    const next = await gateway.request<{ done: boolean; step?: Step; status?: string; error?: string }>(
      "wizard.next",
      { sessionId, ...(answer ? { answer } : {}) },
      { timeoutMs: 60_000 },
    );
    console.log(`\nwizard.next #${i + 1}: ${short(next, 1500)}`);
    if (next.done || !next.step) break;
    const step = next.step;
    if (step.type === "note" || step.type === "progress") {
      answer = { stepId: step.id };
      continue;
    }
    console.log(`→ stop: step "${step.type}" needs the person${step.externalUrl ? " (opens a link)" : ""}${step.deviceCode ? " (shows a device code)" : ""}`);
    break;
  }
} catch (error) {
  const e = error as Error & { gatewayCode?: string; details?: unknown };
  console.error(`✗ ${e.message} code=${e.gatewayCode} details=${short(e.details ?? null, 800)}`);
  process.exitCode = 1;
} finally {
  await gateway.request("wizard.cancel", { sessionId }).then(
    () => console.log(`\ncancelled ${sessionId}`),
    (e: Error) => console.log(`\ncancel: ${e.message}`),
  );
  await done();
}
