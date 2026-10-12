// ClawDesk bridge: the few OpenClaw CLI steps that have no Gateway RPC, for the panel.
//
// Runs inside the Gateway container next to the Gateway (see gateway-start.sh). The panel shares the
// Gateway's network namespace, so loopback is enough; dev publishes it on host loopback only.
// Every request needs the shared Gateway token. Only the commands below exist, arguments are
// validated and passed to the CLI as an argv array (no shell).
//
//   GET  /health
//   GET  /mcp/status?server=notion          → { hasTokens, state }
//   POST /mcp/login/start    { server }     → { authorizationUrl } | { authorized: true }
//   POST /mcp/login/complete { server, code }
//   POST /mcp/logout         { server }

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";

const HOST = process.env.CLAWDESK_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.CLAWDESK_BRIDGE_PORT || 18790);
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const CLI = ["dist/index.js"];
const CLI_CWD = "/app";

const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
// OAuth authorization codes are URL-safe tokens.
const AUTH_CODE = /^[A-Za-z0-9._~\-]{1,2048}$/;

function log(msg, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), component: "clawdesk-bridge", msg, ...extra }));
}

function authorized(req) {
  const header = req.headers.authorization || "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(TOKEN);
  return TOKEN.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

/** Runs the OpenClaw CLI; `until` may end it early once the output has what we need. */
function runCli(args, { timeoutMs = 60_000, until } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...CLI, ...args], { cwd: CLI_CWD, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGTERM");
      resolve({ out, err, ...result });
    };
    const timer = setTimeout(() => finish({ code: null, timedOut: true }), timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (until?.(out)) finish({ code: 0, early: true });
    });
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => finish({ code }));
    child.on("error", (error) => finish({ code: null, err: String(error) }));
  });
}

const tail = (text) => text.trim().split("\n").slice(-3).join("\n").slice(0, 600);

async function mcpStatus(server) {
  const res = await runCli(["mcp", "status", "--json", "-v"], { timeoutMs: 60_000 });
  if (res.code !== 0) return { status: 502, body: { error: "cli_failed", message: tail(res.err || res.out) } };
  const parsed = JSON.parse(res.out.slice(res.out.indexOf("{")));
  const entry = (parsed.servers || []).find((s) => s.name === server);
  if (!entry) return { status: 404, body: { error: "unknown_server", message: `no MCP server "${server}" in config` } };
  return { status: 200, body: { configured: true, hasTokens: !!entry.authStatus?.hasTokens, state: entry.authStatus?.state ?? null } };
}

async function loginStart(server) {
  // The CLI saves the pending authorization, prints the URL and then waits for a loopback callback
  // we do not use (the browser returns to the panel). Stop it once the URL is out.
  const res = await runCli(["mcp", "login", server], { timeoutMs: 60_000, until: (out) => /^https?:\/\/\S+$/m.test(out) || /credentials saved/i.test(out) });
  if (/credentials saved/i.test(res.out)) return { status: 200, body: { authorized: true } };
  const url = res.out.match(/^(https?:\/\/\S+)$/m)?.[1];
  if (!url) return { status: 502, body: { error: "no_authorization_url", message: tail(res.err || res.out) } };
  return { status: 200, body: { authorizationUrl: url } };
}

async function loginComplete(server, code) {
  const res = await runCli(["mcp", "login", server, "--code", code], { timeoutMs: 90_000 });
  if (res.code === 0 && /credentials saved/i.test(res.out)) return { status: 200, body: { ok: true } };
  return { status: 400, body: { error: "login_failed", message: tail(res.err || res.out) } };
}

async function logout(server) {
  const res = await runCli(["mcp", "logout", server], { timeoutMs: 60_000 });
  if (res.code === 0) return { status: 200, body: { ok: true } };
  return { status: 400, body: { error: "logout_failed", message: tail(res.err || res.out) } };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16_384) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function handle(req) {
  const url = new URL(req.url, "http://bridge");
  if (req.method === "GET" && url.pathname === "/health") return { status: 200, body: { ok: true } };
  if (!authorized(req)) return { status: 401, body: { error: "unauthorized", message: "missing or wrong token" } };

  if (req.method === "GET" && url.pathname === "/mcp/status") {
    const server = url.searchParams.get("server") || "";
    if (!SERVER_NAME.test(server)) return { status: 400, body: { error: "invalid_server" } };
    return mcpStatus(server);
  }
  if (req.method !== "POST") return { status: 404, body: { error: "not_found" } };

  const body = await readJson(req);
  const server = typeof body.server === "string" ? body.server : "";
  if (!SERVER_NAME.test(server)) return { status: 400, body: { error: "invalid_server" } };
  switch (url.pathname) {
    case "/mcp/login/start":
      return loginStart(server);
    case "/mcp/login/complete":
      if (typeof body.code !== "string" || !AUTH_CODE.test(body.code)) return { status: 400, body: { error: "invalid_code" } };
      return loginComplete(server, body.code);
    case "/mcp/logout":
      return logout(server);
    default:
      return { status: 404, body: { error: "not_found" } };
  }
}

if (!TOKEN) {
  log("OPENCLAW_GATEWAY_TOKEN is not set; bridge disabled");
} else {
  http
    .createServer(async (req, res) => {
      let result;
      try {
        result = await handle(req);
      } catch (error) {
        result = { status: 400, body: { error: "bad_request", message: String(error?.message ?? error) } };
      }
      if (req.url !== "/health") log("request", { method: req.method, path: new URL(req.url, "http://bridge").pathname, status: result.status });
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    })
    .listen(PORT, HOST, () => log("listening", { host: HOST, port: PORT }));
}
