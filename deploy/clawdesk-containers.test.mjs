import assert from "node:assert/strict";
import { test } from "node:test";
import { composeServiceContainer } from "./clawdesk-containers.mjs";

const identity = { stateDir: "/srv/local/openclaw", token: "fixture-token" };
const gateway = (id, project, token) => ({
  Id: id,
  Config: { Hostname: "clawdesk-gateway", Labels: { "com.docker.compose.project": project, "com.docker.compose.service": "gateway" }, Env: [`OPENCLAW_GATEWAY_TOKEN=${token}`, `OPENCLAW_STATE_DIR=${identity.stateDir}`] },
  Mounts: [{ Source: identity.stateDir, Destination: identity.stateDir }],
});
const own = gateway("local-gateway-1", "local", identity.token);
const other = gateway("server-gateway-1", "server", "different-token");
const command = (items, siblings) => async (args) => {
  if (args[0] === "inspect") {
    assert.deepEqual(args, ["inspect", ...items.map((item) => item.Id)]);
    return JSON.stringify(items);
  }
  if (args.length === 4) {
    assert.deepEqual(args, ["ps", "-q", "--filter", "label=com.docker.compose.service=gateway"]);
    return items.map((item) => item.Id).join("\n");
  }
  assert.deepEqual(args, ["ps", "-q", "--filter", "label=com.docker.compose.project=local", "--filter", "label=com.docker.compose.service=freellmapi"]);
  return siblings.join("\n");
};

test("finds sibling by project identity, independently of hostname and foreign installations", async () => {
  assert.equal(await composeServiceContainer(command([other, own], ["local-freellmapi-1"]), "freellmapi", identity), "local-freellmapi-1");
});

test("does not arbitrarily pick a missing or replicated service", async () => {
  for (const siblings of [[], ["one", "two"]]) {
    assert.equal(await composeServiceContainer(command([own], siblings), "freellmapi", identity), null);
  }
});

test("refuses foreign, ambiguous Gateways and Docker failures", async () => {
  for (const items of [[other], [own, { ...own, Id: "duplicate" }]]) {
    await assert.rejects(composeServiceContainer(command(items, ["unused"]), "freellmapi", identity));
  }
  await assert.rejects(composeServiceContainer(async () => { throw new Error("Docker unavailable"); }, "freellmapi", identity));
});
