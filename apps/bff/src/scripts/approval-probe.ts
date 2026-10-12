// Approvals: raise a harmless exec approval request (nothing runs) so the panel's queue can be checked.
//
//   pnpm --filter @clawdesk/bff approval-probe [--wait]

import { connectForScript, hasFlag, short } from "./_cli.js";

const { gateway, done } = await connectForScript();
try {
  const res = await gateway.request(
    "exec.approval.request",
    {
      command: "echo clawdesk-approval-test",
      commandArgv: ["echo", "clawdesk-approval-test"],
      cwd: "/var/lib/clawdesk/openclaw/workspace",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:main",
      twoPhase: true,
      timeoutMs: 180_000,
    },
    { timeoutMs: 200_000 },
  );
  console.log(`exec.approval.request: ${short(res, 1500)}`);
  if (hasFlag("wait")) {
    // Keeps the request open like an agent turn does, until the owner answers or it expires.
    const decision = await gateway.request("exec.approval.waitDecision", { id: (res as { id: string }).id }, { timeoutMs: 200_000 });
    console.log(`decision: ${short(decision, 800)}`);
  }
} finally {
  await done();
}
