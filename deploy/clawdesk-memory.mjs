import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const MEMORY_PACKAGE = "@openclaw/llama-cpp-provider";
// The official plugin ships in lockstep with OpenClaw: the pinned version (deploy/openclaw.version, copied
// next to this module in the Gateway image).
// openclaw-bump-review: local memory setup answers the plugin's prompts by their exact text; set it up once on the new version.
export const MEMORY_VERSION = readFileSync(new URL("./openclaw.version", import.meta.url), "utf8").trim();
const EMBEDDING_CONFIRM = "OpenClaw can install a verified llama.cpp server and download only the local embedding model (about 0.3 GB). This will not install or change your chat model. Continue?";
const AGENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACTIVE = new Set(["installing", "downloading", "configuring", "indexing", "checking"]);
const INDEX_RACE = /changed while full reindex was building|retry the full reindex/i;
const INDEX_ATTEMPTS = 4;

export class MemoryError extends Error {
  constructor(code, status = 409) { super(code); Object.assign(this, { code, status }); }
}

export function memoryError(error) {
  if (error instanceof MemoryError) return error.code;
  const text = String(error?.message ?? error);
  if (/429/.test(text)) return "download_limited";
  if (/sha-?256|checksum|digest|size mismatch/i.test(text)) return "verification_failed";
  if (/ENOSPC/.test(text)) return "disk_full";
  if (/download|fetch|network|ETIMEDOUT|ENOTFOUND/i.test(text)) return "download_failed";
  return "memory_failed";
}

// Never accept a chat download, a custom model, or a new prompt introduced by another plugin version.
export function embeddingPrompter(progress) {
  const unexpected = () => { throw new MemoryError("setup_incompatible"); };
  return {
    confirm: async ({ message }) => {
      if (message === EMBEDDING_CONFIRM) return true;
      if (message.startsWith("OpenClaw will install a verified llama.cpp server and download Gemma 4 E4B IT Q4_K_M")) return false;
      return unexpected();
    },
    text: unexpected, select: unexpected, multiselect: unexpected,
    note: async () => {},
    progress: () => ({ update: (text) => {
      const percent = /Downloading EmbeddingGemma… (\d+)%/.exec(text);
      if (percent) progress("downloading", Math.min(100, Number(percent[1])));
    }, stop: () => {} }),
  };
}

export function embeddingPatch(result) {
  const managed = result?.configPatch?.models?.providers?.["llama-cpp"];
  if (result?.defaultModel || !managed?.localService || !Array.isArray(managed.models) || managed.models.length !== 0) {
    throw new MemoryError("setup_conflict");
  }
  return { models: { providers: { "llama-cpp": managed } }, memory: { search: { enabled: true, provider: "local", fallback: "none" } } };
}

export function parseMemoryJson(out) {
  // CLI plugins can print log lines before their JSON result.
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^[\[{]/.test(lines[i].trim())) continue;
    try { return JSON.parse(lines.slice(i).join("\n")); } catch { /* Try the next JSON boundary. */ }
  }
  throw new MemoryError("status_unavailable", 503);
}

export function memorySummary(rows) {
  if (!Array.isArray(rows)) throw new MemoryError("status_unavailable", 503);
  return rows.map(({ agentId, status = {}, embeddingProbe }) => {
    if (typeof agentId !== "string" || !AGENT.test(agentId)) throw new MemoryError("status_unavailable", 503);
    const provider = typeof status.provider === "string" ? status.provider : null;
    const probe = embeddingProbe ?? status.embeddingProbe;
    const identity = status.custom?.indexIdentity?.status;
    const vector = status.vector;
    const vectorsReady = vector?.enabled === true && vector.index?.state === "complete" && vector.storeAvailable !== false && (vector.semanticAvailable ?? vector.available) !== false;
    // Sessions grow with every message: the agent the owner is talking to is "dirty" right after a reindex, and
    // OpenClaw adds new turns by itself (seen live on main, 12.11.2026). Only the other sources' state counts.
    const sources = Array.isArray(status.sourceCounts) ? status.sourceCounts : null;
    const stale = sources
      ? status.dirty === true && sources.some((source) => source?.source !== "sessions" && source?.dirty !== false)
      : !!status.dirty;
    const indexReady = !stale && identity === "valid" && (provider === "none" || vectorsReady);
    return {
      agentId, provider, files: Number.isSafeInteger(status.files) ? status.files : null,
      chunks: Number.isSafeInteger(status.chunks) ? status.chunks : null,
      index: indexReady ? "ready" : "pending",
      embeddings: probe?.ok === true && probe.checked !== false ? "ready" : probe?.ok === false ? "error" : "unchecked",
    };
  });
}

async function loadProvider(stateDir) {
  const root = path.join(stateDir, "npm", "projects");
  for (const name of await fs.readdir(root).catch(() => [])) {
    if (!name.startsWith("openclaw-llama-cpp-provider-")) continue;
    const dir = path.join(root, name, "node_modules", MEMORY_PACKAGE);
    const pkg = await fs.readFile(path.join(dir, "package.json"), "utf8").then(JSON.parse).catch(() => null);
    if (pkg?.name !== MEMORY_PACKAGE || pkg.version !== MEMORY_VERSION) continue;
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "openclaw.plugin.json"), "utf8"));
    if (manifest.id !== "llama-cpp" || JSON.stringify(manifest.contracts?.embeddingProviders) !== '["local"]') throw new MemoryError("setup_incompatible");
    let provider;
    const plugin = (await import(pathToFileURL(path.join(dir, "dist", "index.js")).href)).default;
    plugin.register({ registerProvider: (value) => { provider = value; }, registerEmbeddingProvider: () => {} });
    const method = provider?.auth?.find((item) => item.id === "local");
    if (!method?.run) throw new MemoryError("setup_incompatible");
    return method;
  }
  return null;
}

export class LocalMemory {
  #job = { state: "idle", percent: null, error: null, updatedAt: null };
  #task;
  #loading;
  #saving = Promise.resolve();
  #snapshot = { checkedAt: null, agents: [], error: null };

  constructor({ runCli, stateDir = process.env.OPENCLAW_STATE_DIR, configPath = process.env.OPENCLAW_CONFIG_PATH, providerLoader = loadProvider, log = () => {}, retryDelayMs = 3_000 }) {
    Object.assign(this, { runCli, stateDir, configPath, providerLoader, log, retryDelayMs });
    this.file = path.join(stateDir, "clawdesk-memory-job.json");
  }

  async #load() {
    this.#loading ??= (async () => {
      const names = await fs.readdir(this.stateDir).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
      for (const name of names) {
        if (/^\.clawdesk-memory-[a-f0-9-]{36}\.json$/.test(name)) await fs.unlink(path.join(this.stateDir, name));
      }
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    })().then(async (job) => {
      if (["idle", "ready", "error", ...ACTIVE].includes(job.state)) {
        this.#job = { state: ACTIVE.has(job.state) ? "error" : job.state, percent: null,
          error: ACTIVE.has(job.state) ? "interrupted" : job.error, updatedAt: job.updatedAt };
        if (ACTIVE.has(job.state)) await this.#save();
      }
    }).catch((error) => { if (error.code !== "ENOENT") this.#job = { state: "error", percent: null, error: "state_unavailable", updatedAt: Date.now() }; });
    await this.#loading;
  }

  #save() {
    const text = JSON.stringify(this.#job);
    this.#saving = this.#saving.catch(() => {}).then(async () => {
      await fs.mkdir(this.stateDir, { recursive: true });
      await fs.writeFile(`${this.file}.tmp`, text, { mode: 0o600 });
      await fs.rename(`${this.file}.tmp`, this.file);
    });
    return this.#saving;
  }

  async #stage(state, percent = null) {
    if (this.#job.state === state && this.#job.percent === percent) return;
    this.#job = { state, percent, error: null, updatedAt: Date.now() };
    await this.#save();
  }

  async #cli(args, options) {
    const res = await this.runCli(args, options);
    if (res.code !== 0) throw new Error(res.timedOut ? "ETIMEDOUT" : (res.err || res.out));
    return res.out;
  }

  async #localCli(args, config, agentId, timeoutMs) {
    // Freeze this operation's local provider and disable paid fallbacks, even if settings change meanwhile.
    const snapshot = structuredClone(config);
    snapshot.memory ??= {};
    snapshot.memory.search = { ...snapshot.memory.search, provider: "local", fallback: "none" };
    const agent = snapshot.agents?.entries?.[agentId];
    if (agent) {
      agent.memory ??= {};
      agent.memory.search = { ...agent.memory.search, provider: "local", fallback: "none" };
    }
    const file = path.join(this.stateDir, `.clawdesk-memory-${randomUUID()}.json`);
    await fs.writeFile(file, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
    try { return await this.#cli(args, { timeoutMs, env: { OPENCLAW_CONFIG_PATH: file } }); }
    finally { await fs.unlink(file); }
  }

  async status() {
    await this.#load();
    return { job: { ...this.#job }, ...this.#snapshot };
  }

  async search(agentId, query) {
    await this.#load();
    if (!AGENT.test(agentId) || typeof query !== "string" || !query.trim() || query.length > 500) throw new MemoryError("invalid_query", 400);
    if (this.#task) throw new MemoryError("memory_busy");
    const cfg = JSON.parse(await fs.readFile(this.configPath, "utf8"));
    if (agentId !== "main" && !Object.hasOwn(cfg.agents?.entries ?? {}, agentId)) throw new MemoryError("invalid_query", 400);
    const provider = cfg.agents?.entries?.[agentId]?.memory?.search?.provider ?? cfg.memory?.search?.provider;
    if (provider !== "local") throw new MemoryError("local_required");
    try {
      const result = parseMemoryJson(await this.#localCli(["memory", "search", "--agent", agentId, "--query", query.trim(), "--max-results", "3", "--json"], cfg, agentId, 120_000));
      if (!Array.isArray(result.results)) throw new MemoryError("status_unavailable", 503);
      return { stale: result.stale === true, results: result.results.slice(0, 3).map((item) => ({
        path: String(item.path ?? "").slice(0, 500), snippet: String(item.snippet ?? "").slice(0, 2000),
      })) };
    } catch { throw new MemoryError("memory_failed", 503); }
  }

  async start(action, consent = false) {
    await this.#load();
    if (this.#task) return this.status();
    if (action === "setup" && consent !== true) throw new MemoryError("consent_required", 400);
    if (!["setup", "reindex", "check"].includes(action)) throw new MemoryError("invalid_action", 400);
    // Reserve before the first await so a repeated click cannot start a second installer.
    this.#task = this.#run(action).catch(async (error) => {
      this.#job = { state: "error", percent: null, error: memoryError(error), updatedAt: Date.now() };
      // The screen shows only the code; the server log keeps what really failed (the panel never shows it).
      try { this.log("local memory operation failed", { action, code: this.#job.error, detail: String(error?.message ?? error).slice(-2000) }); } catch { /* logging must not change the outcome */ }
      await this.#save();
    }).finally(() => { this.#task = undefined; });
    void this.#task.catch(() => {});
    return this.status();
  }

  async #run(action) {
    await this.#stage(action === "setup" ? "installing" : action === "reindex" ? "indexing" : "checking");
    if (action === "setup") {
      const config = JSON.parse(await fs.readFile(this.configPath, "utf8"));
      const mainSearch = config.agents?.entries?.main?.memory?.search;
      if (mainSearch?.enabled === false || (mainSearch?.provider && mainSearch.provider !== "local")) throw new MemoryError("setup_conflict");
      const existing = config.models?.providers?.["llama-cpp"];
      if (existing && (!existing.localService || existing.models?.length !== 0)) throw new MemoryError("setup_conflict");
      const routes = [config.agents?.defaults?.model, ...Object.values(config.agents?.entries ?? {}).map((agent) => agent.model)];
      if (routes.some((model) => (typeof model === "string" ? [model] : [model?.primary, ...(model?.fallbacks ?? [])]).some((ref) => typeof ref === "string" && ref.startsWith("llama-cpp/")))) throw new MemoryError("setup_conflict");
      if (existing?.params?.modelCacheDir) throw new MemoryError("setup_conflict");
      // The official wizard can silently reuse a cached chat model before asking any questions.
      const chatCache = "hf_unsloth_gemma-4-E4B-it-GGUF_gemma-4-E4B-it-Q4_K_M.gguf";
      for (const cache of [path.join(this.stateDir, "models", "llama.cpp", chatCache), path.join(os.homedir(), ".node-llama-cpp", "models", chatCache)]) {
        if (await fs.stat(cache).then((stat) => stat.isFile()).catch(() => false)) throw new MemoryError("setup_conflict");
      }
      if (config.memory?.search?.local?.modelPath || Object.values(config.agents?.entries ?? {}).some((agent) => agent.memory?.search?.local?.modelPath)) throw new MemoryError("setup_conflict");
      const version = await this.#cli(["--version"]);
      if (!version.split(/\s+/).includes(MEMORY_VERSION)) throw new MemoryError("setup_incompatible");
      let method = await this.providerLoader(this.stateDir);
      if (!method) {
        await this.#cli(["plugins", "install", `${MEMORY_PACKAGE}@${MEMORY_VERSION}`, "--pin", "--accept-capabilities"], { timeoutMs: 300_000 });
        method = await this.providerLoader(this.stateDir);
      }
      if (!method) throw new MemoryError("setup_incompatible");
      const localConfig = { ...config, memory: { ...config.memory, search: { ...config.memory?.search, enabled: true, provider: "local", fallback: "none" } } };
      const result = await method.run({ config: localConfig, agentDir: path.join(this.stateDir, "agents", "main", "agent"),
        env: process.env, signal: AbortSignal.timeout(40 * 60_000),
        runtime: { log: () => {}, error: () => {}, exit: () => { throw new MemoryError("setup_incompatible"); } },
        prompter: embeddingPrompter((state, percent) => { void this.#stage(state, percent).catch(() => {}); }),
      });
      const patch = embeddingPatch(result);
      await this.#stage("configuring");
      const latest = JSON.parse(await fs.readFile(this.configPath, "utf8"));
      if (JSON.stringify(latest.memory) !== JSON.stringify(config.memory) ||
          JSON.stringify(latest.models?.providers?.["llama-cpp"]) !== JSON.stringify(existing) ||
          JSON.stringify(latest.agents) !== JSON.stringify(config.agents)) throw new MemoryError("setup_conflict");
      await this.#cli(["config", "patch", "--stdin"], { input: JSON.stringify(patch), timeoutMs: 120_000 });
    }
    if (action !== "check") {
      const cfg = JSON.parse(await fs.readFile(this.configPath, "utf8"));
      const ids = [...new Set(["main", ...Object.keys(cfg.agents?.entries ?? {})])];
      for (const agentId of ids) {
        if (!AGENT.test(agentId)) throw new MemoryError("setup_conflict");
        const provider = cfg.agents?.entries?.[agentId]?.memory?.search?.provider ?? cfg.memory?.search?.provider;
        const enabled = cfg.agents?.entries?.[agentId]?.memory?.search?.enabled ?? cfg.memory?.search?.enabled ?? true;
        // This action never spends cloud embedding credits or replaces per-agent choices.
        if (provider !== "local" || !enabled) continue;
        await this.#stage("indexing");
        // A live chat writes new turns while a full reindex builds; OpenClaw then drops the build and asks to
        // retry (seen live on main, 12.11.2026: "Memory index changed while full reindex was building").
        for (let attempt = 1; ; attempt++) {
          try { await this.#localCli(["memory", "index", "--agent", agentId, "--force"], cfg, agentId, 20 * 60_000); break; }
          catch (error) {
            if (attempt >= INDEX_ATTEMPTS || !INDEX_RACE.test(String(error?.message ?? error))) throw error;
            await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
          }
        }
      }
    }
    await this.#stage("checking");
    // Deep checks may call a paid embedding provider; only probe local agents.
    const cfg = JSON.parse(await fs.readFile(this.configPath, "utf8"));
    const ids = [...new Set(["main", ...Object.keys(cfg.agents?.entries ?? {})])];
    const rows = [];
    const expectedLocal = [];
    for (const agentId of ids) {
      if (!AGENT.test(agentId)) throw new MemoryError("setup_conflict");
      const provider = cfg.agents?.entries?.[agentId]?.memory?.search?.provider ?? cfg.memory?.search?.provider;
      const enabled = cfg.agents?.entries?.[agentId]?.memory?.search?.enabled ?? cfg.memory?.search?.enabled ?? true;
      if (provider === "local" && enabled) expectedLocal.push(agentId);
      const args = ["memory", "status", "--agent", agentId, "--json", ...(provider === "local" ? ["--deep"] : [])];
      const result = parseMemoryJson(provider === "local" ? await this.#localCli(args, cfg, agentId, 120_000) : await this.#cli(args, { timeoutMs: 120_000 }));
      if (!Array.isArray(result)) throw new MemoryError("status_unavailable", 503);
      rows.push(...(result.length ? result : [{ agentId, status: { provider } }]));
    }
    this.#snapshot = { checkedAt: Date.now(), agents: memorySummary(rows), error: null };
    if (expectedLocal.some((id) => !this.#snapshot.agents.some((agent) => agent.agentId === id && agent.provider === "local" && agent.embeddings === "ready" && agent.index === "ready"))) throw new MemoryError("memory_not_ready");
    await this.#stage("ready");
  }

  async drain() { await this.#task; await this.#saving; }
}
