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
//   POST /freellmapi/reset   { newPassword }   recover FreeLLMAPI's account (code from its log)
//   POST /files/folder       { name }        a junior agent's folder in the shared files folder → { hostPath, gatewayPath }
//   POST /teams/clone        { teamId, repoUrl, token }   project team repository (see clawdesk-teams.mjs)
//   POST /teams/fetch | /teams/push { teamId, … }  GET /teams/status?teamId=…  POST /teams/remove { teamId }
//   GET  /backup/list                       → { backups: [{ name, kind, createdAt, size }] }
//   POST /backup/create      { kind }        daily | manual | before-reset (see clawdesk-backup.mjs)
//   POST /video/study        { jobId, url, maxSeconds, maxDurationSec, maxAudioBytes } → subtitles | audio | { error }
//   POST /video/cancel       { jobId }        stops that job's worker container
//   POST /reset              { ownerCode }   factory reset in a helper container; the stack restarts

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BackupError, createBackup, listBackups, startReset } from "./clawdesk-backup.mjs";
import { cloneTeamRepo, fetchTeamRepo, pushTeamBranch, removeTeamRepo, TeamError, teamRepoStatus } from "./clawdesk-teams.mjs";
import { isAuthorizationCode, mcpLoginArgs } from "./clawdesk-oauth.mjs";
import { AudioSetupError, audioSettings, audioStatus, saveAudioKey, verifyAudioKey } from "./clawdesk-audio.mjs";
import { AgentFolders } from "./clawdesk-agent-folders.mjs";
import { cancelVideo, studyVideo, VideoError } from "./clawdesk-video.mjs";

const HOST = process.env.CLAWDESK_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.CLAWDESK_BRIDGE_PORT || 18790);
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const CLI = ["dist/index.js"];
const CLI_CWD = "/app";

const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
// OAuth authorization codes are opaque provider values, validated by clawdesk-oauth.mjs.

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
function runCli(args, { timeoutMs = 60_000, until, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...CLI, ...args], { cwd: CLI_CWD, env: process.env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
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
  const res = await runCli(mcpLoginArgs(server, code), { timeoutMs: 90_000 });
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

// --- Junior agents' folders
//
// The shared files folder is mounted into the main workspace (deploy/docker-compose.yml). A junior agent gets
// one subfolder bound into its sandbox; the bind needs the folder as the Docker daemon names it, which is the
// source of that mount (on Docker Desktop not the path the person typed).

const FILES_IN_GATEWAY = path.join(process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw", "workspace", "files");
const agentFolders = new AgentFolders({
  stateDir: process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw",
  filesDir: FILES_IN_GATEWAY,
  configPath: process.env.OPENCLAW_CONFIG_PATH || "/var/lib/clawdesk/openclaw/openclaw.json",
  onError: () => log("agent folder sync failed; files retained"),
});
// Same rule as FolderName in packages/shared: ends up in "src:dst:rw" and in paths.
const FOLDER = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;
let filesSource;

async function filesHostSource() {
  if (filesSource) return filesSource;
  const res = await new Promise((resolve) => {
    const child = spawn("docker", ["inspect", process.env.HOSTNAME ?? "", "--format", "{{json .Mounts}}"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => resolve(code === 0 ? out : null));
    child.on("error", () => resolve(null));
  });
  const mount = res ? JSON.parse(res).find((m) => m.Destination === FILES_IN_GATEWAY) : null;
  // Docker Desktop may report the Windows path ("C:/Users/…"); its daemon knows that folder as /run/desktop/mnt/host/c/….
  const source = mount?.Source ?? null;
  const win = source ? /^([A-Za-z]):[\\/](.*)$/.exec(source) : null;
  filesSource = win ? `/run/desktop/mnt/host/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}` : source;
  return filesSource;
}

async function ensureFolder(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!FOLDER.test(name)) return { status: 400, body: { error: "invalid_folder", message: "unsupported folder name" } };
  const source = await filesHostSource();
  if (!source) return { status: 409, body: { error: "no_shared_folder", message: "the shared files folder is not mounted into the Gateway" } };
  await fs.mkdir(path.join(FILES_IN_GATEWAY, name), { recursive: true });
  return { status: 200, body: { hostPath: `${source.replace(/\/$/, "")}/${name}`, gatewayPath: path.join(FILES_IN_GATEWAY, name) } };
}

async function teamCall(run) {
  try {
    return { status: 200, body: await run() };
  } catch (error) {
    if (error instanceof TeamError) return { status: error.status, body: { error: error.code, message: error.message } };
    throw error;
  }
}

// --- FreeLLMAPI account recovery
//
// The panel keeps FreeLLMAPI's single account password in its own volume. If that volume is lost,
// FreeLLMAPI's reset flow is the way back in: it prints a one-time code to its log only. The Gateway
// container can read that log through the Docker socket it already has.

const FREELLMAPI = "http://127.0.0.1:3001"; // shares this network namespace

function runDocker(args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c)); // docker logs writes the container's stderr here
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out });
    });
  });
}

/** The FreeLLMAPI container of this Compose project (it runs in this container's network namespace). */
async function freellmapiContainer() {
  const self = process.env.HOSTNAME ?? "";
  const project = (await runDocker(["inspect", self, "--format", '{{index .Config.Labels "com.docker.compose.project"}}'])).out.trim();
  if (!project) return null;
  const list = await runDocker(["ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=freellmapi", "--format", "{{.Names}}"]);
  return list.out.trim().split("\n")[0] || null;
}

async function freellmapiReset(body) {
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < 16 || newPassword.length > 200) return { status: 400, body: { error: "invalid_password" } };
  const container = await freellmapiContainer();
  if (!container) return { status: 501, body: { error: "freellmapi_missing", message: "FreeLLMAPI container not found" } };
  const since = new Date(Date.now() - 2_000).toISOString();
  const forgot = await fetch(`${FREELLMAPI}/api/auth/forgot-password`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
  if (!forgot?.ok) return { status: 502, body: { error: "reset_failed", message: `forgot-password answered ${forgot?.status ?? "nothing"}` } };
  let code = null;
  for (let i = 0; i < 10 && !code; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const logs = await runDocker(["logs", "--since", since, container]);
    code = [...logs.out.matchAll(/Password-reset code: (\S+)/g)].at(-1)?.[1] ?? null;
  }
  if (!code) return { status: 502, body: { error: "reset_failed", message: "no reset code in the FreeLLMAPI log" } };
  const reset = await fetch(`${FREELLMAPI}/api/auth/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resetCode: code, newPassword }),
  }).catch(() => null);
  if (!reset?.ok) return { status: 502, body: { error: "reset_failed", message: `reset-password answered ${reset?.status ?? "nothing"}` } };
  log("freellmapi password reset");
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

let audioSetupBusy = false;

async function handle(req) {
  const url = new URL(req.url, "http://bridge");
  if (req.method === "GET" && url.pathname === "/health") return { status: 200, body: { ok: true } };
  if (!authorized(req)) return { status: 401, body: { error: "unauthorized", message: "missing or wrong token" } };

  if (req.method === "GET" && url.pathname === "/files/sync-status") {
    try { return { status: 200, body: await agentFolders.statuses() }; }
    catch { return { status: 503, body: { error: "folder_sync_unavailable", message: "folder sync status is unavailable" } }; }
  }

  if (url.pathname === "/telegram/audio") {
    try {
      if (req.method === "GET") return { status: 200, body: await audioStatus(runCli) };
      if (req.method === "POST") {
        if (audioSetupBusy) return { status: 409, body: { error: "audio_setup_busy", message: "speech recognition setup is already in progress" } };
        const body = await readJson(req);
        const selected = audioSettings(body.apiKey, body.provider, body.model);
        audioSetupBusy = true;
        try {
          await verifyAudioKey(body.apiKey, selected.provider, selected.model);
          const cfg = JSON.parse(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
          return { status: 200, body: await saveAudioKey(runCli, body.apiKey, Object.keys(cfg.agents?.entries ?? {}), selected.provider, selected.model) };
        } finally {
          audioSetupBusy = false;
        }
      }
    } catch (error) {
      if (error instanceof AudioSetupError) return { status: error.status, body: { error: error.code, message: error.message } };
      return { status: 502, body: { error: "audio_setup_failed", message: "could not configure speech recognition; the key was not activated" } };
    }
  }

  if (req.method === "GET" && url.pathname === "/telegram/approved") {
    const accountId = url.searchParams.get("accountId") || "default";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountId)) return { status: 400, body: { error: "invalid_account" } };
    const file = path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT entry FROM channel_pairing_allow_entries WHERE channel_key = ? AND account_id = ?").all("telegram", accountId);
      return { status: 200, body: { senderIds: rows.map((row) => row.entry).filter((id) => /^\d+$/.test(id)) } };
    } finally {
      db.close();
    }
  }

  if (req.method === "GET" && url.pathname === "/google/status") return googleStatus();
  if (req.method === "GET" && url.pathname === "/backup/list") return { status: 200, body: { backups: await listBackups() } };
  if (req.method === "GET" && url.pathname === "/teams/status") return teamCall(() => teamRepoStatus({ teamId: url.searchParams.get("teamId") }));
  if (req.method === "GET" && url.pathname === "/mcp/status") {
    const server = url.searchParams.get("server") || "";
    if (!SERVER_NAME.test(server)) return { status: 400, body: { error: "invalid_server" } };
    return mcpStatus(server);
  }
  if (req.method !== "POST") return { status: 404, body: { error: "not_found" } };

  const body = await readJson(req);
  if (!(await gogInstalled()) && url.pathname.startsWith("/google/")) return { status: 501, body: { error: "gog_missing", message: "gog is not in this Gateway image" } };
  if (url.pathname === "/video/study" || url.pathname === "/video/cancel") {
    try {
      const result = url.pathname === "/video/cancel" ? await cancelVideo(body) : await studyVideo(body);
      // Only the reason code travels back; yt-dlp's own output stays in this container.
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof VideoError) return { status: 400, body: { error: error.code, message: error.code } };
      log("studying a video failed", { path: url.pathname });
      return { status: 500, body: { error: "download_failed", message: "download_failed" } };
    }
  }
  if (url.pathname === "/freellmapi/reset") return freellmapiReset(body);
  if (url.pathname === "/files/folder") return ensureFolder(body);
  if (url.pathname === "/files/agent-folder") {
    agentFolders.validate(body);
    const folder = await ensureFolder(body);
    if (folder.status !== 200) return folder;
    const managed = await agentFolders.register(body.agentId, body.name);
    return { status: 200, body: { hostPath: folder.body.hostPath, ...managed } };
  }
  const teamOps = { "/teams/clone": cloneTeamRepo, "/teams/fetch": fetchTeamRepo, "/teams/push": pushTeamBranch, "/teams/remove": removeTeamRepo };
  if (teamOps[url.pathname]) return teamCall(() => teamOps[url.pathname](body));
  if (url.pathname === "/backup/create" || url.pathname === "/reset") {
    try {
      const result = url.pathname === "/reset" ? await startReset(body.ownerCode) : await createBackup(body.kind);
      log(url.pathname === "/reset" ? "factory reset started" : "backup created", url.pathname === "/reset" ? {} : { name: result.name, size: result.size });
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof BackupError) return { status: error.status, body: { error: error.code, message: error.message } };
      throw error;
    }
  }
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
      if (!isAuthorizationCode(body.code)) return { status: 400, body: { error: "invalid_code" } };
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
  const sync = () => agentFolders.syncAll().catch(() => log("agent folder sync failed; files retained"));
  const timer = setInterval(sync, 15000);
  timer.unref();
  void sync();
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
    // A backup of a large workspace takes minutes.
    .setTimeout(20 * 60_000)
    .listen(PORT, HOST, () => log("listening", { host: HOST, port: PORT }));
}
