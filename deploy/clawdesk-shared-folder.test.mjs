import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedFolderSource } from "./clawdesk-shared-folder.mjs";

const identity = { stateDir: "/var/lib/clawdesk-local/openclaw", token: "fixture-token" };
const gateway = (id, token, source) => ({
  Id: id,
  Config: { Hostname: "clawdesk-gateway", Labels: { "com.docker.compose.project": id, "com.docker.compose.service": "gateway" }, Env: [`OPENCLAW_GATEWAY_TOKEN=${token}`, `OPENCLAW_STATE_DIR=${identity.stateDir}`] },
  Mounts: [{ Destination: identity.stateDir, Source: identity.stateDir }, { Destination: `${identity.stateDir}/workspace/files`, Source: source, RW: true }],
});
const command = (items) => async (args) => {
  if (args[0] === "ps") return items.map((item) => item.Id).join("\n");
  assert.deepEqual(args, ["inspect", ...items.map((item) => item.Id)]);
  return JSON.stringify(items);
};

test("resolves the correct installation's mount with a fixed hostname among multiple Gateways", async () => {
  const own = gateway("clawdesk-local-gateway-1", identity.token, "/srv/own/files");
  const foreign = gateway("other-gateway-1", "other-token", "/srv/foreign/files");
  assert.equal(await sharedFolderSource(command([foreign, own]), identity), "/srv/own/files");
});

test("converts Windows Docker Desktop paths and preserves Linux daemon paths", async () => {
  for (const [source, expected] of [["E:\\My Projects\\files", "/run/desktop/mnt/host/e/My Projects/files"], ["C:/Users/user/files", "/run/desktop/mnt/host/c/Users/user/files"], ["/host/files", "/host/files"]]) {
    assert.equal(await sharedFolderSource(command([gateway("own", identity.token, source)]), identity), expected);
  }
});

test("does not use missing, read-only, root or foreign mounts", async () => {
  for (const mount of [undefined, { Source: "/", RW: true }, { Source: "/files", RW: false }]) {
    const own = gateway("own", identity.token, "/files");
    own.Mounts = own.Mounts.slice(0, 1);
    if (mount) own.Mounts.push({ Destination: `${identity.stateDir}/workspace/files`, ...mount });
    assert.equal(await sharedFolderSource(command([own]), identity), null);
  }
  await assert.rejects(sharedFolderSource(command([gateway("foreign", "wrong-token", "/files")]), identity));
  await assert.rejects(sharedFolderSource(command([gateway("one", identity.token, "/one"), gateway("two", identity.token, "/two")]), identity));
});
