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
//   GET  /claude/status                     → { installed, loggedIn, method, subscription, email }
//   POST /claude/login/start                → { authorizationUrl }  (Claude plan sign-in, see clawdesk-claude.mjs)
//   POST /claude/login/complete { code }    → status after the code was accepted
//   POST /claude/logout
//   POST /skills/remove      { dir }         a skill folder of one agent (see clawdesk-skills.mjs)
//   GET  /google/status                     → { installed, clients, accounts }
//   POST /google/credentials { json }       client_secret JSON of the person's own OAuth client
//   POST /google/login/start { email, services, readonly, redirectUri? } → { authorizationUrl }
//   POST /google/login/complete { …same, authUrl }
//   POST /google/remove      { email }
//   GET  /capabilities                      → { openclaw, docker, git, gog } versions, null when missing (P0)
//   POST /google/doc/copy    { agentId, docId, account }  one Doc as a read-only copy in the agent's workspace (stage 7)
//   POST /google/doc/remove  { agentId, docId }   POST /google/doc/list { agentId } → { copies: [{ docId, sha }] }
//   POST /freellmapi/reset   { newPassword }   recover FreeLLMAPI's account (code from its log)
//   POST /files/folder       { name }        a junior agent's folder in the shared files folder → { hostPath, gatewayPath }
//   POST /teams/clone        { teamId, repoUrl, token }   project team repository (see clawdesk-teams.mjs)
//   POST /teams/member { teamId, agentId, role }  a member's copy at <its workspace>/repo
//   POST /teams/fetch | /teams/push { teamId, … }  GET /teams/status?teamId=…&developer=…  POST /teams/remove { teamId }
//   GET  /backup/list                       → { backups: [{ name, kind, createdAt, size }] }
//   POST /backup/create      { kind }        daily | manual | before-reset | before-update (see clawdesk-backup.mjs)
//   POST /backup/delete      { name, confirm: true }   delete one completed archive
//   POST /video/study        { jobId, url, maxSeconds, maxDurationSec, maxAudioBytes } → subtitles | audio | { error }
//   POST /video/frames       { jobId, url, maxFrames, maxFrameBytes, … }  → sampled frames | { error }
//   POST /video/download     { jobId, url, maxFileBytes, … }  → the kept original | { error }
//   GET  /video/progress?jobId=…             → { percent } while a download runs
//   POST /video/cancel       { jobId }        stops that job's worker container
//   POST /reset              { ownerCode }   factory reset in a helper container; the stack restarts
//   GET  /openclaw/update                   → { running, supported, offer, status } (see clawdesk-openclaw-update.mjs)
//   POST /requests/result { id, text }   POST /requests/result/take { id } → { existed }  the panel's answer to a waiting tool call
//   GET  /owner-files/list                  → { files: [{ path, size, modifiedAt }] } the shared folder (see clawdesk-owner-files.mjs)
//   POST /owner-files/store  { inbound, name? }  a file sent to the bot/chat (media://inbound) into «Входящие» → { path, size, sha }
//   POST /owner-files/upload { name, base64 }    a file uploaded in the panel into «Входящие»
//   POST /owner-files/copy | /owner-files/remove { agentId, file }   POST /owner-files/copies { agentId } → { copies: [{ file, sha }] }
//   GET  /library/inbound?after=<ms>        → { files: [{ id, name, mimeType, size, modifiedAt, agentIds }], more } documents sent to the bot
//   POST /library/inbound/read { id }       → { id, mimeType, base64 } one of them (see clawdesk-library-inbound.mjs)
//   POST /openclaw/update    { version }    backup, then a helper container moves the Gateway to that verified OpenClaw

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BackupError, createBackup, deleteBackup, listBackups, resetGateway, startReset } from "./clawdesk-backup.mjs";
import { OpenClawUpdateError, startUpdate as startOpenClawUpdate, updateInfo as openclawUpdateInfo } from "./clawdesk-openclaw-update.mjs";
import { cloneTeamRepo, fetchTeamRepo, prepareMemberRepo, pushTeamBranch, removeTeamRepo, TeamError, teamRepoStatus } from "./clawdesk-teams.mjs";
import { isAuthorizationCode, mcpLoginArgs } from "./clawdesk-oauth.mjs";
import { AudioSetupError, audioSettings, audioStatus, saveAudioKey, verifyAudioKey } from "./clawdesk-audio.mjs";
import { AgentFolders } from "./clawdesk-agent-folders.mjs";
import { ackRequestsSpool, readRequestsSpool, requestsSpoolDir, takeRequestResult, writeRequestResult } from "./clawdesk-requests-spool.mjs";
import { ProjectGitHub } from "./clawdesk-project-github.mjs";
import { directoryIdentityWithin } from "./clawdesk-file-sync.mjs";
import { ClaudeLogin, ClaudeLoginError } from "./clawdesk-claude.mjs";
import { removeWorkspaceSkill, SkillRemoveError } from "./clawdesk-skills.mjs";
import { cancelVideo, downloadVideo, framesOfVideo, studyVideo, videoProgress, VideoError } from "./clawdesk-video.mjs";
import { LocalMemory, MemoryError } from "./clawdesk-memory.mjs";
import { StorageManager, StorageError } from "./clawdesk-storage.mjs";
import { ProjectFolders, ProjectFolderError } from "./clawdesk-project-folders.mjs";
import { ProjectBuilder } from "./clawdesk-project-builder.mjs";
import { ProjectWork } from "./clawdesk-project-work.mjs";
import { GoogleDocCopies } from "./clawdesk-google-docs.mjs";
import { OwnerFiles } from "./clawdesk-owner-files.mjs";
import { listInboundDocuments, readInboundDocument } from "./clawdesk-library-inbound.mjs";
import { ProjectTransfer } from "./clawdesk-project-transfer.mjs";
import { capabilities } from "./clawdesk-capabilities.mjs";
import { sharedFolderSource } from "./clawdesk-shared-folder.mjs";
import { composeServiceContainer } from "./clawdesk-containers.mjs";

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
function runCli(args, { timeoutMs = 60_000, until, input, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...CLI, ...args], { cwd: CLI_CWD, env: env ? { ...process.env, ...env } : process.env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
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
const projectFolders = new ProjectFolders({ stateDir: process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw" });
const projectWork = new ProjectWork({ stateDir: process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw", configPath: process.env.OPENCLAW_CONFIG_PATH || "/var/lib/clawdesk/openclaw/openclaw.json" });
const projectTransfer = new ProjectTransfer({ folders: projectFolders });
const ownerFiles = new OwnerFiles({ stateDir: process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw", configPath: process.env.OPENCLAW_CONFIG_PATH || "/var/lib/clawdesk/openclaw/openclaw.json" });
const googleDocs = new GoogleDocCopies({ stateDir: process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw", configPath: process.env.OPENCLAW_CONFIG_PATH || "/var/lib/clawdesk/openclaw/openclaw.json", gog: (args) => runGog(args, { timeoutMs: 90_000 }) });
const projectGitHub = new ProjectGitHub({ folders: projectFolders, stateDir: process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw" });
const projectBuilder = new ProjectBuilder({ folders: projectFolders, stateDir: process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw" });
function spaceMode() {
  let db;
  try {
    db = new DatabaseSync("/var/lib/clawdesk-sources/panel/panel.sqlite", { readOnly: true });
    const mode = db.prepare("SELECT mode FROM spaces WHERE id = 'default'").get()?.mode ?? "personal";
    return ["personal", "company"].includes(mode) ? mode : null;
  } catch { return null; }
  finally { db?.close(); }
}
const personalMode = () => spaceMode() === "personal";
const agentFolders = new AgentFolders({
  stateDir: process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw",
  filesDir: FILES_IN_GATEWAY,
  configPath: process.env.OPENCLAW_CONFIG_PATH || "/var/lib/clawdesk/openclaw/openclaw.json",
  onError: () => log("agent folder sync failed; files retained"),
  metadataCacheEnabled: personalMode,
});
// Same rule as FolderName in packages/shared: ends up in "src:dst:rw" and in paths.
const FOLDER = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;
let filesSource;

async function filesHostSource() {
  if (filesSource) return filesSource;
  filesSource = await sharedFolderSource();
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
  return composeServiceContainer(async (args) => {
    const result = await runDocker(args);
    if (result.code !== 0) throw new BackupError("docker_failed", "Cannot identify this installation's containers", 502);
    return result.out;
  }, "freellmapi");
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

/** A JSON body; most routes take small ones, project files (checks, work copies, transfer) larger. */
/** Owner files: only the reason code travels back. */
async function ownerFileCall(run) {
  try { return { status: 200, body: await run() }; }
  catch (error) {
    if (error instanceof ProjectFolderError) return { status: error.status, body: { error: error.code, message: error.code } };
    if (error?.code === "ENOENT") return { status: 404, body: { error: "file_missing", message: "file_missing" } };
    throw error;
  }
}

function readJson(req, limit = 32_768) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) reject(new Error("body too large"));
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
const claudeLogin = new ClaudeLogin();
const localMemory = new LocalMemory({ runCli, log });
const storage = new StorageManager({
  stateDir: process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw",
  videoDir: process.env.CLAWDESK_VIDEO_DIR || "",
  activeWorkers: () => new Promise((resolve, reject) => {
    const child = spawn("/usr/local/libexec/docker", ["ps", "--filter", "name=clawdesk-video-", "--format", "{{.Names}}"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new StorageError("storage_unavailable", 503)); }, 5_000);
    child.stdout.on("data", (chunk) => { if (out.length < 64 * 1024) out += chunk; else child.kill("SIGKILL"); });
    child.once("error", () => { clearTimeout(timer); reject(new StorageError("storage_unavailable", 503)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new StorageError("storage_unavailable", 503));
      resolve(out.trim().split("\n").filter((name) => /^clawdesk-video-[0-9a-f-]{36}$/.test(name)).map((name) => name.slice("clawdesk-video-".length)));
    });
  }),
  historyRoots: async () => {
    const registry = await agentFolders.load();
    const config = JSON.parse(await fs.readFile(agentFolders.configPath, "utf8"));
    const roots = [];
    for (const item of registry.folders) {
      const workspace = config.agents?.entries?.[item.agentId]?.workspace;
      if (!workspace) continue;
      const relative = path.relative(agentFolders.stateDir, path.resolve(workspace));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new StorageError("storage_unavailable", 503);
      if (!item.workspaceIdentity || await directoryIdentityWithin(agentFolders.stateDir, relative.split(path.sep).join("/")) !== item.workspaceIdentity) throw new StorageError("storage_unavailable", 503);
      roots.push(path.join(FILES_IN_GATEWAY, item.name), path.join(agentFolders.stateDir, relative, AgentFolders.workspaceDir(item)));
    }
    return roots;
  },
});

async function claudeCall(fn) {
  try {
    return { status: 200, body: await fn() };
  } catch (error) {
    if (error instanceof ClaudeLoginError) return { status: error.status, body: { error: error.code, message: error.message } };
    throw error;
  }
}

async function handle(req) {
  const url = new URL(req.url, "http://bridge");
  if (req.method === "GET" && url.pathname === "/health") return { status: 200, body: { ok: true } };
  if (!authorized(req)) return { status: 401, body: { error: "unauthorized", message: "missing or wrong token" } };
  if (url.pathname.startsWith("/projects/builder")) {
    if (spaceMode() !== "company") return { status: 409, body: { error: "company_only" } };
    try {
      if (req.method === "GET" && url.pathname === "/projects/builder") return { status: 200, body: await projectBuilder.status(url.searchParams.get("projectId")) };
      if (req.method === "GET" && url.pathname === "/projects/builder/files") return { status: 200, body: { files: await projectBuilder.appFiles(url.searchParams.get("projectId")) } };
      if (req.method === "GET" && url.pathname === "/projects/builder/analyze") return { status: 200, body: await projectBuilder.analyze(url.searchParams.get("projectId")) };
      if (req.method === "POST") {
        const { projectId, ...body } = await readJson(req, 512 * 1024);
        const operation = { "/projects/builder/prepare": "prepare", "/projects/builder/start": "start", "/projects/builder/stop": "stop", "/projects/builder/request": "request", "/projects/builder/checks": "checks", "/projects/builder/apply": "apply", "/projects/builder/load": "load" }[url.pathname];
        if (operation) return { status: 200, body: await projectBuilder[operation](projectId, body) };
      }
      return { status: 404, body: { error: "not_found" } };
    } catch (error) {
      const code = error instanceof ProjectFolderError ? error.code : "builder_unavailable";
      return { status: error instanceof ProjectFolderError ? error.status : 503, body: { error: code, message: code } };
    }
  }
  // P7: a project's folder on GitHub; the token stays in the Gateway's state, never in the folder or a sandbox.
  if (url.pathname.startsWith("/projects/github/")) {
    if (spaceMode() !== "company") return { status: 409, body: { error: "company_only" } };
    try {
      if (req.method === "GET" && url.pathname === "/projects/github/status") return { status: 200, body: await projectGitHub.status(url.searchParams.get("projectId")) };
      if (req.method === "GET" && url.pathname === "/projects/github/plan") return { status: 200, body: await projectGitHub.plan(url.searchParams.get("projectId")) };
      if (req.method === "GET" && url.pathname === "/projects/github/changes") return { status: 200, body: await projectGitHub.changes(url.searchParams.get("projectId")) };
      if (req.method !== "POST") return { status: 404, body: { error: "not_found" } };
      const { projectId, ...body } = await readJson(req);
      const operation = { "/projects/github/create": "create", "/projects/github/connect": "connect", "/projects/github/import": "importRepo", "/projects/github/pull-request": "pullRequest", "/projects/github/disconnect": "disconnect" }[url.pathname];
      if (!operation) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: await projectGitHub[operation](projectId, body) };
    } catch (error) {
      const code = error instanceof ProjectFolderError ? error.code : "github_unavailable";
      return { status: error instanceof ProjectFolderError ? error.status : 503, body: { error: code, message: code } };
    }
  }
  // P8: a project's files for a transfer package, and a package's files into a new project folder.
  if (url.pathname.startsWith("/projects/transfer/")) {
    if (spaceMode() !== "company") return { status: 409, body: { error: "company_only" } };
    try {
      if (req.method !== "POST") return { status: 404, body: { error: "not_found" } };
      const { projectId, files } = await readJson(req, 40 * 1024 * 1024);
      if (url.pathname === "/projects/transfer/read") return { status: 200, body: await projectTransfer.read(projectId) };
      if (url.pathname === "/projects/transfer/write") {
        const written = await projectTransfer.write(projectId, files);
        // The files are written; an app the builder cannot take back only loses its checks.
        return { status: 200, body: { ...written, ...(await projectBuilder.adopt(projectId).catch(() => ({ adopted: false }))) } };
      }
      return { status: 404, body: { error: "not_found" } };
    } catch (error) {
      const code = error instanceof ProjectFolderError ? error.code : "transfer_unavailable";
      return { status: error instanceof ProjectFolderError ? error.status : 503, body: { error: code, message: code } };
    }
  }
  // Executors' work copies (P6.2): created, refilled and read by the panel only.
  if (url.pathname.startsWith("/projects/work/")) {
    if (spaceMode() !== "company") return { status: 409, body: { error: "company_only" } };
    try {
      if (req.method !== "POST") return { status: 404, body: { error: "not_found" } };
      const { agentId, files } = await readJson(req, 512 * 1024);
      if (url.pathname === "/projects/work/ensure") return { status: 200, body: await projectWork.ensure(agentId) };
      if (url.pathname === "/projects/work/prepare") return { status: 200, body: await projectWork.prepare(agentId, files) };
      if (url.pathname === "/projects/work/snapshot") return { status: 200, body: await projectWork.snapshot(agentId) };
      return { status: 404, body: { error: "not_found" } };
    } catch (error) {
      const code = error instanceof ProjectFolderError ? error.code : "work_unavailable";
      return { status: error instanceof ProjectFolderError ? error.status : 503, body: { error: code, message: code } };
    }
  }
  if (url.pathname === "/projects/workspace") {
    if (spaceMode() !== "company") return { status: 409, body: { error: "company_only" } };
    try {
      if (req.method === "GET") return { status: 200, body: await projectFolders.status(url.searchParams.get("projectId")) };
      if (req.method === "POST") return { status: 200, body: await projectFolders.prepare(await readJson(req)) };
      return { status: 404, body: { error: "not_found" } };
    } catch (error) {
      const code = error instanceof ProjectFolderError ? error.code : "workspace_unavailable";
      return { status: error instanceof ProjectFolderError ? error.status : 503, body: { error: code, message: code } };
    }
  }

  if (url.pathname.startsWith("/storage/")) {
    if (!personalMode()) return { status: 404, body: { error: "not_found", message: "not_found" } };
    try {
      if (url.pathname === "/storage/status" && req.method === "GET") return { status: 200, body: await storage.status() };
      if (req.method !== "POST") return { status: 404, body: { error: "not_found" } };
      const body = await readJson(req);
      if (url.pathname === "/storage/quota") return { status: 200, body: await storage.setQuota(body.videoQuotaBytes) };
      if (url.pathname === "/storage/preview") return { status: 200, body: await storage.preview(body.category) };
      if (url.pathname === "/storage/cleanup" && body.confirm === true) return { status: 200, body: await storage.cleanup(body.token) };
      throw new StorageError("invalid_request", 400);
    } catch (error) {
      const code = error instanceof StorageError ? error.code : "storage_unavailable";
      return { status: error instanceof StorageError ? error.status : 503, body: { error: code, message: code } };
    }
  }

  if (url.pathname === "/memory/status" && req.method === "GET") return { status: 200, body: await localMemory.status() };
  if (url.pathname === "/memory/search" && req.method === "POST") {
    try {
      const body = await readJson(req);
      return { status: 200, body: await localMemory.search(body.agentId, body.query) };
    } catch (error) {
      const code = error instanceof MemoryError ? error.code : "memory_failed";
      return { status: error instanceof MemoryError ? error.status : 503, body: { error: code, message: code } };
    }
  }
  if (url.pathname === "/memory/action" && req.method === "POST") {
    try {
      const body = await readJson(req);
      return { status: 200, body: await localMemory.start(body.action, body.consent) };
    } catch (error) {
      if (error instanceof MemoryError) return { status: error.status, body: { error: error.code, message: error.code } };
      return { status: 503, body: { error: "status_unavailable", message: "status_unavailable" } };
    }
  }

  // Folders in the shared files folder (names only), for granting one to an agent.
  if (req.method === "GET" && url.pathname === "/files/folders") {
    const entries = await fs.readdir(FILES_IN_GATEWAY, { withFileTypes: true }).catch(() => []);
    return { status: 200, body: { folders: entries.filter((entry) => entry.isDirectory() && FOLDER.test(entry.name)).map((entry) => entry.name).sort() } };
  }
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

  // P0: what this container can do now (versions and tools), for the capabilities screen.
  if (req.method === "GET" && url.pathname === "/capabilities") return { status: 200, body: await capabilities() };
  if (req.method === "GET" && url.pathname === "/google/status") return googleStatus();
  if (req.method === "GET" && url.pathname === "/owner-files/list") return ownerFileCall(() => ownerFiles.list());
  // Documents sent to the bot in Telegram, for the panel's library (see clawdesk-library-inbound.mjs).
  if (req.method === "GET" && url.pathname === "/library/inbound") {
    const after = Number(url.searchParams.get("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return { status: 400, body: { error: "invalid_request", message: "invalid_request" } };
    return ownerFileCall(() => listInboundDocuments(ownerFiles.stateDir, { after }));
  }
  if (req.method === "POST" && url.pathname === "/library/inbound/read") {
    const body = await readJson(req);
    try { return await readInboundDocument(ownerFiles.stateDir, body.id); }
    catch (error) {
      const code = error instanceof ProjectFolderError ? error.code : "file_missing";
      return { status: error instanceof ProjectFolderError ? error.status : 404, body: { error: code, message: code } };
    }
  }
  // A file uploaded in the panel: up to 20 MB as base64, so its own body limit.
  if (req.method === "POST" && url.pathname === "/owner-files/upload") {
    const body = await readJson(req, 28 * 1024 * 1024);
    return ownerFileCall(() => ownerFiles.upload(body.name, body.base64));
  }
  if (req.method === "GET" && url.pathname === "/openclaw/update") return { status: 200, body: await openclawUpdateInfo() };
  if (req.method === "GET" && url.pathname === "/backup/list") return { status: 200, body: { backups: await listBackups() } };
  // Company requests filed by agents (clawdesk-requests plugin): the panel reads, stores, then acknowledges.
  if (req.method === "GET" && url.pathname === "/requests/spool") return { status: 200, body: await readRequestsSpool(requestsSpoolDir(process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw")) };
  if (req.method === "GET" && url.pathname === "/teams/status") return teamCall(() => teamRepoStatus({ teamId: url.searchParams.get("teamId"), developer: url.searchParams.get("developer") || undefined }));
  if (req.method === "GET" && url.pathname === "/claude/status") return claudeCall(() => claudeLogin.status());
  if (req.method === "GET" && url.pathname === "/mcp/status") {
    const server = url.searchParams.get("server") || "";
    if (!SERVER_NAME.test(server)) return { status: 400, body: { error: "invalid_server" } };
    return mcpStatus(server);
  }
  if (req.method !== "POST") return { status: 404, body: { error: "not_found" } };

  const body = await readJson(req);
  if (!(await gogInstalled()) && url.pathname.startsWith("/google/")) return { status: 501, body: { error: "gog_missing", message: "gog is not in this Gateway image" } };
  if (req.method === "GET" && url.pathname === "/video/progress") {
    return { status: 200, body: { percent: videoProgress(url.searchParams.get("jobId")) } };
  }
  if (url.pathname.startsWith("/video/")) {
    const modes = { "/video/study": studyVideo, "/video/frames": framesOfVideo, "/video/download": downloadVideo, "/video/cancel": cancelVideo };
    const handler = modes[url.pathname];
    if (!handler) return { status: 404, body: { error: "unknown_route", message: "unknown route" } };
    try {
      let result;
      if (url.pathname === "/video/download") {
        const mode = spaceMode();
        if (mode === null && await storage.quota() !== null) throw new StorageError("storage_unavailable", 503);
        result = mode === "personal" ? await storage.download(body, handler) : await handler(body);
      } else result = await handler(body);
      // Only the reason code travels back; yt-dlp's own output stays in this container.
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof VideoError) return { status: 400, body: { error: error.code, message: error.code } };
      if (error instanceof StorageError) return { status: error.status, body: { error: error.code, message: error.code } };
      log("a video job failed", { path: url.pathname });
      return { status: 500, body: { error: "download_failed", message: "download_failed" } };
    }
  }
  // The panel's answer to a filed entry for the tool call waiting for it, and taking it back when nobody did.
  if (url.pathname === "/requests/result" || url.pathname === "/requests/result/take") {
    const dir = requestsSpoolDir(process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw");
    try { return { status: 200, body: url.pathname === "/requests/result" ? await writeRequestResult(dir, body.id, body.text) : await takeRequestResult(dir, body.id) }; }
    catch (error) { if (error.status === 400) return { status: 400, body: { error: "invalid_request", message: "invalid result" } }; throw error; }
  }
  if (url.pathname === "/requests/ack") {
    try { return { status: 200, body: await ackRequestsSpool(requestsSpoolDir(process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw"), body.ids) }; }
    catch (error) { if (error.status === 400) return { status: 400, body: { error: "invalid_request", message: "invalid ack" } }; throw error; }
  }
  if (url.pathname === "/freellmapi/reset") return freellmapiReset(body);
  if (url.pathname === "/files/folder") return ensureFolder(body);
  if (url.pathname === "/files/agent-folder/remove") {
    agentFolders.validate(body);
    return { status: 200, body: await agentFolders.unregister(body.agentId, body.name, { dir: body.dir }) };
  }
  if (url.pathname === "/files/agent-folder") {
    agentFolders.validate(body);
    const folder = await ensureFolder(body);
    if (folder.status !== 200) return folder;
    const managed = await agentFolders.register(body.agentId, body.name, { dir: body.dir, readOnly: body.readOnly });
    return { status: 200, body: { hostPath: folder.body.hostPath, ...managed } };
  }
  const teamOps = { "/teams/clone": cloneTeamRepo, "/teams/member": prepareMemberRepo, "/teams/fetch": fetchTeamRepo, "/teams/push": pushTeamBranch, "/teams/remove": removeTeamRepo };
  if (teamOps[url.pathname]) return teamCall(() => teamOps[url.pathname](body));
  if (url.pathname === "/backup/delete") {
    if (body.confirm !== true) return { status: 400, body: { error: "confirmation_required", message: "confirm backup deletion" } };
    try {
      const result = await deleteBackup(body.name);
      log("backup deleted", { name: result.name });
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof BackupError) return { status: error.status, body: { error: error.code, message: error.message } };
      throw error;
    }
  }
  if (url.pathname === "/owner-files/store") return ownerFileCall(() => ownerFiles.storeInbound(body.inbound, body.name));
  if (url.pathname === "/owner-files/copy") return ownerFileCall(() => ownerFiles.copy(body.agentId, body.file));
  if (url.pathname === "/owner-files/remove") return ownerFileCall(() => ownerFiles.remove(body.agentId, body.file));
  if (url.pathname === "/owner-files/copies") return ownerFileCall(() => ownerFiles.copies(body.agentId));
  if (url.pathname === "/openclaw/update") {
    try {
      const result = await startOpenClawUpdate(body.version, { identify: () => resetGateway(), backup: () => createBackup("before-update") });
      log("openclaw update started", { version: result.version });
      return { status: 200, body: { started: true, version: result.version } };
    } catch (error) {
      if (error instanceof OpenClawUpdateError || error instanceof BackupError) return { status: error.status, body: { error: error.code, message: error.message } };
      throw error;
    }
  }
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
  if (url.pathname === "/claude/login/start") return claudeCall(() => claudeLogin.start());
  if (url.pathname === "/claude/login/complete") return claudeCall(() => claudeLogin.complete(body.code));
  if (url.pathname === "/claude/logout") return claudeCall(() => claudeLogin.logout());
  if (url.pathname === "/skills/remove") {
    try {
      return { status: 200, body: await removeWorkspaceSkill(body.dir) };
    } catch (error) {
      if (error instanceof SkillRemoveError) return { status: 400, body: { error: error.code, message: error.message } };
      throw error;
    }
  }
  // Stage 7: prepared copies of single Google Docs for company agents; the agent never gets the connection.
  if (url.pathname.startsWith("/google/doc/")) {
    if (spaceMode() !== "company") return { status: 409, body: { error: "company_only" } };
    try {
      if (url.pathname === "/google/doc/copy") return { status: 200, body: await googleDocs.copy(body.agentId, body.docId, body.account) };
      if (url.pathname === "/google/doc/remove") return { status: 200, body: await googleDocs.remove(body.agentId, body.docId) };
      if (url.pathname === "/google/doc/list") return { status: 200, body: await googleDocs.list(body.agentId) };
      return { status: 404, body: { error: "not_found" } };
    } catch (error) {
      const code = error instanceof ProjectFolderError ? error.code : "google_unavailable";
      return { status: error instanceof ProjectFolderError ? error.status : 503, body: { error: code, message: code } };
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
