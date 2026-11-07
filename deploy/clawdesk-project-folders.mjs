import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withDirectoryWithin, withChildDirectoryWithin } from "./clawdesk-file-sync.mjs";

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGISTRY = "clawdesk-project-folders.json";
// Written by restore: the folders come back with new inodes, so their identities are pinned again once.
export const RESTORED_MARKER = "clawdesk-project-folders.restored";
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export class ProjectFolderError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

/** Owner-selected folders only; preparing a folder never grants access or executes its files. */
export class ProjectFolders {
  constructor({ stateDir }) { this.stateDir = stateDir; this.queue = Promise.resolve(); }

  #run(run) {
    const next = this.queue.then(() => run()).catch((error) => {
      if (error instanceof ProjectFolderError) throw error;
      throw new ProjectFolderError("workspace_unavailable", 503);
    });
    this.queue = next.catch(() => {});
    return next;
  }

  async #registry(state) {
    let handle;
    try {
      handle = await fs.open(`${state}/${REGISTRY}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("invalid registry");
      const data = JSON.parse(await handle.readFile("utf8"));
      if (data.version !== 1 || !Array.isArray(data.bindings) || data.bindings.length > 1000) throw new Error("invalid registry");
      const ids = new Set(), names = new Set();
      for (const item of data.bindings) {
        if (!item || typeof item.projectId !== "string" || !ID.test(item.projectId) || typeof item.name !== "string" || !NAME.test(item.name) || typeof item.requestId !== "string" || !UUID.test(item.requestId) || !["new", "existing"].includes(item.mode) || typeof item.identity !== "string" || !/^\d+:\d+$/.test(item.identity) || ids.has(item.projectId) || names.has(item.name)) throw new Error("invalid binding");
        ids.add(item.projectId); names.add(item.name);
      }
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, bindings: [] };
      throw error;
    } finally { await handle?.close(); }
  }

  async #save(state, registry) {
    const temporary = `${state}/${REGISTRY}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(registry), { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, `${state}/${REGISTRY}`);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  /** The registry, re-pinned after a restore: the folders and the registry come from the same snapshot. */
  async #load(root, state) {
    const registry = await this.#registry(state);
    const marker = `${state}/${RESTORED_MARKER}`;
    if (!(await fs.lstat(marker).catch(() => null))) return registry;
    for (const binding of registry.bindings) {
      let identity;
      try { identity = await this.#identity(root, binding.name); } catch { continue; /* A missing folder stays missing. */ }
      // The builder's record names the folder too (clawdesk-project-builder.mjs).
      const record = `${state}/clawdesk-build-${createHash("sha256").update(binding.projectId).digest("hex").slice(0, 32)}.json`;
      try {
        const data = JSON.parse(await fs.readFile(record, "utf8"));
        if (data.identity === binding.identity) {
          const temporary = `${record}.${randomUUID()}.tmp`;
          try {
            await fs.writeFile(temporary, JSON.stringify({ ...data, identity }), { flag: "wx", mode: 0o600 });
            await fs.rename(temporary, record);
          } finally { await fs.unlink(temporary).catch(() => {}); }
        }
      } catch { /* No build record: nothing else to update. */ }
      binding.identity = identity;
    }
    await this.#save(state, registry);
    await fs.unlink(marker);
    return registry;
  }

  async #identity(root, name) {
    const handle = await fs.open(`${root}/${name}`, DIRECTORY);
    try { const stat = await handle.stat({ bigint: true }); return `${stat.dev}:${stat.ino}`; }
    finally { await handle.close(); }
  }

  async #snapshot(root, registry, projectId) {
    const item = registry.bindings.find((binding) => binding.projectId === projectId);
    let workspace = null;
    if (item) {
      let state = "ready";
      try { if (await this.#identity(root, item.name) !== item.identity) state = "changed"; }
      catch (error) { state = error.code === "ENOENT" ? "missing" : "changed"; }
      workspace = { name: item.name, mode: item.mode, path: path.join(this.stateDir, "company-projects", item.name), state };
    }
    const available = [];
    const directory = await fs.opendir(root);
    let scanned = 0, truncated = false;
    for await (const entry of directory) {
      if (++scanned > 500) { truncated = true; break; }
      if (!entry.isDirectory() || !NAME.test(entry.name) || registry.bindings.some((binding) => binding.name === entry.name)) continue;
      try { const identity = await this.#identity(root, entry.name); if (!registry.bindings.some((binding) => binding.identity === identity)) available.push(entry.name); } catch { /* Unavailable or replaced directories are not selectable. */ }
    }
    return { rootPath: path.join(this.stateDir, "company-projects"), workspace, available: available.sort(), truncated };
  }

  status(projectId) {
    if (typeof projectId !== "string" || !ID.test(projectId)) throw new ProjectFolderError("invalid_workspace", 400);
    return this.#run(() => withDirectoryWithin(this.stateDir, "company-projects", async (root) => {
      return withDirectoryWithin(this.stateDir, "", async (state) => this.#snapshot(root, await this.#load(root, state), projectId));
    }, true));
  }

  /**
   * Serialize access with folder registration and keep the selected directory pinned.
   * The root is created like in status(): on a fresh installation it does not exist until the first
   * folder, and a missing root must read as "no folder yet", not as an unavailable builder.
   */
  withWorkspace(projectId, run) {
    if (typeof projectId !== "string" || !ID.test(projectId)) throw new ProjectFolderError("invalid_workspace", 400);
    return this.#run(() => withDirectoryWithin(this.stateDir, "company-projects", (root) =>
      withDirectoryWithin(this.stateDir, "", async (state) => {
        const binding = (await this.#load(root, state)).bindings.find((item) => item.projectId === projectId);
        if (!binding) throw new ProjectFolderError("workspace_required");
        return withChildDirectoryWithin(root, binding.name, async (directory) => {
          const stat = await fs.stat(directory, { bigint: true });
          if (`${stat.dev}:${stat.ino}` !== binding.identity) throw new ProjectFolderError("workspace_changed");
          return run({ directory, ...binding, path: path.join(this.stateDir, "company-projects", binding.name) });
        });
      }), true));
  }

  prepare({ projectId, name, mode, requestId }) {
    if (typeof projectId !== "string" || !ID.test(projectId) || typeof name !== "string" || !NAME.test(name) || !["new", "existing"].includes(mode) || typeof requestId !== "string" || !UUID.test(requestId)) throw new ProjectFolderError("invalid_workspace", 400);
    return this.#run(() => withDirectoryWithin(this.stateDir, "company-projects", async (root) => {
      return withDirectoryWithin(this.stateDir, "", async (state) => {
        const registry = await this.#load(root, state);
        const before = registry.bindings.find((item) => item.projectId === projectId);
        if (before) {
          if (before.requestId !== requestId || before.name !== name || before.mode !== mode) throw new ProjectFolderError("workspace_already_linked");
          return this.#snapshot(root, registry, projectId);
        }
        if (registry.bindings.some((item) => item.name === name)) throw new ProjectFolderError("workspace_in_use");
        if (registry.bindings.length >= 1000) throw new ProjectFolderError("workspace_limit");
        if (mode === "new") {
          try { await fs.mkdir(`${root}/${name}`, { mode: 0o700 }); }
          catch (error) { if (error.code === "EEXIST") throw new ProjectFolderError("workspace_exists"); throw error; }
        }
        let identity;
        try { identity = await this.#identity(root, name); }
        catch { throw new ProjectFolderError("workspace_not_directory"); }
        if (registry.bindings.some((item) => item.identity === identity)) throw new ProjectFolderError("workspace_in_use");
        // A failed registry save leaves the folder intact; the owner can explicitly connect it as existing.
        registry.bindings.push({ projectId, requestId, name, mode, identity });
        await this.#save(state, registry);
        return this.#snapshot(root, registry, projectId);
      });
    }, true));
  }
}
