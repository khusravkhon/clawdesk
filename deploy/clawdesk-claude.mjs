// Claude subscription sign-in for OpenClaw's "Claude CLI" route.
//
// Anthropic allows a Claude plan only through its own Claude Code (Agent SDK), so the Gateway image
// carries Claude Code and the person signs in to it here: `claude auth login` prints a link, the
// person signs in on claude.com, the page shows a code, and the code is typed into the waiting
// process. Claude Code keeps the login in CLAUDE_CONFIG_DIR (inside OpenClaw's state, so it survives
// restarts and goes into backups); OpenClaw never reads those tokens itself.

import { spawn as nodeSpawn } from "node:child_process";
import { isAuthorizationCode } from "./clawdesk-oauth.mjs";

const LOGIN_URL = /(https:\/\/\S+\/oauth\/authorize\?\S+)/;
const PENDING_MS = 15 * 60_000;

export class ClaudeLoginError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Last lines of Claude Code's output, without links (they carry the one-time PKCE state). */
function tail(text) {
  return text.replace(/https:\/\/\S+/g, "<link>").trim().split("\n").slice(-2).join("\n").slice(0, 300);
}

export class ClaudeLogin {
  #pending = null;

  constructor({ command = "claude", spawn = nodeSpawn, env = process.env } = {}) {
    this.command = command;
    this.spawn = spawn;
    this.env = env;
  }

  #run(args, timeoutMs = 30_000) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawn(this.command, args, { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolve({ code: null, out: "", err: "spawn failed" });
        return;
      }
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, out, err: String(e) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
  }

  /** `claude auth status` exits 1 when signed out, but still prints its JSON. */
  async status() {
    const res = await this.#run(["auth", "status", "--json"]);
    const start = res.out.indexOf("{");
    if (start < 0) {
      if (res.code === null) return { installed: false, loggedIn: false, subscription: null };
      throw new ClaudeLoginError(502, "status_failed", tail(res.err || res.out) || "claude auth status failed");
    }
    const parsed = JSON.parse(res.out.slice(start));
    return {
      installed: true,
      loggedIn: parsed.loggedIn === true,
      // claude.ai = a Claude plan; console = API billing through an Anthropic Console account.
      method: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscription: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
    };
  }

  /** Starts a login and returns its link; the process waits for the code the page shows. */
  start() {
    this.#cancelPending();
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(this.command, ["auth", "login", "--claudeai"], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        reject(new ClaudeLoginError(501, "claude_missing", "Claude Code is not in this Gateway image"));
        return;
      }
      const pending = { child, out: "", url: null, closed: null, timer: null };
      this.#pending = pending;
      pending.timer = setTimeout(() => this.#cancelPending(pending), PENDING_MS);
      pending.timer.unref?.();
      child.stdin.on("error", () => {});
      const onData = (chunk) => {
        pending.out += chunk;
        if (pending.url) return;
        const url = pending.out.match(LOGIN_URL)?.[1];
        if (url) {
          pending.url = url;
          resolve({ authorizationUrl: url });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      pending.closed = new Promise((done) => {
        child.on("error", () => done(null));
        child.on("close", (code) => done(code));
      });
      void pending.closed.then((code) => {
        if (this.#pending === pending) {
          clearTimeout(pending.timer);
          if (!pending.url) this.#pending = null;
        }
        if (!pending.url) reject(new ClaudeLoginError(502, "no_authorization_url", tail(pending.out) || `claude exited with ${code}`));
      });
    });
  }

  /** Types the code into the waiting login and reports whether Claude Code accepted it. */
  async complete(code) {
    if (!isAuthorizationCode(code)) throw new ClaudeLoginError(400, "invalid_code", "invalid code");
    const pending = this.#pending;
    if (!pending || pending.child.exitCode !== null) {
      this.#pending = null;
      throw new ClaudeLoginError(409, "not_started", "the sign-in expired; start it again");
    }
    const before = pending.out.length;
    pending.child.stdin.write(`${code.trim()}\n`);
    let answerTimer;
    const exit = await Promise.race([pending.closed, new Promise((done) => (answerTimer = setTimeout(() => done("timeout"), 90_000)))]);
    clearTimeout(answerTimer);
    clearTimeout(pending.timer);
    this.#pending = null;
    if (exit === "timeout") {
      pending.child.kill("SIGTERM");
      throw new ClaudeLoginError(504, "login_timeout", "Claude did not answer");
    }
    if (exit !== 0) throw new ClaudeLoginError(400, "login_failed", tail(pending.out.slice(before)) || "the code was not accepted");
    const status = await this.status();
    if (!status.loggedIn) throw new ClaudeLoginError(400, "login_failed", "Claude Code is still signed out");
    return status;
  }

  async logout() {
    this.#cancelPending();
    const res = await this.#run(["auth", "logout"]);
    if (res.code !== 0) throw new ClaudeLoginError(502, "logout_failed", tail(res.err || res.out) || "claude auth logout failed");
    return { ok: true };
  }

  #cancelPending(only) {
    const pending = this.#pending;
    if (!pending || (only && only !== pending)) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    if (pending.child.exitCode === null) pending.child.kill("SIGTERM");
  }
}
