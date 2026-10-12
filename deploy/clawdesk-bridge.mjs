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
//   GET  /google/status                     → { installed, clients, accounts }
//   POST /google/credentials { json }       client_secret JSON of the person's own OAuth client
//   POST /google/login/start { email, services, readonly, redirectUri? } → { authorizationUrl }
//   POST /google/login/complete { …same, authUrl }
//   POST /google/remove      { email }

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

// --- Google (gog CLI for OpenClaw's bundled gog skill)

const GOG = "/usr/local/bin/gog";
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;
const GOOGLE_SERVICES = new Set(["gmail", "drive", "docs", "sheets", "calendar"]);
// Where Google sends the browser back to: the panel on loopback, or gog's own loopback default.
const REDIRECT = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[A-Za-z0-9/_.-]*$/;
const AUTH_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/\S{1,3900}$/;

/** Runs gog with argv only; `input` goes to stdin (client JSON never touches the disk unencrypted). */
function runGog(args, { input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(GOG, [...args, "--no-input", "--color", "never"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: String(e) });
    });
    child.stdin.end(input ?? "");
  });
}

const parseJson = (text) => {
  const i = text.indexOf("{");
  return i < 0 ? null : JSON.parse(text.slice(i));
};

function googleLoginArgs(body) {
  if (typeof body.email !== "string" || !EMAIL.test(body.email)) return { error: "invalid_email" };
  const services = Array.isArray(body.services) ? body.services : [];
  if (!services.length || !services.every((s) => GOOGLE_SERVICES.has(s))) return { error: "invalid_services" };
  if (body.redirectUri !== undefined && (typeof body.redirectUri !== "string" || !REDIRECT.test(body.redirectUri))) return { error: "invalid_redirect" };
  const args = ["auth", "add", body.email, "--services", services.join(","), "--remote", "--force-consent"];
  if (body.readonly !== false) args.push("--readonly");
  if (body.redirectUri) args.push("--redirect-uri", body.redirectUri);
  return { args };
}

async function googleStatus() {
  if (!(await gogInstalled())) return { status: 200, body: { installed: false, clients: [], accounts: [] } };
  const [clients, accounts] = await Promise.all([runGog(["auth", "credentials", "list", "--json"]), runGog(["auth", "list", "--json"])]);
  if (clients.code !== 0 || accounts.code !== 0) return { status: 502, body: { error: "gog_failed", message: tail(clients.err || accounts.err) } };
  return { status: 200, body: { installed: true, clients: parseJson(clients.out)?.clients ?? [], accounts: parseJson(accounts.out)?.accounts ?? [] } };
}

let gogPresent = null;
async function gogInstalled() {
  if (gogPresent === null) gogPresent = (await runGog(["--version"], { timeoutMs: 10_000 })).code === 0;
  return gogPresent;
}

async function googleCredentials(body) {
  let parsed;
  try {
    parsed = JSON.parse(String(body.json ?? ""));
  } catch {
    return { status: 400, body: { error: "invalid_client_json", message: "not JSON" } };
  }
  const c = parsed?.installed ?? parsed?.web;
  if (!c || typeof c.client_id !== "string" || typeof c.client_secret !== "string") {
    return { status: 400, body: { error: "invalid_client_json", message: "expected the client_secret JSON of an OAuth client" } };
  }
  // Only the fields an OAuth client needs; anything else in the upload is dropped.
  const kind = parsed.installed ? "installed" : "web";
  const clean = { [kind]: { client_id: c.client_id, client_secret: c.client_secret, project_id: c.project_id, auth_uri: c.auth_uri, token_uri: c.token_uri, redirect_uris: c.redirect_uris } };
  const res = await runGog(["auth", "credentials", "set", "-"], { input: JSON.stringify(clean) });
  if (res.code !== 0) return { status: 400, body: { error: "gog_failed", message: tail(res.err || res.out) } };
  return { status: 200, body: { ok: true, clientId: c.client_id, kind } };
}

async function googleLoginStart(body) {
  const { args, error } = googleLoginArgs(body);
  if (error) return { status: 400, body: { error } };
  const res = await runGog([...args, "--step", "1", "--json"]);
  const url = res.code === 0 ? parseJson(res.out)?.auth_url : null;
  if (!url) return { status: 502, body: { error: "gog_failed", message: tail(res.err || res.out) } };
  return { status: 200, body: { authorizationUrl: url } };
}

async function googleLoginComplete(body) {
  const { args, error } = googleLoginArgs(body);
  if (error) return { status: 400, body: { error } };
  if (typeof body.authUrl !== "string" || !AUTH_URL.test(body.authUrl)) return { status: 400, body: { error: "invalid_auth_url" } };
  const res = await runGog([...args, "--step", "2", "--auth-url", body.authUrl, "--json"], { timeoutMs: 90_000 });
  if (res.code !== 0) return { status: 400, body: { error: "login_failed", message: tail(res.err || res.out) } };
  return { status: 200, body: { ok: true } };
}

async function googleRemove(body) {
  if (typeof body.email !== "string" || !EMAIL.test(body.email)) return { status: 400, body: { error: "invalid_email" } };
  const res = await runGog(["auth", "remove", body.email, "--force"]);
  if (res.code !== 0) return { status: 400, body: { error: "gog_failed", message: tail(res.err || res.out) } };
  return { status: 200, body: { ok: true } };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 32_768) reject(new Error("body too large"));
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

  if (req.method === "GET" && url.pathname === "/google/status") return googleStatus();
  if (req.method === "GET" && url.pathname === "/mcp/status") {
    const server = url.searchParams.get("server") || "";
    if (!SERVER_NAME.test(server)) return { status: 400, body: { error: "invalid_server" } };
    return mcpStatus(server);
  }
  if (req.method !== "POST") return { status: 404, body: { error: "not_found" } };

  const body = await readJson(req);
  if (!(await gogInstalled()) && url.pathname.startsWith("/google/")) return { status: 501, body: { error: "gog_missing", message: "gog is not in this Gateway image" } };
  switch (url.pathname) {
    case "/google/credentials":
      return googleCredentials(body);
    case "/google/login/start":
      return googleLoginStart(body);
    case "/google/login/complete":
      return googleLoginComplete(body);
    case "/google/remove":
      return googleRemove(body);
  }
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
