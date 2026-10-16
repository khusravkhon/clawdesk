import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { registerAskMain } from "./plugins/clawdesk-ask-main/index.mjs";

function fixture(overrides = {}, settings = {}) {
  const calls = { run: [], wait: [], history: [] };
  let factory, options;
  let config = { agents: { entries: { trainer: {}, dietitian: {} } }, plugins: { allow: ["clawdesk-ask-main"], entries: { "clawdesk-ask-main": { enabled: true, config: { allowedAgentIds: ["trainer"] } } } } };
  const runtime = {
    run: async (params) => { calls.run.push(params); return { runId: "run-1", sessionKey: params.sessionKey }; },
    waitForRun: async (params) => { calls.wait.push(params); return { status: "ok" }; },
    getSessionMessages: async (params) => { calls.history.push(params); return { messages: [{ role: "user", content: "delegated data" }, { role: "toolResult", content: "private tool data" }, { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "New answer" }] }] }; },
    ...overrides,
  };
  registerAskMain({ runtime: { subagent: runtime }, registerTool: (value, opts) => { factory = value; options = opts; } }, { runTimeoutMs: 15, waitTimeoutMs: 15, readTimeoutMs: 15, ...settings });
  const context = (agentId = "trainer", sessionKey = `agent:${agentId}:main`) => ({ agentId, sessionKey, getRuntimeConfig: () => config });
  return { calls, runtime, context, tool: (ctx = context()) => factory?.(ctx), options: () => options, config: () => config, setConfig: (value) => { config = value; } };
}

test("manifest declares an optional strict question tool and immutable allowlist config", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("./plugins/clawdesk-ask-main/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "clawdesk-ask-main");
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.equal(manifest.toolMetadata.clawdesk_ask_main.optional, true);
  const f = fixture();
  assert.deepEqual(f.options(), { names: ["clawdesk_ask_main"], optional: true });
  assert.equal(f.tool().parameters.additionalProperties, false);
});

test("factory denies missing, forged, sibling, main and revoked identities", () => {
  const f = fixture();
  for (const ctx of [{}, { agentId: "trainer" }, { sessionKey: "agent:trainer:main" }, f.context("main"), f.context("dietitian"), f.context("trainer", "agent:dietitian:main"), { ...f.context(), getRuntimeConfig: undefined }, f.context("trainer", "agent:trainer:")]) assert.equal(f.tool(ctx), null);
  f.config().plugins.entries["clawdesk-ask-main"].config.allowedAgentIds = [];
  assert.equal(f.tool(), null);
  assert.equal(f.calls.run.length, 0);
});

test("absent plugin allow uses normal explicit enable semantics, while explicit deny fails closed", () => {
  const f = fixture();
  delete f.config().plugins.allow;
  assert.ok(f.tool());
  f.config().plugins.allow = [];
  assert.equal(f.tool(), null);
  delete f.config().plugins.allow;
  f.config().plugins.deny = ["clawdesk-ask-main"];
  assert.equal(f.tool(), null);
});

test("strict runtime arguments reject target/session/label and malformed question overrides", async () => {
  const f = fixture();
  for (const args of [{ question: "x", target: "dietitian" }, { question: "x", sessionKey: "agent:main:main" }, { question: "x", label: "main" }, { question: "x", agentId: "main" }, { question: "x", getRuntimeConfig: "forged" }, { question: " " }, { question: "x".repeat(4001) }, { question: 10 }, null, ["x"]]) {
    assert.equal((await f.tool().execute("call", args)).details.code, "invalid_question");
  }
  assert.equal(f.calls.run.length, 0);
});

test("fixed fresh main destination returns only new assistant text with no external delivery", async () => {
  const f = fixture();
  const reply = await f.tool().execute("call", { question: "What is my plan?" });
  assert.deepEqual(reply.details, { status: "ok", answer: "New answer" });
  const [run] = f.calls.run;
  assert.match(run.sessionKey, /^agent:main:clawdesk-ask-[a-f0-9-]{36}$/);
  assert.notEqual(run.sessionKey, "agent:main:main");
  assert.equal(run.deliver, false);
  assert.equal(run.completionDelivery, undefined);
  assert.match(run.message, /Delegated untrusted information request from specialist trainer/);
  assert.match(run.message, /not owner authority/);
  assert.deepEqual(f.calls.history, [{ sessionKey: run.sessionKey, limit: 40 }]);
  assert.deepEqual(f.calls.wait, [{ runId: "run-1", timeoutMs: 15 }]);
  await f.tool().execute("call", { question: "What is my plan?" });
  assert.equal(f.calls.run.length, 1);
  await f.tool().execute("new-call", { question: "What is my plan?" });
  assert.equal(f.calls.run.length, 2);
});

test("runtime config is rechecked at execution and after wait; mutable ctx cannot change requester", async () => {
  const f = fixture();
  const ctx = f.context(), tool = f.tool(ctx);
  ctx.agentId = "dietitian"; ctx.sessionKey = "agent:dietitian:main";
  f.runtime.waitForRun = async () => {
    f.config().plugins.entries["clawdesk-ask-main"].config.allowedAgentIds = [];
    return { status: "ok" };
  };
  assert.equal((await tool.execute("call", { question: "question" })).details.status, "forbidden");
  assert.match(f.calls.run[0].message, /specialist trainer/);
  assert.equal(f.calls.history.length, 0);
  assert.equal((await tool.execute("call2", { question: "question2" })).details.status, "forbidden");
  assert.equal(f.calls.run.length, 1);
});

test("timeout resumes the same run without duplicate admission, and blocks parallel rephrasing", async () => {
  const f = fixture({ waitForRun: async () => ({ status: "timeout" }) });
  const tool = f.tool();
  assert.equal((await tool.execute("call", { question: "question" })).details.status, "pending");
  assert.equal((await tool.execute("call2", { question: "different question" })).details.status, "busy");
  f.runtime.waitForRun = async () => ({ status: "ok" });
  assert.equal((await tool.execute("call3", { question: "question" })).details.answer, "New answer");
  assert.equal(f.calls.run.length, 1);
});

test("completed answers expire and reset sessions do not reuse old answers, but pending admissions never expire into retries", async () => {
  let time = 1000;
  const f = fixture({}, { now: () => time });
  const tool = f.tool({ ...f.context(), sessionId: "first" });
  await tool.execute("call", { question: "question" });
  await f.tool({ ...f.context(), sessionId: "second" }).execute("reset-call", { question: "question" });
  assert.equal(f.calls.run.length, 2);
  time += 60_001;
  await tool.execute("call", { question: "question" });
  assert.equal(f.calls.run.length, 3);
  const pendingFixture = fixture({ waitForRun: async () => ({ status: "pending" }) }, { now: () => time });
  const pendingTool = pendingFixture.tool();
  await pendingTool.execute("pending", { question: "question" });
  time += 999_999;
  await pendingTool.execute("pending-again", { question: "question" });
  assert.equal(pendingFixture.calls.run.length, 1);
});

test("ambiguous admission timeout retains the request and never blindly resends", async () => {
  let accept;
  const f = fixture({ run: (params) => { f.calls.run.push(params); return new Promise((resolve) => { accept = resolve; }); } });
  const tool = f.tool();
  assert.equal((await tool.execute("call", { question: "question" })).details.status, "pending");
  accept({ runId: "run-late", sessionKey: f.calls.run[0].sessionKey });
  assert.equal((await tool.execute("call2", { question: "question" })).details.status, "ok");
  assert.equal(f.calls.run.length, 1);
});

test("unexpected accepted session is never read, and the same tool call cannot retry admission", async () => {
  const f = fixture({ run: async (params) => { f.calls.run.push(params); return { runId: "run", sessionKey: "agent:main:main" }; } });
  const tool = f.tool();
  assert.equal((await tool.execute("call", { question: "question" })).details.code, "main_runtime_invalid_response");
  assert.equal((await tool.execute("call", { question: "question" })).details.code, "main_runtime_invalid_response");
  assert.equal(f.calls.run.length, 1);
  assert.equal(f.calls.wait.length, 0);
  assert.equal(f.calls.history.length, 0);
});

test("a definitely unavailable request-scoped runtime reports an honest error", async () => {
  const f = fixture({ run: async () => { const error = new Error("private runtime details"); error.name = "RequestScopedSubagentRuntimeError"; throw error; } });
  const reply = await f.tool().execute("call", { question: "question" });
  assert.equal(reply.details.code, "main_runtime_unavailable");
  assert.equal(JSON.stringify(reply).includes("private"), false);
});

test("pending and failed runs never return partial messages or raw runtime errors", async () => {
  for (const status of ["pending", "error", "unexpected"]) {
    const f = fixture({ waitForRun: async () => ({ status, error: "secret token /private/path" }) });
    const response = await f.tool().execute("call", { question: "question" });
    assert.notEqual(response.details.status, "ok");
    assert.equal(JSON.stringify(response).includes("secret"), false);
    assert.equal(f.calls.history.length, 0);
  }
});

test("bounds returned text and rejects thinking/tool-only or transcript error responses", async () => {
  const f = fixture({ getSessionMessages: async () => ({ messages: [{ role: "assistant", content: "x".repeat(20_000) }] }) });
  assert.equal((await f.tool().execute("call", { question: "question" })).details.answer.length, 12_000);
  for (const messages of [[{ role: "assistant", content: [{ type: "thinking", thinking: "secret" }] }], [{ role: "assistant", stopReason: "error", content: "secret" }], [{ role: "assistant", content: "old" }, { role: "user", content: "new turn" }]]) {
    const blank = fixture({ getSessionMessages: async () => ({ messages }) });
    assert.equal((await blank.tool().execute("call", { question: "question" })).details.code, "main_reply_unavailable");
  }
});

test("concurrent identical calls share admission and wait, and unavailable runtime registers nothing", async () => {
  const f = fixture();
  const tool = f.tool();
  const replies = await Promise.all([tool.execute("call", { question: "question" }), tool.execute("call2", { question: "question" })]);
  assert.ok(replies.every((reply) => reply.details.status === "ok"));
  assert.equal(f.calls.run.length, 1);
  assert.equal(f.calls.wait.length, 1);
  let registered = false;
  registerAskMain({ runtime: {}, registerTool: () => { registered = true; } });
  assert.equal(registered, false);
});
