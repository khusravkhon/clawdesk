// Backups and factory reset for the ClawDesk bridge (runs in the Gateway container, imported by
// clawdesk-bridge.mjs).
//
// A backup is one tar in <data>/backups (0600, the folder 0700) holding:
//   manifest.json      format, kind, time, OpenClaw version
//   openclaw.tar.gz    `openclaw backup create --verify`: config, agents, sessions, workspaces, Google (gog)
//                      tokens, and the shared files folder (mounted inside the main workspace)
//   panel/             panel database (SQLite snapshot), Gateway device identity
//   freellmapi/        FreeLLMAPI database (SQLite snapshot)
//   auth-secrets/      OpenClaw's auth secrets volume
//   env                the .env secrets the data above is encrypted with (Gateway token, FreeLLMAPI key,
//                      gog keyring password) — without them a restored server cannot read it
// SQLite files are copied with SQLite's online backup, so a running panel gives a consistent copy.
//
// Factory reset: the Gateway cannot wipe itself while running, so a one-off helper container (this
// same image) stops the stack, empties every data folder except backups, onboards OpenClaw again,
// leaves the owner code the panel chose, and starts the stack.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw";
const DATA_DIR = path.dirname(STATE_DIR);
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
/** Other services' volumes, mounted into the Gateway for backups (deploy/docker-compose.yml). */
const SOURCES = "/var/lib/clawdesk-sources";
const AUTH_SECRETS = "/home/node/.config/openclaw";
const SECRET_ENV = ["OPENCLAW_GATEWAY_TOKEN", "FREELLMAPI_ENCRYPTION_KEY", "GOG_KEYRING_PASSWORD"];
/** How many archives of each group stay; older ones are deleted after a new backup. */
const KEEP = { regular: 7, "before-reset": 3 };
export const BACKUP_NAME = /^clawdesk-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-(daily|manual|before-reset)\.tar$/;
const OWNER_CODE = /^[A-Z0-9]{4}(-[A-Z0-9]{4}){2}$/;

function run(cmd, args, { cwd = "/app", timeoutMs = 120_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
  });
}

const tail = (text) => text.trim().split("\n").slice(-3).join("\n").slice(0, 600);
const exists = (p) => fs.access(p).then(() => true, () => false);

class BackupError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Copies a folder; SQLite databases through SQLite's backup (consistent while in use), their journals skipped. */
async function copyTree(from, to, skip = () => false) {
  await fs.mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (skip(entry.name) || /\.(sqlite|db)-(wal|shm|journal)$/.test(entry.name)) continue;
    if (entry.isDirectory()) await copyTree(src, dst, skip);
    else if (entry.isFile() && /\.(sqlite|db)$/.test(entry.name)) {
      const db = new DatabaseSync(src, { readOnly: true });
      try {
        await sqliteBackup(db, dst);
      } finally {
        db.close();
      }
    } else if (entry.isFile()) await fs.copyFile(src, dst);
  }
}

let busy = false;

/** Creates a backup; one at a time. */
export async function createBackup(kind) {
  if (!["daily", "manual", "before-reset"].includes(kind)) throw new BackupError("invalid_kind", "unknown backup kind", 400);
  if (busy) throw new BackupError("backup_busy", "a backup is already being made", 409);
  busy = true;
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const name = `clawdesk-${stamp}-${kind}.tar`;
  const staging = path.join(BACKUP_DIR, `.staging-${stamp}`);
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
    await fs.mkdir(staging, { mode: 0o700 });

    const oc = await run("node", ["dist/index.js", "backup", "create", "--verify", "--json", "--output", staging], { timeoutMs: 15 * 60_000 });
    const archive = oc.code === 0 ? JSON.parse(oc.out.slice(oc.out.indexOf("{"))).archivePath : null;
    if (!archive) throw new BackupError("openclaw_backup_failed", tail(oc.err || oc.out) || "openclaw backup create failed", 502);
    await fs.rename(archive, path.join(staging, "openclaw.tar.gz"));

    // The owner code is a one-time key, not data; it never goes into a backup.
    if (await exists(`${SOURCES}/panel`)) await copyTree(`${SOURCES}/panel`, path.join(staging, "panel"), (n) => n === "owner-code" || n.endsWith(".tmp"));
    if (await exists(`${SOURCES}/freellmapi`)) await copyTree(`${SOURCES}/freellmapi`, path.join(staging, "freellmapi"));
    if (await exists(AUTH_SECRETS)) await copyTree(AUTH_SECRETS, path.join(staging, "auth-secrets"));

    const env = SECRET_ENV.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`).join("\n");
    await fs.writeFile(path.join(staging, "env"), `${env}\n`, { mode: 0o600 });
    const version = JSON.parse(await fs.readFile("/app/package.json", "utf8")).version ?? null;
    const manifest = { format: 1, kind, createdAt: new Date().toISOString(), openclawVersion: version, stateDir: STATE_DIR };
    await fs.writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const tmp = path.join(BACKUP_DIR, `.${name}.tmp`);
    const tar = await run("tar", ["-cf", tmp, "-C", staging, "."], { timeoutMs: 15 * 60_000 });
    if (tar.code !== 0) throw new BackupError("archive_failed", tail(tar.err), 500);
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, path.join(BACKUP_DIR, name));
    await prune();
    const st = await fs.stat(path.join(BACKUP_DIR, name));
    return { name, kind, createdAt: manifest.createdAt, size: st.size };
  } finally {
    busy = false;
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function listBackups() {
  let names = [];
  try {
    names = await fs.readdir(BACKUP_DIR);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const items = [];
  for (const name of names) {
    const m = BACKUP_NAME.exec(name);
    if (!m) continue;
    const st = await fs.stat(path.join(BACKUP_DIR, name));
    items.push({ name, kind: m[2], createdAt: m[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z"), size: st.size });
  }
  return items.sort((a, b) => b.name.localeCompare(a.name));
}

/** Deletes one completed archive, never a directory, symlink or caller-supplied path. */
export async function deleteBackup(name) {
  if (typeof name !== "string" || BACKUP_NAME.exec(name)?.[0] !== name) throw new BackupError("invalid_backup_name", "invalid backup name", 400);
  if (busy) throw new BackupError("backup_busy", "a backup operation is already running", 409);
  busy = true;
  try {
    const root = await fs.realpath(BACKUP_DIR);
    const file = path.resolve(root, name);
    if (path.dirname(file) !== root) throw new BackupError("invalid_backup_name", "invalid backup name", 400);
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new BackupError("invalid_backup_file", "backup is not a regular archive", 409);
    await fs.unlink(file);
    return { deleted: true, name };
  } catch (error) {
    if (error.code === "ENOENT") throw new BackupError("backup_not_found", "backup no longer exists", 404);
    throw error;
  } finally {
    busy = false;
  }
}

async function prune() {
  const all = await listBackups();
  const groups = { regular: all.filter((b) => b.kind !== "before-reset"), "before-reset": all.filter((b) => b.kind === "before-reset") };
  for (const [group, items] of Object.entries(groups)) {
    for (const old of items.slice(KEEP[group])) await fs.rm(path.join(BACKUP_DIR, old.name), { force: true });
  }
}

async function docker(args, timeoutMs = 60_000) {
  const res = await run("docker", args, { cwd: "/", timeoutMs });
  if (res.code !== 0) throw new BackupError("docker_failed", `docker ${args[0]}: ${tail(res.err || res.out)}`, 502);
  return res.out.trim();
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function ownsSandbox(mounts, roots) {
  return mounts.some((mount) => typeof mount.Source === "string" && roots.some((raw) => {
    const root = raw?.replace(/\/+$/, "");
    return root && root !== "/" && (mount.Source === root || mount.Source.startsWith(`${root}/`));
  }));
}

export function stopOwnedSandboxesAtRuntime(roots, modulePath = "/usr/local/lib/clawdesk-backup.mjs") {
  const source = `import {spawnSync} from "node:child_process"; import {ownsSandbox} from ${JSON.stringify(modulePath)};
const roots=JSON.parse(process.argv[1]);
const run=args=>{const r=spawnSync("docker",args,{encoding:"utf8"});if(r.status!==0)throw new Error("sandbox ownership/stop failed");return r.stdout.trim();};
for(const id of run(["ps","-q","--filter","name=openclaw-sbx-"]).split("\\n").filter(Boolean)) {
const mounts=JSON.parse(run(["inspect","-f","{{json .Mounts}}",id]));
if(ownsSandbox(mounts,roots))run(["stop",id]);
}`;
  return `node --input-type=module -e ${q(source)} ${q(JSON.stringify(roots))}`;
}

/**
 * Starts the factory reset in a helper container and returns at once: the panel is stopped by it.
 * `ownerCode` lands in the fresh panel data, so the person who reset can set a new password right away.
 */
export async function startReset(ownerCode) {
  if (typeof ownerCode !== "string" || !OWNER_CODE.test(ownerCode)) throw new BackupError("invalid_owner_code", "owner code missing", 400);
  const self = JSON.parse(await docker(["inspect", process.env.HOSTNAME ?? ""]))[0];
  const project = self.Config.Labels["com.docker.compose.project"];
  if (!project) throw new BackupError("not_compose", "the Gateway does not run under docker compose", 409);
  const image = self.Config.Image;
  const mounts = self.Mounts;
  const socket = mounts.find((m) => m.Destination === "/var/run/docker.sock")?.Source;
  const filesDir = path.join(STATE_DIR, "workspace", "files");
  const files = mounts.find((m) => m.Destination === filesDir);
  const state = mounts.find((m) => m.Destination === STATE_DIR);
  if (!socket || !state) throw new BackupError("mounts_unknown", "cannot find the Docker socket or the state folder mount", 409);

  const lines = await docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", '{{.Names}}\t{{.Label "com.docker.compose.service"}}']);
  const byService = Object.fromEntries(lines.split("\n").filter(Boolean).map((l) => l.split("\t").reverse()));
  const volumes = new Set((await docker(["volume", "ls", "--format", "{{.Name}}"])).split("\n"));
  const volume = (n) => (volumes.has(`${project}_${n}`) ? `${project}_${n}` : null);

  const mountArgs = [
    ["-v", `${socket}:/var/run/docker.sock`],
    ["-v", `${state.Source}:${STATE_DIR}`],
    files ? ["-v", `${files.Source}:/reset/files`] : [],
    volume("panel-data") ? ["-v", `${volume("panel-data")}:/reset/panel`] : [],
    volume("freellmapi-data") ? ["-v", `${volume("freellmapi-data")}:/reset/freellmapi`] : [],
    volume("openclaw-auth-secrets") ? ["-v", `${volume("openclaw-auth-secrets")}:${AUTH_SECRETS}`] : [],
  ].flat();
  const envNames = ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_CONFIG_DIR", "OPENCLAW_WORKSPACE_DIR", "OPENCLAW_GATEWAY_TOKEN", "GOG_HOME"];
  const envArgs = envNames.filter((k) => process.env[k]).flatMap((k) => ["-e", `${k}=${process.env[k]}`]);

  const { gateway, panel, freellmapi } = byService;
  const others = [panel, freellmapi].filter(Boolean);
  const empty = (dir) => `[ -d ${q(dir)} ] && find ${q(dir)} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`;
  const script = [
    "set -e",
    "log() { echo \"clawdesk-reset: $*\"; }",
    "log stopping",
    `docker stop -t 30 ${[...others, gateway].map(q).join(" ")} >/dev/null`,
    // Sandbox names are global. Only a bind mount under this installation's state proves ownership.
    stopOwnedSandboxesAtRuntime([state.Source, files?.Source].filter(Boolean)),
    "log wiping",
    `${empty(STATE_DIR)}`,
    `${empty("/reset/files")} || true`,
    `${empty("/reset/panel")} || true`,
    `${empty("/reset/freellmapi")} || true`,
    `${empty(AUTH_SECRETS)} || true`,
    "log onboarding",
    // Same onboarding as deploy/scripts/init.sh.
    "node dist/index.js onboard --non-interactive --accept-risk --skip-health --mode local --auth-choice skip --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN --skip-channels --no-install-daemon >/dev/null",
    `[ -d /reset/panel ] && printf '%s\\n' ${q(ownerCode)} > /reset/panel/owner-code && chmod 600 /reset/panel/owner-code`,
    `chown -R 1000:1000 ${q(STATE_DIR)} ${q(AUTH_SECRETS)} 2>/dev/null || true`,
    "for d in /reset/files /reset/panel /reset/freellmapi; do [ -d \"$d\" ] && chown -R 1000:1000 \"$d\"; done; true",
    "log starting",
    `docker start ${q(gateway)} >/dev/null`,
    `for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' ${q(gateway)})" = healthy ] && break; sleep 3; done`,
    others.length ? `docker start ${others.map(q).join(" ")} >/dev/null` : "true",
    "log done",
  ].join("\n");

  const name = `clawdesk-reset-${Date.now()}`;
  await docker(["run", "-d", "--rm", "--name", name, "--user", "0", "--workdir", "/app", "--entrypoint", "sh", ...mountArgs, ...envArgs, image, "-c", script]);
  return { started: true, helper: name };
}

export { BackupError };
