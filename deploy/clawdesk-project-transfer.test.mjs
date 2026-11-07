import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectFolders } from "./clawdesk-project-folders.mjs";
import { ProjectTransfer, safePath } from "./clawdesk-project-transfer.mjs";

const linux = { skip: process.platform !== "linux" && "Directory handle confinement requires Linux /proc" };

async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-transfer-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const folders = new ProjectFolders({ stateDir });
  await folders.status("source");
  await folders.prepare({ projectId: "source", mode: "new", name: "Source", requestId: randomUUID() });
  await folders.prepare({ projectId: "target", mode: "new", name: "Target", requestId: randomUUID() });
  const root = path.join(stateDir, "company-projects");
  return { stateDir, root, folders, transfer: new ProjectTransfer({ folders }) };
}

test("a project's files travel with their hashes; secrets, dependencies, git and links stay behind", linux, async t => {
  const f = await fixture(t);
  const source = path.join(f.root, "Source");
  await fs.mkdir(path.join(source, "src", "lib"), { recursive: true });
  await fs.writeFile(path.join(source, "server.mjs"), "console.log('ok');");
  await fs.writeFile(path.join(source, "src", "lib", "rules.mjs"), "export const limit = 10;");
  await fs.writeFile(path.join(source, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
  await fs.writeFile(path.join(source, ".env"), "TOKEN=1");
  await fs.writeFile(path.join(source, "tasks.sqlite"), "db");
  await fs.writeFile(path.join(source, "notes.txt"), "key ghp_" + "a".repeat(36));
  await fs.mkdir(path.join(source, "node_modules", "x"), { recursive: true });
  await fs.mkdir(path.join(source, ".git"));
  await fs.symlink("/etc", path.join(source, "outside"));
  const read = await f.transfer.read("source");
  assert.deepEqual(read.files.map(file => file.path), ["logo.png", "server.mjs", "src/lib/rules.mjs"]);
  assert.deepEqual(read.excluded.map(item => [item.path, item.reason]).sort(), [[".env", "secret_or_local"], [".git/", "version_control"], ["node_modules/", "generated"], ["notes.txt", "looks_like_secret"], ["outside", "link"], ["tasks.sqlite", "secret_or_local"]]);
  const result = await f.transfer.write("target", read.files);
  assert.deepEqual(result, { written: 3, bytes: read.files.reduce((sum, file) => sum + file.size, 0) });
  assert.deepEqual(await fs.readFile(path.join(f.root, "Target", "logo.png")), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
  assert.equal(await fs.readFile(path.join(f.root, "Target", "src", "lib", "rules.mjs"), "utf8"), "export const limit = 10;");
  // A second write into the now filled folder is refused: nothing is overwritten.
  await assert.rejects(f.transfer.write("target", read.files), { code: "transfer_target_not_empty" });
});

test("a package that escapes, is corrupt or brings what an export leaves out is refused before writing", linux, async t => {
  const f = await fixture(t);
  const file = (filePath, text = "x") => ({ path: filePath, data: Buffer.from(text).toString("base64"), sha256: (awaitHash(text)) });
  for (const bad of ["../escape.txt", "/etc/passwd", "a/../../b", ".env", "node_modules/x.js", ".git/config", "a\\b", "", "./x"])
    await assert.rejects(f.transfer.write("target", [file(bad)]), { code: "invalid_transfer" }, bad);
  await assert.rejects(f.transfer.write("target", [{ ...file("a.txt"), sha256: "0".repeat(64) }]), { code: "transfer_corrupt" });
  await assert.rejects(f.transfer.write("target", [file("a"), file("a/b")]), { code: "invalid_transfer" });
  await assert.rejects(f.transfer.write("target", [file("a.txt"), file("a.txt")]), { code: "invalid_transfer" });
  assert.deepEqual(await fs.readdir(path.join(f.root, "Target")), []);
  await assert.rejects(f.transfer.write("missing", [file("a.txt")]), { code: "workspace_required" });
});

test("only a new, empty folder receives a package", linux, async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "Existing"));
  await f.folders.prepare({ projectId: "existing", mode: "existing", name: "Existing", requestId: randomUUID() });
  const one = { path: "a.txt", data: Buffer.from("x").toString("base64"), sha256: awaitHash("x") };
  await assert.rejects(f.transfer.write("existing", [one]), { code: "transfer_target_not_new" });
});

test("package paths are checked one segment at a time", () => {
  assert.equal(safePath("src/app/main.ts"), true);
  assert.equal(safePath("docs/.gitkeep"), true);
  assert.equal(safePath("a/".repeat(12) + "b"), false);
  assert.equal(safePath("build/out.js"), false);
});

import { createHash } from "node:crypto";
function awaitHash(text) { return createHash("sha256").update(Buffer.from(text)).digest("hex"); }

test("a builder-made app arrives with its note and keeps its checks on the new installation", linux, async t => {
  const { ProjectBuilder } = await import("./clawdesk-project-builder.mjs");
  const f = await fixture(t);
  const builder = new ProjectBuilder({ folders: f.folders, stateDir: f.stateDir, command: async () => { throw new Error("no docker in this test"); } });
  const request = { templateId: "task-board-v1", planId: "plan-1", projectName: "Задачи", brief: { purpose: "Учёт" }, rules: [] };
  await builder.prepare("source", request);
  const read = await f.transfer.read("source");
  assert.ok(read.files.some(file => file.path === "app/.clawdesk-build.json"));
  await f.transfer.write("target", read.files);
  assert.deepEqual(await builder.adopt("target"), { adopted: true });
  assert.deepEqual(await builder.adopt("target"), { adopted: false });
  assert.deepEqual(Object.keys(await builder.appFiles("target")).sort(), Object.keys(await builder.appFiles("source")).sort());
  // This installation's own plan binds to the app as it came; its files are not rebuilt.
  const bound = await builder.prepare("target", { ...request, planId: "plan-here" });
  assert.equal(bound.planId, "plan-here");
  await assert.rejects(builder.prepare("target", { ...request, planId: "plan-other" }), { code: "builder_plan_changed" });
  // A folder without the note is not taken for a builder app.
  await f.folders.prepare({ projectId: "plain", mode: "new", name: "Plain", requestId: randomUUID() });
  await f.transfer.write("plain", read.files.filter(file => file.path !== "app/.clawdesk-build.json"));
  assert.deepEqual(await builder.adopt("plain"), { adopted: false });
  await assert.rejects(builder.appFiles("plain"), { code: "checks_unsupported" });
});
