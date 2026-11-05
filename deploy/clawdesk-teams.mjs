// Project teams' repositories for the ClawDesk bridge (runs in the Gateway container).
//
//   <state>/teams/<teamId>/repo           the panel's clone of the default branch; never mounted into a sandbox
//   <state>/teams/<teamId>/.github-token  fine-grained token, 0600 — never mounted into a sandbox
//   <developer workspace>/repo            the developer's own clone on branch agent/<teamId>
//   <PM / reviewer workspace>/repo        read copies, refreshed by the panel from its clone
//
// OpenClaw (2026.8+) accepts sandbox bind sources only inside the agent's workspace and reserves /workspace,
// so the copies live in each member's workspace: the sandbox sees it at /workspace/repo, as before.
// The agent controls its workspace, so the panel treats those copies as untrusted: it never runs git
// with the token there, reads the developer's branch into its own clone (git fetch from a path) and
// pushes from that clone. Hooks and fsmonitor are switched off for the few commands run inside a copy.
//
// Sandboxes have no network, so agents never push: the owner presses "push and open a pull request" in the
// panel, and this module pushes the developer's branch with the token and opens the pull request.
// The token is passed per command as an HTTP header, so it never lands in a .git/config anyone can read.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STATE_DIR = path.resolve(process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw");
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(STATE_DIR, "openclaw.json");
export const TEAMS_DIR = path.join(STATE_DIR, "teams");
const TEAM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const AGENT = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const ROLES = new Set(["pm", "developer", "reviewer"]);
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const TOKEN = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/;
/** For commands inside an agent's copy: its config must not run anything in the Gateway. */
const UNTRUSTED = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
export const MEMBER_REPO = "repo";

export class TeamError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function git(args, { cwd, token, timeoutMs = 300_000 } = {}) {
  // GIT_TERMINAL_PROMPT=0: a wrong token fails instead of waiting for a password forever.
  const auth = token ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : [];
  return new Promise((resolve) => {
    const child = spawn("git", [...auth, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: String(e) });
    });
  });
}

async function must(res, what) {
  if (res.code !== 0) throw new TeamError("git_failed", `${what}: ${res.err.split("\n").slice(-2).join(" ").slice(0, 400)}`, 502);
  return res.out;
}

/** Paths of one team; `dirs` lets tests use their own state folder. */
export function teamPaths(teamId, dirs = { stateDir: STATE_DIR, configPath: CONFIG_PATH }) {
  if (!TEAM_ID.test(teamId ?? "")) throw new TeamError("invalid_team", "bad team id");
  const dir = path.join(dirs.stateDir, "teams", teamId);
  return { ...dirs, dir, repo: path.join(dir, "repo"), legacyDev: path.join(dir, "dev"), token: path.join(dir, ".github-token"), branch: `agent/${teamId}` };
}

async function readToken(p) {
  try {
    return (await fs.readFile(p.token, "utf8")).trim();
  } catch {
    throw new TeamError("no_token", "the team has no GitHub token", 409);
  }
}

/** The member's workspace (OpenClaw config, else the default), always inside the state folder. */
async function workspaceOf(p, agentId) {
  if (!AGENT.test(agentId ?? "")) throw new TeamError("invalid_member", "bad agent id");
  let configured;
  try {
    configured = JSON.parse(await fs.readFile(p.configPath, "utf8")).agents?.entries?.[agentId]?.workspace;
  } catch { /* No readable config: the default location below. */ }
  const workspace = path.resolve(configured ?? path.join(p.stateDir, "workspace", agentId));
  const relative = path.relative(p.stateDir, workspace);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new TeamError("member_workspace", "the member's workspace is outside managed storage", 409);
  await fs.mkdir(workspace, { recursive: true, mode: 0o755 });
  return workspace;
}

/** The entry `repo` in the workspace if it is a real directory; a link put there is never followed. */
async function existingCopy(workspace) {
  const target = path.join(workspace, MEMBER_REPO);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TeamError("member_repo_layout", "the member's repo folder was replaced", 409);
    return target;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Clones the panel's copy into a fresh folder next to it, then moves it into the workspace. */
async function placeCopy(p, workspace, prepare) {
  const temporary = path.join(p.dir, `.member-${randomUUID()}`);
  try {
    // --no-hardlinks: the workspace belongs to the agent; shared object files would let it edit the panel's clone.
    await must(await git(["clone", "--quiet", "--no-hardlinks", p.repo, temporary]), "member clone");
    const origin = await must(await git(["remote", "get-url", "origin"], { cwd: p.repo }), "origin");
    await must(await git(["remote", "set-url", "origin", origin], { cwd: temporary }), "member remote");
    await git(["config", "user.name", "ClawDesk agent"], { cwd: temporary });
    await git(["config", "user.email", "agent@clawdesk.local"], { cwd: temporary });
    await prepare(temporary);
    const target = path.join(workspace, MEMBER_REPO);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(temporary, target);
    return target;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** Clones the repository for the panel and keeps the token aside; members get their copies separately. */
export async function cloneTeamRepo({ teamId, repoUrl, token }, dirs) {
  const p = teamPaths(teamId, dirs);
  if (!GITHUB_REPO.test(repoUrl ?? "")) throw new TeamError("invalid_repo", "expected https://github.com/<owner>/<repo>");
  if (!TOKEN.test(token ?? "")) throw new TeamError("invalid_token", "expected a GitHub token (github_pat_… or ghp_…)");
  await fs.rm(p.dir, { recursive: true, force: true });
  await fs.mkdir(p.dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(p.token, `${token}\n`, { mode: 0o600 });
  try {
    await must(await git(["clone", "--quiet", repoUrl, p.repo], { token }), "clone");
    const base = await must(await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: p.repo }), "default branch");
    return { defaultBranch: base, branch: p.branch };
  } catch (error) {
    await fs.rm(p.dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A member's copy at <workspace>/repo. The developer's is created once on its branch and then kept (it
 * holds the work); a developer clone from before this layout (<team>/dev) is moved in with its history and
 * uncommitted changes. PM's and reviewer's copies are replaced by a fresh copy of the panel's clone, which
 * also carries the developer's branch (agent/<teamId>, as read at the last status or fetch).
 */
export async function prepareMemberRepo({ teamId, agentId, role }, dirs) {
  const p = teamPaths(teamId, dirs);
  if (!ROLES.has(role)) throw new TeamError("invalid_member", "bad role");
  const workspace = await workspaceOf(p, agentId);
  if (role === "developer") {
    const current = await existingCopy(workspace);
    if (current) return { path: current, moved: false };
    try {
      await fs.rename(p.legacyDev, path.join(workspace, MEMBER_REPO));
      return { path: path.join(workspace, MEMBER_REPO), moved: true };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const target = await placeCopy(p, workspace, async (copy) => {
      const known = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${p.branch}`], { cwd: copy });
      await must(await git(["checkout", "--quiet", "-b", p.branch, ...(known.code === 0 ? [`origin/${p.branch}`] : [])], { cwd: copy }), "developer branch");
    });
    return { path: target, moved: false };
  }
  await existingCopy(workspace);
  // The developer's branch as a local branch too, the way the reviewer's instructions name it.
  return { path: await placeCopy(p, workspace, async (copy) => {
    if ((await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${p.branch}`], { cwd: copy })).code === 0) await must(await git(["branch", "--quiet", p.branch, `origin/${p.branch}`], { cwd: copy }), "developer branch");
  }), moved: false };
}

/** The developer's copy: in its workspace, or (not yet moved) where the old layout kept it. */
async function developerCopy(p, developer) {
  const current = developer ? await existingCopy(await workspaceOf(p, developer)) : null;
  if (current) return current;
  try {
    if ((await fs.lstat(p.legacyDev)).isDirectory()) return p.legacyDev;
  } catch { /* none */ }
  throw new TeamError("no_developer_copy", "the developer has no copy of the repository", 409);
}

/** Reads the developer's branch into the panel's clone (git fetch from a path: nothing of the copy runs here). */
async function readDeveloperBranch(p, developer) {
  const copy = await developerCopy(p, developer);
  await must(await git(["fetch", "--quiet", "--no-tags", copy, `+refs/heads/${p.branch}:refs/heads/${p.branch}`], { cwd: p.repo }), "developer branch");
  return copy;
}

/** New commits from GitHub into the panel's clone, the developer's branch read back, read copies refreshed. */
export async function fetchTeamRepo({ teamId, members = [] }, dirs) {
  const p = teamPaths(teamId, dirs);
  const token = await readToken(p);
  await must(await git(["fetch", "--quiet", "origin"], { cwd: p.repo, token }), "fetch");
  const base = await must(await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: p.repo }), "default branch");
  await must(await git(["merge", "--quiet", "--ff-only", `origin/${base}`], { cwd: p.repo }), "update");
  const developer = members.find((member) => member.role === "developer")?.agentId;
  await readDeveloperBranch(p, developer).catch(() => undefined);
  for (const member of members.filter((item) => item.role !== "developer")) await prepareMemberRepo({ teamId, ...member }, dirs);
  return teamRepoStatus({ teamId, developer }, dirs);
}

export async function teamRepoStatus({ teamId, developer }, dirs) {
  const p = teamPaths(teamId, dirs);
  const base = await must(await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: p.repo }), "default branch");
  const copy = await readDeveloperBranch(p, developer);
  const known = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`], { cwd: p.repo })).code === 0;
  const ahead = known ? Number(await must(await git(["rev-list", "--count", `${base}..${p.branch}`], { cwd: p.repo }), "count")) : 0;
  const dirty = (await git([...UNTRUSTED, "status", "--porcelain"], { cwd: copy })).out.length > 0;
  const last = known ? (await git(["log", "-1", "--format=%h %s", p.branch], { cwd: p.repo })).out || null : null;
  return { defaultBranch: base, branch: p.branch, ahead, uncommitted: dirty, lastCommit: last };
}

async function github(token, method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Pushes the developer's branch from the panel's clone and opens (or finds) its pull request. */
export async function pushTeamBranch({ teamId, repoUrl, developer, title, body }, dirs) {
  const p = teamPaths(teamId, dirs);
  const m = GITHUB_REPO.exec(repoUrl ?? "");
  if (!m) throw new TeamError("invalid_repo", "expected https://github.com/<owner>/<repo>");
  const token = await readToken(p);
  const status = await teamRepoStatus({ teamId, developer }, dirs);
  if (status.ahead === 0) throw new TeamError("nothing_to_push", "the developer has no new commits", 409);
  await must(await git(["push", "--quiet", "origin", `refs/heads/${p.branch}:refs/heads/${p.branch}`], { cwd: p.repo, token }), "push");
  const [owner, repo] = [m[1], m[2]];
  const created = await github(token, "POST", `/repos/${owner}/${repo}/pulls`, {
    title: String(title || `Changes from the ${teamId} team`).slice(0, 200),
    body: String(body || "Prepared by ClawDesk agents. Review before merging.").slice(0, 10_000),
    head: p.branch,
    base: status.defaultBranch,
  });
  if (created.status === 201) return { url: created.body.html_url, number: created.body.number, created: true };
  // 422: a pull request for this branch already exists — the push updated it.
  const open = await github(token, "GET", `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(p.branch)}&state=open`);
  const existing = Array.isArray(open.body) ? open.body[0] : null;
  if (existing) return { url: existing.html_url, number: existing.number, created: false };
  throw new TeamError("pull_request_failed", created.body?.message ?? `GitHub answered ${created.status}`, 502);
}

/** The panel's clone and token; members' copies go with their workspaces when the agents are deleted. */
export async function removeTeamRepo({ teamId }, dirs) {
  await fs.rm(teamPaths(teamId, dirs).dir, { recursive: true, force: true });
  return { ok: true };
}
