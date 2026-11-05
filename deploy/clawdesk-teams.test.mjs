import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareMemberRepo, teamPaths, teamRepoStatus } from "./clawdesk-teams.mjs";

// Members' copies live in their own workspaces (OpenClaw refuses binds from elsewhere): the panel keeps its
// clone apart, moves an old developer clone in, refreshes read copies and never lets a copy run code.

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-teams-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state"), origin = path.join(root, "origin");
  await fs.mkdir(origin, { recursive: true });
  git(origin, "init", "--quiet");
  await fs.writeFile(path.join(origin, "README.md"), "hello\n");
  git(origin, "add", "README.md");
  git(origin, "commit", "--quiet", "-m", "first");
  const dirs = { stateDir, configPath: path.join(stateDir, "openclaw.json") };
  const p = teamPaths("shop", dirs);
  await fs.mkdir(p.dir, { recursive: true });
  git(p.dir, "clone", "--quiet", origin, p.repo);
  await fs.writeFile(dirs.configPath, JSON.stringify({ agents: { entries: { "shop-reviewer": { workspace: path.join(stateDir, "workspace", "shop-reviewer") } } } }));
  return { root, stateDir, dirs, p, ws: (agent) => path.join(stateDir, "workspace", agent) };
}

test("the developer gets its branch in its workspace once, and its work survives a second prepare", async (t) => {
  const { dirs, ws } = await fixture(t);
  const first = await prepareMemberRepo({ teamId: "shop", agentId: "shop-developer", role: "developer" }, dirs);
  assert.equal(first.path, path.join(ws("shop-developer"), "repo"));
  assert.equal(git(first.path, "rev-parse", "--abbrev-ref", "HEAD"), "agent/shop");
  await fs.writeFile(path.join(first.path, "feature.txt"), "work\n");
  git(first.path, "add", "feature.txt");
  git(first.path, "commit", "--quiet", "-m", "feature");
  await prepareMemberRepo({ teamId: "shop", agentId: "shop-developer", role: "developer" }, dirs);
  assert.equal(await fs.readFile(path.join(first.path, "feature.txt"), "utf8"), "work\n");
  const status = await teamRepoStatus({ teamId: "shop", developer: "shop-developer" }, dirs);
  assert.deepEqual({ ...status, lastCommit: status.lastCommit?.replace(/^\w+ /, "") }, { defaultBranch: "main", branch: "agent/shop", ahead: 1, uncommitted: false, lastCommit: "feature" });
});

test("an old developer clone is moved into the workspace with its uncommitted changes", async (t) => {
  const { dirs, p, ws } = await fixture(t);
  git(p.dir, "clone", "--quiet", p.repo, p.legacyDev);
  git(p.legacyDev, "checkout", "--quiet", "-b", p.branch);
  await fs.writeFile(path.join(p.legacyDev, "draft.txt"), "not committed\n");
  // Before the move the panel still finds the old clone.
  assert.equal((await teamRepoStatus({ teamId: "shop", developer: "shop-developer" }, dirs)).uncommitted, true);
  const moved = await prepareMemberRepo({ teamId: "shop", agentId: "shop-developer", role: "developer" }, dirs);
  assert.equal(moved.moved, true);
  assert.equal(await fs.readFile(path.join(ws("shop-developer"), "repo", "draft.txt"), "utf8"), "not committed\n");
  await assert.rejects(fs.access(p.legacyDev));
});

test("read copies are replaced from the panel's clone and carry the developer's branch", async (t) => {
  const { dirs, ws } = await fixture(t);
  const dev = await prepareMemberRepo({ teamId: "shop", agentId: "shop-developer", role: "developer" }, dirs);
  await fs.writeFile(path.join(dev.path, "feature.txt"), "work\n");
  git(dev.path, "add", "feature.txt");
  git(dev.path, "commit", "--quiet", "-m", "feature");
  await teamRepoStatus({ teamId: "shop", developer: "shop-developer" }, dirs);
  const reviewer = await prepareMemberRepo({ teamId: "shop", agentId: "shop-reviewer", role: "reviewer" }, dirs);
  await fs.writeFile(path.join(reviewer.path, "scribble.txt"), "the reviewer's own edit\n");
  await prepareMemberRepo({ teamId: "shop", agentId: "shop-reviewer", role: "reviewer" }, dirs);
  await assert.rejects(fs.access(path.join(ws("shop-reviewer"), "repo", "scribble.txt")));
  assert.match(git(reviewer.path, "log", "--format=%s", "agent/shop", "-1"), /feature/);
  // No object files shared with the panel's clone.
  const objects = path.join(reviewer.path, ".git", "objects");
  for (const entry of await fs.readdir(objects, { recursive: true, withFileTypes: true })) if (entry.isFile()) assert.equal((await fs.stat(path.join(entry.parentPath, entry.name))).nlink, 1);
});

test("a copy's config cannot run code in the Gateway, and a link in place of the copy is refused", async (t) => {
  const { root, dirs, ws } = await fixture(t);
  const dev = await prepareMemberRepo({ teamId: "shop", agentId: "shop-developer", role: "developer" }, dirs);
  const marker = path.join(root, "ran");
  const script = path.join(root, "evil.sh");
  await fs.writeFile(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  git(dev.path, "config", "core.fsmonitor", script);
  git(dev.path, "config", "core.hooksPath", root);
  await fs.copyFile(script, path.join(root, "reference-transaction"));
  await fs.chmod(path.join(root, "reference-transaction"), 0o755);
  await teamRepoStatus({ teamId: "shop", developer: "shop-developer" }, dirs);
  await assert.rejects(fs.access(marker));

  await fs.mkdir(path.join(root, "elsewhere"));
  await fs.mkdir(ws("shop-reviewer"), { recursive: true });
  await fs.symlink(path.join(root, "elsewhere"), path.join(ws("shop-reviewer"), "repo"));
  await assert.rejects(prepareMemberRepo({ teamId: "shop", agentId: "shop-reviewer", role: "reviewer" }, dirs), { code: "member_repo_layout" });
  assert.deepEqual(await fs.readdir(path.join(root, "elsewhere")), []);
});

test("refuses a workspace outside the state folder and bad members", async (t) => {
  const { root, dirs } = await fixture(t);
  await fs.writeFile(dirs.configPath, JSON.stringify({ agents: { entries: { "shop-pm": { workspace: root } } } }));
  await assert.rejects(prepareMemberRepo({ teamId: "shop", agentId: "shop-pm", role: "pm" }, dirs), { code: "member_workspace" });
  await assert.rejects(prepareMemberRepo({ teamId: "shop", agentId: "../x", role: "pm" }, dirs), { code: "invalid_member" });
  await assert.rejects(prepareMemberRepo({ teamId: "shop", agentId: "shop-pm", role: "owner" }, dirs), { code: "invalid_member" });
  await assert.rejects(teamRepoStatus({ teamId: "shop", developer: "shop-developer" }, dirs), { code: "no_developer_copy" });
});
