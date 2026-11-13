import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { ProjectFolderError } from "./clawdesk-project-folders.mjs";
import { withDirectoryWithin } from "./clawdesk-file-sync.mjs";

// P7: a project's folder on GitHub (runs in the Gateway container, which has the network).
//
//   <state>/clawdesk/project-github/<projectId>/token       the owner's token, 0600, never in the project folder
//   <state>/clawdesk/project-github/<projectId>/state.json  the repository and the step reached
//
// Create a new repository (private by default), with a first push of exactly the files the owner saw in the
// plan: secrets, local databases, dependencies and large files are left out, by name and by content. A retry
// checks what the previous attempt did: it continues with a repository this project created and refuses one
// it did not. Later changes go to a new branch and a pull request; nothing is ever force-pushed. Agents never
// see the token: they work on copies; git runs here, in the project folder, with the token passed per command.

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const TOKEN = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/;
const MAX_FILES = 2000, MAX_FILE = 5 * 1024 * 1024, MAX_TOTAL = 50 * 1024 * 1024;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const UNTRUSTED = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
/** Left out by name: version control, the panel's own files, dependencies, local data, secrets. */
export const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".cache"]);
export const SKIP_FILE = /(^\.env(\..*)?$)|(\.sqlite(-wal|-shm|-journal)?$)|(\.db$)|(\.pem$)|(\.key$)|(^id_(rsa|ed25519|ecdsa)(\.pub)?$)|(\.p12$)|(\.pfx$)|(^\.clawdesk)|(\.log$)/i;
/** Left out by content: things that look like credentials. */
export const SECRET = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bsk-[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/];
export const GITIGNORE = [".env", ".env.*", "*.sqlite", "*.sqlite-*", "*.db", "*.pem", "*.key", "node_modules/", "dist/", "build/", ".clawdesk*", "*.log", ""].join("\n");

const fail = (code, status = 409) => { throw new ProjectFolderError(code, status); };
const sha = (value) => createHash("sha256").update(value).digest("hex");

function git(args, { cwd, token, timeoutMs = 300_000 } = {}) {
  const auth = token ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : [];
  return new Promise((resolve) => {
    const child = spawn("git", [...UNTRUSTED, "-c", "user.name=ClawDesk", "-c", "user.email=clawdesk@localhost", ...auth, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, out, err: String(e) }); });
  });
}
async function must(res, _what) {
  if (res.code !== 0) fail("github_git_failed", 502);
  return res.out;
}

export class ProjectGitHub {
  /**
   * `api(token, method, path, body)` calls the GitHub REST API; `remote(owner, name)` is the push URL. Both are
   * injectable so tests run against a local bare repository.
   */
  constructor({ folders, stateDir, api = githubApi, remote = (owner, name) => `https://github.com/${owner}/${name}.git` }) {
    Object.assign(this, { folders, stateDir, api, remote });
  }

  #dir(projectId) {
    if (typeof projectId !== "string" || !ID.test(projectId)) fail("invalid_github_request", 400);
    return `clawdesk/project-github/${projectId}`;
  }

  async #read(projectId) {
    return withDirectoryWithin(this.stateDir, this.#dir(projectId), async (dir) => {
      const read = async (name) => { try { return await fs.readFile(`${dir}/${name}`, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
      const state = await read("state.json");
      return { token: (await read("token"))?.trim() ?? null, state: state ? JSON.parse(state) : null };
    }, true);
  }

  async #write(projectId, { token, state }) {
    await withDirectoryWithin(this.stateDir, this.#dir(projectId), async (dir) => {
      const put = async (name, data) => {
        const temporary = `${dir}/.${name}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 }); await fs.rename(temporary, `${dir}/${name}`); }
        finally { await fs.unlink(temporary).catch(() => {}); }
      };
      if (token !== undefined) await put("token", `${token}\n`);
      if (state !== undefined) await put("state.json", JSON.stringify(state));
    }, true);
  }

  /** The folder's files for a push: what goes, and what is left out and why. Read without following links. */
  async #files(directory) {
    const included = [], excluded = [];
    let total = 0;
    const walk = async (relative) => {
      const entries = await fs.readdir(relative ? `${directory}/${relative}` : directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) { excluded.push({ path: name, reason: "link" }); continue; }
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".clawdesk")) { if (entry.name !== ".git") excluded.push({ path: `${name}/`, reason: "generated" }); continue; }
          await walk(name);
          continue;
        }
        if (!entry.isFile()) continue;
        if (SKIP_FILE.test(entry.name)) { excluded.push({ path: name, reason: "secret_or_local" }); continue; }
        const handle = await fs.open(`${directory}/${name}`, READ);
        try {
          const stat = await handle.stat();
          if (stat.size > MAX_FILE) { excluded.push({ path: name, reason: "too_large" }); continue; }
          const data = await handle.readFile();
          if (SECRET.some((pattern) => pattern.test(data.toString("latin1")))) { excluded.push({ path: name, reason: "looks_like_secret" }); continue; }
          total += stat.size;
          if (included.length >= MAX_FILES || total > MAX_TOTAL) fail("github_project_too_large", 413);
          included.push({ path: name, size: stat.size, hash: sha(data) });
        } finally { await handle.close(); }
      }
    };
    await walk("");
    return { included, excluded };
  }

  async #git(directory) {
    const real = await fs.realpath(directory);
    const present = await fs.lstat(`${real}/.git`).then((stat) => stat.isDirectory(), () => false);
    return { real, present };
  }

  /** What is connected and how the folder compares with GitHub. The token is never returned. */
  async status(projectId) {
    const { token, state } = await this.#read(projectId);
    return this.folders.withWorkspace(projectId, async (workspace) => {
      const { real, present } = await this.#git(workspace.directory);
      let local = null;
      if (present && state?.repo) {
        const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: real })).out || null;
        const changes = (await this.#changes(real, workspace.directory)).length;
        local = { branch, changes };
      }
      return { tokenSaved: !!token, repo: state?.repo ?? null, step: state?.step ?? null, pullRequests: state?.pullRequests ?? [], git: present, local, mode: workspace.mode };
    });
  }

  /** The first push's plan for a new repository; its hash is what the owner confirms. */
  async plan(projectId) {
    return this.folders.withWorkspace(projectId, async (workspace) => {
      const { present } = await this.#git(workspace.directory);
      if (present) fail("github_folder_has_git");
      const files = await this.#files(workspace.directory);
      const addGitignore = !files.included.some((file) => file.path === ".gitignore");
      const planHash = sha(JSON.stringify([files.included.map((file) => [file.path, file.hash]), addGitignore]));
      return { files: files.included.map(({ path, size }) => ({ path, size })), excluded: files.excluded, addGitignore, planHash };
    });
  }

  /**
   * Creates the repository (or continues with one this project created before) and pushes exactly the
   * confirmed plan to its default branch. A repository with that name not created by this project is refused.
   */
  async create(projectId, { token, owner, name, visibility = "private", planHash, requestId }) {
    if (token !== undefined && !TOKEN.test(token ?? "")) fail("invalid_token", 400);
    if (!OWNER.test(owner ?? "") || !REPO.test(name ?? "") || name.startsWith(".") || !["private", "public"].includes(visibility) || typeof planHash !== "string" || typeof requestId !== "string") fail("invalid_github_request", 400);
    const saved = await this.#read(projectId);
    if (saved.state?.step === "pushed") {
      if (saved.state.requestId === requestId) return this.status(projectId);
      fail("github_already_connected");
    }
    const secret = token ?? saved.token;
    if (!secret) fail("github_token_required", 400);
    if (token) await this.#write(projectId, { token });
    // Who the token is: a user, or an organization it may create repositories in.
    const user = await this.api(secret, "GET", "/user");
    if (user.status === 401) fail("github_token_rejected");
    if (user.status !== 200) fail("github_unreachable", 502);
    const login = user.body.login;
    // 1. The repository: continue with ours, refuse anyone else's.
    let repo = saved.state?.repo ?? null;
    const existing = await this.api(secret, "GET", `/repos/${owner}/${name}`);
    if (existing.status === 200) {
      if (!repo || repo.id !== existing.body.id) fail("github_repo_exists");
    } else if (existing.status === 404) {
      if (repo) fail("github_repo_gone");
      const created = await this.api(secret, "POST", owner.toLowerCase() === String(login).toLowerCase() ? "/user/repos" : `/orgs/${owner}/repos`, { name, private: visibility === "private", auto_init: false, description: "Created from ClawDesk" });
      if (created.status === 403 || created.status === 404) fail("github_no_permission");
      if (created.status === 422) fail("github_repo_exists");
      if (created.status !== 201) fail("github_unreachable", 502);
      // Private was asked for and the account cannot make one: never fall back to public silently.
      if (visibility === "private" && created.body.private !== true) fail("github_private_unavailable");
      repo = { id: created.body.id, owner: created.body.owner?.login ?? owner, name: created.body.name, url: created.body.html_url, private: created.body.private === true, defaultBranch: "main" };
      await this.#write(projectId, { state: { requestId, step: "created", repo, pullRequests: [] } });
    } else if (existing.status === 401) fail("github_token_rejected");
    else fail("github_unreachable", 502);
    // 2. The first push of exactly the plan.
    await this.folders.withWorkspace(projectId, async (workspace) => {
      const { real, present } = await this.#git(workspace.directory);
      if (present && saved.state?.step !== "committed") fail("github_folder_has_git");
      if (!present) {
        const files = await this.#files(workspace.directory);
        const addGitignore = !files.included.some((file) => file.path === ".gitignore");
        if (sha(JSON.stringify([files.included.map((file) => [file.path, file.hash]), addGitignore])) !== planHash) fail("github_plan_changed");
        if (addGitignore) await fs.writeFile(`${real}/.gitignore`, GITIGNORE, { flag: "wx", mode: 0o644 });
        await must(await git(["init", "--quiet", "-b", repo.defaultBranch], { cwd: real }), "init");
        const list = [...files.included.map((file) => file.path), ...(addGitignore ? [".gitignore"] : [])];
        for (let index = 0; index < list.length; index += 200) await must(await git(["add", "--", ...list.slice(index, index + 200)], { cwd: real }), "add");
        await must(await git(["commit", "--quiet", "-m", "Initial commit from ClawDesk"], { cwd: real }), "commit");
        await this.#write(projectId, { state: { requestId, step: "committed", repo, pullRequests: [] } });
      }
      const url = this.remote(repo.owner, repo.name);
      if ((await git(["remote", "get-url", "origin"], { cwd: real })).code !== 0) await must(await git(["remote", "add", "origin", url], { cwd: real }), "remote");
      await must(await git(["push", "--quiet", "origin", `refs/heads/${repo.defaultBranch}:refs/heads/${repo.defaultBranch}`], { cwd: real, token: secret }), "push");
    });
    await this.#write(projectId, { state: { requestId, step: "pushed", repo, pullRequests: [], baseline: await this.#baseline(projectId) } });
    return this.status(projectId);
  }

  async #baseline(projectId) {
    return this.folders.withWorkspace(projectId, async (workspace) => (await this.#files(workspace.directory)).included.map((file) => [file.path, file.hash]));
  }

  /** Files that differ from the last pushed state, with the same exclusions as the first push. */
  async #changes(real, directory) {
    const head = new Map(((await git(["ls-tree", "-r", "--format=%(path) %(objectname)", "HEAD"], { cwd: real })).out || "").split("\n").filter(Boolean).map((line) => { const i = line.lastIndexOf(" "); return [line.slice(0, i), line.slice(i + 1)]; }));
    const now = (await this.#files(directory)).included;
    const changes = [];
    for (const file of now) {
      const blob = (await git(["hash-object", "--", file.path], { cwd: real })).out;
      if (head.get(file.path) !== blob) changes.push({ path: file.path, change: head.has(file.path) ? "modified" : "added" });
    }
    // Removed means gone from the disk: a tracked file the push rules leave out (a committed .env) is not removed.
    for (const name of head.keys()) {
      if (now.some((file) => file.path === name)) continue;
      if (await fs.lstat(path.join(real, name)).then(() => false, () => true)) changes.push({ path: name, change: "removed" });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The changes since the default branch, for the owner to confirm before a pull request. */
  async changes(projectId) {
    const { state } = await this.#read(projectId);
    if (state?.step !== "pushed") fail("github_not_connected");
    return this.folders.withWorkspace(projectId, async (workspace) => {
      const { real } = await this.#git(workspace.directory);
      const changes = await this.#changes(real, workspace.directory);
      return { changes, changesHash: sha(JSON.stringify(changes)) };
    });
  }

  /**
   * Commits the confirmed changes to a new branch, pushes it and opens a pull request; the default branch
   * is not touched locally or on GitHub. The same requestId does not open a second pull request.
   */
  async pullRequest(projectId, { title, body, changesHash, requestId }) {
    const { token, state } = await this.#read(projectId);
    if (state?.step !== "pushed") fail("github_not_connected");
    if (!token) fail("github_token_required", 400);
    if (typeof requestId !== "string" || typeof changesHash !== "string") fail("invalid_github_request", 400);
    const done = (state.pullRequests ?? []).find((pr) => pr.requestId === requestId);
    if (done) return done;
    const repo = state.repo, branch = `clawdesk/changes-${(state.pullRequests?.length ?? 0) + 1}-${requestId.slice(0, 8)}`;
    await this.folders.withWorkspace(projectId, async (workspace) => {
      const { real } = await this.#git(workspace.directory);
      const changes = await this.#changes(real, workspace.directory);
      if (!changes.length) fail("github_nothing_to_push");
      if (sha(JSON.stringify(changes)) !== changesHash) fail("github_plan_changed");
      // A temporary index: the branch is built from the default branch plus exactly these files.
      const index = `${real}/.git/clawdesk-index-${randomUUID()}`;
      const env = { GIT_INDEX_FILE: index };
      try {
        const run = (args) => new Promise((resolve) => {
          const child = spawn("git", [...UNTRUSTED, "-c", "user.name=ClawDesk", "-c", "user.email=clawdesk@localhost", ...args], { cwd: real, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
          let out = ""; child.stdout.on("data", (c) => (out += c)); child.on("close", (code) => resolve({ code, out: out.trim(), err: "" })); child.on("error", () => resolve({ code: null, out: "", err: "" }));
        });
        await must(await run(["read-tree", "HEAD"]), "read-tree");
        for (const change of changes) await must(await run(change.change === "removed" ? ["rm", "--cached", "--quiet", "--", change.path] : ["add", "--", change.path]), "stage");
        const tree = await must(await run(["write-tree"]), "write-tree");
        const commit = await must(await run(["commit-tree", tree, "-p", "HEAD", "-m", String(title || "Changes from ClawDesk").slice(0, 200)]), "commit-tree");
        await must(await git(["push", "--quiet", "origin", `${commit}:refs/heads/${branch}`], { cwd: real, token }), "push");
      } finally { await fs.unlink(index).catch(() => {}); }
    });
    const created = await this.api(token, "POST", `/repos/${repo.owner}/${repo.name}/pulls`, { title: String(title || "Changes from ClawDesk").slice(0, 200), body: String(body || "Prepared in ClawDesk. Review before merging.").slice(0, 10_000), head: branch, base: repo.defaultBranch });
    if (created.status !== 201) fail("github_pull_request_failed", 502);
    const pr = { requestId, url: created.body.html_url, number: created.body.number, branch, at: Date.now() };
    await this.#write(projectId, { state: { ...state, pullRequests: [...(state.pullRequests ?? []), pr] } });
    return pr;
  }

  /** owner/name of a GitHub remote URL (https or git@), or null. */
  static parseRemote(url) {
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
    return match ? { owner: match[1], name: match[2] } : null;
  }

  async #repoInfo(token, owner, name) {
    const res = await this.api(token, "GET", `/repos/${owner}/${name}`);
    if (res.status === 401) fail("github_token_rejected");
    if (res.status === 404 || res.status === 403) fail("github_repo_not_found");
    if (res.status !== 200) fail("github_unreachable", 502);
    if (res.body.permissions && res.body.permissions.push === false) fail("github_no_permission");
    return { id: res.body.id, owner: res.body.owner?.login ?? owner, name: res.body.name ?? name, url: res.body.html_url ?? `https://github.com/${owner}/${name}`, private: res.body.private === true, defaultBranch: res.body.default_branch || "main" };
  }

  /**
   * Connects a folder that already has git and a GitHub "origin" (an existing project, or a clone): nothing in
   * the folder changes; later changes go to pull requests like for a repository created here.
   */
  async connect(projectId, { token, requestId }) {
    if (token !== undefined && !TOKEN.test(token ?? "")) fail("invalid_token", 400);
    if (typeof requestId !== "string") fail("invalid_github_request", 400);
    const saved = await this.#read(projectId);
    if (saved.state?.step === "pushed") { if (saved.state.requestId === requestId) return this.status(projectId); fail("github_already_connected"); }
    const secret = token ?? saved.token;
    if (!secret) fail("github_token_required", 400);
    const origin = await this.folders.withWorkspace(projectId, async (workspace) => {
      const { real, present } = await this.#git(workspace.directory);
      if (!present) fail("github_folder_has_no_git");
      return (await git(["remote", "get-url", "origin"], { cwd: real })).out;
    });
    const remote = ProjectGitHub.parseRemote(origin);
    if (!remote) fail("github_no_origin");
    const repo = await this.#repoInfo(secret, remote.owner, remote.name);
    if (token) await this.#write(projectId, { token });
    await this.#write(projectId, { state: { requestId, step: "pushed", repo: { ...repo, connected: true }, pullRequests: [] } });
    return this.status(projectId);
  }

  /**
   * Clones a GitHub repository into a new folder of the allowed root and links it to the project as an
   * existing folder. A folder name already taken is refused; a failed clone leaves nothing behind.
   */
  async importRepo(projectId, { token, url, folder, requestId }) {
    if (token !== undefined && !TOKEN.test(token ?? "")) fail("invalid_token", 400);
    const remote = ProjectGitHub.parseRemote(url);
    if (!remote || typeof folder !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u.test(folder) || typeof requestId !== "string") fail("invalid_github_request", 400);
    const saved = await this.#read(projectId);
    if (saved.state?.step === "pushed") { if (saved.state.requestId === requestId) return this.status(projectId); fail("github_already_connected"); }
    const secret = token ?? saved.token;
    if (!secret) fail("github_token_required", 400);
    if ((await this.folders.status(projectId)).workspace) fail("workspace_already_linked");
    const repo = await this.#repoInfo(secret, remote.owner, remote.name);
    if (token) await this.#write(projectId, { token });
    await withDirectoryWithin(this.stateDir, "company-projects", async (root) => {
      const real = await fs.realpath(root);
      if (await fs.lstat(`${real}/${folder}`).then(() => true, () => false)) fail("workspace_exists");
      const temporary = `${real}/.clawdesk-clone-${randomUUID()}`;
      try {
        await must(await git(["clone", "--quiet", this.remote(repo.owner, repo.name), temporary], { token: secret, timeoutMs: 10 * 60_000 }), "clone");
        await fs.rename(temporary, `${real}/${folder}`);
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    }, true);
    await this.folders.prepare({ projectId, name: folder, mode: "existing", requestId });
    await this.#write(projectId, { state: { requestId, step: "pushed", repo: { ...repo, imported: true }, pullRequests: [] } });
    return this.status(projectId);
  }

  /** Forgets the token and the connection; the repository on GitHub and the folder's history stay. */
  async disconnect(projectId) {
    await withDirectoryWithin(this.stateDir, "clawdesk/project-github", async (dir) => { await fs.rm(`${dir}/${projectId}`, { recursive: true, force: true }); }, true);
    return { ok: true };
  }
}

async function githubApi(token, method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res) return { status: 0, body: {} };
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
