import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerRequests, REPLY, UP } from "./plugins/clawdesk-requests/index.mjs";

async function fixture(t) {
  const spoolDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-requests-")), "spool");
  t.after(() => fs.rm(path.dirname(spoolDir), { recursive: true, force: true }));
  const factories = {};
  let config = { agents: { entries: { dev: {}, other: {} } }, plugins: { entries: { "clawdesk-requests": { enabled: true, config: { allowedAgentIds: ["dev", "main"] } } } } };
  registerRequests({ registerTool: (factory, options) => { for (const name of options.names) factories[name] = { factory, options }; } }, { spoolDir, now: () => 1000 });
  const context = (agentId = "dev", sessionKey = `agent:${agentId}:main`) => ({ agentId, sessionKey, getRuntimeConfig: () => config });
  const spool = async () => Promise.all((await fs.readdir(spoolDir).catch(() => [])).map(async (name) => JSON.parse(await fs.readFile(path.join(spoolDir, name), "utf8"))));
  return { spoolDir, factories, context, tool: (name, ctx = context()) => factories[name].factory(ctx), spool, setConfig: (value) => { config = value; }, config: () => config };
}

test("manifest declares both optional tools with a strict agent allowlist", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("./plugins/clawdesk-requests/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(manifest.contracts.tools, [UP, REPLY]);
  assert.equal(manifest.toolMetadata[UP].optional, true);
});

test("files a request once per tool call, with the identity from the runtime, not the arguments", async (t) => {
  const f = await fixture(t);
  const up = f.tool(UP);
  assert.equal(up.parameters.additionalProperties, false);
  const args = { kind: "question", subject: " Где ТЗ? ", details: "Нужна ссылка на ТЗ приложения" };
  const first = await up.execute("call-1", args);
  assert.equal(first.details.status, "filed");
  assert.equal((await up.execute("call-1", args)).details.status, "filed");
  await up.execute("call-2", { ...args, taskRef: "TASK-001" });
  const filed = (await f.spool()).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(filed.length, 2);
  assert.ok(filed.every((item) => item.type === "up" && item.agentId === "dev" && item.sessionKey === "agent:dev:main" && /^[a-f0-9]{32}$/.test(item.id)));
  assert.ok(filed.some((item) => item.subject === "Где ТЗ?" && item.taskRef === undefined));
  // Main may file and reply too (it is an addressee and asks the owner).
  assert.equal((await f.tool(REPLY, f.context("main")).execute("c", { requestId: "REQ-001", action: "escalate", text: "к владельцу" })).details.status, "filed");
});

test("refuses unknown, forged and revoked identities and malformed arguments", async (t) => {
  const f = await fixture(t);
  for (const ctx of [{}, f.context("other"), f.context("dev", "agent:other:main"), f.context("dev", "agent:dev:"), { ...f.context(), getRuntimeConfig: undefined }]) assert.equal(f.tool(UP, ctx), null);
  const up = f.tool(UP), reply = f.tool(REPLY);
  for (const args of [{}, { kind: "access", subject: "x", details: "y" }, { kind: "question", subject: "", details: "y" }, { kind: "question", subject: "x", details: "y", agentId: "main" }, { kind: "question", subject: "x\0", details: "y" }, { kind: "question", subject: "x".repeat(201), details: "y" }]) assert.equal((await up.execute("c", args)).details.code, "invalid_arguments", JSON.stringify(args));
  assert.equal((await reply.execute("c", { requestId: "../x", action: "answer", text: "t" })).details.code, "invalid_arguments");
  assert.equal((await reply.execute("c", { requestId: "REQ-1", action: "grant", text: "t" })).details.code, "invalid_arguments");
  assert.equal((await up.execute("", { kind: "question", subject: "x", details: "y" })).details.code, "invalid_request_id");
  f.config().plugins.entries["clawdesk-requests"].config.allowedAgentIds = [];
  assert.equal((await up.execute("c", { kind: "question", subject: "x", details: "y" })).details.code, "requests_not_granted");
  assert.deepEqual(await f.spool(), []);
});

test("the spool is read oldest first without following links, and acknowledged entries disappear", async (t) => {
  const { readRequestsSpool, ackRequestsSpool } = await import("./clawdesk-requests-spool.mjs");
  const f = await fixture(t);
  const up = f.tool(UP);
  await up.execute("a", { kind: "question", subject: "one", details: "d" });
  await fs.writeFile(path.join(f.spoolDir, `${"b".repeat(32)}.json`), JSON.stringify({ id: "c".repeat(32) }));
  await fs.writeFile(path.join(f.spoolDir, `${"d".repeat(32)}.json`), "x".repeat(20_000));
  await fs.symlink("/etc/hostname", path.join(f.spoolDir, `${"e".repeat(32)}.json`));
  await fs.writeFile(path.join(f.spoolDir, "notes.txt"), "ignored");
  const read = await readRequestsSpool(f.spoolDir);
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].subject, "one");
  assert.deepEqual(read.rejected.sort(), ["b".repeat(32), "d".repeat(32), "e".repeat(32)]);
  await ackRequestsSpool(f.spoolDir, [read.entries[0].id, ...read.rejected]);
  assert.deepEqual(await fs.readdir(f.spoolDir), ["notes.txt"]);
  await assert.rejects(ackRequestsSpool(f.spoolDir, ["../x"]));
  assert.deepEqual(await readRequestsSpool(path.join(f.spoolDir, "missing")), { entries: [], rejected: [] });
});

test("an access request names its resource and level; other kinds may not", async (t) => {
  const f = await fixture(t);
  const up = f.tool(UP);
  assert.equal((await up.execute("a1", { kind: "access", subject: "Нужна папка", details: "Для отчёта", resource: "folder:Finance", access: "read" })).details.status, "filed");
  assert.equal((await up.execute("a2", { kind: "access", subject: "x", details: "y" })).details.code, "invalid_arguments");
  assert.equal((await up.execute("a3", { kind: "question", subject: "x", details: "y", resource: "folder:Finance", access: "read" })).details.code, "invalid_arguments");
  assert.equal((await up.execute("a4", { kind: "access", subject: "x", details: "y", resource: "disk:/etc", access: "read" })).details.code, "invalid_arguments");
  assert.equal((await up.execute("a5", { kind: "access", subject: "x", details: "y", resource: "mcp:notion", access: "admin" })).details.code, "invalid_arguments");
  const [filed] = await f.spool();
  assert.deepEqual([filed.kind, filed.resource, filed.access], ["access", "folder:Finance", "read"]);
});
