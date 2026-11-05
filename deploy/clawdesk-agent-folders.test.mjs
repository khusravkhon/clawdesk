import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncFolders } from "./clawdesk-file-sync.mjs";
import { AgentFolders } from "./clawdesk-agent-folders.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const host = path.join(root, "host"), agent = path.join(root, "agent");
  await fs.mkdir(host); await fs.mkdir(agent);
  return { root, host, agent };
}

test("exchanges new files and later edits both ways; deleting a copy never deletes the other", async (t) => {
  const { host, agent } = await fixture(t);
  await fs.writeFile(path.join(host, "данные.txt"), "owner input");
  let state = await syncFolders(host, agent);
  assert.equal(await fs.readFile(path.join(agent, "данные.txt"), "utf8"), "owner input");
  await fs.writeFile(path.join(agent, "plan.txt"), "agent output");
  state = await syncFolders(host, agent, state.hashes);
  assert.equal(await fs.readFile(path.join(host, "plan.txt"), "utf8"), "agent output");
  await fs.writeFile(path.join(agent, "plan.txt"), "updated output");
  state = await syncFolders(host, agent, state.hashes);
  assert.equal(await fs.readFile(path.join(host, "plan.txt"), "utf8"), "updated output");
  await fs.unlink(path.join(agent, "данные.txt"));
  await syncFolders(host, agent, state.hashes);
  assert.equal(await fs.readFile(path.join(agent, "данные.txt"), "utf8"), "owner input");
});

test("simultaneous edits preserve both versions and converge without repeated conflicts", async (t) => {
  const { host, agent } = await fixture(t);
  await fs.writeFile(path.join(host, "plan.txt"), "original");
  let state = await syncFolders(host, agent);
  await fs.writeFile(path.join(host, "plan.txt"), "owner changes");
  await fs.writeFile(path.join(agent, "plan.txt"), "agent changes");
  state = await syncFolders(host, agent, state.hashes);
  assert.equal(state.conflicts, 1);
  const conflict = (await fs.readdir(host)).find((name) => name.includes(".conflict-"));
  assert.ok(conflict);
  assert.equal(await fs.readFile(path.join(host, conflict), "utf8"), "agent changes");
  assert.equal(await fs.readFile(path.join(agent, "plan.txt"), "utf8"), "owner changes");
  state = await syncFolders(host, agent, state.hashes);
  assert.equal(state.conflicts, 0);
  assert.equal(await fs.readFile(path.join(agent, conflict), "utf8"), "agent changes");
});

test("ignores symlinks and never follows a destination directory into another agent", async (t) => {
  const { root, host, agent } = await fixture(t);
  const other = path.join(root, "other"); await fs.mkdir(other);
  await fs.writeFile(path.join(other, "private.txt"), "private");
  await fs.symlink(other, path.join(agent, "escape"));
  await fs.symlink(path.join(other, "private.txt"), path.join(host, "linked.txt"));
  await syncFolders(host, agent);
  await assert.rejects(fs.stat(path.join(agent, "linked.txt")), { code: "ENOENT" });
  await fs.mkdir(path.join(host, "escape"));
  await fs.writeFile(path.join(host, "escape", "private.txt"), "overwrite attempt");
  const result = await syncFolders(host, agent);
  assert.ok(result.issues.some((issue) => issue.path === "escape" && issue.code === "unsupported_file"));
  assert.equal(await fs.readFile(path.join(other, "private.txt"), "utf8"), "private");
});

test("skips oversized files while exchanging valid files on both sides", async (t) => {
  const { host, agent } = await fixture(t);
  const file = await fs.open(path.join(host, "large.bin"), "w");
  await file.truncate(33 * 1024 * 1024); await file.close();
  await fs.writeFile(path.join(host, "input.txt"), "input");
  await fs.writeFile(path.join(agent, "output.txt"), "output");
  const result = await syncFolders(host, agent);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.issues, [{ code: "file_too_large", path: "large.bin" }]);
  assert.equal(await fs.readFile(path.join(agent, "input.txt"), "utf8"), "input");
  assert.equal(await fs.readFile(path.join(host, "output.txt"), "utf8"), "output");
  assert.equal((await fs.stat(path.join(host, "large.bin"))).size, 33 * 1024 * 1024);
});

for (const largeSide of ["host", "agent"]) {
  test(`preserves oversized ${largeSide} and its baseline against stale small copies; recovers after shrink`, async (t) => {
    const { host, agent } = await fixture(t);
    await fs.writeFile(path.join(host, "same.bin"), "original");
    let state = await syncFolders(host, agent);
    const baseline = state.hashes["same.bin"];
    const large = largeSide === "host" ? host : agent, small = largeSide === "host" ? agent : host;
    const file = await fs.open(path.join(large, "same.bin"), "w");
    await file.truncate(33 * 1024 * 1024); await file.close();
    state = await syncFolders(host, agent, state.hashes);
    assert.equal(state.hashes["same.bin"], baseline);
    assert.equal((await fs.stat(path.join(large, "same.bin"))).size, 33 * 1024 * 1024);
    assert.equal(await fs.readFile(path.join(small, "same.bin"), "utf8"), "original");
    await fs.writeFile(path.join(large, "same.bin"), "replacement");
    state = await syncFolders(host, agent, state.hashes);
    assert.equal(state.skipped, 0);
    assert.equal(await fs.readFile(path.join(small, "same.bin"), "utf8"), "replacement");
  });
}

test("blocked paths also protect descendants and preserve their prior hashes", async (t) => {
  const { host, agent } = await fixture(t);
  await fs.mkdir(path.join(host, "nested"));
  await fs.writeFile(path.join(host, "nested", "safe.txt"), "original");
  let state = await syncFolders(host, agent);
  const baseline = state.hashes["nested/safe.txt"];
  await fs.rm(path.join(host, "nested"), { recursive: true });
  await fs.symlink(agent, path.join(host, "nested"));
  await fs.writeFile(path.join(agent, "nested", "safe.txt"), "new");
  state = await syncFolders(host, agent, state.hashes);
  assert.equal(state.hashes["nested/safe.txt"], baseline);
  assert.equal((await fs.lstat(path.join(host, "nested"))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(agent, "nested", "safe.txt"), "utf8"), "new");
});

test("bounds diagnostics without losing blocked paths, and never copies after a failed root scan", async (t) => {
  const { root, host, agent } = await fixture(t);
  for (let n = 0; n < 25; n++) await fs.symlink(agent, path.join(host, `link-${n}`));
  const result = await syncFolders(host, agent);
  assert.equal(result.skipped, 25);
  assert.equal(result.issues.length, 20);
  await fs.writeFile(path.join(host, "pending.txt"), "retained");
  await assert.rejects(syncFolders(host, path.join(root, "missing")));
  assert.equal(await fs.readFile(path.join(host, "pending.txt"), "utf8"), "retained");
});

test("a directory replaced with a file preserves blocked descendant baselines", async (t) => {
  const { host, agent } = await fixture(t);
  await fs.mkdir(path.join(host, "nested"));
  await fs.writeFile(path.join(host, "nested", "a.txt"), "original");
  let state = await syncFolders(host, agent);
  const baseline = state.hashes["nested/a.txt"];
  await fs.rm(path.join(host, "nested"), { recursive: true });
  await fs.writeFile(path.join(host, "nested"), "replacement");
  state = await syncFolders(host, agent, state.hashes);
  assert.equal(state.hashes["nested/a.txt"], baseline);
  assert.equal(await fs.readFile(path.join(host, "nested"), "utf8"), "replacement");
  assert.equal(await fs.readFile(path.join(agent, "nested", "a.txt"), "utf8"), "original");
});

test("public statuses sanitize persisted diagnostics and never expose registry hashes or internals", async (t) => {
  const { root, host } = await fixture(t);
  const stateDir = path.join(root, "state");
  await fs.mkdir(path.join(stateDir, "clawdesk"), { recursive: true });
  const item = { agentId: "trainer", name: "Training", hashes: { "secret.txt": "private-hash" }, workspaceIdentity: "private-inode", status: {
    state: "partial", lastAttempt: -1, lastSuccess: 9_000_000_000_000_000, conflicts: -10, skipped: -10,
    issues: [...["/private/path", "C:/private/path", "../secret", "control\nname", "x".repeat(501)].map((name) => ({ code: "raw secret exception", path: name })), ...Array.from({ length: 30 }, () => ({ code: "file_too_large", path: "safe.bin" }))],
  } };
  await fs.writeFile(path.join(stateDir, "clawdesk", "folder-sync.json"), JSON.stringify({ version: 1, folders: [item] }));
  const result = await new AgentFolders({ stateDir, filesDir: host, configPath: "unused" }).statuses();
  const status = result.folders[0];
  assert.equal(status.issues.length, 20);
  assert.equal(status.lastAttempt, null);
  assert.equal(status.lastSuccess, null);
  assert.ok(status.issues.slice(0, 5).every((issue) => issue.code === "folder_unavailable" && issue.path === null));
  for (const sensitive of ["private-hash", "private-inode", "secret.txt", "raw secret exception", "/private/path"]) assert.equal(JSON.stringify(result).includes(sensitive), false);
});

test("global depth limit aborts before transferring eligible files", async (t) => {
  const { host, agent } = await fixture(t);
  await fs.writeFile(path.join(host, "eligible.txt"), "source");
  await fs.mkdir(path.join(agent, ...Array(31).fill("deep")), { recursive: true });
  await assert.rejects(syncFolders(host, agent), { code: "folder_depth_limit" });
  await assert.rejects(fs.stat(path.join(agent, "eligible.txt")), { code: "ENOENT" });
});

test("rejects symlinked ancestors of either synchronization root", async (t) => {
  const { root, host, agent } = await fixture(t);
  await fs.mkdir(path.join(agent, "nested"));
  await fs.symlink(agent, path.join(root, "alias"));
  await fs.writeFile(path.join(host, "private.txt"), "owner file");
  await assert.rejects(syncFolders(host, path.join(root, "alias", "nested")));
  await assert.rejects(fs.stat(path.join(agent, "nested", "private.txt")), { code: "ENOENT" });
});

test("registers per-agent workspaces, survives restart and never recreates deleted agents", async (t) => {
  const { root, host } = await fixture(t);
  const stateDir = path.join(root, "state"), workspace = path.join(stateDir, "workspace", "trainer");
  await fs.mkdir(workspace, { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  const config = { agents: { defaults: { workspace: path.join(stateDir, "workspace") }, entries: { trainer: { workspace } } } };
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.mkdir(path.join(host, "Тренировки"));
  await fs.writeFile(path.join(host, "Тренировки", "input.txt"), "source");
  const options = { stateDir, filesDir: host, configPath };
  const manager = new AgentFolders(options);
  const registered = await manager.register("trainer", "Тренировки");
  let status = (await manager.statuses()).folders[0];
  assert.equal(status.state, "ready");
  assert.ok(status.lastAttempt && status.lastSuccess);
  assert.equal(Object.hasOwn(status, "hashes"), false);
  assert.equal(registered.gatewayPath, path.join(workspace, "folders", "Тренировки"));
  assert.equal(await fs.readFile(path.join(registered.gatewayPath, "input.txt"), "utf8"), "source");
  await fs.writeFile(path.join(registered.gatewayPath, "output.txt"), "result");
  await new AgentFolders(options).syncAll();
  const large = await fs.open(path.join(host, "Тренировки", "large.bin"), "w");
  await large.truncate(33 * 1024 * 1024); await large.close();
  const lastSuccess = (await manager.statuses()).folders[0].lastSuccess;
  await manager.syncAll();
  status = (await new AgentFolders(options).statuses()).folders[0];
  assert.equal(status.state, "partial");
  assert.equal(status.lastSuccess, lastSuccess);
  assert.deepEqual(status.issues, [{ code: "file_too_large", path: "large.bin" }]);
  assert.equal(JSON.stringify(status).includes(stateDir), false);
  assert.equal(JSON.stringify(status).includes("hashes"), false);
  assert.equal(await fs.readFile(path.join(host, "Тренировки", "output.txt"), "utf8"), "result");
  await assert.rejects(manager.register("main", "Тренировки"));
  await assert.rejects(manager.register("trainer", "../escape"));
  delete config.agents.entries.trainer;
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.rm(workspace, { recursive: true });
  await manager.syncAll();
  assert.deepEqual(await manager.statuses(), { folders: [] });
  await assert.rejects(fs.stat(workspace), { code: "ENOENT" });
});

test("rejects an outside workspace and symlinked managed folders", async (t) => {
  const { root, host } = await fixture(t);
  const stateDir = path.join(root, "state"); await fs.mkdir(stateDir);
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({ agents: { entries: { trainer: { workspace: root } } } }));
  const manager = new AgentFolders({ stateDir, filesDir: host, configPath });
  await assert.rejects(manager.register("trainer", "Training"), /outside/);
  const workspace = path.join(stateDir, "workspace", "trainer");
  await fs.mkdir(workspace, { recursive: true });
  await fs.symlink(host, path.join(workspace, "folders"));
  await fs.writeFile(configPath, JSON.stringify({ agents: { entries: { trainer: { workspace } } } }));
  await assert.rejects(manager.register("trainer", "Training"));
  await assert.rejects(fs.stat(path.join(host, "Training")), { code: "ENOENT" });
});

test("an agent ID reused for a different workspace does not inherit the deleted agent's files", async (t) => {
  const { root, host } = await fixture(t);
  const stateDir = path.join(root, "state"), workspace = path.join(stateDir, "workspace", "trainer");
  await fs.mkdir(workspace, { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({ agents: { entries: { trainer: { workspace } } } }));
  await fs.mkdir(path.join(host, "Old"));
  await fs.writeFile(path.join(host, "Old", "private.txt"), "old agent data");
  const manager = new AgentFolders({ stateDir, filesDir: host, configPath });
  await manager.register("trainer", "Old");
  await fs.rename(workspace, `${workspace}-deleted`);
  await fs.mkdir(workspace);
  await manager.syncAll();
  await assert.rejects(fs.stat(path.join(workspace, "folders")), { code: "ENOENT" });
});

test("metadata cache requires personal-mode opt-in and discards cached data when mode changes", () => {
  const options = { stateDir: "/unused", filesDir: "/unused", configPath: "/unused" };
  const disabled = new AgentFolders(options);
  assert.deepEqual(disabled.syncOptions(), {});
  let personal = true;
  const manager = new AgentFolders({ ...options, metadataCacheEnabled: () => personal });
  const first = manager.syncOptions().cache;
  assert.ok(first);
  assert.equal(manager.syncOptions().cache, first);
  personal = false;
  assert.deepEqual(manager.syncOptions(), {});
  personal = true;
  assert.notEqual(manager.syncOptions().cache, first);
});

test("a team member's docs: a fixed workspace folder, and read-only members never write back", async (t) => {
  const { root, host } = await fixture(t);
  const stateDir = path.join(root, "state"), pm = path.join(stateDir, "workspace", "shop-pm"), dev = path.join(stateDir, "workspace", "shop-developer");
  await fs.mkdir(pm, { recursive: true }); await fs.mkdir(dev, { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: { workspace: path.join(stateDir, "workspace") }, entries: { "shop-pm": { workspace: pm }, "shop-developer": { workspace: dev } } } }));
  await fs.mkdir(path.join(host, "Shop"));
  await fs.writeFile(path.join(host, "Shop", "spec.md"), "v1");
  const manager = new AgentFolders({ stateDir, filesDir: host, configPath });
  assert.equal((await manager.register("shop-pm", "Shop", { dir: "docs" })).gatewayPath, path.join(pm, "docs"));
  assert.equal((await manager.register("shop-developer", "Shop", { dir: "docs", readOnly: true })).gatewayPath, path.join(dev, "docs"));
  assert.equal(await fs.readFile(path.join(dev, "docs", "spec.md"), "utf8"), "v1");
  // The PM's edit reaches the shared folder and the developer; the developer's edits stay in its workspace.
  await fs.writeFile(path.join(pm, "docs", "spec.md"), "v2");
  await fs.writeFile(path.join(dev, "docs", "notes.md"), "mine");
  await manager.syncAll();
  await manager.syncAll();
  assert.equal(await fs.readFile(path.join(host, "Shop", "spec.md"), "utf8"), "v2");
  assert.equal(await fs.readFile(path.join(dev, "docs", "spec.md"), "utf8"), "v2");
  await assert.rejects(fs.stat(path.join(host, "Shop", "notes.md")), { code: "ENOENT" });
  await fs.writeFile(path.join(dev, "docs", "spec.md"), "tampered");
  await manager.syncAll();
  assert.equal(await fs.readFile(path.join(host, "Shop", "spec.md"), "utf8"), "v2");
  assert.equal(await fs.readFile(path.join(dev, "docs", "spec.md"), "utf8"), "v2");
  await assert.rejects(manager.register("shop-pm", "Shop", { dir: "../x" }));
  await assert.rejects(manager.register("shop-pm", "Shop", { readOnly: "yes" }));
});

test("unregistering removes the agent's copy and stops synchronizing, never touching the shared folder", async (t) => {
  const { root, host } = await fixture(t);
  const stateDir = path.join(root, "state"), workspace = path.join(stateDir, "workspace", "analyst");
  await fs.mkdir(workspace, { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: { workspace: path.join(stateDir, "workspace") }, entries: { analyst: { workspace } } } }));
  await fs.mkdir(path.join(host, "Finance")); await fs.writeFile(path.join(host, "Finance", "report.txt"), "secret");
  const manager = new AgentFolders({ stateDir, filesDir: host, configPath });
  await manager.register("analyst", "Finance", { readOnly: true });
  assert.deepEqual((await manager.statuses()).folders.map((item) => [item.folder, item.dir, item.readOnly]), [["Finance", null, true]]);
  assert.equal(await fs.readFile(path.join(workspace, "folders", "Finance", "report.txt"), "utf8"), "secret");
  assert.deepEqual(await manager.unregister("analyst", "Finance"), { removed: true });
  await assert.rejects(fs.stat(path.join(workspace, "folders", "Finance")), { code: "ENOENT" });
  assert.deepEqual(await manager.statuses(), { folders: [] });
  await fs.writeFile(path.join(host, "Finance", "later.txt"), "new");
  await manager.syncAll();
  await assert.rejects(fs.stat(path.join(workspace, "folders", "Finance")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(host, "Finance", "report.txt"), "utf8"), "secret");
  // A link the agent put in place of the copy is removed itself; its target stays.
  await fs.mkdir(path.join(root, "elsewhere")); await fs.writeFile(path.join(root, "elsewhere", "keep.txt"), "x");
  await fs.mkdir(path.join(workspace, "folders"), { recursive: true });
  await fs.symlink(path.join(root, "elsewhere"), path.join(workspace, "folders", "Finance"));
  assert.deepEqual(await manager.unregister("analyst", "Finance"), { removed: false });
  assert.equal(await fs.readFile(path.join(root, "elsewhere", "keep.txt"), "utf8"), "x");
  await assert.rejects(fs.lstat(path.join(workspace, "folders", "Finance")), { code: "ENOENT" });
});
