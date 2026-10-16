import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIO_PROFILE, AUDIO_PROVIDERS, audioSettings, audioStatus, normalAuthOrder, saveAudioKey, verifyAudioKey } from "./clawdesk-audio.mjs";

test("audio credentials never enter the normal inference order", () => {
  assert.deepEqual(normalAuthOrder(null, [{ id: "openai:oauth" }, { id: AUDIO_PROFILE }]), ["openai:oauth"]);
  assert.deepEqual(normalAuthOrder(["openai:second", AUDIO_PROFILE, "openai:first"], []), ["openai:second", "openai:first"]);
});

test("API key travels through stdin, after normal inference is pinned, for each agent", async () => {
  const calls = [];
  const key = "sk-test012345678901234567890";
  const run = async (args, opts) => {
    calls.push({ args, opts });
    if (args.includes("list")) return { code: 0, out: JSON.stringify({ profiles: [{ id: "openai:oauth", type: "oauth" }] }) };
    if (args.includes("get")) return { code: 0, out: '{"order":null}' };
    return { code: 0, out: "ok" };
  };
  await saveAudioKey(run, key, ["main", "junior"]);
  const saved = calls.filter((c) => c.args.includes("paste-api-key"));
  assert.equal(saved.length, 2);
  for (const call of saved) {
    assert.equal(call.opts.input, `${key}\n`);
    assert.ok(!call.args.includes(key));
    const index = calls.indexOf(call);
    assert.ok(calls[index - 1].args.includes("set"));
    assert.ok(!calls[index - 1].args.includes(AUDIO_PROFILE));
  }
});

test("fails before saving if the normal auth order cannot be protected", async () => {
  const calls = [];
  await assert.rejects(saveAudioKey(async (args) => {
    calls.push(args);
    if (args.includes("list")) return { code: 0, out: '{"profiles":[{"id":"openai:oauth"}]}' };
    if (args.includes("get")) return { code: 0, out: '{"order":null}' };
    return { code: 1 };
  }, "sk-test012345678901234567890", []), /authentication order/);
  assert.ok(!calls.some((args) => args.includes("paste-api-key")));
});

test("status exposes only whether the dedicated API key exists", async () => {
  assert.deepEqual(await audioStatus(async () => ({ code: 0, out: JSON.stringify({ profiles: [{ id: AUDIO_PROFILE, type: "api_key" }] }) })), { configured: true, providers: { openai: true, groq: false } });
  assert.deepEqual(await audioStatus(async () => ({ code: 0, out: '{"profiles":[]}' })), { configured: false, providers: { openai: false, groq: false } });
});

test("Groq keys use an isolated compatible profile, never the normal inference order or command arguments", async () => {
  const key = "gsk_test012345678901234567890";
  const profile = AUDIO_PROVIDERS.groq.profile;
  const calls = [];
  await saveAudioKey(async (args, opts) => {
    calls.push({ args, opts });
    assert.equal(args[args.indexOf("--provider") + 1], "groq");
    if (args.includes("list")) return { code: 0, out: JSON.stringify({ profiles: [{ id: "groq:text" }, { id: profile }] }) };
    if (args.includes("get")) return { code: 0, out: '{"order":null}' };
    return { code: 0, out: "ok" };
  }, key, ["trainer"], "groq", "whisper-large-v3-turbo");
  assert.equal(calls.filter((call) => call.args.includes("paste-api-key")).length, 2);
  for (const call of calls.filter((item) => item.args.includes("paste-api-key"))) {
    assert.ok(call.args.includes(profile)); assert.equal(call.opts.input, `${key}\n`); assert.ok(!call.args.includes(key));
  }
  for (const call of calls.filter((item) => item.args.includes("set"))) assert.deepEqual(call.args.slice(-1), ["groq:text"]);
});

test("validates keys only against the selected fixed endpoint without redirects or a paid transcription request", async () => {
  const key = "gsk_test012345678901234567890";
  await verifyAudioKey(key, "groq", "whisper-large-v3", async (url, options) => {
    assert.equal(url, "https://api.groq.com/openai/v1/models");
    assert.equal(options.headers.authorization, `Bearer ${key}`);
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ data: [{ id: "whisper-large-v3" }] }));
  });
  assert.throws(() => audioSettings(key, "openai"), /does not match/);
  assert.throws(() => audioSettings(key, "https://attacker.example"), /does not match/);
  assert.throws(() => audioSettings(key, "groq", "gpt-4o-mini-transcribe"), /not supported/);
});

test("returns safe actionable errors for invalid keys, unavailable models, quota and network failures", async () => {
  const key = "gsk_test012345678901234567890";
  for (const [status, code] of [[401, "audio_key_rejected"], [403, "audio_key_rejected"], [429, "audio_rate_limit"], [500, "audio_unreachable"]]) {
    await assert.rejects(verifyAudioKey(key, "groq", undefined, async () => new Response("do not expose provider body", { status })), (error) => error.code === code && !error.message.includes(key) && !error.message.includes("provider body"));
  }
  await assert.rejects(verifyAudioKey(key, "groq", undefined, async () => new Response('{"data":[]}')), (error) => error.code === "audio_model_unavailable");
  await assert.rejects(verifyAudioKey(key, "groq", undefined, async () => { throw new Error(key); }), (error) => error.code === "audio_unreachable" && !error.message.includes(key));
});
