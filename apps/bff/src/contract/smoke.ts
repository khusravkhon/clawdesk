// Contract smoke test against a LIVE OpenClaw Gateway: the RPCs ClawDesk relies on, called the way the
// panel calls them, with the panel's own gateway client. Unit tests use shapes captured from one
// OpenClaw version; this catches a release that changes them.
//
// Runs inside the panel container (it shares the Gateway's loopback, so pairing is silent, as for the
// panel itself) — see deploy/scripts/contract.sh:
//   node dist/contract/smoke.js
// Env: GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, OPENCLAW_EXPECTED_VERSION (deploy/openclaw.version).
//
// A chat turn goes to a stub OpenAI-compatible model served by this script on loopback, so no real
// provider or key is needed. Everything it creates is removed again.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { EventFrame } from "@openclaw/gateway-protocol/frame-guards";
import { strToU8, zipSync } from "fflate";
import { ChatService } from "../chat/chat-service.js";
import { openDb } from "../db/client.js";
import { patchConfig } from "../gateway/config-patch.js";
import { loadOrCreateDeviceIdentity } from "../gateway/device-identity.js";
import { GatewayService, PANEL_OPERATOR_SCOPES } from "../gateway/gateway-service.js";
import { DeviceTokenStore } from "../gateway/token-store.js";
import { createLogger } from "../lib/logger.js";
import { LibraryService } from "../library/library-service.js";
import { MemoryNoteService } from "../library/memory-note-service.js";
import { ReminderService } from "../schedules/reminder-service.js";
import { SpaceService } from "../space/space-service.js";
import { PANEL_VERSION } from "../version.js";
import { telegramSendRequest } from "../telegram/telegram-service.js";

/** The Gateway refusing the call itself, not its delivery: a wrong field, a missing one, no agent named. */
const SHAPE_REFUSED = /invalid .*params|unexpected property|must have required property|no explicit owner|pass agentid/i;

const PROVIDER = "clawdesk-contract";
const MODEL = "echo";
const REPLY = `contract-ok-${randomUUID().slice(0, 8)}`;

type Step = { name: string; ok: boolean; ms: number; error?: string };
const steps: Step[] = [];

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await run();
    steps.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`✓ ${name} (${Date.now() - t0} ms)`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ name, ok: false, ms: Date.now() - t0, error: message });
    console.error(`✗ ${name}: ${message}`);
    throw error;
  }
}

/** OpenAI-compatible chat completions that always answer REPLY (streamed or not). */
function startStubModel(): Promise<{ server: http.Server; port: number; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", owned_by: "clawdesk" }] }));
        return;
      }
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw || "{}") as { stream?: boolean };
      requests.push(body);
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, object: "chat.completion", created, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }], usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (choices: unknown[], extra: object = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL, choices, ...extra })}\n\n`);
      chunk([{ index: 0, delta: { role: "assistant", content: REPLY }, finish_reason: null }]);
      chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage });
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, requests })));
}

const text = (value: unknown) => JSON.stringify(value);

async function main(): Promise<void> {
  const url = process.env.GATEWAY_URL ?? "ws://127.0.0.1:18789";
  const expected = process.env.OPENCLAW_EXPECTED_VERSION?.trim() || null;
  // A device of its own, so the test never touches the panel's pairing.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-contract-"));
  const gateway = new GatewayService({
    url,
    sharedToken: process.env.OPENCLAW_GATEWAY_TOKEN,
    identity: loadOrCreateDeviceIdentity(dataDir),
    tokens: new DeviceTokenStore(dataDir),
    clientVersion: PANEL_VERSION,
    logger: createLogger(process.env.LOG_LEVEL ?? "warn"),
  });
  const stub = await startStubModel();
  let agentId: string | null = null;
  let cronId: string | null = null;

  try {
    await step("connect (silent loopback pairing, operator scopes)", async () => {
      gateway.start();
      await gateway.waitUntilConnected(60_000);
      const hello = gateway.hello!;
      assert.equal(typeof hello.server.version, "string");
      assert.equal(typeof hello.protocol, "number");
      for (const scope of PANEL_OPERATOR_SCOPES) assert.ok(hello.auth.scopes.includes(scope), `scope ${scope} not granted: ${text(hello.auth.scopes)}`);
      console.log(`  OpenClaw ${hello.server.version}, protocol ${hello.protocol}`);
      if (expected) assert.equal(hello.server.version, expected, "the Gateway runs another OpenClaw than deploy/openclaw.version");
    });

    await step("agents.list", async () => {
      const list = await gateway.request<{ defaultId?: string; agents?: { id: string }[] }>("agents.list", {});
      assert.ok(Array.isArray(list.agents), `no agents array: ${text(list)}`);
      assert.equal(typeof list.defaultId, "string");
      assert.ok(list.agents.some((a) => a.id === "main"), "no main agent");
    });

    await step("config.get", async () => {
      const result = await gateway.request<{ hash?: string; config?: unknown }>("config.get", {});
      assert.equal(typeof result.hash, "string", "config.get has no hash (patches need baseHash)");
      assert.equal(typeof result.config, "object");
    });

    await step("config.patch (models.providers, as free models do)", async () => {
      await patchConfig(gateway, {
        models: {
          providers: {
            [PROVIDER]: {
              baseUrl: `http://127.0.0.1:${stub.port}/v1`,
              api: "openai-completions",
              apiKey: "contract-stub",
              models: [{ id: MODEL, name: "Contract echo", contextWindow: 32768, maxTokens: 1024 }],
            },
          },
        },
      }, { note: "ClawDesk contract test" });
      const { config } = await gateway.request<{ config?: { models?: { providers?: Record<string, unknown> } } }>("config.get", {});
      assert.ok(config?.models?.providers?.[PROVIDER], "patched provider not in config");
    });

    await step("plugins.list", async () => {
      const result = await gateway.request<{ plugins?: { id: string; installed?: boolean }[] }>("plugins.list", {});
      assert.ok(Array.isArray(result.plugins) && result.plugins.length > 0, `no plugins: ${text(result).slice(0, 300)}`);
      assert.ok(result.plugins.every((p) => typeof p.id === "string"));
    });

    agentId = await step("agents.create + agents.update (name, model)", async () => {
      const created = await gateway.request<{ agentId: string }>("agents.create", { name: `contract-${randomUUID().slice(0, 6)}` });
      assert.equal(typeof created.agentId, "string");
      await gateway.request("agents.update", { agentId: created.agentId, name: "Contract test", model: `${PROVIDER}/${MODEL}` });
      const list = await gateway.request<{ agents: { id: string; model?: { primary?: string } }[] }>("agents.list", {});
      const agent = list.agents.find((a) => a.id === created.agentId);
      assert.ok(agent, "created agent not listed");
      assert.equal(agent.model?.primary, `${PROVIDER}/${MODEL}`);
      return created.agentId;
    });

    await step("agents.files.set + agents.files.get", async () => {
      const content = `# Contract\n\nAnswer briefly. ${REPLY}\n`;
      await gateway.request("agents.files.set", { agentId, name: "SOUL.md", content });
      const read = await gateway.request<{ file?: { content?: string } }>("agents.files.get", { agentId, name: "SOUL.md" });
      assert.equal(read.file?.content, content);
    });

    cronId = await step("cron.add + cron.list", async () => {
      const job = await gateway.request<{ id: string }>("cron.add", {
        name: `${agentId}:contract-${randomUUID().slice(0, 8)}`,
        displayName: "Contract test",
        agentId,
        enabled: false,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "contract" },
        delivery: { mode: "none" },
      });
      assert.equal(typeof job.id, "string");
      const page = await gateway.request<{ jobs?: { id: string }[]; total?: number; hasMore?: boolean }>("cron.list", { includeDisabled: true, limit: 100, offset: 0, includeDeliveryPreviews: false });
      assert.ok(Array.isArray(page.jobs), `no jobs array: ${text(page).slice(0, 300)}`);
      assert.equal(typeof page.total, "number");
      assert.equal(typeof page.hasMore, "boolean");
      assert.ok(page.jobs.some((j) => j.id === job.id), "added job not listed");
      return job.id;
    });

    await step("cron.remove", async () => {
      await gateway.request("cron.remove", { id: cronId });
      cronId = null;
    });

    await step("chat.send → final reply from the stub model + chat.history", async () => {
      const sessionKey = `agent:${agentId}:main`;
      const final = new Promise<{ state?: string; errorMessage?: string }>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error("no final chat event within 120 s")); }, 120_000);
        const off = gateway.onEvent((event: EventFrame) => {
          const payload = event.payload as { sessionKey?: string; state?: string; errorMessage?: string } | undefined;
          if (event.event !== "chat" || payload?.sessionKey !== sessionKey) return;
          if (["final", "error", "aborted"].includes(payload.state ?? "")) {
            clearTimeout(timer);
            off();
            resolve(payload);
          }
        });
      });
      await gateway.request("chat.send", { sessionKey, agentId, message: "Reply with the word from your SOUL.md.", idempotencyKey: randomUUID() }, { timeoutMs: 60_000 });
      const done = await final;
      assert.equal(done.state, "final", `chat ended ${done.state}: ${done.errorMessage ?? text(done).slice(0, 300)}`);
      assert.ok(stub.requests.length > 0, "the Gateway never called the model");
      const history = await gateway.request<{ messages?: { role: string; content: unknown }[] }>("chat.history", { sessionKey, agentId, limit: 10 });
      assert.ok(Array.isArray(history.messages), "no messages array");
      assert.ok(history.messages.some((m) => m.role === "assistant" && text(m.content).includes(REPLY)), `stub reply not in history: ${text(history.messages).slice(0, 400)}`);
    });

    await step("personal space, named chat with Office attachment, materials, memory and restart", async () => {
      assert.ok(agentId);
      const id = agentId;
      const file = path.join(dataDir, "personal.sqlite");
      const logger = createLogger("warn");
      let opened = openDb(file);
      try {
        const space = new SpaceService({ db: opened.db, logger });
        space.create({ mode: "personal", name: "Contract personal", locale: "en", timezone: "Asia/Dushanbe" });
        const library = new LibraryService(opened.db);
        const chat = new ChatService(gateway, library, opened.db);
        const conversation = await chat.createConversation(id, "Contract document");
        const bytes = zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Fixture document</w:t></w:r></w:p></w:body></w:document>') });
        const files = [{ fileName: "fixture.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const,
          sizeBytes: bytes.length, content: Buffer.from(bytes).toString("base64") }];
        const sendId = randomUUID();
        let off = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const final = new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("topic reply timed out")), 120_000);
          off = chat.subscribe(id, (event) => {
            if (event.runId !== sendId) return;
            if (event.type === "final") resolve();
            if (event.type === "error" || event.type === "aborted") reject(new Error("topic did not finish: " + text(event)));
          }, conversation.id);
        });
        // A rejected send has no terminal event. Ensure its timer and listener always go away.
        void final.catch(() => {});
        try {
          const sent = await chat.send(id, "Read the document.", files, sendId, conversation.id);
          assert.equal(sent.reads[0]?.state, "read");
          await final;
          assert.deepEqual(await chat.send(id, "Read the document.", files, sendId, conversation.id), sent);
          const topic = await chat.history(id, 60, conversation.id, sendId);
          assert.equal(topic.acceptedSend, true);
          assert.ok(topic.messages.some((message) => message.role === "assistant" && message.text.includes(REPLY)));
        } finally { clearTimeout(timer); off(); }
        assert.ok(!(await chat.history(id)).messages.some((message) => message.text.includes("Fixture document")));
        const material = library.recent(id)[0]!;
        assert.equal(library.recent(id).length, 1);
        assert.equal(library.material(material.id)?.text.trim(), "Fixture document");
        const notes = new MemoryNoteService({ db: opened.db, gateway, logger });
        assert.equal((await notes.add(id, { text: "Fixture owner fact" })).applied, true);
        const dueAt = Date.now() + 60_000;
        const reminderDeps = { gateway, telegram: { ownerDelivery: () => null }, mode: () => "personal", now: () => dueAt };
        new ReminderService({ ...reminderDeps, db: opened.db }).create({ requestId: randomUUID(), text: "Fixture reminder", dueAt, timeZone: "Asia/Dushanbe" });
        opened.close();
        opened = openDb(file);
        const restarted = new ReminderService({ ...reminderDeps, db: opened.db });
        restarted.recover();
        await restarted.tick();
        assert.equal(restarted.list().reminders[0]?.reason, "owner_not_connected");
        assert.equal(new MemoryNoteService({ db: opened.db, gateway, logger }).list(id).applied, true);
        assert.equal(new ChatService(gateway, undefined, opened.db).conversations(id)[0]?.id, conversation.id);
      } finally { opened.close(); }
    });

    // The panel's own Telegram calls, in a Gateway with several agents. Telegram is not connected here, so a
    // delivery error is expected; a refusal of the call's shape is not (2026.8.35 broke both, unnoticed).
    await step("send + message.action (Telegram, the panel's params)", async () => {
      const shapes = [
        telegramSendRequest("default", agentId!, { to: "100000001", message: "contract" }, [], randomUUID()),
        telegramSendRequest("default", agentId!, { to: "100000001", message: "contract" }, [{ label: "OK", data: "cdreq:contract", style: "success" }], randomUUID()),
        telegramSendRequest("default", "main", { to: "-1000000000001", threadId: "7", message: "contract" }, [{ label: "OK", data: "cdreq:contract" }], randomUUID()),
      ];
      for (const { method, params } of shapes) {
        const error = await gateway.request(method, params).then(() => null, (failure: Error) => failure.message);
        console.log(`    ${method}${(params as { params?: unknown }).params ? " (buttons)" : ""}: ${error ?? "accepted"}`);
        assert.ok(error === null || !SHAPE_REFUSED.test(error), `${method} refused the panel's call: ${error}`);
      }
    });

    await step("agents.delete", async () => {
      const result = await gateway.request<{ failed?: { path: string; reason: string }[] }>("agents.delete", { agentId, deleteFiles: true });
      assert.deepEqual(result.failed ?? [], [], "deleted agent left files in the Gateway state directory");
      const list = await gateway.request<{ agents: { id: string }[] }>("agents.list", {});
      assert.ok(!list.agents.some((a) => a.id === agentId), "deleted agent still listed");
      agentId = null;
    });
  } finally {
    // Leave the Gateway as it was, even after a failure.
    if (gateway.status.state === "connected") {
      if (cronId) await gateway.request("cron.remove", { id: cronId }).catch(() => undefined);
      if (agentId) await gateway.request("agents.delete", { agentId, deleteFiles: true }).catch(() => undefined);
      await patchConfig(gateway, (config) => ((config as { models?: { providers?: Record<string, unknown> } }).models?.providers?.[PROVIDER] ? { models: { providers: { [PROVIDER]: null } } } : null)).catch(() => undefined);
    }
    await gateway.stop();
    stub.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log(`\nContract OK: ${steps.length} steps against OpenClaw ${process.env.OPENCLAW_EXPECTED_VERSION ?? "(version not pinned)"}`);
} catch {
  console.error(`\nContract FAILED at "${steps.find((s) => !s.ok)?.name ?? "setup"}"`);
  process.exitCode = 1;
}
