import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ClaudeLogin, ClaudeLoginError } from "./clawdesk-claude.mjs";

const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s";

/** A fake `claude` process; `script` decides what it prints and how it ends. */
function fakeSpawn(script) {
  const calls = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => end(143);
    const end = (code) => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      setImmediate(() => child.emit("close", code));
    };
    child.stdin.on("data", (chunk) => script.onInput?.(String(chunk), child, end));
    calls.push({ command, args, child });
    setImmediate(() => script.run(args, child, end));
    return child;
  };
  return { spawn, calls };
}

const statusJson = (loggedIn) => JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", subscriptionType: loggedIn ? "max" : undefined });

test("status reads the JSON even when claude exits 1 (signed out)", async () => {
  const { spawn } = fakeSpawn({ run: (_a, child, end) => { child.stdout.write(statusJson(false)); end(1); } });
  assert.deepEqual(await new ClaudeLogin({ spawn }).status(), { installed: true, loggedIn: false, method: "none", subscription: null, email: null });
});

test("login: link out, code typed into the waiting process, then signed in", async () => {
  let signedIn = false;
  const { spawn, calls } = fakeSpawn({
    run: (args, child, end) => {
      if (args[1] === "status") { child.stdout.write(statusJson(signedIn)); end(signedIn ? 0 : 1); return; }
      child.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${LINK}\nPaste code here if prompted > `);
    },
    onInput: (text, child, end) => {
      assert.equal(text, "abc#state\n");
      signedIn = true;
      child.stdout.write("Login successful\n");
      end(0);
    },
  });
  const login = new ClaudeLogin({ spawn });
  assert.deepEqual(await login.start(), { authorizationUrl: LINK });
  assert.deepEqual(calls[0].args, ["auth", "login", "--claudeai"]);
  const status = await login.complete("  abc#state ");
  assert.equal(status.loggedIn, true);
  assert.equal(status.subscription, "max");
});

test("a rejected code reports the reason without the link", async () => {
  const { spawn } = fakeSpawn({
    run: (_a, child) => child.stdout.write(`visit: ${LINK}\nPaste code here if prompted > `),
    onInput: (_t, child, end) => { child.stdout.write(`Login failed: Request failed with status code 400 (${LINK})\n`); end(1); },
  });
  const login = new ClaudeLogin({ spawn });
  await login.start();
  await assert.rejects(login.complete("bad"), (e) => e instanceof ClaudeLoginError && e.code === "login_failed" && !e.message.includes("https://"));
  // The finished attempt is gone: another code needs a new sign-in.
  await assert.rejects(login.complete("again"), (e) => e.code === "not_started");
});

test("a new start ends the previous waiting login", async () => {
  const { spawn, calls } = fakeSpawn({ run: (_a, child) => child.stdout.write(`visit: ${LINK}\n`) });
  const login = new ClaudeLogin({ spawn });
  await login.start();
  await login.start();
  assert.equal(calls[0].child.exitCode, 143);
  assert.equal(calls[1].child.exitCode, null);
});

test("codes with line breaks or control characters never reach the process", async () => {
  const { spawn } = fakeSpawn({ run: (_a, child) => child.stdout.write(`visit: ${LINK}\n`), onInput: () => assert.fail("written") });
  const login = new ClaudeLogin({ spawn });
  await login.start();
  for (const code of ["a\nb", "", "a\x00"]) await assert.rejects(login.complete(code), (e) => e.code === "invalid_code");
});

test("no link and an exit means the login could not start", async () => {
  const { spawn } = fakeSpawn({ run: (_a, child, end) => { child.stderr.write("network down"); end(1); } });
  await assert.rejects(new ClaudeLogin({ spawn }).start(), (e) => e.code === "no_authorization_url" && /network down/.test(e.message));
});
