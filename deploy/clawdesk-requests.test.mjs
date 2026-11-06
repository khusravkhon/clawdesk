import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerRequests, REPLY, SHARE, UP } from "./plugins/clawdesk-requests/index.mjs";

async function fixture(t) {
  const spoolDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-requests-")), "spool");
  t.after(() => fs.rm(path.dirname(spoolDir), { recursive: true, force: true }));
  const factories = {};
  let config = { agents: { entries: { dev: {}, other: {} } }, plugins: { entries: { "clawdesk-requests": { enabled: true, config: { allowedAgentIds: ["dev", "main"] } } } } };
  const interactive = [];
  registerRequests({ registerTool: (factory, options) => { for (const name of options.names) factories[name] = { factory, options }; }, registerInteractiveHandler: (registration) => interactive.push(registration) }, { spoolDir, now: () => 1000 });
  const context = (agentId = "dev", sessionKey = `agent:${agentId}:main`) => ({ agentId, sessionKey, getRuntimeConfig: () => config });
  const spool = async () => Promise.all((await fs.readdir(spoolDir).catch(() => [])).map(async (name) => JSON.parse(await fs.readFile(path.join(spoolDir, name), "utf8"))));
  return { interactive, spoolDir, factories, context, tool: (name, ctx = context()) => factories[name].factory(ctx), spool, setConfig: (value) => { config = value; }, config: () => config };
}

test("manifest declares both optional tools with a strict agent allowlist", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("./plugins/clawdesk-requests/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(manifest.contracts.tools, [UP, REPLY, "clawdesk_task_report", "clawdesk_task_review", SHARE]);
  assert.equal(manifest.toolMetadata[SHARE].optional, true);
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

test("an owner's Telegram button is filed once with the presser's ID and its buttons cleared, never sent to a model", async (t) => {
  const f = await fixture(t);
  assert.equal(f.interactive.length, 1);
  const [handler] = f.interactive;
  assert.deepEqual([handler.channel, handler.namespace], ["telegram", "cdreq"]);
  let cleared = 0;
  const press = (payload, senderId = "4242", callbackId = "cb-1") => handler.handler({ callbackId, senderId, accountId: "default", callback: { payload, data: `cdreq:${payload}` }, respond: { clearButtons: async () => { cleared++; } } });
  assert.deepEqual(await press("tok_abcdefghijklmnop"), { handled: true });
  await press("tok_abcdefghijklmnop");
  await press("bad token!", "4242", "cb-2");
  await press("tok_abcdefghijklmnop", "not-a-number", "cb-3");
  const filed = await f.spool();
  assert.equal(filed.length, 1);
  assert.deepEqual([filed[0].type, filed[0].token, filed[0].senderId, filed[0].accountId], ["owner_button", "tok_abcdefghijklmnop", "4242", "default"]);
  assert.equal(cleared, 2);
});

test("an executor's task report is filed once with its identity; malformed reports are refused", async (t) => {
  const f = await fixture(t);
  const report = f.tool("clawdesk_task_report");
  assert.equal((await report.execute("r1", { taskId: "WI-001", status: "done", result: "Готово: отчёт в docs/report.md" })).details.status, "filed");
  assert.equal((await report.execute("r2", { taskId: "WI-1", status: "done" })).details.code, "invalid_arguments");
  assert.equal((await report.execute("r3", { taskId: "TASK-1", status: "done", result: "x" })).details.code, "invalid_arguments");
  assert.equal((await report.execute("r4", { taskId: "WI-001", status: "maybe", result: "x" })).details.code, "invalid_arguments");
  const [filed] = await f.spool();
  assert.deepEqual([filed.type, filed.agentId, filed.taskId, filed.status], ["task_report", "dev", "WI-001", "done"]);
});

test("a team lead's decision on a task is filed with its identity; malformed ones are refused", async (t) => {
  const f = await fixture(t);
  const review = f.tool("clawdesk_task_review");
  assert.equal((await review.execute("v1", { taskId: "WI-002", decision: "return", comment: "Нет ссылки на отчёт" })).details.status, "filed");
  assert.equal((await review.execute("v2", { taskId: "WI-002", decision: "maybe", comment: "x" })).details.code, "invalid_arguments");
  assert.equal((await review.execute("v3", { taskId: "WI-002", decision: "accept" })).details.code, "invalid_arguments");
  const [filed] = await f.spool();
  assert.deepEqual([filed.type, filed.agentId, filed.taskId, filed.decision], ["task_review", "dev", "WI-002", "return"]);
});

test("the owner's /req command in Telegram is filed with the sender's ID, never sent to a model", async (t) => {
  const spoolDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-req-cmd-")), "spool");
  t.after(() => fs.rm(path.dirname(spoolDir), { recursive: true, force: true }));
  const { registerOwnerCommand } = await import("./plugins/clawdesk-requests/index.mjs");
  let command;
  registerOwnerCommand({ registerCommand: (definition) => { command = definition; } }, { spoolDir, now: () => 120_000 });
  assert.equal(command.name, "req");
  const run = (args, extra = {}) => command.handler({ channel: "telegram", senderId: "4242", args, ...extra });
  assert.match((await run("REQ-003 ответ Отчёт в папке Sales")).text, /Принято: REQ-003/);
  await run("req-003 ответ Отчёт в папке Sales");
  assert.match((await run("REQ-003 отказ")).text, /Формат/);
  assert.match((await run("REQ-003 выдай всё")).text, /Формат/);
  assert.match((await run("REQ-003 deny нет", { channel: "discord" })).text, /только в Telegram/);
  assert.match((await run("REQ-003 deny нет", { senderId: "abc" })).text, /Формат/);
  await run("REQ-004 уточни Для какого месяца?");
  const filed = await Promise.all((await fs.readdir(spoolDir)).map(async (name) => JSON.parse(await fs.readFile(path.join(spoolDir, name), "utf8"))));
  assert.deepEqual(filed.map((item) => [item.type, item.senderId, item.requestId, item.action, item.text]).sort(), [["owner_text", "4242", "REQ-003", "answer", "Отчёт в папке Sales"], ["owner_text", "4242", "REQ-004", "clarify", "Для какого месяца?"]]);
});

test("only the main agent proposes giving the owner's file; the proposal is filed with its identity", async (t) => {
  const f = await fixture(t);
  assert.equal(f.tool(SHARE, f.context("dev")), null, "a company agent has no such tool");
  const share = f.tool(SHARE, f.context("main"));
  assert.equal(share.parameters.additionalProperties, false);
  const args = { to: "Разработчик проекта", file: "media://inbound/ТЗ---0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.pdf", instruction: "Изучи ТЗ и составь план" };
  assert.equal((await share.execute("s1", args)).details.status, "filed");
  assert.equal((await share.execute("s2", { ...args, file: "Входящие/ТЗ.pdf", name: "ТЗ" })).details.status, "filed");
  for (const bad of [{ ...args, file: ["a", "b"].join("\n") }, { ...args, instruction: "" }, { to: "x", file: "f" }, { ...args, extra: "1" }]) assert.equal((await share.execute("bad", bad)).details.code, "invalid_arguments");
  const filed = await f.spool();
  assert.equal(filed.length, 2);
  assert.ok(filed.every((item) => item.type === "share" && item.agentId === "main" && item.sessionKey === "agent:main:main"));
});
