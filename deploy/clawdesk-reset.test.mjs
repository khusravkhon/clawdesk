import assert from "node:assert/strict";
import { test } from "node:test";
import { resetGateway } from "./clawdesk-backup.mjs";

const identity = { stateDir: "/var/lib/clawdesk-local/openclaw", token: "fixture-token" };
const container = (id, token = identity.token, stateDir = identity.stateDir) => ({
  Id: id, Name: `/${id}`, Config: { Hostname: "clawdesk-gateway", Labels: { "com.docker.compose.project": id, "com.docker.compose.service": "gateway" }, Env: [`OPENCLAW_GATEWAY_TOKEN=${token}`, `OPENCLAW_STATE_DIR=${stateDir}`] },
  Mounts: [{ Destination: stateDir, Source: stateDir }],
});
const command = (items) => async (args) => {
  if (args[0] === "ps") { assert.deepEqual(args, ["ps", "-q", "--filter", "label=com.docker.compose.service=gateway"]); return items.map((item) => item.Id).join("\n"); }
  assert.deepEqual(args, ["inspect", ...items.map((item) => item.Id)]);
  return JSON.stringify(items);
};

test("finds its own Gateway with a custom hostname among other installations", async () => {
  const own = container("clawdesk-local-gateway-1");
  const other = container("other-gateway-1", "other-token");
  assert.deepEqual(await resetGateway(command([other, own]), identity), own);
});

test("refuses missing, foreign, unmounted and ambiguous Gateways without mutations", async () => {
  for (const items of [[], [container("foreign", "other-token")], [{ ...container("no-mount"), Mounts: [] }], [container("one"), container("two")], [container("other-state", identity.token, "/other")]]) {
    await assert.rejects(resetGateway(command(items), identity));
  }
  await assert.rejects(resetGateway(() => { throw new Error("must not invoke Docker"); }, { ...identity, token: "" }), /identity is unavailable/);
});
