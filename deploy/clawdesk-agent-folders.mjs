import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { directoryIdentityWithin, ensureDirectoryWithin, FolderSyncError, SyncMetadataCache, syncFolders } from "./clawdesk-file-sync.mjs";

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;
const AGENT = /^[a-z0-9][a-z0-9_-]{0,79}$/;
/** A team member's docs live at <workspace>/docs (the path its instructions name), not under folders/. */
const DIRS = new Set(["docs"]);
const CODES = new Set(["file_too_large", "unsupported_file", "file_unavailable", "file_changed", "folder_depth_limit", "folder_entry_limit", "folder_size_limit", "conflict_requires_review", "folder_unavailable"]);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000 ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const safeIssue = (issue) => ({
  code: CODES.has(issue?.code) ? issue.code : "folder_unavailable",
  path: typeof issue?.path === "string" && issue.path.length <= 500 && !/[\x00-\x1f\x7f\\]/.test(issue.path) && !/^[A-Za-z]:/.test(issue.path) && !issue.path.startsWith("/") && !issue.path.split("/").some((part) => part === ".." || part === ".") ? issue.path : null,
});

function publicStatus(item) {
  const status = item.status ?? {};
  return {
    agentId: item.agentId, folder: item.name,
    state: ["ready", "partial", "error"].includes(status.state) ? status.state : "pending",
    lastAttempt: timestamp(status.lastAttempt), lastSuccess: timestamp(status.lastSuccess),
    conflicts: count(status.conflicts), skipped: count(status.skipped),
    issues: Array.isArray(status.issues) ? status.issues.slice(0, 20).map(safeIssue) : [],
  };
}

export class AgentFolders {
  constructor({ stateDir, filesDir, configPath, onError = () => {}, metadataCacheEnabled = false }) {
    Object.assign(this, { stateDir: path.resolve(stateDir), filesDir, configPath, onError });
    this.queue = Promise.resolve();
    this.metadataCacheEnabled = typeof metadataCacheEnabled === "function" ? metadataCacheEnabled : () => metadataCacheEnabled === true;
    this.metadataCache = undefined;
  }

  syncOptions() {
    if (!this.metadataCacheEnabled()) { this.metadataCache = undefined; return {}; }
    this.metadataCache ??= new SyncMetadataCache();
    return { cache: this.metadataCache };
  }

  serial(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async load() {
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.stateDir, "clawdesk", "folder-sync.json"), "utf8"));
      if (value.version !== 1 || !Array.isArray(value.folders) || value.folders.length > 1000) throw new Error("invalid folder sync registry");
      for (const item of value.folders) this.validate(item);
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, folders: [] };
      throw error;
    }
  }

  validate({ agentId, name, dir, readOnly }) {
    if (agentId === "main" || !AGENT.test(agentId ?? "") || !NAME.test(name ?? "")) throw new Error("invalid managed agent folder");
    if ((dir !== undefined && !DIRS.has(dir)) || (readOnly !== undefined && typeof readOnly !== "boolean")) throw new Error("invalid managed agent folder");
  }

  /** The folder inside the agent's workspace: folders/<name>, or a fixed one such as docs. */
  static workspaceDir(item) {
    return item.dir ?? `folders/${item.name}`;
  }

  async save(registry) {
    const dir = await ensureDirectoryWithin(this.stateDir, "clawdesk");
    const temporary = path.join(dir, `folder-sync-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(registry), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, path.join(dir, "folder-sync.json"));
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  async statuses() {
    return { folders: (await this.load()).folders.map(publicStatus) };
  }

  record(item, result, lastAttempt) {
    item.status = {
      state: result.skipped ? "partial" : "ready", lastAttempt,
      lastSuccess: result.skipped ? timestamp(item.status?.lastSuccess) : Date.now(),
      conflicts: result.conflicts, skipped: result.skipped, issues: result.issues.slice(0, 20).map(safeIssue),
      metrics: result.metrics,
    };
  }

  async paths(item, config, registering = false) {
    this.validate(item);
    const workspace = config.agents?.entries?.[item.agentId]?.workspace;
    if (!workspace) throw new Error("managed folder needs an existing agent workspace");
    const resolved = path.resolve(workspace);
    const relative = path.relative(this.stateDir, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || resolved === path.resolve(config.agents?.defaults?.workspace ?? this.stateDir)) throw new Error("agent workspace is outside managed storage");
    const identity = await directoryIdentityWithin(this.stateDir, relative.split(path.sep).join("/"));
    if (item.workspaceIdentity && item.workspaceIdentity !== identity) {
      if (!registering) throw new Error("agent workspace has changed; folder registration required");
      item.hashes = {};
    }
    item.workspaceIdentity = identity;
    const managed = await ensureDirectoryWithin(this.stateDir, `${relative.split(path.sep).join("/")}/${AgentFolders.workspaceDir(item)}`);
    const shared = await ensureDirectoryWithin(this.filesDir, item.name);
    return { managed, shared };
  }

  /**
   * Starts (or keeps) synchronizing a shared folder into the agent's workspace. `dir` places it at a fixed
   * workspace folder; `readOnly` mirrors the shared folder into the workspace and never copies back.
   */
  register(agentId, name, { dir, readOnly } = {}) {
    return this.serial(async () => {
      this.validate({ agentId, name, dir, readOnly });
      const config = JSON.parse(await fs.readFile(this.configPath, "utf8"));
      const registry = await this.load();
      let item = registry.folders.find((folder) => folder.agentId === agentId && folder.name === name);
      if (!item) {
        if (registry.folders.length >= 1000) throw new Error("managed folder limit exceeded");
        registry.folders.push(item = { agentId, name, hashes: {} });
      }
      if (dir !== undefined && (item.dir ?? undefined) !== dir) { item.dir = dir; item.hashes = {}; }
      if (readOnly !== undefined) item.readOnly = readOnly;
      const { shared, managed } = await this.paths(item, config, true);
      const lastAttempt = Date.now();
      const result = await syncFolders(shared, managed, item.hashes, { ...this.syncOptions(), readOnly: item.readOnly === true });
      item.hashes = result.hashes;
      this.record(item, result, lastAttempt);
      await this.save(registry);
      return { gatewayPath: managed, conflicts: result.conflicts };
    });
  }

  syncAll() {
    return this.serial(async () => {
      const config = JSON.parse(await fs.readFile(this.configPath, "utf8"));
      const registry = await this.load();
      registry.folders = registry.folders.filter((item) => !!config.agents?.entries?.[item.agentId]);
      for (const item of registry.folders) {
        // Deleted agents must never have their workspaces recreated by synchronization.
        if (!config.agents?.entries?.[item.agentId]) continue;
        const lastAttempt = Date.now();
        try {
          const { shared, managed } = await this.paths(item, config);
          const result = await syncFolders(shared, managed, item.hashes, { ...this.syncOptions(), readOnly: item.readOnly === true });
          item.hashes = result.hashes;
          this.record(item, result, lastAttempt);
        } catch (error) {
          item.status = { state: "error", lastAttempt, lastSuccess: timestamp(item.status?.lastSuccess), conflicts: 0, skipped: 0, issues: [safeIssue({ code: error instanceof FolderSyncError ? error.code : "folder_unavailable" })] };
          this.onError(error);
        }
      }
      await this.save(registry);
    });
  }
}
