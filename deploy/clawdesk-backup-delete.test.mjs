import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";

const tempRoot = path.resolve(os.tmpdir());
const root = await fs.mkdtemp(path.join(tempRoot, "clawdesk-backup-delete-"));
const previousState = process.env.OPENCLAW_STATE_DIR;
let backup;
try {
  process.env.OPENCLAW_STATE_DIR = path.join(root, "openclaw");
  backup = await import("./clawdesk-backup.mjs?delete-fixture");
} finally {
  if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previousState;
}
assert.equal(backup.BACKUP_DIR, path.join(root, "backups"));
await fs.mkdir(backup.BACKUP_DIR);
after(async () => {
  const target = path.resolve(root);
  assert.equal(path.dirname(target), tempRoot);
  assert.ok(path.basename(target).startsWith("clawdesk-backup-delete-"));
  await fs.rm(target, { recursive: true, force: true });
});

const name = (day) => `clawdesk-2026-10-${day}T03-30-00Z-daily.tar`;
const file = (day) => path.join(backup.BACKUP_DIR, name(day));
const code = (expected) => (error) => error instanceof backup.BackupError && error.code === expected;

test("deletes only the selected completed archive and reports missing files", async () => {
  await fs.writeFile(file("11"), "selected");
  await fs.writeFile(file("12"), "keep");
  await fs.writeFile(path.join(root, "panel.sqlite"), "current data");
  assert.deepEqual(await backup.deleteBackup(name("11")), { deleted: true, name: name("11") });
  await assert.rejects(fs.stat(file("11")), { code: "ENOENT" });
  assert.equal(await fs.readFile(file("12"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(root, "panel.sqlite"), "utf8"), "current data");
  await assert.rejects(backup.deleteBackup(name("11")), code("backup_not_found"));
});

test("rejects arbitrary paths and directories without recursive deletion", async () => {
  for (const invalid of ["../panel.sqlite", "..\\panel.sqlite", file("12"), "notes.txt", ".staging-x", `${name("12")}\n`, null]) {
    await assert.rejects(backup.deleteBackup(invalid), code("invalid_backup_name"));
  }
  await fs.mkdir(file("13"));
  await fs.writeFile(path.join(file("13"), "keep.txt"), "keep directory");
  await assert.rejects(backup.deleteBackup(name("13")), code("invalid_backup_file"));
  assert.equal(await fs.readFile(path.join(file("13"), "keep.txt"), "utf8"), "keep directory");
});

test("refuses a symbolic link and keeps its target", async (t) => {
  const outside = path.join(root, "outside.tar");
  await fs.writeFile(outside, "keep target");
  try { await fs.symlink(outside, file("14")); }
  catch (error) {
    if (error.code === "EPERM" && process.platform === "win32") return t.skip("Windows symlink permission unavailable");
    throw error;
  }
  await assert.rejects(backup.deleteBackup(name("14")), code("invalid_backup_file"));
  assert.equal(await fs.readFile(outside, "utf8"), "keep target");
});

test("serializes deletion with other backup operations and releases the lock", async () => {
  await fs.writeFile(file("15"), "first");
  await fs.writeFile(file("16"), "second");
  const first = backup.deleteBackup(name("15"));
  await assert.rejects(backup.deleteBackup(name("16")), code("backup_busy"));
  await first;
  assert.deepEqual(await backup.deleteBackup(name("16")), { deleted: true, name: name("16") });
});
