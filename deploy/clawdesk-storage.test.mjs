import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageManager } from "./clawdesk-storage.mjs";

const JOB = "10000000-0000-4000-8000-000000000001";
const SECOND = "10000000-0000-4000-8000-000000000002";
const MiB = 1024 ** 2;
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-storage-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state"), videoDir = path.join(root, "videos"), files = path.join(root, "registered");
  await Promise.all([stateDir, videoDir, files].map((dir) => fs.mkdir(dir)));
  const manager = new StorageManager({ stateDir, videoDir, historyRoots: async () => [files], ...options });
  const video = async (id = JOB, content = "original") => {
    await fs.mkdir(path.join(videoDir, id), { recursive: true });
    const file = path.join(videoDir, id, "video.mp4"); await fs.writeFile(file, content); return file;
  };
  return { root, stateDir, videoDir, files, manager, video };
}

test("quota is disabled by default; exact filesystem counts and settings survive recreation", async (t) => {
  const f = await fixture(t); await f.video();
  assert.equal((await f.manager.status()).videoQuotaBytes, null);
  assert.deepEqual((await f.manager.status()).videos, { available: true, bytes: 8, files: 1, retainedFiles: 0, retainedNames: [] });
  await f.manager.setQuota(MiB);
  assert.equal(await new StorageManager(f).quota(), MiB);
});
test("quota caps a download to remaining space and serializes simultaneous reservations", async (t) => {
  const f = await fixture(t); await f.video(JOB, Buffer.alloc(100)); await f.manager.setQuota(MiB);
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const task = f.manager.download({ jobId: SECOND, maxFileBytes: 2 * MiB }, async (request) => { assert.equal(request.maxFileBytes, MiB - 100); entered(); await waiting; });
  await started;
  assert.equal((await f.manager.status()).reservedBytes, MiB - 100);
  await assert.rejects(f.manager.download({ jobId: "10000000-0000-4000-8000-000000000003", maxFileBytes: MiB }, async () => {}), { code: "storage_quota_exceeded" });
  release(); await task; assert.equal((await f.manager.status()).reservedBytes, 0);
});
test("failed workers release their reservation; orphan workers after restart block configured quota", async (t) => {
  const f = await fixture(t, { activeWorkers: async () => [] }); await f.manager.setQuota(MiB);
  await assert.rejects(f.manager.download({ jobId: JOB, maxFileBytes: MiB }, async () => { throw new Error("failure"); }));
  assert.equal((await f.manager.status()).reservedBytes, 0);
  f.manager.activeWorkers = async () => [SECOND];
  await assert.rejects(f.manager.download({ jobId: JOB, maxFileBytes: MiB }, async () => {}), { code: "storage_busy" });
});
test("unknown accounting and corrupt quota fail closed", async (t) => {
  const f = await fixture(t); await f.manager.setQuota(MiB);
  await fs.symlink(f.files, path.join(f.videoDir, "unexpected"));
  assert.equal((await f.manager.status()).videos.available, false);
  await assert.rejects(f.manager.download({ jobId: JOB, maxFileBytes: MiB }, async () => {}), { code: "storage_unavailable" });
  await fs.writeFile(path.join(f.stateDir, "clawdesk-storage.json"), "invalid");
  await assert.rejects(f.manager.quota(), { code: "storage_unavailable" });
});
test("cleanup only removes the approved managed originals; new, changed and unrelated files stay", async (t) => {
  const f = await fixture(t); const first = await f.video();
  await fs.writeFile(path.join(f.videoDir, JOB, "private.txt"), "keep");
  const preview = await f.manager.preview("videos"); assert.equal(preview.files, 1);
  await f.video(SECOND); await fs.writeFile(first, "changed");
  const skipped = await f.manager.cleanup(preview.token); assert.equal(skipped.deleted, 0); assert.equal(skipped.skipped, 1);
  const next = await f.manager.preview("videos"); assert.equal(next.files, 2);
  const result = await f.manager.cleanup(next.token); assert.equal(result.deleted, 2);
  assert.equal(await fs.readFile(path.join(f.videoDir, JOB, "private.txt"), "utf8"), "keep");
  await assert.rejects(f.manager.cleanup(next.token), { code: "preview_expired" });
});
test("history cleanup preserves working files and external hard links; roots and categories are fixed", async (t) => {
  const f = await fixture(t); await fs.mkdir(path.join(f.files, ".clawdesk-history"));
  const working = path.join(f.files, "note.md"); await fs.writeFile(working, "keep");
  await fs.link(working, path.join(f.files, ".clawdesk-history", "old.md"));
  const preview = await f.manager.preview("history"); assert.equal(preview.files, 1);
  assert.equal((await f.manager.cleanup(preview.token)).deleted, 1);
  assert.equal(await fs.readFile(working, "utf8"), "keep");
  await assert.rejects(f.manager.preview("../../outside"), { code: "invalid_category" });
});
test("expired previews and active downloads cannot be purged", async (t) => {
  let now = 1;
  const f = await fixture(t, { now: () => now }); await f.video();
  const preview = await f.manager.preview("videos"); now += 300001;
  await assert.rejects(f.manager.cleanup(preview.token), { code: "preview_expired" });
  f.manager.activeWorkers = async () => [JOB]; assert.equal((await f.manager.preview("videos")).files, 0);
});
test("replaced ancestor and symlink do not redirect cleanup", async (t) => {
  const f = await fixture(t); await f.video(); const preview = await f.manager.preview("videos");
  await fs.rename(path.join(f.videoDir, JOB), path.join(f.videoDir, "saved"));
  await fs.mkdir(path.join(f.files, "outside")); await fs.writeFile(path.join(f.files, "outside", "video.mp4"), "outside");
  await fs.symlink(path.join(f.files, "outside"), path.join(f.videoDir, JOB));
  assert.equal((await f.manager.cleanup(preview.token)).deleted, 0);
  assert.equal(await fs.readFile(path.join(f.files, "outside", "video.mp4"), "utf8"), "outside");
});
test("replacement during rename is retained and reported, never overwritten or recursively removed", async (t) => {
  const f = await fixture(t); const file = await f.video(); const preview = await f.manager.preview("videos");
  const originalRename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (String(to).includes(".clawdesk-cleanup-")) {
      await fs.unlink(file); await fs.mkdir(file); await fs.writeFile(path.join(file, "working.txt"), "new replacement");
    }
    return originalRename(from, to);
  });
  const result = await f.manager.cleanup(preview.token);
  assert.equal(result.deleted, 0); assert.equal(result.retainedCount, 1); assert.equal(result.retained.length, 1);
  const names = await fs.readdir(path.dirname(file)); const quarantine = names.find((name) => name.startsWith(".clawdesk-cleanup-"));
  assert.equal(await fs.readFile(path.join(path.dirname(file), quarantine, "working.txt"), "utf8"), "new replacement");
  assert.equal((await f.manager.status()).videos.available, false);
});
test("an unlink failure after quarantine retains and reports the saved original", async (t) => {
  const f = await fixture(t); await f.video(); const preview = await f.manager.preview("videos");
  const originalUnlink = fs.unlink;
  const mocked = t.mock.method(fs, "unlink", async (file) => {
    if (String(file).includes(".clawdesk-cleanup-")) throw Object.assign(new Error(), { code: "EACCES" });
    return originalUnlink(file);
  });
  const result = await f.manager.cleanup(preview.token);
  mocked.mock.restore();
  assert.equal(result.deleted, 0); assert.equal(result.retainedCount, 1);
  const names = await fs.readdir(path.join(f.videoDir, JOB));
  const retained = names.find((name) => name.startsWith(".clawdesk-cleanup-"));
  assert.equal(await fs.readFile(path.join(f.videoDir, JOB, retained), "utf8"), "original");
  assert.equal((await f.manager.status()).videos.bytes, 8);
  assert.equal((await f.manager.status()).videos.retainedNames.length, 1);
  const restarted = new StorageManager(f);
  assert.equal((await restarted.status()).videos.retainedNames.length, 1);
  assert.equal((await f.manager.preview("videos")).files, 0);
});
test("retained history files remain in usage; retained directories make history accounting incomplete", async (t) => {
  const f = await fixture(t);
  const history = path.join(f.files, ".clawdesk-history"); await fs.mkdir(history);
  await fs.writeFile(path.join(history, "old.md"), "history version");
  const preview = await f.manager.preview("history");
  const originalUnlink = fs.unlink;
  const mocked = t.mock.method(fs, "unlink", async (file) => {
    if (String(file).includes(".clawdesk-cleanup-")) throw Object.assign(new Error(), { code: "EACCES" });
    return originalUnlink(file);
  });
  const result = await f.manager.cleanup(preview.token); mocked.mock.restore();
  assert.equal(result.deleted, 0); assert.equal(result.retainedCount, 1);
  const usage = (await f.manager.status()).history;
  assert.equal(usage.available, true); assert.equal(usage.bytes, Buffer.byteLength("history version"));
  assert.equal(usage.files, 1); assert.equal(usage.retainedFiles, 1); assert.equal(usage.retainedNames.length, 1);
  assert.equal((await f.manager.preview("history")).files, 0);
  await fs.mkdir(path.join(history, ".clawdesk-cleanup-retained-directory"));
  const partial = (await f.manager.status()).history;
  assert.equal(partial.available, false); assert.equal(partial.retainedFiles, 2);
  await assert.rejects(f.manager.preview("history"), { code: "storage_unavailable" });
});
