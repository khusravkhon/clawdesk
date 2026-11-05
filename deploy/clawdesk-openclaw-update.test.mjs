import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cloneSpec, parseSupported, readStatus, runUpdate, startUpdate, updateInfo, updateOffer, VERSION_LABEL } from "./clawdesk-openclaw-update.mjs";

const tmp = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-openclaw-update-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

test("the offer is the newest verified version above the running one; a new line is marked", () => {
  const supported = parseSupported("# comment\n2026.8.35\n2026.11.2 # newer line\n\n2026.8.35\n");
  assert.deepEqual(supported, ["2026.8.35", "2026.11.2"]);
  assert.deepEqual(updateOffer("2026.8.35", supported), { version: "2026.11.2", newLine: true });
  assert.deepEqual(updateOffer("2026.8.30", ["2026.8.35"]), { version: "2026.8.35", newLine: false });
  assert.equal(updateOffer("2026.11.2", supported), null);
  assert.equal(updateOffer(null, supported), null);
  assert.throws(() => parseSupported("2026.11.1-beta.1"), /stable/);
});

const oldImage = {
  Env: ["PATH=/usr/local/bin:/usr/bin", "NODE_VERSION=24.1.0", "HOME=/home/node"],
  Labels: { [VERSION_LABEL]: "2026.8.35", "org.opencontainers.image.version": "2026.8.35" },
  Entrypoint: ["tini", "-s", "--", "/usr/local/bin/clawdesk-gateway-start"],
  Cmd: ["node", "dist/index.js"],
  User: "node",
  WorkingDir: "/app",
  Healthcheck: { Test: ["CMD", "node", "dist/docker-healthcheck.js"], Interval: 180e9 },
};

const gatewayContainer = {
  Id: "aaaaaaaaaaaa1111",
  Name: "/clawdesk-local-gateway-1",
  Image: "sha256:old",
  Config: {
    Hostname: "clawdesk-gateway",
    Image: "ghcr.io/khusravkhon/clawdesk-gateway:local",
    Env: [...oldImage.Env, "OPENCLAW_GATEWAY_TOKEN=t", "TZ=UTC"],
    Labels: { ...oldImage.Labels, "com.docker.compose.project": "clawdesk-local", "com.docker.compose.service": "gateway" },
    Entrypoint: oldImage.Entrypoint,
    Cmd: ["node", "dist/index.js", "gateway", "--bind", "loopback", "--port", "18789"],
    User: "node",
    WorkingDir: "/app",
    Healthcheck: { Test: ["CMD", "node", "dist/docker-healthcheck.js"], Interval: 30e9 },
    ExposedPorts: { "8080/tcp": {} },
  },
  HostConfig: {
    Binds: ["/run/desktop/mnt/host/c/Users/u/ClawDesk:/var/lib/clawdesk-local/openclaw/workspace/files"],
    Mounts: [{ Type: "volume", Source: "clawdesk-local_panel-data", Target: "/var/lib/clawdesk-sources/panel" }],
    PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] },
    NetworkMode: "clawdesk-local_default",
  },
  Mounts: [
    { Type: "volume", Name: "clawdesk-local_panel-data", Destination: "/var/lib/clawdesk-sources/panel" },
    { Type: "volume", Name: "0123anon", Destination: "/cache" },
  ],
  NetworkSettings: { Networks: { "clawdesk-local_default": { Aliases: ["clawdesk-local-gateway-1", "gateway", "aaaaaaaaaaaa"], NetworkID: "n1", IPAddress: "172.18.0.2" } } },
  State: { Running: true },
};

const panelContainer = {
  Id: "bbbbbbbbbbbb2222",
  Name: "/clawdesk-local-panel-1",
  Image: "sha256:panel",
  Config: { Hostname: "clawdesk-gateway", Image: "ghcr.io/khusravkhon/clawdesk-panel:local", Env: ["PORT=8080"], Labels: { "com.docker.compose.service": "panel" }, ExposedPorts: { "8080/tcp": {} } },
  HostConfig: { NetworkMode: `container:${gatewayContainer.Id}` },
  Mounts: [],
  State: { Running: true },
};

test("the Gateway's copy keeps what Compose set and takes from the new image what came from the old one", () => {
  const spec = cloneSpec(gatewayContainer, { image: "ghcr.io/khusravkhon/clawdesk-gateway:local", oldImage });
  assert.deepEqual(spec.Env, ["OPENCLAW_GATEWAY_TOKEN=t", "TZ=UTC"]);
  assert.deepEqual(spec.Labels, { "com.docker.compose.project": "clawdesk-local", "com.docker.compose.service": "gateway" });
  assert.equal(spec.Entrypoint, undefined);
  assert.equal(spec.User, undefined);
  assert.deepEqual(spec.Cmd, gatewayContainer.Config.Cmd);
  assert.deepEqual(spec.Healthcheck, gatewayContainer.Config.Healthcheck, "Compose's own health check stays");
  assert.equal(spec.Hostname, "clawdesk-gateway");
  // Paths and ports exactly as Docker stored them (Windows host paths included).
  assert.deepEqual(spec.HostConfig.Binds, gatewayContainer.HostConfig.Binds);
  assert.deepEqual(spec.HostConfig.PortBindings, gatewayContainer.HostConfig.PortBindings);
  assert.deepEqual(spec.HostConfig.Mounts.at(-1), { Type: "volume", Source: "0123anon", Target: "/cache" }, "an anonymous volume is attached again");
  assert.equal(spec.HostConfig.Mounts.length, 2);
  assert.deepEqual(spec.NetworkingConfig.EndpointsConfig["clawdesk-local_default"].Aliases, ["clawdesk-local-gateway-1", "gateway"]);
});

test("a container in the Gateway's network joins the new Gateway without its own hostname or ports", () => {
  const spec = cloneSpec(panelContainer, { image: panelContainer.Config.Image, networkMode: "container:new" });
  assert.equal(spec.HostConfig.NetworkMode, "container:new");
  assert.equal(spec.Hostname, undefined);
  assert.equal(spec.ExposedPorts, undefined);
  assert.equal(spec.NetworkingConfig, undefined);
  assert.deepEqual(spec.Env, ["PORT=8080"]);
});

/** A Docker that keeps containers by name and records what was done. */
function fakeDocker({ buildOk = true, builtVersion = "2026.11.2" } = {}) {
  const containers = new Map([[gatewayContainer.Id, structuredClone(gatewayContainer)], [panelContainer.Id, structuredClone(panelContainer)]]);
  const calls = [];
  let next = 0;
  const api = async (method, url, body) => {
    calls.push(`${method} ${url.split("?")[0]}${url.includes("name=") ? ` ${decodeURIComponent(url.split("name=")[1])}` : ""}`);
    const id = url.split("/")[2]?.split("?")[0];
    if (method === "GET" && url.startsWith("/images/sha256:old")) return { Config: oldImage };
    if (method === "GET" && url.startsWith("/images/")) return { Id: "sha256:new", Config: { Labels: { [VERSION_LABEL]: builtVersion } } };
    if (method === "GET" && url.startsWith("/containers/json")) return [...containers.values()].map((c) => ({ Id: c.Id }));
    if (method === "GET") return containers.get(id);
    if (method === "POST" && url.startsWith("/containers/create")) {
      const created = { Id: `new${++next}`, Name: `/${decodeURIComponent(url.split("name=")[1])}`, Config: body, HostConfig: body.HostConfig, State: { Running: false } };
      containers.set(created.Id, created);
      return { Id: created.Id };
    }
    if (url.endsWith("/stop") || url.includes("/stop?")) { containers.get(id).State.Running = false; return null; }
    if (url.endsWith("/start")) { containers.get(id).State.Running = true; return null; }
    if (url.includes("/rename")) { containers.get(id).Name = `/${decodeURIComponent(url.split("name=")[1])}`; return null; }
    if (method === "DELETE") { containers.delete(id); return null; }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const docker = async (_cmd, args) => {
    calls.push(`docker ${args[0]} ${args.at(-1)}`);
    return { code: args[0] === "build" && !buildOk ? 1 : 0, out: "", err: args[0] === "build" && !buildOk ? "pull access denied" : "" };
  };
  return { api, docker, calls, containers };
}

const args = { version: "2026.11.2", from: "2026.8.35", gateway: gatewayContainer.Id, project: "clawdesk-local", openclawImage: "ghcr.io/openclaw/openclaw", backup: "b.tar", startedAt: "2026-11-05T00:00:00Z", helper: "h" };
const memoryStatus = () => {
  const states = [];
  return { states, write: async (s) => { states.push(s.state); return s; } };
};

test("an update builds, recreates the Gateway and its network neighbours, checks them and cleans up", async () => {
  const d = fakeDocker();
  const s = memoryStatus();
  const result = await runUpdate(args, { api: d.api, docker: d.docker, status: s.write, healthy: async () => {}, panelReady: async () => {} });
  assert.equal(result.state, "done");
  assert.deepEqual(s.states, ["building", "switching", "checking", "done"]);
  const names = [...d.containers.values()].map((c) => c.Name).sort();
  assert.deepEqual(names, ["/clawdesk-local-gateway-1", "/clawdesk-local-panel-1"], "old containers are gone, new ones carry the names");
  const panel = [...d.containers.values()].find((c) => c.Name === "/clawdesk-local-panel-1");
  const gateway = [...d.containers.values()].find((c) => c.Name === "/clawdesk-local-gateway-1");
  assert.equal(panel.HostConfig.NetworkMode, `container:${gateway.Id}`);
  assert.ok(d.calls.indexOf("docker tag ghcr.io/khusravkhon/clawdesk-gateway:local") < d.calls.indexOf("POST /containers/create clawdesk-local-gateway-1"));
});

test("a failed check brings the previous containers and image back", async () => {
  const d = fakeDocker();
  const s = memoryStatus();
  const result = await runUpdate(args, { api: d.api, docker: d.docker, status: s.write, healthy: async () => { throw new Error("the new Gateway failed its health check"); }, panelReady: async () => {} });
  assert.equal(result.state, "rolled_back");
  assert.match(result.message, /health check/);
  assert.deepEqual([...d.containers.keys()].sort(), [gatewayContainer.Id, panelContainer.Id]);
  assert.equal(d.containers.get(gatewayContainer.Id).Name, gatewayContainer.Name);
  assert.equal(d.containers.get(panelContainer.Id).Name, panelContainer.Name);
  assert.ok(d.containers.get(gatewayContainer.Id).State.Running && d.containers.get(panelContainer.Id).State.Running);
  const lastTag = d.calls.filter((c) => c.startsWith("docker tag")).at(-1);
  assert.equal(lastTag, "docker tag ghcr.io/khusravkhon/clawdesk-gateway:local");
});

test("a failed build changes nothing", async () => {
  const d = fakeDocker({ buildOk: false });
  const result = await runUpdate(args, { api: d.api, docker: d.docker, status: memoryStatus().write });
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "build_failed");
  assert.ok(!d.calls.some((c) => c.includes("/stop") || c.includes("create")));
  const wrong = fakeDocker({ builtVersion: "2026.8.35" });
  assert.equal((await runUpdate(args, { api: wrong.api, docker: wrong.docker, status: memoryStatus().write })).reason, "build_failed");
});

async function files(t, running = "2026.8.35", supported = "2026.8.35\n2026.11.2\n") {
  const dir = await tmp(t);
  await fs.writeFile(path.join(dir, "version"), `${running}\n`);
  await fs.writeFile(path.join(dir, "supported"), supported);
  return { dir, versionFile: path.join(dir, "version"), supportedFile: path.join(dir, "supported"), statusFile: path.join(dir, "status.json") };
}

test("the panel sees the offer; a step nobody carries on any more reads as interrupted", async (t) => {
  const f = await files(t);
  const info = await updateInfo({ ...f, isHelperRunning: async () => true });
  assert.deepEqual({ running: info.running, offer: info.offer, status: info.status }, { running: "2026.8.35", offer: { version: "2026.11.2", newLine: true }, status: null });
  await fs.writeFile(f.statusFile, JSON.stringify({ version: "2026.11.2", state: "building", helper: "h" }));
  assert.equal((await updateInfo({ ...f, isHelperRunning: async () => true })).status.state, "building");
  const cut = await updateInfo({ ...f, isHelperRunning: async () => false });
  assert.equal(cut.status.state, "failed");
  assert.equal(cut.status.reason, "interrupted");
});

const self = { Id: "gw", Image: "sha256:old", Config: { Labels: { "com.docker.compose.project": "p" } }, Mounts: [{ Destination: "/var/run/docker.sock", Source: "/var/run/docker.sock" }, { Destination: process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw", Source: "/var/lib/clawdesk/openclaw" }] };

test("only a newer verified version starts, after a backup, and only once", async (t) => {
  const f = await files(t);
  const runs = [];
  const deps = { ...f, identify: async () => self, backup: async () => ({ name: "before.tar" }), docker: async (_c, a) => { runs.push(a); return { code: 0, out: "id", err: "" }; } };
  await assert.rejects(startUpdate("2026.12.1", deps), { code: "not_verified" });
  await assert.rejects(startUpdate("2026.8.35", deps), { code: "not_newer" });
  await assert.rejects(startUpdate("latest", deps), { code: "invalid_version" });
  const started = await startUpdate("2026.11.2", deps);
  await assert.rejects(startUpdate("2026.11.2", { ...deps, isHelperRunning: async () => true }), { code: "update_running" });
  await started.done;
  const status = await readStatus(f.statusFile);
  assert.equal(status.state, "building");
  assert.equal(status.backup, "before.tar");
  const run = runs.at(-1);
  assert.equal(run[0], "run");
  assert.ok(run.includes("sha256:old"), "the helper is this very image");
  assert.equal(JSON.parse(run.at(-1)).version, "2026.11.2");
});

test("no backup, no update", async (t) => {
  const f = await files(t);
  const runs = [];
  const started = await startUpdate("2026.11.2", { ...f, identify: async () => self, backup: async () => { throw new Error("disk full"); }, docker: async (_c, a) => { runs.push(a); return { code: 0, out: "", err: "" }; } });
  await started.done;
  const status = await readStatus(f.statusFile);
  assert.equal(status.state, "failed");
  assert.equal(status.reason, "backup_failed");
  assert.equal(runs.length, 0);
});

// deploy/scripts/openclaw-choice.sh, as init.sh uses it.
const choose = async (t, installed, def, supported) => {
  const dir = await tmp(t);
  const file = path.join(dir, "supported");
  await fs.writeFile(file, `# verified\n${supported.join("\n")}\n`);
  const script = path.join(import.meta.dirname, "scripts", "openclaw-choice.sh");
  const r = spawnSync("bash", ["-c", `. "$1"; openclaw_choose "$2" "$3" "$4"`, "_", script, installed, def, file], { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim() };
};

test("init.sh keeps an install on its OpenClaw line and never moves it to another line by itself", { skip: process.platform === "win32" && "bash here is not the install's bash" }, async (t) => {
  assert.deepEqual(await choose(t, "", "2026.8.35", ["2026.8.35", "2026.11.2"]), { code: 0, out: "2026.8.35" }, "a new install gets the default");
  assert.deepEqual(await choose(t, "2026.8.30", "2026.8.35", ["2026.8.35", "2026.11.2"]), { code: 0, out: "2026.8.35" }, "newest patch of its line");
  assert.deepEqual(await choose(t, "2026.11.1", "2026.8.35", ["2026.8.35", "2026.11.2"]), { code: 0, out: "2026.11.2" }, "the line the owner chose stays");
  assert.deepEqual(await choose(t, "2026.8.35", "2026.11.2", ["2026.11.2", "2026.12.4"]), { code: 0, out: "2026.11.2" }, "a dropped line moves to the default");
  assert.deepEqual(await choose(t, "2026.11.9", "2026.8.35", ["2026.8.35", "2026.12.1", "2026.12.4", "2027.1.1"]), { code: 0, out: "2026.12.4" }, "never down: the oldest newer line");
  assert.equal((await choose(t, "2027.2.1", "2026.8.35", ["2026.8.35", "2026.11.2"])).code, 2, "an install newer than the code stops");
});
