// Rehydrate approved plugin dependencies omitted by portable backups before the Gateway starts.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const pinned = /^(@openclaw\/[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/;
const inside = (root, target) => target.startsWith(`${path.resolve(root)}${path.sep}`);

export function recoveryPlan(records, stateDir) {
  return Object.entries(records).map(([id, record]) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error("Invalid plugin identity");
    const spec = (record.spec ?? "").replace(/^clawhub:/, "");
    const match = pinned.exec(spec);
    if (!match || !record.acceptedSurfaceHash || !record.acceptedSurface || !record.integrity) {
      throw new Error(`Plugin ${id} needs manual review: its pinned source, checksum or previous capability consent is missing`);
    }
    const target = path.resolve(record.installPath ?? "");
    if (!inside(stateDir, target)) throw new Error(`Plugin ${id} has an unsupported installation path`);
    if (record.source === "npm") {
      const root = path.dirname(path.dirname(path.dirname(target)));
      if (target !== path.join(root, "node_modules", match[1]) || path.dirname(root) !== path.join(stateDir, "npm", "projects")) {
        throw new Error(`Plugin ${id} has an unsupported managed npm path`);
      }
      return { id, name: match[1], version: match[2], spec, integrity: record.integrity, target, root, source: "npm" };
    }
    if (record.source !== "clawhub" || target !== path.join(stateDir, "extensions", id)) {
      throw new Error(`Plugin ${id} needs its original installation source`);
    }
    return { id, name: match[1], version: match[2], spec, integrity: record.integrity, target, source: "clawhub" };
  });
}

export function verifyArtifact(bytes, integrity) {
  const supported = integrity.split(/\s+/).filter((item) => /^(sha256|sha384|sha512)-/.test(item));
  if (!supported.length || !supported.some((item) => {
    const dash = item.indexOf("-");
    return createHash(item.slice(0, dash)).update(bytes).digest("base64") === item.slice(dash + 1);
  })) throw new Error("Plugin archive checksum does not match the previously approved artifact");
}

export async function run(program, args, { cwd = "/app", timeoutMs = 300_000, env = process.env, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, env: { ...process.env, ...env }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { out = (out + chunk).slice(-4 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { err = (err + chunk).slice(-32768); });
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, out: "", err: "command could not start", timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
  });
}

async function ordinaryDirectory(dir, root) {
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(dir);
  if (real !== realRoot && !inside(realRoot, real)) throw new Error("Plugin directory escapes its installation");
  if (!(await fs.lstat(dir)).isDirectory()) throw new Error("Plugin directory must not be a symbolic link");
}

async function manifest(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function restoreNpm(item, { command = run, log = console.log } = {}) {
  const state = path.resolve(item.root, "../../..");
  await ordinaryDirectory(state, state);
  for (const dir of [path.join(state, "npm"), path.join(state, "npm/projects"), item.root]) {
    try { await fs.mkdir(dir); } catch (error) { if (error.code !== "EEXIST") throw error; }
    await ordinaryDirectory(dir, state);
  }
  const project = await manifest(item.root) ?? { private: true, dependencies: { [item.name]: item.version } };
  if (Object.keys(project.dependencies ?? {}).length !== 1 || project.dependencies[item.name] !== item.version) {
    throw new Error(`Plugin ${item.id} has an unexpected dependency project`);
  }
  for (const value of Object.values(project.overrides ?? {})) {
    if (typeof value !== "string" || !/^(?:npm:[@a-z0-9/._-]+@)?[0-9][a-zA-Z0-9.+-]*$/.test(value)) throw new Error("Unsupported plugin dependency override");
  }
  const stage = await fs.mkdtemp(path.join(item.root, ".clawdesk-repair-"));
  try {
    log(`Restoring approved plugin ${item.id}@${item.version}`);
    const packed = await command("npm", ["pack", item.spec, "--ignore-scripts", "--json", "--pack-destination", stage], { cwd: stage });
    if (packed.code !== 0) throw new Error(`Plugin ${item.id} could not be downloaded; check network access to the npm registry`);
    const packs = JSON.parse(packed.out);
    const filename = (Array.isArray(packs) ? packs[0] : packs?.[item.name])?.filename;
    if (typeof filename !== "string") throw new Error("Invalid downloaded plugin archive");
    const archive = path.resolve(stage, filename);
    if (path.dirname(archive) !== path.resolve(stage)) throw new Error("Downloaded plugin archive escapes its staging directory");
    const stat = await fs.lstat(archive);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error("Invalid plugin archive size");
    verifyArtifact(await fs.readFile(archive), item.integrity);
    await fs.writeFile(path.join(stage, "package.json"), JSON.stringify({ private: true, dependencies: { [item.name]: `file:${archive}` }, overrides: project.overrides ?? {} }));
    const installed = await command("npm", ["install", "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund", "--package-lock=false"], { cwd: stage });
    if (installed.code !== 0) throw new Error(`Plugin ${item.id} dependencies could not be restored; check network access and free disk space`);
    const pkg = await manifest(path.join(stage, "node_modules", item.name));
    if (pkg?.name !== item.name || pkg.version !== item.version) throw new Error("Restored plugin identity does not match its receipt");
    const modules = path.join(item.root, "node_modules");
    const old = path.join(item.root, `.clawdesk-previous-${randomUUID()}`);
    let moved = false;
    try {
      try {
        if (!(await fs.lstat(modules)).isDirectory()) throw new Error("Managed dependencies must not be a symbolic link");
        await fs.rename(modules, old); moved = true;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await fs.rename(path.join(stage, "node_modules"), modules);
    } catch (error) { if (moved) await fs.rename(old, modules); throw error; }
    await fs.writeFile(path.join(item.root, "package.json"), JSON.stringify(project), { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    // Keep any replaced incomplete tree for diagnosis; no user files are recursively removed here.
  } finally {
    const target = path.resolve(stage);
    if (path.dirname(target) !== path.resolve(item.root) || !path.basename(target).startsWith(".clawdesk-repair-")) throw new Error("Invalid plugin staging cleanup path");
    await fs.rm(target, { recursive: true, force: true });
  }
}

export async function linkHost(dir, hostRoot) {
  const pkg = await manifest(dir);
  if (!pkg?.peerDependencies?.openclaw && !pkg?.dependencies?.openclaw) return;
  const modules = path.join(dir, "node_modules");
  await fs.mkdir(modules, { recursive: true });
  await ordinaryDirectory(modules, dir);
  const link = path.join(modules, "openclaw");
  try {
    const stat = await fs.lstat(link);
    if ((await fs.realpath(link).catch(() => null)) === await fs.realpath(hostRoot)) return;
    if (!stat.isSymbolicLink()) throw new Error("Existing OpenClaw dependency is not a managed host link");
    await fs.unlink(link);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.symlink(hostRoot, link, "dir");
}

export async function repair({ stateDir = process.env.OPENCLAW_STATE_DIR, hostRoot = "/app", command = run, log = console.log } = {}) {
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error("An absolute OpenClaw state directory is required");
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const database = path.join(stateDir, "state", "openclaw.sqlite");
  let records = config.plugins?.installs ?? {};
  if (await fs.stat(database).catch(() => null)) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='config_machine_state'").get()) {
        const row = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key=?").get("plugins.installedIndex");
        if (row) {
          records = JSON.parse(row.value_json)?.index?.installRecords;
          if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("Invalid installed plugin receipts");
        }
      }
    } finally { db.close(); }
  }
  const active = Object.fromEntries(Object.entries(records).filter(([id]) => config.plugins?.entries?.[id]?.enabled !== false));
  // Healthy local/path plugins remain developer-owned. Only approved registry artifacts are rehydrated.
  const managed = Object.fromEntries(Object.entries(active).filter(([, item]) => ["npm", "clawhub"].includes(item.source)));
  const plan = recoveryPlan(managed, stateDir);
  for (const item of plan) {
    let pkg = await manifest(item.target);
    if (!pkg && item.source === "npm") {
      await restoreNpm(item, { command, log });
      pkg = await manifest(item.target);
    }
    if (pkg?.name !== item.name || pkg.version !== item.version) throw new Error(`Plugin ${item.id} is missing or has a different version; restore its original approved artifact`);
    await ordinaryDirectory(item.target, stateDir);
    await linkHost(item.target, hostRoot);
  }
  const local = config.models?.providers?.["llama-cpp"];
  const engine = local?.localService?.command;
  if (config.memory?.search?.provider === "local" && typeof engine === "string" && inside(path.join(stateDir, "tools", "llama.cpp"), engine) && !await fs.stat(engine).catch(() => null)) {
    if (!plan.some((item) => item.id === "llama-cpp") || local.models?.length !== 0) throw new Error("Local memory runtime needs manual review");
    log("Restoring the previously configured local memory engine; no chat model will be downloaded");
    const { LocalMemory } = await import("./clawdesk-memory.mjs");
    const memory = new LocalMemory({ stateDir, configPath, runCli: (args, opts) => command(process.execPath, [path.join(hostRoot, "dist/index.js"), ...args], { ...opts, cwd: hostRoot }) });
    await memory.start("setup", true);
    await memory.drain();
    if ((await memory.status()).job.state !== "ready") throw new Error("Local memory runtime recovery did not finish; check its status in the panel");
  }
  log(`Plugin dependency check complete (${plan.length} approved registry plugins)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  repair().catch((error) => { console.error(`ClawDesk startup repair: ${error.message}`); process.exitCode = 1; });
}
