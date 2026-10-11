// Generic one-off RPC call for exploration.
//
//   pnpm --filter @clawdesk/bff rpc --method config.schema.lookup --params '{"path":"agents.entries"}' [--max 4000]

import { connectForScript, flagValue, short } from "./_cli.js";

const method = flagValue("method");
if (!method) throw new Error("--method is required");
const params = JSON.parse(flagValue("params") ?? "{}") as unknown;
const max = Number(flagValue("max") ?? 4000);

const { gateway, done } = await connectForScript();
try {
  const res = await gateway.request(method, params, { timeoutMs: 60_000 });
  console.log(short(res, max));
} catch (error) {
  const e = error as Error & { gatewayCode?: string; details?: unknown };
  console.error(`✗ ${e.message} code=${e.gatewayCode ?? "-"}`);
  process.exitCode = 1;
} finally {
  await done();
}
