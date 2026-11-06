import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ProjectFolders, RESTORED_MARKER } from "./clawdesk-project-folders.mjs";

async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-projects-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const service = new ProjectFolders({ stateDir });
  const root = path.join(stateDir, "company-projects");
  await service.status("project-a");
  return { stateDir, root, service };
}
const request = (patch = {}) => ({ projectId: "project-a", mode: "new", name: "Моё приложение", requestId: randomUUID(), ...patch });

test("creates an empty folder, persists the binding and deduplicates after restart", async (t) => {
  const { stateDir, root, service } = await fixture(t);
  const req = request();
  const result = await service.prepare(req);
  assert.equal(result.workspace.state, "ready");
  assert.deepEqual(await fs.readdir(path.join(root, req.name)), []);
  const restarted = new ProjectFolders({ stateDir });
  assert.deepEqual(await restarted.prepare(req), result);
  await assert.rejects(restarted.prepare({ ...req, name: "Other" }), { code: "workspace_already_linked" });
  await assert.rejects(restarted.prepare(request({ projectId: "project-b" })), { code: "workspace_in_use" });
  assert.deepEqual(await fs.readdir(root), [req.name]);
});

test("connects existing dirty Git and executable files without reading or changing contents", async (t) => {
  const { root, service } = await fixture(t);
  await fs.mkdir(path.join(root, "Existing", ".git"), { recursive: true });
  await fs.writeFile(path.join(root, "Existing", ".git", "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(root, "Existing", "package.json"), '{"scripts":{"prepare":"exit 1"}}');
  await fs.writeFile(path.join(root, "Existing", "dirty.txt"), "uncommitted\n");
  assert.deepEqual((await service.status("project-a")).available, ["Existing"]);
  const req = request({ name: "Existing" });
  await assert.rejects(service.prepare(req), { code: "workspace_exists" });
  assert.equal((await service.prepare({ ...req, mode: "existing" })).workspace.state, "ready");
  assert.equal(await fs.readFile(path.join(root, "Existing", "dirty.txt"), "utf8"), "uncommitted\n");
  assert.equal(await fs.readFile(path.join(root, "Existing", ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
  assert.deepEqual((await service.status("project-b")).available, []);
});

test("rejects traversal, links outside the root and a linked root itself", async (t) => {
  const { stateDir, root, service } = await fixture(t);
  for (const name of ["../escape", "/tmp/project", "a/b", "a\\b", ".", "..", "C:drive", "a\n"]) {
    await assert.rejects(async () => service.prepare(request({ name })), { code: "invalid_workspace" });
  }
  await fs.symlink(stateDir, path.join(root, "Outside"));
  assert.deepEqual((await service.status("project-a")).available, []);
  await assert.rejects(service.prepare(request({ name: "Outside", mode: "existing" })), { code: "workspace_not_directory" });
  await fs.rename(root, root + "-retained");
  await fs.symlink(root + "-retained", root);
  await assert.rejects(service.status("project-a"), { code: "workspace_unavailable" });
});

test("reports removal and replacement and blocks reassignment of a renamed folder", async (t) => {
  const { root, service } = await fixture(t);
  const req = request();
  await service.prepare(req);
  await fs.rename(path.join(root, req.name), path.join(root, "Moved"));
  assert.equal((await service.status(req.projectId)).workspace.state, "missing");
  await assert.rejects(service.prepare(request({ projectId: "project-b", name: "Moved", mode: "existing" })), { code: "workspace_in_use" });
  await fs.mkdir(path.join(root, req.name));
  assert.equal((await service.prepare(req)).workspace.state, "changed");
});

test("after a restore the recreated folders are pinned again, once", async (t) => {
  const { stateDir, root, service } = await fixture(t);
  const req = request();
  await service.prepare(req);
  await service.prepare(request({ projectId: "project-b", name: "Gone" }));
  const registryFile = path.join(stateDir, "clawdesk-project-folders.json");
  const pinned = () => JSON.parse(readFileSync(registryFile, "utf8")).bindings.find((item) => item.projectId === req.projectId).identity;
  const record = path.join(stateDir, `clawdesk-build-${createHash("sha256").update(req.projectId).digest("hex").slice(0, 32)}.json`);
  await fs.writeFile(record, JSON.stringify({ identity: pinned(), templateId: "task-board-v1", hashes: {} }));
  // Restore brings the same folder back as a new directory, and a folder may be absent from the copy.
  await fs.cp(path.join(root, req.name), path.join(root, "copy"), { recursive: true });
  await fs.rm(path.join(root, req.name), { recursive: true });
  await fs.rename(path.join(root, "copy"), path.join(root, req.name));
  await fs.rm(path.join(root, "Gone"), { recursive: true });
  assert.equal((await service.status(req.projectId)).workspace.state, "changed");
  await fs.writeFile(path.join(stateDir, RESTORED_MARKER), "");
  assert.equal(await service.withWorkspace(req.projectId, async ({ name }) => name), req.name);
  assert.equal((await service.status(req.projectId)).workspace.state, "ready");
  assert.equal((await service.status("project-b")).workspace.state, "missing");
  await assert.rejects(fs.stat(path.join(stateDir, RESTORED_MARKER)), { code: "ENOENT" });
  // The builder's record follows the folder, so the app still counts as made by the builder.
  assert.deepEqual(JSON.parse(await fs.readFile(record, "utf8")), { identity: pinned(), templateId: "task-board-v1", hashes: {} });
  // Without the marker a replacement is still reported.
  await fs.rm(path.join(root, req.name), { recursive: true });
  await fs.mkdir(path.join(root, req.name));
  assert.equal((await service.status(req.projectId)).workspace.state, "changed");
});

test("serializes competing claims and fails closed for a corrupted or linked registry", async (t) => {
  const { stateDir, root, service } = await fixture(t);
  await fs.mkdir(path.join(root, "Shared"));
  const results = await Promise.allSettled([service.prepare(request({ name: "Shared", mode: "existing" })), service.prepare(request({ projectId: "project-b", name: "Shared", mode: "existing" }))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const registry = path.join(stateDir, "clawdesk-project-folders.json");
  await fs.writeFile(registry, "broken");
  await assert.rejects(service.prepare(request({ projectId: "project-c", name: "New" })), { code: "workspace_unavailable" });
  await assert.rejects(fs.stat(path.join(root, "New")), { code: "ENOENT" });
  await fs.unlink(registry);
  await fs.symlink(path.join(root, "Shared"), registry);
  await assert.rejects(service.status("project-a"), { code: "workspace_unavailable" });
});

test("a failed registry save retains the created folder for explicit recovery", async (t) => {
  const { root, service } = await fixture(t);
  const rename = fs.rename;
  const req = request();
  fs.rename = async () => { throw new Error("simulated disk failure"); };
  try { await assert.rejects(service.prepare(req), { code: "workspace_unavailable" }); }
  finally { fs.rename = rename; }
  assert.deepEqual(await fs.readdir(path.join(root, req.name)), []);
  assert.equal((await service.status(req.projectId)).workspace, null);
  await assert.rejects(service.prepare(req), { code: "workspace_exists" });
  assert.equal((await service.prepare({ ...req, mode: "existing" })).workspace.state, "ready");
});
