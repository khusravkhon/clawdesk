import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory, MEMORY_VERSION, embeddingPatch, embeddingPrompter, memoryError, memorySummary } from "./clawdesk-memory.mjs";

const row = (agentId = "main", provider = "local", deep = true) => ({ agentId, status: {
  provider, files: 2, chunks: 3, dirty: false, custom: { indexIdentity: { status: "valid" } },
  vector: { enabled: true, index: { state: "complete" }, storeAvailable: true, semanticAvailable: true },
}, ...(deep ? { embeddingProbe: { ok: true } } : {}) });
const managed = { localService: { command: "/verified/llama-server", args: [] }, models: [] };

async function fixture(t, { config = {}, method, loader } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-memory-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  const calls = [];
  const runCli = async (args, opts) => {
    calls.push({ args, opts, snapshot: opts?.env?.OPENCLAW_CONFIG_PATH ? JSON.parse(await fs.readFile(opts.env.OPENCLAW_CONFIG_PATH, "utf8")) : undefined });
    if (args[0] === "--version") return { code: 0, out: `OpenClaw ${MEMORY_VERSION}` };
    if (args[0] === "config") {
      const current = JSON.parse(await fs.readFile(configPath, "utf8"));
      const patch = JSON.parse(opts.input);
      await fs.writeFile(configPath, JSON.stringify({ ...current, memory: patch.memory, models: { ...current.models, providers: { ...current.models?.providers, ...patch.models.providers } } }));
    }
    if (args[1] === "search") return { code: 0, out: JSON.stringify({ results: [{ path: "USER.md", snippet: "Owner note" }] }) };
    const agent = args[args.indexOf("--agent") + 1] ?? "main";
    return { code: 0, out: JSON.stringify([row(agent, config.agents?.entries?.[agent]?.memory?.search?.provider ?? "local", args.includes("--deep"))]) };
  };
  const logs = [];
  const memory = new LocalMemory({ runCli, stateDir: dir, configPath, log: (msg, extra) => logs.push({ msg, ...extra }), providerLoader: loader ?? (async () => method ?? { run: async () => ({ profiles: [], configPatch: { models: { providers: { "llama-cpp": managed } } } }) }) });
  return { memory, dir, configPath, calls, runCli, logs };
}

test("consent is mandatory and only the known embedding prompt is accepted", async (t) => {
  const { memory, calls } = await fixture(t);
  await assert.rejects(memory.start("setup"), { code: "consent_required" });
  assert.equal(calls.length, 0);
  const prompts = embeddingPrompter(() => {});
  assert.equal(await prompts.confirm({ message: "OpenClaw can install a verified llama.cpp server and download only the local embedding model (about 0.3 GB). This will not install or change your chat model. Continue?" }), true);
  assert.equal(await prompts.confirm({ message: "OpenClaw will install a verified llama.cpp server and download Gemma 4 E4B IT Q4_K_M (about 5.0 GB) plus anything" }), false);
  await assert.rejects(prompts.confirm({ message: "Install another model" }), { code: "setup_incompatible" });
});

test("only an embedding-only patch is applied; chat settings remain intact", async (t) => {
  assert.throws(() => embeddingPatch({ defaultModel: "chat/model" }), { code: "setup_conflict" });
  assert.throws(() => embeddingPatch({ configPatch: { models: { providers: { "llama-cpp": { ...managed, models: [{ id: "chat" }] } } } } }), { code: "setup_conflict" });
  const config = { agents: { defaults: { model: "openai-codex/chat" }, entries: { main: {}, trainer: {}, cloud: { memory: { search: { provider: "openai" } } } } }, models: { providers: { openai: { api: "preserved" } } } };
  const { memory, calls, configPath } = await fixture(t, { config });
  await memory.start("setup", true);
  await memory.drain();
  assert.equal((await memory.status()).job.state, "ready");
  const after = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.deepEqual(after.agents, config.agents);
  assert.deepEqual(after.models.providers.openai, config.models.providers.openai);
  assert.deepEqual(after.memory.search, { enabled: true, provider: "local", fallback: "none" });
  assert.equal(calls.filter((call) => call.args[1] === "index").length, 2);
  assert.equal(calls.some((call) => call.args.includes("cloud") && call.args.includes("--deep")), false);
});

test("repeated clicks share one task, progress is numeric, no provider text reaches status", async (t) => {
  let finish;
  let runs = 0;
  const gate = new Promise((resolve) => { finish = resolve; });
  const { memory } = await fixture(t, { method: { run: async (ctx) => {
    runs++;
    ctx.prompter.progress().update("Downloading EmbeddingGemma… 42% (PRIVATE)");
    await gate;
    return { configPatch: { models: { providers: { "llama-cpp": managed } } } };
  } } });
  await Promise.all([memory.start("setup", true), memory.start("setup", true)]);
  while (!runs) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await memory.status()).job.percent, 42);
  assert.equal(JSON.stringify(await memory.status()).includes("PRIVATE"), false);
  finish();
  await memory.drain();
  assert.equal(runs, 1);
});

test("a restart records an interruption and permits an explicit retry", async (t) => {
  const { memory, dir } = await fixture(t, { config: { memory: { search: { provider: "local" } } } });
  await fs.writeFile(path.join(dir, "clawdesk-memory-job.json"), JSON.stringify({ state: "downloading", updatedAt: 10 }));
  assert.equal((await memory.status()).job.error, "interrupted");
  await memory.start("check");
  await memory.drain();
  assert.equal((await memory.status()).job.state, "ready");
});

test("download failure is safe, preserves memory selection, and can be retried", async (t) => {
  let fail = true;
  const { memory, configPath, logs } = await fixture(t, { config: { memory: { search: { provider: "none" } } }, method: { run: async () => {
    if (fail) throw new Error("download failed: HTTP 429 SECRET");
    return { configPatch: { models: { providers: { "llama-cpp": managed } } } };
  } } });
  await memory.start("setup", true); await memory.drain();
  assert.equal((await memory.status()).job.error, "download_limited");
  assert.equal(JSON.stringify(await memory.status()).includes("SECRET"), false);
  // The real cause stays in the server log only.
  assert.deepEqual(logs, [{ msg: "local memory operation failed", action: "setup", code: "download_limited", detail: "download failed: HTTP 429 SECRET" }]);
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).memory.search.provider, "none");
  fail = false;
  await memory.start("setup", true); await memory.drain();
  assert.equal((await memory.status()).job.state, "ready");
});

test("existing chat or custom embedding settings are not replaced", async (t) => {
  for (const config of [{ models: { providers: { "llama-cpp": { models: [{ id: "chat" }] } } } }, { memory: { search: { local: { modelPath: "/my/model.gguf" } } } }]) {
    const { memory, calls } = await fixture(t, { config });
    await memory.start("setup", true); await memory.drain();
    assert.equal((await memory.status()).job.error, "setup_conflict");
    assert.equal(calls.length, 0);
  }
});

test("checks distinguish index readiness from embedding readiness", () => {
  assert.equal(memorySummary([row("main", "local", false)])[0].embeddings, "unchecked");
  assert.equal(memorySummary([row()])[0].embeddings, "ready");
  assert.equal(memorySummary([{ ...row(), embeddingProbe: { ok: false, error: "PRIVATE" } }])[0].embeddings, "error");
  assert.equal(memorySummary([{ ...row(), embeddingProbe: { ok: true, checked: false } }])[0].embeddings, "unchecked");
  assert.equal(memorySummary([{ ...row(), status: { ...row().status, vector: { enabled: true, index: { state: "complete" }, semanticAvailable: false } } }])[0].index, "pending");
  assert.equal(memoryError(new Error("SHA-256 mismatch PRIVATE")), "verification_failed");
});

test("a live chat's new session turns do not make the index unready; stale notes do", () => {
  const withSources = (memoryDirty) => ({ ...row(), status: { ...row().status, dirty: true, sourceCounts: [
    { source: "memory", files: 23, chunks: 40, dirty: memoryDirty }, { source: "sessions", files: 7, chunks: 89 },
  ] } });
  assert.equal(memorySummary([withSources(false)])[0].index, "ready");
  assert.equal(memorySummary([withSources(true)])[0].index, "pending");
  assert.equal(memorySummary([withSources(undefined)])[0].index, "pending");
  // Without per-source counts the overall flag decides.
  assert.equal(memorySummary([{ ...row(), status: { ...row().status, dirty: true } }])[0].index, "pending");
});

test("search only reads a configured local agent, caps results, and survives recreation", async (t) => {
  const fixtureValue = await fixture(t, { config: { memory: { search: { provider: "local" } }, agents: { entries: { cloud: { memory: { search: { provider: "openai" } } } } } } });
  const { memory, dir, configPath, runCli } = fixtureValue;
  await assert.rejects(memory.search("cloud", "note"), { code: "local_required" });
  await assert.rejects(memory.search("unknown", "note"), { code: "invalid_query" });
  await assert.rejects(memory.search("main", ""), { code: "invalid_query" });
  assert.equal((await memory.search("main", "note")).results[0].snippet, "Owner note");
  const restarted = new LocalMemory({ stateDir: dir, configPath, runCli });
  assert.equal((await restarted.search("main", "note")).results.length, 1);
});

test("local operations freeze their configuration and disable paid fallbacks without changing the owner's settings", async (t) => {
  const config = { memory: { search: { provider: "local", fallback: "openai" } }, agents: { entries: { main: { memory: { search: { fallback: "gemini" } } } } } };
  const { memory, calls, configPath, dir } = await fixture(t, { config });
  await memory.start("reindex"); await memory.drain();
  await memory.search("main", "note");
  for (const call of calls.filter((call) => call.args[0] === "memory")) {
    assert.equal(call.snapshot.memory.search.provider, "local");
    assert.equal(call.snapshot.memory.search.fallback, "none");
    assert.equal(call.snapshot.agents.entries.main.memory.search.fallback, "none");
  }
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), config);
  assert.equal((await fs.readdir(dir)).some((name) => name.startsWith(".clawdesk-memory-")), false);
});
