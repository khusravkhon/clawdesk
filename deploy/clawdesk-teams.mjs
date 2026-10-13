// Project teams' repositories for the ClawDesk bridge (runs in the Gateway container).
//
//   <state>/teams/<teamId>/repo           clone of the default branch: PM and reviewer read it (sandbox bind, ro)
//   <state>/teams/<teamId>/dev            the developer's own clone on branch agent/<teamId> (sandbox bind, rw)
//   <state>/teams/<teamId>/.github-token  fine-grained token, 0600 — never mounted into a sandbox
//
// Sandboxes have no network, so agents never push: the owner presses "push and open a pull request" in the
// panel, and this module pushes the developer's branch with the token and opens the pull request.
// The token is passed per command as an HTTP header, so it never lands in a .git/config an agent can read.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/var/lib/clawdesk/openclaw";
export const TEAMS_DIR = path.join(STATE_DIR, "teams");
const TEAM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const TOKEN = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/;

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

function paths(teamId) {
  if (!TEAM_ID.test(teamId ?? "")) throw new TeamError("invalid_team", "bad team id");
  const dir = path.join(TEAMS_DIR, teamId);
  return { dir, repo: path.join(dir, "repo"), dev: path.join(dir, "dev"), token: path.join(dir, ".github-token"), branch: `agent/${teamId}` };
}

async function readToken(p) {
  try {
    return (await fs.readFile(p.token, "utf8")).trim();
  } catch {
    throw new TeamError("no_token", "the team has no GitHub token", 409);
  }
}

/** Clones the repository twice (read-only copy and the developer's branch) and keeps the token aside. */
export async function cloneTeamRepo({ teamId, repoUrl, token }) {
  const p = paths(teamId);
  if (!GITHUB_REPO.test(repoUrl ?? "")) throw new TeamError("invalid_repo", "expected https://github.com/<owner>/<repo>");
  if (!TOKEN.test(token ?? "")) throw new TeamError("invalid_token", "expected a GitHub token (github_pat_… or ghp_…)");
  await fs.rm(p.dir, { recursive: true, force: true });
  await fs.mkdir(p.dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(p.token, `${token}\n`, { mode: 0o600 });
  try {
    await must(await git(["clone", "--quiet", repoUrl, p.repo], { token }), "clone");
    const base = await must(await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: p.repo }), "default branch");
    // The developer's clone comes from the local one (fast), then points at GitHub like the first.
    await must(await git(["clone", "--quiet", p.repo, p.dev]), "developer clone");
    await must(await git(["remote", "set-url", "origin", repoUrl], { cwd: p.dev }), "developer remote");
    await must(await git(["checkout", "--quiet", "-b", p.branch], { cwd: p.dev }), "developer branch");
    for (const cwd of [p.repo, p.dev]) {
      await git(["config", "user.name", "ClawDesk agent"], { cwd });
      await git(["config", "user.email", "agent@clawdesk.local"], { cwd });
    }
    return { defaultBranch: base, branch: p.branch, repoPath: p.repo, devPath: p.dev };
  } catch (error) {
    await fs.rm(p.dir, { recursive: true, force: true });
    throw error;
  }
}

/** New commits from GitHub into the read-only copy; the developer's branch is shown there too. */
export async function fetchTeamRepo({ teamId }) {
  const p = paths(teamId);
  const token = await readToken(p);
  await must(await git(["fetch", "--quiet", "origin"], { cwd: p.repo, token }), "fetch");
  const base = await must(await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: p.repo }), "default branch");
  await must(await git(["merge", "--quiet", "--ff-only", `origin/${base}`], { cwd: p.repo }), "update");
  await git(["fetch", "--quiet", p.dev, `+${p.branch}:${p.branch}`], { cwd: p.repo });
  return teamRepoStatus({ teamId });
}

export async function teamRepoStatus({ teamId }) {
  const p = paths(teamId);
  const base = await must(await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: p.repo }), "default branch");
  await git(["fetch", "--quiet", p.dev, `+${p.branch}:${p.branch}`], { cwd: p.repo });
  const ahead = Number(await must(await git(["rev-list", "--count", `${base}..${p.branch}`], { cwd: p.repo }), "count"));
  const dirty = (await git(["status", "--porcelain"], { cwd: p.dev })).out.length > 0;
  const last = (await git(["log", "-1", "--format=%h %s", p.branch], { cwd: p.repo })).out || null;
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

/** Pushes the developer's branch and opens (or finds) its pull request. */
export async function pushTeamBranch({ teamId, repoUrl, title, body }) {
  const p = paths(teamId);
  const m = GITHUB_REPO.exec(repoUrl ?? "");
  if (!m) throw new TeamError("invalid_repo", "expected https://github.com/<owner>/<repo>");
  const token = await readToken(p);
  const status = await teamRepoStatus({ teamId });
  if (status.ahead === 0) throw new TeamError("nothing_to_push", "the developer has no new commits", 409);
  await must(await git(["push", "--quiet", "origin", `${p.branch}:${p.branch}`], { cwd: p.dev, token }), "push");
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

export async function removeTeamRepo({ teamId }) {
  await fs.rm(paths(teamId).dir, { recursive: true, force: true });
  return { ok: true };
}
