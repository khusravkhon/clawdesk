import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ProjectFolderError } from "./clawdesk-project-folders.mjs";
import { withDirectoryWithin, withChildDirectoryWithin } from "./clawdesk-file-sync.mjs";
import { resetGateway } from "./clawdesk-backup.mjs";
import { APP_BOOTSTRAP, CHECKS_BOOTSTRAP, attemptOf, CHECK_ARGUMENT_LIMIT, CHECK_FILE, CHECK_PAYLOAD_LIMIT, checkIsolation, filesFingerprint, joinRuns, parseCheckOutput, selectCheckFiles } from "./clawdesk-project-checks.mjs";
import { LOAD_BOOTSTRAP, LOAD_LIMITS, parseLoadOutput } from "./clawdesk-project-load.mjs";
/** Hardening shared by every checks container: no network of its own, read-only root, no capabilities, a fixed user. */
const HARDENED = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000"];
/** The whole separate run (all files, both attempts) stays within this, like one shared run. */
const SEPARATE_BUDGET_MS = 150000;
const hash = value => createHash("sha256").update(value).digest("hex");
export const PROJECT_TEMPLATE_FILES = ["server.mjs", "index.html", "checks.test.mjs", "package.json", "README.md", "PROJECT-REQUIREMENTS.json", "LICENSE", ".clawdesk-build.json"];
/** Files a build record covers: projects created before a template version keep their own list. */
const recordFiles = record => Object.keys(record?.hashes ?? {});
export class ProjectBuilderError extends ProjectFolderError {
}
const fail = (code, status = 409) => {
    throw new ProjectBuilderError(code, status);
};
async function readFile(directory, name, limit = 262144) {
    const handle = await fs.open(`${directory}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit)
            fail("builder_files_changed");
        return await handle.readFile("utf8");
    }
    finally {
        await handle.close();
    }
}
/** Reads a flat project directory: regular files only (selectCheckFiles), at most CHECK_PAYLOAD_LIMIT in all. */
export async function readFlatFiles(directory) {
    const files = {};
    let size = 0;
    for (const name of selectCheckFiles(await fs.readdir(directory, { withFileTypes: true }))) {
        const data = await readFile(directory, name, CHECK_PAYLOAD_LIMIT).catch(error => {
            throw error instanceof ProjectBuilderError ? new ProjectBuilderError("checks_too_large", 413) : error;
        });
        size += Buffer.byteLength(data);
        if (size > CHECK_PAYLOAD_LIMIT)
            fail("checks_too_large", 413);
        files[name] = data;
    }
    return files;
}
/** Files handed in by the panel: the same names and limits as files read from disk. */
export function checkedFiles(files) {
    if (!files || typeof files !== "object" || Array.isArray(files))
        fail("invalid_builder_request", 400);
    let size = 0;
    for (const [name, data] of Object.entries(files)) {
        if (!CHECK_FILE.test(name) || /\.sqlite(?:-(?:wal|shm|journal))?$/.test(name) || typeof data !== "string")
            fail("invalid_builder_request", 400);
        size += Buffer.byteLength(data);
    }
    if (size > CHECK_PAYLOAD_LIMIT)
        fail("checks_too_large", 413);
    return files;
}
export function dockerCommand(args, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn("/usr/local/libexec/docker", args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", failed = false;
        const timer = setTimeout(() => {
            failed = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", chunk => {
            out += chunk;
            if (Buffer.byteLength(out) > 1048576) {
                failed = true;
                child.kill("SIGKILL");
            }
        });
        child.stderr.on("data", () => {
        });
        child.on("error", () => {
            clearTimeout(timer);
            reject(new ProjectBuilderError("preview_unavailable", 503));
        });
        child.on("close", code => {
            clearTimeout(timer);
            if (code !== 0 || failed)
                reject(new ProjectBuilderError("preview_unavailable", 503));
            else
                resolve(out);
        });
    });
}
export class ProjectBuilder {
    constructor({ folders, stateDir, command = dockerCommand, identity } = {}) {
        Object.assign(this, { folders, stateDir, command, identity });
    }
    #key(id) {
        return hash(id).slice(0, 32);
    }
    #with(id, run) {
        return this.folders.withWorkspace(id, workspace => withDirectoryWithin(this.stateDir, "", state => run(workspace, state)));
    }
    async #record(state, id) {
        try {
            return JSON.parse(await readFile(state, `clawdesk-build-${this.#key(id)}.json`));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw error;
        }
    }
    async #save(state, id, record) {
        const name = `clawdesk-build-${this.#key(id)}.json`;
        const temp = `${name}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(`${state}/${temp}`, JSON.stringify(record), { flag: "wx", mode: 384 });
            await fs.rename(`${state}/${temp}`, `${state}/${name}`);
        }
        finally {
            await fs.unlink(`${state}/${temp}`).catch(() => {
            });
        }
    }
    async #verify(workspace, record) {
        if (!record || record.identity !== workspace.identity || record.templateId !== "task-board-v1")
            fail("builder_files_changed");
        const entries = await fs.readdir(workspace.directory);
        if (entries.length !== 1 || entries[0] !== "app")
            fail("builder_files_changed");
        await withChildDirectoryWithin(workspace.directory, "app", async (app) => {
            const entries = await fs.readdir(app);
            const files = recordFiles(record);
            if (entries.length !== files.length || files.some(file => !entries.includes(file)))
                fail("builder_files_changed");
            for (const file of files)
                if (hash(await readFile(app, file)) !== record.hashes[file])
                    fail("builder_files_changed");
        });
    }
    async #complete(workspace, record, files) {
        const entries = await fs.readdir(workspace.directory);
        if (entries.length === 1 && entries[0] === "app") {
            await this.#verify(workspace, record);
            return;
        }
        if (!/^\.clawdesk-stage-[0-9a-f-]{36}$/.test(record.staging) ||
            entries.some(name => name !== record.staging))
            fail("builder_files_changed");
        if (!entries.length)
            await fs.mkdir(`${workspace.directory}/${record.staging}`, { mode: 448 });
        await withChildDirectoryWithin(workspace.directory, record.staging, async stage => {
            const names = await fs.readdir(stage);
            const expected = recordFiles(record);
            if (names.some(name => !expected.includes(name)))
                fail("builder_files_changed");
            for (const file of expected) {
                if (hash(files[file]) !== record.hashes[file])
                    fail("builder_files_changed");
                if (names.includes(file) && hash(await readFile(stage, file)) !== record.hashes[file])
                    fail("builder_files_changed");
            }
            for (const file of expected)
                if (!names.includes(file))
                    await fs.writeFile(`${stage}/${file}`, files[file], { flag: "wx", mode: 420 });
        });
        await fs.rename(`${workspace.directory}/${record.staging}`, `${workspace.directory}/app`);
    }
    #dto(record, state = "prepared") {
        return { state, planId: record?.planId ?? null, files: recordFiles(record).map(file => `app/${file}`), previewUrl: null, error: null };
    }
    async #gateway() {
        try {
            return await resetGateway(this.command, this.identity ?? { stateDir: this.stateDir });
        }
        catch (error) {
            throw new ProjectBuilderError(error.code ?? "preview_unavailable", error.status ?? 503);
        }
    }
    #container(gateway, id) {
        const install = gateway.Config.Labels["com.docker.compose.project"];
        return { name: `clawdesk-preview-${hash(install).slice(0, 12)}-${this.#key(id)}`, install };
    }
    async #inspect(gateway, id, record) {
        const { name, install } = this.#container(gateway, id);
        const ids = (await this.command(["ps", "-aq", "--filter", `name=^/${name}$`])).trim();
        if (!ids)
            return null;
        if (!/^[a-f0-9]{12,64}$/.test(ids))
            fail("preview_identity_changed");
        const rows = JSON.parse(await this.command(["inspect", ids]));
        const item = rows[0], labels = item?.Config?.Labels;
        if (rows.length !== 1 || item.Name !== `/${name}` || labels?.["clawdesk.preview.install"] !== install || labels?.["clawdesk.preview.project"] !== this.#key(id) || labels?.["clawdesk.preview.plan"] !== record?.planId)
            fail("preview_identity_changed");
        return item;
    }
    status(id) {
        return this.#with(id, async (workspace, state) => {
            const record = await this.#record(state, id);
            if (!record)
                return this.#dto(null, "empty");
            let integrityError = null;
            try {
                await this.#verify(workspace, record);
            }
            catch {
                integrityError = "builder_files_changed";
            }
            let preview;
            try {
                preview = await this.#inspect(await this.#gateway(), id, record);
            }
            catch (error) {
                return { ...this.#dto(record, "failed"), error: error.code ?? "preview_unavailable" };
            }
            if (integrityError && !preview?.State?.Running)
                fail(integrityError);
            return { ...this.#dto(record, preview?.State?.Running ? "running" : record.started ? "stopped" : "prepared"), error: integrityError };
        });
    }
    prepare(id, request) {
        return this.#with(id, async (workspace, state) => {
            if (workspace.mode !== "new")
                fail("builder_existing_readonly");
            if (request.templateId !== "task-board-v1" || typeof request.planId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.planId) || typeof request.projectName !== "string" || request.projectName.length > 200 || Buffer.byteLength(JSON.stringify(request)) > 131072)
                fail("invalid_builder_request", 400);
            const fingerprint = hash(JSON.stringify(request));
            const previous = await this.#record(state, id);
            // A transferred app gets this installation's plan once; its files stay as they came.
            if (previous?.adopted && previous.fingerprint === null) {
                Object.assign(previous, { planId: request.planId, fingerprint });
                await this.#save(state, id, previous);
            }
            if (previous) {
                if (previous.planId !== request.planId || previous.fingerprint !== fingerprint)
                    fail("builder_plan_changed");
            }
            if (!previous && (await fs.readdir(workspace.directory)).length)
                fail("builder_workspace_not_empty");
            const files = {};
            for (const file of ["server.mjs", "index.html", "checks.test.mjs"])
                files[file] = await fs.readFile(new URL(`./project-templates/task-board-v1/${file}`, import.meta.url), "utf8");
            files["package.json"] = JSON.stringify({ name: "clawdesk-task-board", version: "1.0.0", private: true, type: "module", engines: { node: ">=22.13.0" }, scripts: { start: "node server.mjs", test: "node --test" }, license: "MIT" }, null, 2) + "\n";
            files["README.md"] = "# " + request.projectName.replace(/[\r\n]/g, " ") + "\n\nTask board template v1: create, list, rename, complete and delete tasks. Node.js >=22.13.0, built-in HTTP and SQLite, no external packages.\n\nRun locally: node server.mjs. Checks: node --test (checks.test.mjs; each test name starts with a permanent ID such as TB-002, which the panel links to acceptance scenarios). Open http://127.0.0.1:3000. The default database is app/tasks.sqlite; DATA_FILE optionally selects another writable SQLite path and PORT changes the local port.\n\nPreview data is ephemeral and is removed when the preview stops. PROJECT-REQUIREMENTS.json preserves the conversation and rules as requirements; custom business rules are not automatically implemented by this template.\n";
            files["PROJECT-REQUIREMENTS.json"] = JSON.stringify({ projectName: request.projectName, brief: request.brief, rules: request.rules }, null, 2) + "\n";
            files.LICENSE = "MIT License\n\nCopyright (c) 2026 ClawDesk contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n";
            files[".clawdesk-build.json"] = JSON.stringify({ templateId: request.templateId, templateVersion: 2, planId: request.planId, runtime: "Node.js >=22.13.0", license: "MIT" }, null, 2) + "\n";
            const staging = `.clawdesk-stage-${randomUUID()}`;
            const record = { identity: workspace.identity, planId: request.planId, templateId: request.templateId, fingerprint, staging, hashes: Object.fromEntries(Object.entries(files).map(([file, value]) => [file, hash(value)])) };
            if (!previous)
                await this.#save(state, id, record);
            await this.#complete(workspace, previous ?? record, files);
            return this.#dto(previous ?? record);
        });
    }
    start(id, { planId }) {
        return this.#with(id, async (workspace, state) => {
            if (workspace.mode !== "new")
                fail("builder_existing_readonly");
            const record = await this.#record(state, id);
            if (!record || record.planId !== planId)
                fail("builder_plan_changed");
            await this.#verify(workspace, record);
            const gateway = await this.#gateway(), previous = await this.#inspect(gateway, id, record);
            if (previous?.State?.Running)
                return this.#dto(record, "running");
            if (previous)
                await this.command(["rm", previous.Id]);
            if (!/^(sha256:)?[a-f0-9]{64}$/.test(gateway.Image))
                fail("preview_image_unavailable");
            const { name, install } = this.#container(gateway, id);
            const payload = await withChildDirectoryWithin(workspace.directory, "app", async (app) => {
                const files = {};
                for (const file of ["server.mjs", "index.html"]) {
                    const data = await readFile(app, file);
                    if (hash(data) !== record.hashes[file])
                        fail("builder_files_changed");
                    files[file] = data;
                }
                return Buffer.from(JSON.stringify(files)).toString("base64");
            });
            const bootstrap = "import fs from 'node:fs/promises';const files=JSON.parse(Buffer.from(process.argv[1],'base64'));for(const [name,data]of Object.entries(files))await fs.writeFile('/project/'+name,data,{mode:0o444});await fs.chmod('/project',0o555);await import('file:///project/server.mjs');";
            await this.command(["run", "-d", "--pull=never", "--name", name, "--label", `clawdesk.preview.install=${install}`, "--label", `clawdesk.preview.project=${this.#key(id)}`, "--label", `clawdesk.preview.plan=${record.planId}`, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "192m", "--cpus", "0.5", "--user", "1000:1000", "--tmpfs", "/data:rw,noexec,nosuid,size=16777216,uid=1000,gid=1000", "--tmpfs", "/tmp:rw,noexec,nosuid,size=8388608", "--tmpfs", "/project:rw,noexec,nosuid,size=1048576,uid=1000,gid=1000", "--env", "DATA_FILE=/data/tasks.sqlite", "--workdir", "/project", "--entrypoint", "node", gateway.Image, "--input-type=module", "-e", bootstrap, payload]);
            record.started = true;
            await this.#save(state, id, record);
            const ready = "for(let attempt=0;attempt<30;attempt++){try{const response=await fetch('http://127.0.0.1:3000/api/tasks',{signal:AbortSignal.timeout(500)});if(response.ok)process.exit(0);}catch{}await new Promise(resolve=>setTimeout(resolve,100));}process.exit(1);";
            try {
                const preview = await this.#inspect(gateway, id, record);
                if (!preview?.State?.Running)
                    fail("preview_unavailable", 503);
                await this.command(["exec", preview.Id, "node", "--input-type=module", "-e", ready]);
            }
            catch (error) {
                const preview = await this.#inspect(gateway, id, record);
                if (preview)
                    await this.command(["rm", "-f", preview.Id]);
                throw error;
            }
            return this.#dto(record, "running");
        });
    }
    stop(id) {
        return this.#with(id, async (_workspace, state) => {
            const record = await this.#record(state, id);
            if (!record)
                return this.#dto(null, "empty");
            const preview = await this.#inspect(await this.#gateway(), id, record);
            if (preview)
                await this.command(["rm", "-f", preview.Id]);
            return this.#dto(record, "stopped");
        });
    }
    request(id, request) {
        return this.#with(id, async (workspace, state) => {
            if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method) || typeof request.path !== "string" || !/^\/(?:api\/tasks(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)?$/.test(request.path) || Buffer.byteLength(JSON.stringify(request.body ?? null)) > 8192)
                fail("invalid_preview_request", 400);
            const record = await this.#record(state, id);
            await this.#verify(workspace, record);
            const preview = await this.#inspect(await this.#gateway(), id, record);
            if (!preview?.State?.Running)
                fail("preview_not_running");
            const client = `const r=JSON.parse(process.argv[1]);const response=await fetch('http://127.0.0.1:3000'+r.path,{method:r.method,headers:{'content-type':'application/json'},body:r.body===undefined?undefined:JSON.stringify(r.body),signal:AbortSignal.timeout(5000)});const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>262144)throw Error('too large');chunks.push(chunk);}const body=Buffer.concat(chunks).toString('utf8');console.log(JSON.stringify({status:response.status,contentType:response.headers.get('content-type'),body}));`;
            return JSON.parse(await this.command(["exec", preview.Id, "node", "--input-type=module", "-e", client, JSON.stringify(request)]));
        });
    }
    /**
     * Runs the project's own checks (node --test) in throwaway containers: no network, read-only root,
     * a copy of the current files (not the template's: changed code is what checks are for). Only projects
     * created by the builder qualify. Files are read under the folder lock; the run itself is outside it.
     * Where the tests allow it the app and the tests run in separate containers (see checkIsolation).
     */
    async checks(id, request = {}) {
        // Files given by the panel (an executor's work copy) or the app's own; either way the project must qualify.
        const files = request.files === undefined ? await this.appFiles(id) : (await this.appFiles(id), checkedFiles(request.files));
        const payload = Buffer.from(JSON.stringify(files)).toString("base64");
        if (payload.length > CHECK_ARGUMENT_LIMIT)
            fail("checks_too_large", 413);
        const gateway = await this.#gateway();
        if (!/^(sha256:)?[a-f0-9]{64}$/.test(gateway.Image))
            fail("preview_image_unavailable");
        const install = gateway.Config.Labels["com.docker.compose.project"];
        const name = `clawdesk-checks-${hash(install).slice(0, 12)}-${this.#key(id)}`, appName = `clawdesk-checks-app-${hash(install).slice(0, 12)}-${this.#key(id)}`;
        await this.#removeChecks(name, install);
        await this.#removeChecks(appName, install);
        const nonce = randomUUID().replace(/-/g, "");
        const started = Date.now();
        const isolation = checkIsolation(files);
        const labels = ["--label", `clawdesk.checks.install=${install}`, "--label", `clawdesk.checks.project=${this.#key(id)}`];
        const runner = (network, extra, args, timeoutMs) => this.command(["run", "--rm", "--pull=never", "--name", name, ...labels, "--network", network, ...HARDENED, "--pids-limit", "128", "--memory", "256m", "--cpus", "1", "--tmpfs", "/project:rw,noexec,nosuid,size=4194304,uid=1000,gid=1000", "--tmpfs", "/runner:rw,noexec,nosuid,size=1048576,uid=1000,gid=1000", "--tmpfs", "/tmp:rw,noexec,nosuid,size=33554432", ...extra, "--workdir", "/project", "--entrypoint", "node", gateway.Image, "--input-type=module", "-e", CHECKS_BOOTSTRAP, ...args], { timeoutMs });
        const result = run => ({ ...run, isolation: isolation.mode, durationMs: Date.now() - started, filesFingerprint: filesFingerprint(files) });
        const blocked = reason => result({ status: "blocked", reason, tests: [] });
        if (isolation.mode === "shared") {
            let stdout;
            try {
                stdout = await runner("none", [], [payload, nonce], 120000);
            }
            catch {
                await this.#removeChecks(name, install).catch(() => { });
                return blocked("runner_failed");
            }
            return result(parseCheckOutput(stdout, nonce, files));
        }
        const appPayload = Buffer.from(JSON.stringify(isolation.app)).toString("base64"), testPayload = Buffer.from(JSON.stringify(isolation.tests)).toString("base64");
        const runs = [];
        try {
            for (const attempt of [1, 2]) {
                let failed = false;
                for (const file of isolation.testFiles) {
                    if (Date.now() - started > SEPARATE_BUDGET_MS)
                        return blocked("timeout");
                    // A fresh app per test file: its own container, sharing only its loopback network with the tests.
                    await this.command(["run", "-d", "--pull=never", "--name", appName, ...labels, "--label", "clawdesk.checks.role=app", "--network", "none", ...HARDENED, "--pids-limit", "64", "--memory", "192m", "--cpus", "0.5", "--tmpfs", "/data:rw,noexec,nosuid,size=16777216,uid=1000,gid=1000", "--tmpfs", "/tmp:rw,noexec,nosuid,size=8388608", "--tmpfs", "/project:rw,noexec,nosuid,size=4194304,uid=1000,gid=1000", "--env", "DATA_FILE=/data/tasks.sqlite", "--env", "PORT=3000", "--workdir", "/project", "--entrypoint", "node", gateway.Image, "--input-type=module", "-e", APP_BOOTSTRAP, appPayload]);
                    try {
                        const stdout = await runner(`container:${appName}`, ["--env", "CLAWDESK_APP_URL=http://127.0.0.1:3000"], [testPayload, nonce, String(attempt), file], 60000);
                        runs.push({ stdout });
                        if (attemptOf(stdout, nonce)?.code !== 0)
                            failed = true;
                    }
                    finally {
                        await this.#removeChecks(appName, install).catch(() => { });
                    }
                }
                if (!failed)
                    break;
            }
        }
        catch {
            await this.#removeChecks(name, install).catch(() => { });
            await this.#removeChecks(appName, install).catch(() => { });
            return blocked("runner_failed");
        }
        return result(parseCheckOutput(joinRuns(runs, nonce), nonce, files));
    }
    /**
     * A load check (see clawdesk-project-load.mjs): the app alone in its container with the checks limits, the
     * load client in another that shares only its loopback network. Returns the conditions with the result.
     */
    async load(id, request = {}) {
        const concurrency = Number(request.concurrency), durationMs = Number(request.durationMs);
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > LOAD_LIMITS.maxConcurrency || !Number.isInteger(durationMs) || durationMs < LOAD_LIMITS.minDurationMs || durationMs > LOAD_LIMITS.maxDurationMs)
            fail("invalid_builder_request", 400);
        const files = await this.appFiles(id);
        if (!Object.hasOwn(files, "server.mjs"))
            fail("checks_unsupported");
        const app = Object.fromEntries(Object.entries(files).filter(([name]) => !name.endsWith(".test.mjs")));
        const payload = Buffer.from(JSON.stringify(app)).toString("base64");
        if (payload.length > CHECK_ARGUMENT_LIMIT)
            fail("checks_too_large", 413);
        const gateway = await this.#gateway();
        if (!/^(sha256:)?[a-f0-9]{64}$/.test(gateway.Image))
            fail("preview_image_unavailable");
        const install = gateway.Config.Labels["com.docker.compose.project"];
        const name = `clawdesk-checks-${hash(install).slice(0, 12)}-${this.#key(id)}`, appName = `clawdesk-checks-app-${hash(install).slice(0, 12)}-${this.#key(id)}`;
        await this.#removeChecks(name, install);
        await this.#removeChecks(appName, install);
        const labels = ["--label", `clawdesk.checks.install=${install}`, "--label", `clawdesk.checks.project=${this.#key(id)}`];
        const conditions = { concurrency, durationMs, appCpus: 0.5, appMemoryMb: 192, requests: ["GET /api/tasks", "POST /api/tasks", "DELETE /api/tasks/:id"], data: "пустая база SQLite во временной памяти контейнера", network: "только внутри контейнеров, без сети" };
        const nonce = randomUUID().replace(/-/g, "");
        let stdout = "";
        try {
            await this.command(["run", "-d", "--pull=never", "--name", appName, ...labels, "--label", "clawdesk.checks.role=app", "--network", "none", ...HARDENED, "--pids-limit", "64", "--memory", "192m", "--cpus", "0.5", "--tmpfs", "/data:rw,noexec,nosuid,size=16777216,uid=1000,gid=1000", "--tmpfs", "/tmp:rw,noexec,nosuid,size=8388608", "--tmpfs", "/project:rw,noexec,nosuid,size=4194304,uid=1000,gid=1000", "--env", "DATA_FILE=/data/tasks.sqlite", "--env", "PORT=3000", "--workdir", "/project", "--entrypoint", "node", gateway.Image, "--input-type=module", "-e", APP_BOOTSTRAP, payload]);
            stdout = await this.command(["run", "--rm", "--pull=never", "--name", name, ...labels, "--network", `container:${appName}`, ...HARDENED, "--pids-limit", "64", "--memory", "128m", "--cpus", "0.5", "--tmpfs", "/tmp:rw,noexec,nosuid,size=8388608", "--env", "CLAWDESK_APP_URL=http://127.0.0.1:3000", "--entrypoint", "node", gateway.Image, "--input-type=module", "-e", LOAD_BOOTSTRAP, nonce, String(concurrency), String(durationMs)], { timeoutMs: durationMs + 40000 });
        }
        catch {
            stdout = "";
        }
        finally {
            await this.#removeChecks(appName, install).catch(() => { });
            await this.#removeChecks(name, install).catch(() => { });
        }
        const result = parseLoadOutput(stdout, nonce);
        return { conditions, result: result && !result.error ? result : null, error: result?.error ?? (result ? null : "runner_failed") };
    }
    /**
     * A project carried over by a transfer package (clawdesk-project-transfer.mjs): its folder holds only app/
     * with the builder's note. The record is made again for this folder from the files as they are, so checks
     * and rule tasks work as on the source installation. Anything else in the folder, or no note: nothing.
     */
    adopt(id) {
        return this.#with(id, async (workspace, state) => {
            if (workspace.mode !== "new" || await this.#record(state, id))
                return { adopted: false };
            const entries = await fs.readdir(workspace.directory);
            if (entries.length !== 1 || entries[0] !== "app")
                return { adopted: false };
            return withChildDirectoryWithin(workspace.directory, "app", async (app) => {
                let note;
                try {
                    note = JSON.parse(await readFile(app, ".clawdesk-build.json"));
                }
                catch {
                    return { adopted: false };
                }
                if (note?.templateId !== "task-board-v1" || typeof note.planId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(note.planId))
                    return { adopted: false };
                const hashes = {};
                for (const entry of await fs.readdir(app, { withFileTypes: true })) {
                    if (!entry.isFile())
                        return { adopted: false };
                    hashes[entry.name] = hash(await readFile(app, entry.name));
                }
                await this.#save(state, id, { identity: workspace.identity, planId: note.planId, templateId: note.templateId, fingerprint: null, staging: null, adopted: true, hashes });
                return { adopted: true };
            });
        });
    }
    /** The app's current flat files (see selectCheckFiles), for checks, executors' work copies and reviews. */
    appFiles(id) {
        return this.#with(id, async (workspace, state) => {
            if (workspace.mode !== "new" || !(await this.#record(state, id)))
                fail("checks_unsupported");
            try {
                return await withChildDirectoryWithin(workspace.directory, "app", async (app) => readFlatFiles(app));
            }
            catch (error) {
                if (error.code === "ENOENT")
                    fail("checks_no_files");
                throw error;
            }
        });
    }
    /**
     * Writes reviewed work into app/ (P6.2): only if app/ still has exactly the files the work started from
     * (baseline name → sha256), then updates the build record so the result counts as the project's files.
     * Files missing from `files` are removed; dotfiles (the build record) and local databases are never touched.
     */
    async apply(id, { files, baseline }) {
        const next = checkedFiles(files);
        if (!baseline || typeof baseline !== "object")
            fail("invalid_builder_request", 400);
        return this.#with(id, async (workspace, state) => {
            const record = await this.#record(state, id);
            if (workspace.mode !== "new" || !record)
                fail("checks_unsupported");
            return withChildDirectoryWithin(workspace.directory, "app", async (app) => {
                const current = await readFlatFiles(app);
                const same = Object.keys(current).length === Object.keys(baseline).length && Object.entries(current).every(([name, data]) => baseline[name] === hash(data));
                if (!same)
                    fail("work_app_changed");
                for (const [name, data] of Object.entries(next)) {
                    if (current[name] === data)
                        continue;
                    const temp = `.clawdesk-apply-${randomUUID()}.tmp`;
                    try {
                        await fs.writeFile(`${app}/${temp}`, data, { flag: "wx", mode: 0o644 });
                        await fs.rename(`${app}/${temp}`, `${app}/${name}`);
                    }
                    finally {
                        await fs.unlink(`${app}/${temp}`).catch(() => { });
                    }
                }
                for (const name of Object.keys(current))
                    if (!Object.hasOwn(next, name))
                        await fs.unlink(`${app}/${name}`);
                const hashes = {};
                for (const name of recordFiles(record).filter(name => name.startsWith(".")))
                    hashes[name] = hash(await readFile(app, name));
                for (const [name, data] of Object.entries(next))
                    hashes[name] = hash(data);
                await this.#save(state, id, { ...record, hashes });
                return { files: Object.keys(next).sort(), applied: true };
            });
        });
    }
    /** A leftover checks container of this installation and project (e.g. after a timeout), and only that. */
    async #removeChecks(name, install) {
        const ids = (await this.command(["ps", "-aq", "--filter", `name=^/${name}$`])).trim();
        if (!ids)
            return;
        if (!/^[a-f0-9]{12,64}$/.test(ids))
            fail("preview_identity_changed");
        const item = JSON.parse(await this.command(["inspect", ids]))[0];
        if (item?.Name !== `/${name}` || item?.Config?.Labels?.["clawdesk.checks.install"] !== install)
            fail("preview_identity_changed");
        await this.command(["rm", "-f", item.Id]);
    }
    analyze(id) {
        return this.#with(id, async (workspace) => {
            if (workspace.mode !== "existing")
                fail("existing_workspace_required");
            const entries = await fs.readdir(workspace.directory, { withFileTypes: true });
            const files = entries.filter(item => !item.isSymbolicLink() && !item.name.startsWith(".") && item.name.length <= 120).slice(0, 100).map(item => item.name);
            const dependencies = [];
            try {
                const manifest = JSON.parse(await readFile(workspace.directory, "package.json", 65536));
                for (const name of ["vue", "react", "next", "vite", "typescript", "fastify", "express", "@angular/core", "svelte"])
                    if (manifest.dependencies?.[name] || manifest.devDependencies?.[name])
                        dependencies.push(name);
            }
            catch (error) {
                if (error.code !== "ENOENT" && error instanceof ProjectBuilderError)
                    throw error;
            }
            return { files, dependencies, hasGit: entries.some(item => item.name === ".git" && item.isDirectory()), truncated: entries.length > 100 };
        });
    }
}
