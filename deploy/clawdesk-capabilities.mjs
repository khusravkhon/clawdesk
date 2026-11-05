import { spawn } from "node:child_process";
import fs from "node:fs/promises";

// P0: what this Gateway container can actually do, checked now rather than assumed: the pinned OpenClaw
// version, and whether the tools the panel's features run exist and answer. Each probe has a short time
// limit and reports only a yes/no and a version; nothing here changes anything.

/** Runs a command with argv only; resolves its first output line, or null when it is missing or fails. */
export function probe(command, args, { timeoutMs = 5000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    let child;
    try { child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "ignore"] }); }
    catch { finish(null); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? (out.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, 120) : null));
  });
}

export async function capabilities({ versionFile = "/usr/local/lib/openclaw.version", run = probe } = {}) {
  const [openclaw, docker, git, gog] = await Promise.all([
    fs.readFile(versionFile, "utf8").then((text) => text.trim().slice(0, 40), () => null),
    run("/usr/local/libexec/docker", ["version", "--format", "{{.Server.Version}}"]),
    run("git", ["--version"]),
    run("/usr/local/bin/gog", ["--version"]),
  ]);
  return { openclaw, docker, git, gog };
}
