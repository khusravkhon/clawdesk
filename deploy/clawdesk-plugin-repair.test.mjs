import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { recoveryPlan, verifyArtifact, repair, restoreNpm, linkHost, run } from "./clawdesk-plugin-repair.mjs";

const base = path.resolve(os.tmpdir());
const root = await fs.mkdtemp(path.join(base, "clawdesk-plugin-test-"));
after(async () => {
  assert.equal(path.dirname(path.resolve(root)), base);
  assert.ok(path.basename(root).startsWith("clawdesk-plugin-test-"));
  await fs.rm(root, { recursive: true, force: true });
});
const packageName = "@openclaw/llama-cpp-provider";
const artifact = Buffer.from("approved fixture artifact");
const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
const record = (state) => ({ source: "npm", spec: `${packageName}@2026.8.1`, installPath: path.join(state, "npm/projects/fixture/node_modules", packageName), integrity, acceptedSurfaceHash: "saved-review", acceptedSurface: { providers: ["llama-cpp"] } });

test("accepts only pinned approved artifacts in managed paths", () => {
  const state = path.join(root, "planning");
  assert.equal(recoveryPlan({ "llama-cpp": record(state) }, state)[0].version, "2026.8.1");
  for (const patch of [{ spec: `${packageName}@latest` }, { acceptedSurfaceHash: undefined }, { integrity: undefined }, { installPath: "/outside/node_modules/plugin" }, { source: "path" }]) {
    assert.throws(() => recoveryPlan({ "llama-cpp": { ...record(state), ...patch } }, state));
  }
});

test("verifies the exact previously approved bytes", () => {
  assert.doesNotThrow(() => verifyArtifact(artifact, integrity));
  assert.throws(() => verifyArtifact(Buffer.from("different bytes"), integrity));
  assert.throws(() => verifyArtifact(artifact, "unverified"));
});

test("fresh installation performs no downloads and leaves configuration untouched", async () => {
  const state = path.join(root, "fresh");
  await fs.mkdir(state);
  const config = '{"agents":{},"fixture":"keep"}';
  await fs.writeFile(path.join(state, "openclaw.json"), config);
  await repair({ stateDir: state, command: () => { throw new Error("unexpected command"); }, log: () => {} });
  assert.equal(await fs.readFile(path.join(state, "openclaw.json"), "utf8"), config);
});

for (const missingProject of [false, true]) test(`restores approved dependencies with missing project=${missingProject}`, async () => {
  const state = path.join(root, `restored-${missingProject}`);
  const item = record(state);
  const project = path.join(state, "npm/projects/fixture");
  await fs.mkdir(state, { recursive: true });
  if (!missingProject) {
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ private: true, dependencies: { [packageName]: "2026.8.1" } }));
  }
  const config = JSON.stringify({ plugins: { installs: { "llama-cpp": item }, entries: { "llama-cpp": { enabled: true } } }, agents: { fixture: "preserve" } });
  await fs.writeFile(path.join(state, "openclaw.json"), config);
  const calls = [];
  const command = async (program, args, { cwd }) => {
    calls.push([program, ...args]);
    assert.equal(program, "npm");
    assert.ok(args.includes("--ignore-scripts"));
    if (args[0] === "pack") {
      await fs.writeFile(path.join(cwd, "plugin.tgz"), artifact);
      return { code: 0, out: JSON.stringify({ [packageName]: { filename: 'plugin.tgz' } }) };
    }
    const target = path.join(cwd, "node_modules", packageName);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "package.json"), JSON.stringify({ name: packageName, version: "2026.8.1", peerDependencies: { openclaw: "*" } }));
    return { code: 0, out: "" };
  };
  const host = path.join(root, `host-${missingProject}`); await fs.mkdir(host);
  await repair({ stateDir: state, hostRoot: host, command, log: () => {} });
  assert.equal(calls.length, 2);
  assert.equal(await fs.realpath(path.join(item.installPath, "node_modules/openclaw")), await fs.realpath(host));
  assert.equal(await fs.readFile(path.join(state, "openclaw.json"), "utf8"), config);
  await repair({ stateDir: state, hostRoot: host, command: () => { throw new Error("healthy boot downloaded packages"); }, log: () => {} });
});

test("repairs a missing registered host link without overwriting an ordinary dependency", async () => {
  const dir = path.join(root, "registered"), host = path.join(root, "second-host");
  await fs.mkdir(dir); await fs.mkdir(host);
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ peerDependencies: { openclaw: "*" } }));
  await linkHost(dir, host);
  assert.equal(await fs.realpath(path.join(dir, "node_modules/openclaw")), await fs.realpath(host));
  await fs.unlink(path.join(dir, "node_modules/openclaw"));
  await fs.mkdir(path.join(dir, "node_modules/openclaw"));
  await assert.rejects(linkHost(dir, host), /not a managed host link/);
});

test("rejects a linked npm parent before creating projects or downloading", async () => {
  const state = path.join(root, "linked-parent"), outside = path.join(root, "outside-parent");
  await fs.mkdir(state); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(state, "npm"), "dir");
  const [item] = recoveryPlan({ "llama-cpp": record(state) }, state);
  await assert.rejects(restoreNpm(item, { command: () => { throw new Error("unexpected download"); } }), /symbolic link|escapes/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("CLI runner preserves the environment and supplies configuration patch input", async () => {
  const result = await run(process.execPath, ["--input-type=module", "-e", 'let s="";for await(const c of process.stdin)s+=c;console.log(JSON.stringify({s,ok:process.env.PATH!==undefined,custom:process.env.REPAIR_TEST}))'], { cwd: root, input: "fixture", env: { REPAIR_TEST: "yes" } });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out), { s: "fixture", ok: true, custom: "yes" });
});
