import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ENTRIES = 20_000;
const MAX_PREVIEW = 500;
const fdPath = (handle, name = "") => `/proc/self/fd/${handle.fd}${name ? `/${name}` : ""}`;
const fingerprint = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const identity = (s) => `${s.dev}:${s.ino}`;
export class StorageError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

// Each path component is opened without following links; later actions use these directory handles.
async function directory(root, parts = []) {
  if (process.platform !== "linux") throw new StorageError("storage_unavailable", 503);
  const components = [...path.resolve(root).split("/").filter(Boolean), ...parts];
  let handle = await fs.open("/", DIRECTORY);
  try {
    for (const part of components) {
      if (!part || part === "." || part === ".." || /[/\\\x00]/.test(part)) throw new StorageError("storage_unavailable", 503);
      const child = await fs.open(fdPath(handle, part), DIRECTORY);
      await handle.close(); handle = child;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export class StorageManager {
  constructor({ stateDir, videoDir = "", historyRoots = async () => [], activeWorkers = async () => [], now = Date.now }) {
    Object.assign(this, { stateDir, videoDir, historyRoots, activeWorkers, now });
    this.queue = Promise.resolve(); this.active = new Map(); this.previews = new Map();
  }
  serial(action) {
    const result = this.queue.then(action); this.queue = result.catch(() => {}); return result;
  }
  async quota() {
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.stateDir, "clawdesk-storage.json"), "utf8"));
      if (!(data.videoQuotaBytes === null || Number.isSafeInteger(data.videoQuotaBytes) && data.videoQuotaBytes >= 1024 * 1024)) throw new Error();
      return data.videoQuotaBytes;
    } catch (error) { if (error.code === "ENOENT") return null; throw new StorageError("storage_unavailable", 503); }
  }
  setQuota(bytes) {
    return this.serial(async () => {
      if (!(bytes === null || Number.isSafeInteger(bytes) && bytes >= 1024 * 1024 && bytes <= 100 * 1024 ** 4)) throw new StorageError("invalid_quota", 400);
      const dir = await directory(this.stateDir);
      const name = `storage-${randomUUID()}.tmp`;
      try {
        await fs.writeFile(fdPath(dir, name), JSON.stringify({ videoQuotaBytes: bytes }), { mode: 0o600, flag: "wx" });
        await fs.rename(fdPath(dir, name), fdPath(dir, "clawdesk-storage.json"));
      } finally { await fs.unlink(fdPath(dir, name)).catch(() => {}); await dir.close(); }
      return this.status();
    });
  }
  async scan(category) {
    const result = { bytes: 0, files: 0, available: true, retainedFiles: 0, retainedNames: [], candidates: [] };
    let entries = 0;
    const workers = new Set(category === "videos" ? await this.activeWorkers() : []);
    result.workers = [...workers];
    const roots = category === "videos" ? (this.videoDir ? [this.videoDir] : []) : [...new Set(await this.historyRoots())];
    if (!roots.length && category === "videos") result.available = false;
    const walk = async (root, parts, insideHistory, parents) => {
      if (parts.length > 16) { result.available = false; return; }
      let dir;
      try { dir = await directory(root, parts); }
      catch (error) { if (error.code !== "ENOENT") result.available = false; return; }
      try {
        const lineage = [...parents, identity(await dir.stat({ bigint: true }))];
        const listing = await fs.opendir(fdPath(dir));
        for await (const entry of listing) {
          if (++entries > MAX_ENTRIES) { result.available = false; break; }
          if (/[\x00-\x1f\x7f]/.test(entry.name)) { result.available = false; continue; }
          const relative = [...parts, entry.name];
          if (relative.join("/").length > 1500) { result.available = false; continue; }
          const stat = await fs.lstat(fdPath(dir, entry.name), { bigint: true });
          if (entry.name.startsWith(".clawdesk-cleanup-")) {
            result.retainedFiles++;
            if (result.retainedNames.length < 20) result.retainedNames.push(this.label(root, relative));
            if (!stat.isFile()) result.available = false;
            else if (category === "videos" || insideHistory) { result.bytes += Number(stat.size); result.files++; }
            continue;
          }
          if (stat.isSymbolicLink()) { result.available = false; continue; }
          const history = insideHistory || entry.name === ".clawdesk-history";
          if (stat.isDirectory()) { await walk(root, relative, history, lineage); continue; }
          if (!stat.isFile()) { result.available = false; continue; }
          if (category === "videos" || history) {
            result.bytes += Number(stat.size); result.files++;
            const managedVideo = relative.length === 2 && UUID.test(relative[0]) && /^video\.[a-z0-9]{1,10}$/.test(entry.name) && !this.active.has(relative[0]) && !workers.has(relative[0]);
            if ((category === "history" || managedVideo) && result.candidates.length < MAX_PREVIEW) result.candidates.push({ root, parts: relative, lineage, signature: fingerprint(stat), bytes: Number(stat.size) });
          }
        }
      } catch { result.available = false; }
      finally { await dir.close(); }
    };
    for (const root of roots) await walk(root, [], false, []);
    return result;
  }
  async status() {
    const [videos, history, videoQuotaBytes] = await Promise.all([this.scan("videos"), this.scan("history"), this.quota()]);
    let freeBytes = null;
    try { const value = await fs.statfs(this.stateDir); freeBytes = value.bavail * value.bsize; } catch { /* Space is unknown when the filesystem cannot report it. */ }
    const dto = ({ bytes, files, available, retainedFiles, retainedNames }) => ({ bytes, files, available, retainedFiles, retainedNames });
    return { videos: dto(videos), history: dto(history), videoQuotaBytes, reservedBytes: [...this.active.values()].reduce((sum, bytes) => sum + bytes, 0), activeDownloads: new Set([...this.active.keys(), ...videos.workers]).size, freeBytes };
  }
  preview(category) {
    return this.serial(async () => {
      if (!["videos", "history"].includes(category)) throw new StorageError("invalid_category", 400);
      const scan = await this.scan(category);
      if (!scan.available) throw new StorageError("storage_unavailable", 503);
      const token = randomUUID(), expiresAt = this.now() + 5 * 60_000;
      for (const [key, value] of this.previews) if (value.expiresAt < this.now()) this.previews.delete(key);
      if (this.previews.size >= 10) this.previews.delete(this.previews.keys().next().value);
      this.previews.set(token, { category, expiresAt, candidates: scan.candidates });
      return { token, category, expiresAt, files: scan.candidates.length, bytes: scan.candidates.reduce((sum, file) => sum + file.bytes, 0), more: scan.files > scan.candidates.length,
        entries: scan.candidates.map((file) => ({ name: this.label(file.root, file.parts), bytes: file.bytes })) };
    });
  }
  cleanup(token) {
    return this.serial(async () => {
      const preview = this.previews.get(token); this.previews.delete(token);
      if (!preview || preview.expiresAt < this.now()) throw new StorageError("preview_expired");
      let deleted = 0, bytes = 0, skipped = 0, retainedCount = 0;
      const retained = [];
      const workers = new Set(preview.category === "videos" ? await this.activeWorkers() : []);
      for (const item of preview.candidates) {
        if (preview.category === "videos" && (this.active.has(item.parts[0]) || workers.has(item.parts[0]))) { skipped++; continue; }
        let dir, quarantinedName;
        try {
          // Reopen every approved ancestor and verify its identity before taking the file out.
          for (let depth = 0; depth < item.parts.length; depth++) {
            const next = await directory(item.root, item.parts.slice(0, depth));
            if (identity(await next.stat({ bigint: true })) !== item.lineage[depth]) { await next.close(); throw new Error(); }
            if (dir) await dir.close(); dir = next;
          }
          const name = item.parts.at(-1), quarantine = `.clawdesk-cleanup-${randomUUID()}`;
          if (fingerprint(await fs.lstat(fdPath(dir, name), { bigint: true })) !== item.signature) { skipped++; continue; }
          await fs.rename(fdPath(dir, name), fdPath(dir, quarantine));
          quarantinedName = quarantine;
          const taken = await fs.lstat(fdPath(dir, quarantine), { bigint: true });
          // Rename updates ctime; identity, size and mtime must still match the approved file.
          const approved = item.signature.split(":");
          if (!taken.isFile() || [String(taken.dev), String(taken.ino), String(taken.size), String(taken.mtimeNs)].some((v, i) => v !== approved[i])) {
            // Restore exclusively. A concurrent replacement is never overwritten or removed.
            try {
              await fs.link(fdPath(dir, quarantine), fdPath(dir, name));
              await fs.unlink(fdPath(dir, quarantine));
              quarantinedName = null;
            } catch {
              retainedCount++;
              if (retained.length < 20) retained.push({ name: this.label(item.root, [...item.parts.slice(0, -1), quarantine]), originalName: this.label(item.root, item.parts) });
              quarantinedName = null;
            }
            skipped++; continue;
          }
          await fs.unlink(fdPath(dir, quarantine)); quarantinedName = null; deleted++; bytes += item.bytes;
        } catch {
          skipped++;
          if (quarantinedName) {
            retainedCount++;
            if (retained.length < 20) retained.push({ name: this.label(item.root, [...item.parts.slice(0, -1), quarantinedName]), originalName: this.label(item.root, item.parts) });
          }
        }
        finally { if (dir) await dir.close(); }
      }
      return { deleted, bytes, skipped, retainedCount, retained };
    });
  }
  label(root, parts) {
    return `${path.basename(path.dirname(root))}/${path.basename(root)}/${parts.join("/")}`;
  }
  async download(body, run) {
    const maxFileBytes = await this.serial(async () => {
      if (!UUID.test(body?.jobId ?? "") || this.active.has(body.jobId)) throw new StorageError("storage_busy");
      const quota = await this.quota();
      let limit = Number(body.maxFileBytes);
      if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 8 * 1024 ** 3) throw new StorageError("invalid_quota", 400);
      if (quota !== null) {
        // A worker surviving a bridge restart has no in-memory reservation: refuse until it ends.
        if ((await this.activeWorkers()).some((id) => !this.active.has(id))) throw new StorageError("storage_busy");
        const used = await this.scan("videos");
        if (!used.available) throw new StorageError("storage_unavailable", 503);
        const reserved = [...this.active.values()].reduce((sum, bytes) => sum + bytes, 0);
        limit = Math.min(limit, quota - used.bytes - reserved);
        if (limit < 1024) throw new StorageError("storage_quota_exceeded");
      }
      this.active.set(body.jobId, limit); return limit;
    });
    try { return await run({ ...body, maxFileBytes }); }
    finally { await this.serial(async () => { this.active.delete(body.jobId); }); }
  }
}
