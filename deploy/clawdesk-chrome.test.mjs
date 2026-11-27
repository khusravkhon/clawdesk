import assert from "node:assert/strict";
import { test } from "node:test";
import { ChromeError, chromePair, chromeStatus } from "./clawdesk-chrome.mjs";

const cli = (out, code = 0) => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { code, out }; };
  return { run, calls };
};

test("status tells a connected extension from a waiting one", async () => {
  assert.deepEqual(await chromeStatus(cli('warning line\n{"enabled":true,"running":true}').run), { enabled: true, connected: true });
  assert.deepEqual(await chromeStatus(cli('{"enabled":true,"running":false}').run), { enabled: true, connected: false });
  await assert.rejects(chromeStatus(cli("", 1).run), ChromeError);
  await assert.rejects(chromeStatus(cli("not json").run), ChromeError);
});

test("pairing asks OpenClaw for the panel's address only", async () => {
  const ok = cli('{"pairingString":"secret","relayPort":18799,"remote":true}');
  assert.deepEqual(await chromePair(ok.run, "wss://panel.example.com"), { pairingString: "secret" });
  assert.deepEqual(ok.calls[0], ["browser", "extension", "pair", "--gateway-url", "wss://panel.example.com", "--json"]);
  await chromePair(ok.run, "ws://127.0.0.1:18080");

  for (const bad of ["https://panel.example.com", "wss://panel.example.com/path", "wss://a b", "wss://x --token y", "", undefined]) {
    await assert.rejects(chromePair(ok.run, bad), { message: "invalid_address" });
  }
  assert.equal(ok.calls.length, 2);
  await assert.rejects(chromePair(cli("{}").run, "wss://panel.example.com"), { message: "chrome_unavailable" });
});
