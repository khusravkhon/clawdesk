import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyncMetadataCache, syncFolders } from "./clawdesk-file-sync.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const host = path.join(root, "host"), agent = path.join(root, "agent");
  await fs.mkdir(host); await fs.mkdir(agent);
  await fs.writeFile(path.join(host, "input.txt"), "original");
  const cache = new SyncMetadataCache();
  let result = await syncFolders(host, agent, {}, { cache });
  result = await syncFolders(host, agent, result.hashes, { cache });
  return { root, host, agent, cache, result };
}

test("unchanged files avoid reads and hashing; bounded age forces a full check without sliding expiry", async (t) => {
  const { host, agent, result } = await fixture(t);
  let now = 0;
  const cache = new SyncMetadataCache({ now: () => now, fullCheckMs: 100 });
  const cold = await syncFolders(host, agent, result.hashes, { cache });
  assert.equal(cold.metrics.bytesRead, 16);
  assert.equal(cold.metrics.bytesHashed, 16);
  now = 50;
  const warm = await syncFolders(host, agent, result.hashes, { cache });
  assert.deepEqual({ ...warm.metrics, durationMs: 0 }, { bytesRead: 0, bytesHashed: 0, cacheHits: 2, durationMs: 0 });
  now = 100;
  const expired = await syncFolders(host, agent, result.hashes, { cache });
  assert.equal(expired.metrics.bytesRead, 16);
  now = 90;
  assert.equal((await syncFolders(host, agent, result.hashes, { cache })).metrics.bytesRead, 16);
});

test("same-size changes with restored mtime invalidate ctime and propagate correctly", async (t) => {
  const { host, agent, cache, result } = await fixture(t);
  const file = path.join(host, "input.txt");
  const before = await fs.stat(file);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fs.writeFile(file, "modified");
  await fs.utimes(file, before.atime, before.mtime);
  const changed = await syncFolders(host, agent, result.hashes, { cache });
  assert.equal(changed.skipped, 0);
  assert.ok(changed.metrics.bytesRead >= 8);
  assert.equal(await fs.readFile(path.join(agent, "input.txt"), "utf8"), "modified");
  assert.equal((await fs.readdir(path.join(agent, ".clawdesk-history"))).length, 1);
});

test("inode replacement invalidates cached content even with matching size and timestamps", async (t) => {
  const { host, agent, cache, result } = await fixture(t);
  const file = path.join(host, "input.txt");
  const before = await fs.stat(file);
  const replacement = path.join(host, "replacement");
  await fs.writeFile(replacement, "replaced");
  await fs.utimes(replacement, before.atime, before.mtime);
  await fs.rename(replacement, file);
  await syncFolders(host, agent, result.hashes, { cache });
  assert.equal(await fs.readFile(path.join(agent, "input.txt"), "utf8"), "replaced");
});

test("warm cache never follows a file symlink or reuses a deleted path entry", async (t) => {
  const { root, host, agent, cache, result } = await fixture(t);
  const file = path.join(host, "input.txt");
  const outside = path.join(root, "outside");
  await fs.writeFile(outside, "private!");
  await fs.unlink(file);
  await fs.symlink(outside, file);
  const blocked = await syncFolders(host, agent, result.hashes, { cache });
  assert.equal(blocked.skipped, 1);
  assert.equal(blocked.hashes["input.txt"], result.hashes["input.txt"]);
  assert.equal(await fs.readFile(path.join(agent, "input.txt"), "utf8"), "original");
  assert.equal(cache.entries.size, 1);
  await fs.unlink(file);
  await syncFolders(host, agent, result.hashes, { cache });
  assert.equal((await fs.lstat(file)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(outside, "utf8"), "private!");
});

test("warm cached ancestor symlink is blocked; simultaneous edits preserve both versions", async (t) => {
  const { root, host, agent, cache, result } = await fixture(t);
  await fs.mkdir(path.join(host, "nested"));
  await fs.writeFile(path.join(host, "nested", "file"), "safe");
  let state = await syncFolders(host, agent, result.hashes, { cache });
  state = await syncFolders(host, agent, state.hashes, { cache });
  await fs.rename(path.join(host, "nested"), path.join(root, "outside"));
  await fs.symlink(path.join(root, "outside"), path.join(host, "nested"));
  await fs.writeFile(path.join(agent, "nested", "file"), "edited");
  await fs.writeFile(path.join(host, "input.txt"), "owner");
  await fs.writeFile(path.join(agent, "input.txt"), "agent");
  const blocked = await syncFolders(host, agent, state.hashes, { cache });
  assert.equal(blocked.conflicts, 1);
  assert.ok(blocked.issues.some((issue) => issue.path === "nested"));
  assert.equal(await fs.readFile(path.join(root, "outside", "file"), "utf8"), "safe");
  const conflict = (await fs.readdir(host)).find((file) => file.includes(".conflict-"));
  assert.equal(await fs.readFile(path.join(host, conflict), "utf8"), "agent");
});

test("restart ignores persisted hashes for scanning and cache remains bounded", async (t) => {
  const { host, agent, result } = await fixture(t);
  const cache = new SyncMetadataCache({ maxEntries: 1 });
  const next = await syncFolders(host, agent, result.hashes, { cache });
  assert.equal(next.metrics.cacheHits, 0);
  assert.equal(next.metrics.bytesRead, 16);
  assert.equal(cache.entries.size, 1);
  await fs.unlink(path.join(host, "input.txt"));
  await fs.unlink(path.join(agent, "input.txt"));
  await syncFolders(host, agent, next.hashes, { cache });
  assert.equal(cache.entries.size, 0);
  assert.throws(() => new SyncMetadataCache({ maxEntries: 20001 }));
  assert.throws(() => new SyncMetadataCache({ fullCheckMs: 300001 }));
});

test("cached file growth remains subject to file size protection", async (t) => {
  const { host, agent, cache, result } = await fixture(t);
  const large = await fs.open(path.join(host, "input.txt"), "r+");
  await large.truncate(33 * 1024 * 1024); await large.close();
  const next = await syncFolders(host, agent, result.hashes, { cache });
  assert.deepEqual(next.issues, [{ code: "file_too_large", path: "input.txt" }]);
  assert.equal(next.hashes["input.txt"], result.hashes["input.txt"]);
  assert.equal(await fs.readFile(path.join(agent, "input.txt"), "utf8"), "original");
});

test("cached scans still enforce the aggregate folder size before any transfer", async (t) => {
  const { host, agent, cache } = await fixture(t);
  await fs.unlink(path.join(host, "input.txt"));
  await fs.unlink(path.join(agent, "input.txt"));
  for (let index = 0; index < 9; index++) {
    const file = await fs.open(path.join(host, `${index}.bin`), "w");
    await file.truncate(31 * 1024 * 1024); await file.close();
  }
  await assert.rejects(syncFolders(host, agent, {}, { cache }), { code: "folder_size_limit" });
  assert.ok(cache.entries.size >= 8);
  await assert.rejects(syncFolders(host, agent, {}, { cache }), { code: "folder_size_limit" });
  assert.deepEqual(await fs.readdir(agent), []);
});
