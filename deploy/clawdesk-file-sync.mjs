import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const HISTORY = ".clawdesk-history";
const MAX_ISSUES = 20;
export class FolderSyncError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const safePath = (relative) => relative.length <= 500 && !/[\x00-\x1f\x7f\\]/.test(relative) && !/^[A-Za-z]:/.test(relative) ? relative : null;
const issueCode = (error) => error instanceof FolderSyncError ? error.code : "file_unavailable";
const blockedBy = (blocked, file) => [...blocked].some((entry) => file === entry || file.startsWith(`${entry}/`) || entry.startsWith(`${file}/`));
const digest = (data) => createHash("sha256").update(data).digest("hex");
const fdPath = (handle, name = "") => `/proc/self/fd/${handle.fd}${name ? `/${name}` : ""}`;
const signature = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].join(":");

/** Only verified reads populate this process-local cache; persisted sync hashes are never evidence. */
export class SyncMetadataCache {
  constructor({ maxEntries = 20000, fullCheckMs = 300000, now = Date.now } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 20000 || !Number.isFinite(fullCheckMs) || fullCheckMs < 0 || fullCheckMs > 300000) throw new Error("invalid sync cache limits");
    Object.assign(this, { maxEntries, fullCheckMs, now });
    this.entries = new Map();
  }
  get(key, identity) {
    const entry = this.entries.get(key);
    const age = entry ? this.now() - entry.checkedAt : -1;
    if (!entry || entry.identity !== identity || age < 0 || age >= this.fullCheckMs) { this.entries.delete(key); return null; }
    return entry.hash;
  }
  set(key, identity, hash) {
    this.entries.delete(key);
    this.entries.set(key, { identity, hash, checkedAt: this.now() });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
  invalidate(root, seen = new Set()) {
    const prefix = `${JSON.stringify(path.resolve(root))}:`;
    for (const key of this.entries.keys()) if (key.startsWith(prefix) && !seen.has(key)) this.entries.delete(key);
  }
}
const cacheKey = (root, relative) => `${JSON.stringify(path.resolve(root))}:${relative}`;
const hashed = (data, metrics) => { metrics.bytesHashed += data.length; return digest(data); };

// Directory handles keep an agent's symlink/rename from redirecting a copy outside the selected tree.
async function directory(root, parts, create = false) {
  const absolute = path.resolve(root);
  let handle = await fs.open(path.parse(absolute).root, DIRECTORY);
  try {
    const rootParts = absolute.split(path.sep).filter(Boolean);
    for (const [index, part] of [...rootParts, ...parts].entries()) {
      if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\")) throw new Error("unsafe file path");
      if (create && index >= rootParts.length) await fs.mkdir(fdPath(handle, part)).catch((error) => { if (error.code !== "EEXIST") throw error; });
      const child = await fs.open(fdPath(handle, part), DIRECTORY);
      await handle.close();
      handle = child;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function ensureDirectoryWithin(root, relative) {
  const handle = await directory(root, relative.split("/"), true);
  await handle.close();
  return path.join(root, relative);
}

export async function directoryIdentityWithin(root, relative) {
  const handle = await directory(root, relative.split("/"));
  try {
    const stat = await handle.stat({ bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } finally { await handle.close(); }
}

/** Keep the verified directory open until the caller's filesystem operation finishes. */
export async function withDirectoryWithin(root, relative, run, create = false) {
  const handle = await directory(root, relative ? relative.split("/") : [], create);
  try { return await run(fdPath(handle)); }
  finally { await handle.close(); }
}

/** Descend from an already-open directory without re-walking its /proc descriptor symlink. */
export async function withChildDirectoryWithin(directory, name, run) {
  if (!/^\/proc\/self\/fd\/\d+$/.test(directory) || !name || name === "." || name === ".." || /[\/\\\x00]/.test(name)) throw new Error("unsafe file path");
  const handle = await fs.open(`${directory}/${name}`, DIRECTORY);
  try { return await run(fdPath(handle)); }
  finally { await handle.close(); }
}

async function readAt(parent, name, metrics, cache, key) {
  let handle;
  try {
    handle = await fs.open(fdPath(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new FolderSyncError("unsupported_file");
    if (stat.size > BigInt(MAX_FILE)) throw new FolderSyncError("file_too_large");
    const identity = signature(stat);
    const cached = cache?.get(key, identity);
    if (cached && signature(await handle.stat({ bigint: true })) === identity) {
      metrics.cacheHits++;
      return { hash: cached, size: Number(stat.size) };
    }
    const chunks = [];
    let length = 0;
    while (length <= MAX_FILE) {
      const chunk = Buffer.alloc(Math.min(65536, MAX_FILE + 1 - length));
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
      metrics.bytesRead += bytesRead;
    }
    if (length > MAX_FILE) throw new FolderSyncError("file_too_large");
    if (signature(await handle.stat({ bigint: true })) !== identity || BigInt(length) !== stat.size) throw new FolderSyncError("file_changed");
    const data = Buffer.concat(chunks, length);
    if (cache) {
      const hash = hashed(data, metrics);
      cache.set(key, identity, hash);
      return { hash, size: length };
    }
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function scan(root, cache, metrics) {
  const files = new Map();
  const blocked = new Set();
  const issues = [];
  let total = 0;
  let entries = 0;
  const seen = new Set();
  const skip = (relative, code) => {
    blocked.add(relative);
    if (issues.length < MAX_ISSUES) issues.push({ code, path: safePath(relative) });
  };
  async function walk(parent, prefix = "", depth = 0) {
    if (depth > 30) throw new FolderSyncError("folder_depth_limit");
    for (const entry of await fs.readdir(fdPath(parent), { withFileTypes: true })) {
      if (entry.name === HISTORY || entry.name.startsWith(".clawdesk-copy-")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (++entries > 10000) throw new FolderSyncError("folder_entry_limit");
      if (entry.isSymbolicLink()) { skip(relative, "unsupported_file"); continue; }
      if (entry.isDirectory()) {
        let child;
        try {
          child = await fs.open(fdPath(parent, entry.name), DIRECTORY);
          await walk(child, relative, depth + 1);
        } catch (error) {
          if (error instanceof FolderSyncError) throw error;
          skip(relative, "file_unavailable");
        } finally { await child?.close(); }
      } else if (entry.isFile()) {
        try {
          const key = cacheKey(root, relative);
          seen.add(key);
          const data = await readAt(parent, entry.name, metrics, cache, key);
          if (!data) { skip(relative, "file_changed"); continue; }
          total += cache ? data.size : data.length;
          if (total > MAX_TOTAL) throw new FolderSyncError("folder_size_limit");
          files.set(relative, cache ? data.hash : hashed(data, metrics));
        } catch (error) {
          if (error.code === "folder_size_limit") throw error;
          cache?.entries.delete(cacheKey(root, relative));
          skip(relative, issueCode(error));
        }
      } else skip(relative, "unsupported_file");
    }
  }
  const parent = await directory(root, []);
  try { await walk(parent); } finally { await parent.close(); cache?.invalidate(root, seen); }
  return { files, blocked, issues };
}

async function transfer(from, to, relative, expectedSource, expectedTarget, metrics, targetRelative = relative) {
  const parts = relative.split("/");
  const source = await directory(from, parts.slice(0, -1));
  let target;
  try {
    const data = await readAt(source, parts.at(-1), metrics);
    if (!data || hashed(data, metrics) !== expectedSource) return false;
    const targetParts = targetRelative.split("/");
    target = await directory(to, targetParts.slice(0, -1), true);
    const name = targetParts.at(-1);
    const old = await readAt(target, name, metrics);
    if ((old ? hashed(old, metrics) : undefined) !== expectedTarget) return false;
    const temporary = `.clawdesk-copy-${randomUUID()}`;
    const output = await fs.open(fdPath(target, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(data); } finally { await output.close(); }
    try {
      if (old) {
        // Preserve the previous inode before replacement, including a concurrent writer's last changes.
        await fs.mkdir(fdPath(target, HISTORY)).catch((error) => { if (error.code !== "EEXIST") throw error; });
        const history = await fs.open(fdPath(target, HISTORY), DIRECTORY);
        try { await fs.link(fdPath(target, name), fdPath(history, randomUUID())); } finally { await history.close(); }
        await fs.rename(fdPath(target, temporary), fdPath(target, name));
      } else {
        await fs.link(fdPath(target, temporary), fdPath(target, name));
      }
      return true;
    } finally {
      await fs.unlink(fdPath(target, temporary)).catch(() => {});
    }
  } finally {
    await source.close();
    await target?.close();
  }
}

/** No delete propagation; simultaneous edits keep both versions instead of losing either one. */
export async function syncFolders(hostRoot, agentRoot, previous = {}, { cache } = {}) {
  const started = performance.now();
  const metrics = { bytesRead: 0, bytesHashed: 0, cacheHits: 0, durationMs: 0 };
  const hostScan = await scan(hostRoot, cache, metrics);
  const agentScan = await scan(agentRoot, cache, metrics);
  const host = hostScan.files, agent = agentScan.files;
  const blocked = new Set([...hostScan.blocked, ...agentScan.blocked]);
  const issues = [...hostScan.issues, ...agentScan.issues].slice(0, MAX_ISSUES);
  const next = Object.create(null);
  let conflicts = 0;
  for (const file of Object.keys(previous)) if (blockedBy(blocked, file)) next[file] = previous[file];
  for (const file of new Set([...host.keys(), ...agent.keys()])) {
    if (blockedBy(blocked, file)) continue;
    const left = host.get(file);
    const right = agent.get(file);
    if (left === right) { next[file] = left; continue; }
    const baseline = Object.hasOwn(previous, file) ? previous[file] : undefined;
    try {
      if (!right || (left && baseline === right)) {
        if (await transfer(hostRoot, agentRoot, file, left, right, metrics)) next[file] = left;
      } else if (!left || baseline === left) {
        if (await transfer(agentRoot, hostRoot, file, right, left, metrics)) next[file] = right;
      } else {
        const extension = path.posix.extname(file);
        const conflict = `${file.slice(0, file.length - extension.length)}.conflict-${right.slice(0, 12)}${extension}`;
        const existing = host.get(conflict);
        if (existing && existing !== right) throw new FolderSyncError("conflict_requires_review");
        if (blockedBy(blocked, conflict)) throw new FolderSyncError("conflict_requires_review");
        const saved = existing === right || await transfer(agentRoot, hostRoot, file, right, undefined, metrics, conflict);
        if (saved && await transfer(hostRoot, agentRoot, file, left, right, metrics)) { next[file] = left; conflicts++; }
      }
      if (!Object.hasOwn(next, file)) throw new FolderSyncError("file_changed");
    } catch (error) {
      blocked.add(file);
      if (baseline !== undefined) next[file] = baseline;
      if (issues.length < MAX_ISSUES) issues.push({ code: issueCode(error), path: safePath(file) });
    }
  }
  for (const file of Object.keys(previous)) if (blockedBy(blocked, file)) next[file] = previous[file];
  metrics.durationMs = Math.round((performance.now() - started) * 100) / 100;
  return { hashes: next, conflicts, skipped: blocked.size, issues, metrics };
}
