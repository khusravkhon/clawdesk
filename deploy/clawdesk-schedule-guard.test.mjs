import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { BLOCK_REASON, registerScheduleGuard } from "./plugins/clawdesk-schedule-guard/index.mjs";

function hook() {
  const hooks = {};
  registerScheduleGuard({ on: (name, handler) => { hooks[name] = handler; } });
  return hooks.before_tool_call;
}

test("manifest matches the plugin id and takes no settings", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("./plugins/clawdesk-schedule-guard/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "clawdesk-schedule-guard");
  assert.equal(manifest.configSchema.additionalProperties, false);
});

test("a scheduled run cannot send a message itself; its reply is delivered once", () => {
  const guard = hook();
  const send = { toolName: "message", params: { action: "send", target: "telegram:-1004392187934:topic:2", message: "Пора" } };
  assert.deepEqual(guard(send, { sessionKey: "agent:agent:cron:40944e26:run:f69432cb" }), { block: true, blockReason: BLOCK_REASON });
  assert.deepEqual(guard(send, { sessionKey: "agent:main:main", trigger: "cron" }), { block: true, blockReason: BLOCK_REASON });
});

test("chats and other tools are untouched", () => {
  const guard = hook();
  assert.equal(guard({ toolName: "message", params: { action: "send" } }, { sessionKey: "agent:agent:telegram:group:-1004392187934:topic:2" }), undefined);
  assert.equal(guard({ toolName: "message", params: { action: "send" } }, { sessionKey: "agent:main:main", trigger: "user" }), undefined);
  assert.equal(guard({ toolName: "read", params: {} }, { sessionKey: "agent:trainer:cron:x:run:y" }), undefined);
  assert.equal(guard({ toolName: "message" }, {}), undefined);
});
