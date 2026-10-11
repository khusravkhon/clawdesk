// Stage 0 helper: invoke one agent tool directly (no model turn) to check what an
// agent can see, e.g. inside its sandbox.
//
//   pnpm --filter @clawdesk/bff tool-invoke --agent main --name read --args '{"path":"SOUL.md"}'
//   pnpm --filter @clawdesk/bff tool-invoke --agent main --effective     list the agent's effective tools

import { connectForScript, flagValue, hasFlag, short } from "./_cli.js";

const agentId = flagValue("agent") ?? "main";
const sessionKey = flagValue("session") ?? `agent:${agentId}:main`;

const { gateway, done } = await connectForScript();
try {
  if (hasFlag("effective")) {
    const res = await gateway.request<{ groups?: { id?: string; label?: string; tools?: { id: string; risk?: string }[] }[] }>("tools.effective", { agentId, sessionKey });
    for (const group of res.groups ?? []) console.log(`${group.label ?? group.id}: ${(group.tools ?? []).map((t) => t.id).join(", ")}`);
    if (!res.groups) console.log(short(res, 3000));
  } else {
    const name = flagValue("name");
    if (!name) throw new Error("--name is required");
    const args = JSON.parse(flagValue("args") ?? "{}") as Record<string, unknown>;
    const res = await gateway.request("tools.invoke", { name, args, agentId, sessionKey, idempotencyKey: crypto.randomUUID() }, { timeoutMs: 120_000 });
    console.log(short(res, 4000));
  }
} catch (error) {
  console.error(`✗ ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await done();
}
