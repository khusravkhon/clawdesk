// OpenClaw update from the panel ("System → OpenClaw"), for the ClawDesk bridge.
//
// Each ClawDesk release builds only the OpenClaw versions it has verified (deploy/openclaw.supported: the
// bump PR, the tests and the contract test passed for each). An install keeps the OpenClaw line it runs;
// a newer verified version is offered in the panel and installed only when the owner asks for it.
//
// The Gateway cannot replace itself, so the update runs in a one-off helper container (this same image,
// started through the Docker socket like the factory reset):
//   1. the bridge makes a "before-update" backup — if it fails nothing is changed;
//   2. the helper builds the Gateway image for the new OpenClaw from the build files this image carries
//      (/usr/local/share/clawdesk/gateway-build, the same code that built this image);
//   3. it stops the Gateway and the containers in its network (panel, FreeLLMAPI) and creates them again from
//      their own Docker configuration with the new Gateway image. Paths come back exactly as Docker stored
//      them, so it works the same on a Linux server and in Docker Desktop on Windows;
//   4. it waits for the Gateway health check and for the panel to reach the Gateway;
//   5. on any failure the previous containers and image come back. Data the new OpenClaw already wrote stays;
//      if the previous version cannot start on it, the status names the backup to restore.
// Progress is a JSON file in the OpenClaw state folder, so the panel reads it again after its own restart.
//
// deploy/scripts/init.sh keeps the chosen line on later code updates (deploy/scripts/openclaw-choice.sh).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw";
export const STATUS_DIR = path.join(STATE_DIR, "clawdesk", "openclaw-update");
const STATUS_FILE = path.join(STATUS_DIR, "status.json");
export const BUILD_CONTEXT = "/usr/local/share/clawdesk/gateway-build";
const VERSION_FILE = "/usr/local/lib/openclaw.version";
const SUPPORTED_FILE = "/usr/local/lib/openclaw.supported";
/** The real Docker CLI (the plain `docker` is the mount wrapper for sandboxes). */
const DOCKER = "/usr/local/libexec/docker";
const SOCKET = "/var/run/docker.sock";
export const VERSION_LABEL = "org.clawdesk.openclaw-version";
const HELPER_PREFIX = "clawdesk-openclaw-update-";
const STABLE = /^\d{4}\.\d{1,2}\.\d{1,4}$/;
const ACTIVE = new Set(["backup", "building", "switching", "checking", "rolling_back"]);
const HEALTH_TIMEOUT_MS = Number(process.env.CLAWDESK_UPDATE_HEALTH_TIMEOUT || 360) * 1000;

export class OpenClawUpdateError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// --- versions -------------------------------------------------------------------------------------------

const parts = (v) => v.split(".").map(Number);
export const lineOf = (v) => parts(v).slice(0, 2).join(".");
export function compare(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** deploy/openclaw.supported: one verified version per line, # comments allowed. */
export function parseSupported(text) {
  const versions = text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
  for (const v of versions) if (!STABLE.test(v)) throw new Error(`openclaw.supported: "${v}" is not a stable YYYY.M.P version`);
  return [...new Set(versions)].sort(compare);
}

/** The newest verified version above the running one, or null. */
export function updateOffer(running, supported) {
  if (!running || !STABLE.test(running)) return null;
  const newer = supported.filter((v) => compare(v, running) > 0);
  if (!newer.length) return null;
  const version = newer.at(-1);
  return { version, newLine: lineOf(version) !== lineOf(running) };
}

// --- status ---------------------------------------------------------------------------------------------

export async function readStatus(file = STATUS_FILE) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeStatus(status, file = STATUS_FILE) {
  const next = { ...status, updatedAt: new Date().toISOString() };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
  // The helper runs as root; the bridge (node) must be able to replace the file next time.
  await fs.chown(tmp, 1000, 1000).catch(() => {});
  await fs.rename(tmp, file);
  return next;
}

export const isActive = (status) => !!status && ACTIVE.has(status.state);

// --- Docker ---------------------------------------------------------------------------------------------

function run(cmd, args, { timeoutMs = 60_000, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DOCKER_CONFIG: "/tmp/clawdesk-docker-config" } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const take = (sink) => (chunk) => {
      const text = String(chunk);
      if (sink === "out") out += text;
      else err += text;
      if (onLine) for (const line of text.split("\n")) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
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

const tail = (text, lines = 6) => text.trim().split("\n").slice(-lines).join("\n").slice(-1200);

/** One Docker Engine API call over the socket; JSON in and out. 304 (already stopped) counts as success. */
export function dockerApi(method, url, body, { socketPath = SOCKET, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath, path: url, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}, timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`docker ${method} ${url.split("?")[0]}: ${res.statusCode} ${data.trim().slice(0, 300)}`));
        try { resolve(data ? JSON.parse(data) : null); } catch { resolve(data); }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`docker ${method} ${url}: timed out`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The create request for a container like `container`, from its own Docker configuration.
 * `oldImage` (the image config it ran) is subtracted, so values that came from the old image (Env, labels,
 * entrypoint…) come from the new image instead; values Compose set stay.
 */
export function cloneSpec(container, { image, oldImage = null, networkMode = null } = {}) {
  const c = container.Config ?? {};
  const old = oldImage ?? {};
  const spec = { ...c, Image: image };
  if (oldImage) {
    spec.Env = (c.Env ?? []).filter((e) => !(old.Env ?? []).includes(e));
    spec.Labels = Object.fromEntries(Object.entries(c.Labels ?? {}).filter(([k, v]) => old.Labels?.[k] !== v));
    for (const key of ["Entrypoint", "Cmd", "WorkingDir", "User", "Healthcheck", "StopSignal", "ExposedPorts", "Volumes", "Shell", "OnBuild"]) {
      if (same(c[key], old[key])) delete spec[key];
    }
  }
  const hostConfig = { ...container.HostConfig };
  if (networkMode) hostConfig.NetworkMode = networkMode;
  // Anonymous volumes would otherwise start empty: attach the same ones again.
  const named = new Set([...(hostConfig.Mounts ?? []).map((m) => m.Source), ...(hostConfig.Binds ?? []).map((b) => b.split(":")[0])]);
  const anonymous = (container.Mounts ?? []).filter((m) => m.Type === "volume" && m.Name && !named.has(m.Name));
  if (anonymous.length) hostConfig.Mounts = [...(hostConfig.Mounts ?? []), ...anonymous.map((m) => ({ Type: "volume", Source: m.Name, Target: m.Destination }))];
  spec.HostConfig = hostConfig;
  // Docker's default hostname is the container's short id: the new container gets its own.
  if (container.Id && spec.Hostname === container.Id.slice(0, 12)) delete spec.Hostname;
  if (String(hostConfig.NetworkMode ?? "").startsWith("container:")) {
    // Shares another container's network: hostname and ports belong to that one.
    delete spec.Hostname;
    delete spec.Domainname;
    delete spec.ExposedPorts;
  } else {
    const shortId = container.Id?.slice(0, 12);
    const networks = container.NetworkSettings?.Networks ?? {};
    spec.NetworkingConfig = {
      EndpointsConfig: Object.fromEntries(Object.entries(networks).map(([name, n]) => [name, {
        Aliases: (n.Aliases ?? []).filter((a) => a !== shortId),
        ...(n.IPAMConfig ? { IPAMConfig: n.IPAMConfig } : {}),
        ...(n.Links ? { Links: n.Links } : {}),
        ...(n.DriverOpts ? { DriverOpts: n.DriverOpts } : {}),
      }])),
    };
  }
  return spec;
}

const nameOf = (container) => container.Name.replace(/^\//, "");

// --- bridge side ----------------------------------------------------------------------------------------

export async function runningVersion(file = VERSION_FILE) {
  try {
    return (await fs.readFile(file, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export async function supportedVersions(file = SUPPORTED_FILE) {
  try {
    return parseSupported(await fs.readFile(file, "utf8"));
  } catch {
    return [];
  }
}

async function helperRunning(name) {
  const res = await run(DOCKER, ["ps", "-q", "--filter", `name=^/${name}$`], { timeoutMs: 20_000 });
  return res.code === 0 && res.out.trim() !== "";
}

/** In this bridge process, while the backup before the helper is being made. */
let preparing = false;

/** What the panel shows: the running version, the offer and the last update. */
export async function updateInfo({ statusFile = STATUS_FILE, versionFile = VERSION_FILE, supportedFile = SUPPORTED_FILE, isHelperRunning = helperRunning } = {}) {
  const [running, supported] = [await runningVersion(versionFile), await supportedVersions(supportedFile)];
  let status = await readStatus(statusFile);
  // A step that no process carries on any more was cut short (restart of the computer or of Docker).
  if (isActive(status) && !(status.state === "backup" ? preparing : await isHelperRunning(status.helper ?? ""))) {
    status = await writeStatus({ ...status, state: "failed", reason: "interrupted", finishedAt: new Date().toISOString() }, statusFile);
  }
  return { running, supported, offer: updateOffer(running, supported), status };
}

/**
 * Starts the update to `version` and returns at once. `identify` finds this Gateway's container
 * (clawdesk-backup.mjs: resetGateway), `backup` makes the "before-update" archive.
 */
export async function startUpdate(version, { identify, backup, docker = run, statusFile = STATUS_FILE, ...files }) {
  const info = await updateInfo({ statusFile, ...files });
  if (typeof version !== "string" || !STABLE.test(version)) throw new OpenClawUpdateError("invalid_version", "invalid OpenClaw version");
  if (!info.supported.includes(version)) throw new OpenClawUpdateError("not_verified", `OpenClaw ${version} is not verified for this ClawDesk`, 409);
  if (!info.running || compare(version, info.running) <= 0) throw new OpenClawUpdateError("not_newer", `OpenClaw ${info.running ?? "?"} already runs`, 409);
  if (preparing || isActive(info.status)) throw new OpenClawUpdateError("update_running", "an OpenClaw update is already running", 409);

  const self = await identify();
  const project = self.Config.Labels["com.docker.compose.project"];
  const socket = self.Mounts.find((m) => m.Destination === SOCKET)?.Source;
  const state = self.Mounts.find((m) => m.Destination === STATE_DIR)?.Source;
  if (!project || !socket || !state) throw new OpenClawUpdateError("not_compose", "the Gateway does not run as a ClawDesk install", 409);

  const helper = `${HELPER_PREFIX}${project}`;
  const write = (next) => writeStatus(next, statusFile);
  let status = await write({ version, from: info.running, state: "backup", helper, startedAt: new Date().toISOString() });
  preparing = true;
  const job = (async () => {
    try {
      const archive = await backup();
      status = await write({ ...status, backup: archive.name });
      const args = { version, from: info.running, gateway: self.Id, project, openclawImage: process.env.OPENCLAW_IMAGE || "ghcr.io/openclaw/openclaw", backup: archive.name, startedAt: status.startedAt, helper };
      const res = await docker(DOCKER, [
        "run", "-d", "--rm", "--name", helper, "--user", "0", "--entrypoint", "node",
        "-v", `${socket}:${SOCKET}`,
        "-v", `${state}/clawdesk/openclaw-update:${STATUS_DIR}`,
        "-e", `OPENCLAW_STATE_DIR=${STATE_DIR}`,
        "-e", "HOME=/tmp",
        "--label", "org.clawdesk.helper=openclaw-update",
        self.Image,
        "/usr/local/lib/clawdesk-openclaw-update.mjs", "run", JSON.stringify(args),
      ], { timeoutMs: 120_000 });
      if (res.code !== 0) throw new Error(`the update helper did not start: ${tail(res.err || res.out, 3)}`);
      // From here on the helper carries the status; "backup" with nobody making it would read as cut short.
      if ((await readStatus(statusFile))?.state === "backup") status = await write({ ...status, state: "building" });
    } catch (error) {
      status = await write({ ...status, state: "failed", reason: status.backup ? "helper_failed" : "backup_failed", message: String(error.message ?? error).slice(0, 1200), finishedAt: new Date().toISOString() });
    } finally {
      preparing = false;
    }
  })();
  return { started: true, version, done: job };
}

// --- helper side ----------------------------------------------------------------------------------------

async function waitHealthy(id, api) {
  const until = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < until) {
    const c = await api("GET", `/containers/${id}/json`);
    if (!c.State.Running) throw new Error(`the new Gateway stopped (exit code ${c.State.ExitCode})`);
    const health = c.State.Health?.Status;
    if (health === "unhealthy") throw new Error("the new Gateway failed its health check");
    if (health === "healthy" || (!c.State.Health && Date.now() - Date.parse(c.State.StartedAt) > 20_000)) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("the new Gateway did not become healthy in time");
}

const PANEL_PROBE = 'fetch("http://127.0.0.1:8080/api/health").then((r) => r.json()).then((h) => process.exit(h.ok && h.gateway.state === "connected" ? 0 : 1), () => process.exit(1))';

async function waitPanel(name) {
  const until = Date.now() + 2 * 60_000;
  while (Date.now() < until) {
    const res = await run(DOCKER, ["exec", name, "node", "-e", PANEL_PROBE], { timeoutMs: 20_000 });
    if (res.code === 0) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("the panel did not reach the new Gateway");
}

/** The helper's whole job (see the header). Exported for tests with a fake Docker. */
export async function runUpdate(args, { api = dockerApi, docker = run, status: write = writeStatus, healthy = waitHealthy, panelReady = waitPanel } = {}) {
  const { version, gateway: gatewayId, project, openclawImage } = args;
  let status = await write({ version: args.version, from: args.from, state: "building", helper: args.helper, backup: args.backup, startedAt: args.startedAt });
  const step = async (state, extra = {}) => (status = await write({ ...status, state, ...extra }));

  const gateway = await api("GET", `/containers/${gatewayId}/json`);
  const oldImage = await api("GET", `/images/${gateway.Image}/json`);
  const ref = gateway.Config.Image;
  const rollbackTag = `clawdesk-rollback/gateway-openclaw:${project}`;
  const buildTag = `clawdesk-openclaw-update:${version}`;

  // 1. Build. Pulling the new OpenClaw image takes a while; three attempts like init.sh.
  let built = null;
  let lastOut = "";
  let lastBeat = 0;
  for (let attempt = 1; attempt <= 3 && !built; attempt++) {
    const res = await docker(DOCKER, ["build", "--progress", "plain", "-t", buildTag, "--build-arg", `OPENCLAW_VERSION=${version}`, "--build-arg", `OPENCLAW_IMAGE=${openclawImage}`, "-f", path.join(BUILD_CONTEXT, "gateway.Dockerfile"), BUILD_CONTEXT], {
      timeoutMs: 45 * 60_000,
      onLine: () => {
        if (Date.now() - lastBeat > 15_000) { lastBeat = Date.now(); void write({ ...status, attempt }).then((s) => (status = s), () => {}); }
      },
    });
    lastOut = res.err || res.out;
    if (res.code === 0) built = await api("GET", `/images/${encodeURIComponent(buildTag)}/json`);
  }
  if (!built) return step("failed", { reason: "build_failed", message: tail(lastOut), finishedAt: new Date().toISOString() });
  if (built.Config?.Labels?.[VERSION_LABEL] !== version) {
    return step("failed", { reason: "build_failed", message: `the built image carries OpenClaw ${built.Config?.Labels?.[VERSION_LABEL] ?? "?"}`, finishedAt: new Date().toISOString() });
  }

  // 2. Who shares the Gateway's network (panel, FreeLLMAPI): they are recreated with it.
  const all = await api("GET", `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }))}`);
  const dependents = [];
  for (const summary of all) {
    if (summary.Id === gateway.Id) continue;
    const c = await api("GET", `/containers/${summary.Id}/json`);
    if (c.HostConfig?.NetworkMode === `container:${gateway.Id}`) dependents.push(c);
  }
  const wasRunning = new Set([gateway, ...dependents].filter((c) => c.State?.Running).map((c) => c.Id));
  const panel = dependents.find((c) => c.Config?.Labels?.["com.docker.compose.service"] === "panel");

  // Names as they are now: the containers get renamed below.
  const names = new Map([gateway, ...dependents].map((c) => [c.Id, nameOf(c)]));
  await step("switching");
  const created = [];
  const renamed = [];
  const suffix = `-before-openclaw-${version}`;
  try {
    for (const c of [...dependents, gateway]) await api("POST", `/containers/${c.Id}/stop?t=30`).catch((e) => { if (!/ 304 /.test(e.message)) throw e; });
    for (const c of [gateway, ...dependents]) {
      await api("POST", `/containers/${c.Id}/rename?name=${encodeURIComponent(names.get(c.Id) + suffix)}`);
      renamed.push(c);
    }
    await docker(DOCKER, ["tag", gateway.Image, rollbackTag]);
    const tagged = await docker(DOCKER, ["tag", built.Id, ref]);
    if (tagged.code !== 0) throw new Error(`docker tag: ${tail(tagged.err)}`);
    const fresh = await api("POST", `/containers/create?name=${encodeURIComponent(names.get(gateway.Id))}`, cloneSpec(gateway, { image: ref, oldImage: oldImage.Config }));
    created.push(fresh.Id);
    await api("POST", `/containers/${fresh.Id}/start`);
    for (const d of dependents) {
      const dep = await api("POST", `/containers/create?name=${encodeURIComponent(names.get(d.Id))}`, cloneSpec(d, { image: d.Config.Image, networkMode: `container:${fresh.Id}` }));
      created.push(dep.Id);
      if (wasRunning.has(d.Id)) await api("POST", `/containers/${dep.Id}/start`);
    }

    // 3. Checks.
    await step("checking");
    await healthy(fresh.Id, api);
    if (panel && wasRunning.has(panel.Id)) await panelReady(names.get(panel.Id));
  } catch (error) {
    // 4. Back to the previous containers and image.
    await step("rolling_back", { message: String(error.message ?? error).slice(0, 1200) });
    try {
      for (const id of created.reverse()) await api("DELETE", `/containers/${id}?force=true`);
      await docker(DOCKER, ["tag", gateway.Image, ref]);
      for (const c of renamed) await api("POST", `/containers/${c.Id}/rename?name=${encodeURIComponent(names.get(c.Id))}`);
      for (const c of [gateway, ...dependents]) if (wasRunning.has(c.Id)) await api("POST", `/containers/${c.Id}/start`).catch((e) => { if (!/ 304 /.test(e.message)) throw e; });
      await docker(DOCKER, ["rmi", rollbackTag]);
      await docker(DOCKER, ["rmi", buildTag]);
      return step("rolled_back", { reason: "check_failed", finishedAt: new Date().toISOString() });
    } catch (rollbackError) {
      return step("failed", { reason: "rollback_failed", message: `${status.message}\n${String(rollbackError.message ?? rollbackError)}`.slice(0, 1200), finishedAt: new Date().toISOString() });
    }
  }

  // 5. Done: the previous containers go, their volumes stay (they are attached to the new ones).
  for (const c of renamed) await api("DELETE", `/containers/${c.Id}?force=true`).catch(() => {});
  await docker(DOCKER, ["rmi", rollbackTag]);
  await docker(DOCKER, ["rmi", buildTag]);
  return step("done", { finishedAt: new Date().toISOString() });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "run") {
  runUpdate(JSON.parse(process.argv[3])).then(
    () => process.exit(0),
    async (error) => {
      const status = await readStatus();
      await writeStatus({ ...(status ?? {}), state: "failed", reason: "helper_failed", message: String(error.message ?? error).slice(0, 1200), finishedAt: new Date().toISOString() }).catch(() => {});
      process.exit(1);
    },
  );
}
