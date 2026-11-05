import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectGitHub } from "./clawdesk-project-github.mjs";

// P7 against a local bare repository and a fake GitHub API: what is pushed, what is left out, retries.

const TOKEN = "github_pat_" + "a".repeat(40);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function fixture(t, { repoExists = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-pgh-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state"), folder = path.join(root, "project"), remote = path.join(root, "remote.git");
  await fs.mkdir(path.join(folder, "app"), { recursive: true }); await fs.mkdir(stateDir);
  git(root, "init", "--quiet", "--bare", remote);
  await fs.writeFile(path.join(folder, "app", "server.mjs"), "console.log('hi');\n");
  await fs.writeFile(path.join(folder, "PROJECT-REQUIREMENTS.json"), "{}\n");
  await fs.writeFile(path.join(folder, ".env"), "SECRET=1\n");
  await fs.writeFile(path.join(folder, "app", "tasks.sqlite"), "db");
  await fs.writeFile(path.join(folder, "app", "notes.txt"), "token ghp_" + "Z".repeat(36) + "\n");
  await fs.mkdir(path.join(folder, "app", "node_modules", "x"), { recursive: true });
  await fs.writeFile(path.join(folder, "app", "node_modules", "x", "index.js"), "x");
  await fs.writeFile(path.join(folder, ".clawdesk-build.json"), "{}");
  const calls = [];
  let created = repoExists ? { id: 999 } : null, fail = null;
  const api = async (token, method, url, body) => {
    calls.push([method, url, body?.private]);
    if (fail?.(method, url)) return { status: 500, body: {} };
    if (token !== TOKEN) return { status: 401, body: {} };
    if (url === "/user") return { status: 200, body: { login: "owner1" } };
    if (method === "GET" && url === "/repos/owner1/shop") return created ? { status: 200, body: { id: created.id } } : { status: 404, body: {} };
    if (method === "POST" && url === "/user/repos") { created = { id: 7 }; return { status: 201, body: { id: 7, name: body.name, private: body.private, html_url: "https://github.com/owner1/shop", owner: { login: "owner1" } } }; }
    if (method === "POST" && url === "/repos/owner1/shop/pulls") return { status: 201, body: { html_url: "https://github.com/owner1/shop/pull/1", number: 1 } };
    return { status: 404, body: {} };
  };
  const folders = { withWorkspace: async (_id, run) => run({ directory: folder, mode: "new" }) };
  const github = new ProjectGitHub({ folders, stateDir, api, remote: () => remote });
  return { root, folder, remote, stateDir, github, calls, setFail: (value) => { fail = value; } };
}

test("the first push carries exactly the plan: secrets, databases, dependencies and panel files are left out", async (t) => {
  const f = await fixture(t);
  const plan = await f.github.plan("p1");
  assert.deepEqual(plan.files.map((file) => file.path).sort(), ["PROJECT-REQUIREMENTS.json", "app/server.mjs"]);
  assert.deepEqual(plan.excluded.map((item) => [item.path, item.reason]).sort(), [[".clawdesk-build.json", "secret_or_local"], [".env", "secret_or_local"], ["app/node_modules/", "generated"], ["app/notes.txt", "looks_like_secret"], ["app/tasks.sqlite", "secret_or_local"]]);
  assert.equal(plan.addGitignore, true);
  const status = await f.github.create("p1", { token: TOKEN, owner: "owner1", name: "shop", visibility: "private", planHash: plan.planHash, requestId: "r1" });
  assert.deepEqual([status.step, status.repo.private, status.repo.url, status.tokenSaved, status.local.changes], ["pushed", true, "https://github.com/owner1/shop", true, 0]);
  assert.deepEqual(git(f.remote, "ls-tree", "-r", "--name-only", "main").split("\n"), [".gitignore", "PROJECT-REQUIREMENTS.json", "app/server.mjs"]);
  assert.ok(f.calls.some(([method, url, isPrivate]) => method === "POST" && url === "/user/repos" && isPrivate === true));
  // The token is kept outside the project folder and not in the git config.
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  assert.equal((await fs.readFile(path.join(f.folder, ".git", "config"), "utf8")).includes("github_pat_"), false);
  assert.equal((await fs.readFile(path.join(f.stateDir, "clawdesk", "project-github", "p1", "token"), "utf8")).trim(), TOKEN);
  // The same request again is the same result; another one is refused.
  assert.equal((await f.github.create("p1", { owner: "owner1", name: "shop", planHash: plan.planHash, requestId: "r1" })).step, "pushed");
  await assert.rejects(f.github.create("p1", { owner: "owner1", name: "shop", planHash: plan.planHash, requestId: "r2" }), { code: "github_already_connected" });
});

test("a plan that changed is refused, someone else's repository is never used, a retry continues ours", async (t) => {
  const taken = await fixture(t, { repoExists: true });
  const takenPlan = await taken.github.plan("p1");
  await assert.rejects(taken.github.create("p1", { token: TOKEN, owner: "owner1", name: "shop", planHash: takenPlan.planHash, requestId: "r1" }), { code: "github_repo_exists" });

  const f = await fixture(t);
  const before = await f.github.plan("p1");
  await fs.writeFile(path.join(f.folder, "app", "server.mjs"), "changed\n");
  await assert.rejects(f.github.create("p1", { token: TOKEN, owner: "owner1", name: "shop", planHash: before.planHash, requestId: "r1" }), { code: "github_plan_changed" });
  // The repository was created before the plan check: a retry with a fresh plan continues with it, no second repository.
  const plan = await f.github.plan("p1");
  const status = await f.github.create("p1", { owner: "owner1", name: "shop", planHash: plan.planHash, requestId: "r2" });
  assert.equal(status.step, "pushed");
  assert.equal(f.calls.filter(([method, url]) => method === "POST" && url === "/user/repos").length, 1);
  await assert.rejects(f.github.create("p2", { token: "nope", owner: "owner1", name: "shop", planHash: "x", requestId: "r" }), { code: "invalid_token" });
});

test("later changes go to a new branch and a pull request; the default branch is untouched", async (t) => {
  const f = await fixture(t);
  const plan = await f.github.plan("p1");
  await f.github.create("p1", { token: TOKEN, owner: "owner1", name: "shop", planHash: plan.planHash, requestId: "r1" });
  await assert.rejects(f.github.pullRequest("p1", { title: "t", changesHash: (await f.github.changes("p1")).changesHash, requestId: "pr0" }), { code: "github_nothing_to_push" });
  await fs.writeFile(path.join(f.folder, "app", "server.mjs"), "console.log('v2');\n");
  await fs.writeFile(path.join(f.folder, "app", "new.mjs"), "export {};\n");
  await fs.writeFile(path.join(f.folder, "app", "leak.txt"), "-----BEGIN RSA PRIVATE KEY-----\n");
  const { changes, changesHash } = await f.github.changes("p1");
  assert.deepEqual(changes, [{ path: "app/new.mjs", change: "added" }, { path: "app/server.mjs", change: "modified" }]);
  const pr = await f.github.pullRequest("p1", { title: "Правило BR-002", changesHash, requestId: "pr1" });
  assert.equal(pr.url, "https://github.com/owner1/shop/pull/1");
  assert.deepEqual(await f.github.pullRequest("p1", { title: "again", changesHash, requestId: "pr1" }), pr);
  assert.equal(git(f.remote, "show", `${pr.branch}:app/server.mjs`), "console.log('v2');");
  assert.equal(git(f.remote, "show", "main:app/server.mjs"), "console.log('hi');");
  assert.throws(() => git(f.remote, "show", `${pr.branch}:app/leak.txt`));
  assert.equal(git(f.folder, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal((await f.github.status("p1")).pullRequests.length, 1);
});

test("a folder that already has git is not reinitialized; a failure on GitHub leaves the folder as it was", async (t) => {
  const f = await fixture(t);
  git(f.folder, "init", "--quiet");
  await assert.rejects(f.github.plan("p1"), { code: "github_folder_has_git" });
  const g = await fixture(t);
  const plan = await g.github.plan("p1");
  g.setFail((method, url) => method === "POST" && url === "/user/repos");
  await assert.rejects(g.github.create("p1", { token: TOKEN, owner: "owner1", name: "shop", planHash: plan.planHash, requestId: "r1" }), { code: "github_unreachable" });
  await assert.rejects(fs.stat(path.join(g.folder, ".git")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(g.folder, "app", "server.mjs"), "utf8"), "console.log('hi');\n");
  await g.github.disconnect("p1");
  assert.equal((await g.github.status("p1")).tokenSaved, false);
});

test("an existing folder with a GitHub origin is connected as it is; tracked files the rules leave out are not removed", async (t) => {
  const f = await fixture(t);
  const api = f.github.api;
  f.github.api = async (token, method, url, body) => url === "/repos/owner1/site" ? { status: 200, body: { id: 11, name: "site", html_url: "https://github.com/owner1/site", private: true, default_branch: "trunk", owner: { login: "owner1" }, permissions: { push: true } } } : api(token, method, url, body);
  git(f.folder, "init", "--quiet", "-b", "trunk");
  git(f.folder, "remote", "add", "origin", "git@github.com:owner1/site.git");
  git(f.folder, "add", "-A");
  git(f.folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "existing history");
  const status = await f.github.connect("p1", { token: TOKEN, requestId: "c1" });
  assert.deepEqual([status.step, status.repo.defaultBranch, status.repo.private, status.git], ["pushed", "trunk", true, true]);
  // .env is committed in that history but never sent by the panel; it is not shown as removed either.
  assert.deepEqual((await f.github.changes("p1")).changes, []);
  await fs.writeFile(path.join(f.folder, "app", "server.mjs"), "v3\n");
  assert.deepEqual((await f.github.changes("p1")).changes, [{ path: "app/server.mjs", change: "modified" }]);
  assert.equal(git(f.folder, "log", "-1", "--format=%s"), "existing history");
  // Without a GitHub origin there is nothing to connect.
  const g = await fixture(t);
  git(g.folder, "init", "--quiet");
  await assert.rejects(g.github.connect("p1", { token: TOKEN, requestId: "c1" }), { code: "github_no_origin" });
  assert.deepEqual(ProjectGitHub.parseRemote("https://github.com/a-b/c.d.git"), { owner: "a-b", name: "c.d" });
  assert.equal(ProjectGitHub.parseRemote("https://gitlab.com/a/b"), null);
});

test("importing clones into a new folder of the root and links it; a taken name or a linked project is refused", async (t) => {
  const f = await fixture(t);
  const root = path.join(f.stateDir, "company-projects");
  await fs.mkdir(root, { recursive: true });
  // The remote has one commit to clone.
  const seed = path.join(f.root, "seed");
  git(f.root, "clone", "--quiet", f.remote, seed);
  await fs.writeFile(path.join(seed, "README.md"), "hello\n");
  git(seed, "add", "README.md");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  git(f.remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const prepared = [];
  let linked = null;
  f.github.folders = { ...f.github.folders, status: async () => ({ workspace: linked }), prepare: async (args) => { prepared.push(args); linked = { name: args.name }; return {}; } };
  const api = f.github.api;
  f.github.api = async (token, method, url, body) => url === "/repos/owner1/site" ? { status: 200, body: { id: 12, name: "site", html_url: "https://github.com/owner1/site", private: false, default_branch: "main", owner: { login: "owner1" } } } : api(token, method, url, body);
  f.github.folders.withWorkspace = async (_id, run) => run({ directory: path.join(root, "Сайт"), mode: "existing" });
  await fs.mkdir(path.join(root, "Занято"));
  await assert.rejects(f.github.importRepo("p1", { token: TOKEN, url: "https://github.com/owner1/site", folder: "Занято", requestId: "i0" }), { code: "workspace_exists" });
  const status = await f.github.importRepo("p1", { token: TOKEN, url: "https://github.com/owner1/site", folder: "Сайт", requestId: "i1" });
  assert.equal(await fs.readFile(path.join(root, "Сайт", "README.md"), "utf8"), "hello\n");
  assert.deepEqual(prepared, [{ projectId: "p1", name: "Сайт", mode: "existing", requestId: "i1" }]);
  assert.deepEqual([status.step, status.repo.name], ["pushed", "site"]);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith(".clawdesk-clone")), []);
  await assert.rejects(f.github.importRepo("p1", { url: "https://github.com/owner1/site", folder: "Другая", requestId: "i2" }), { code: "github_already_connected" });
});
