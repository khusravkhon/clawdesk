import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ProjectFolderError } from "./clawdesk-project-folders.mjs";
import { withDirectoryWithin, withChildDirectoryWithin } from "./clawdesk-file-sync.mjs";
import { resetGateway } from "./clawdesk-backup.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
export const PROJECT_TEMPLATE_FILES = ["server.mjs", "index.html", "package.json", "README.md", "PROJECT-REQUIREMENTS.json", "LICENSE", ".clawdesk-build.json"];
const FILES = PROJECT_TEMPLATE_FILES;
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
export function dockerCommand(args) {
    return new Promise((resolve, reject) => {
        const child = spawn("/usr/local/libexec/docker", args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", failed = false;
        const timer = setTimeout(() => {
            failed = true;
            child.kill("SIGKILL");
        }, 20000);
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
            if (entries.length !== FILES.length || FILES.some(file => !entries.includes(file)))
                fail("builder_files_changed");
            for (const file of FILES)
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
            if (names.some(name => !FILES.includes(name)))
                fail("builder_files_changed");
            for (const file of FILES) {
                if (hash(files[file]) !== record.hashes[file])
                    fail("builder_files_changed");
                if (names.includes(file) && hash(await readFile(stage, file)) !== record.hashes[file])
                    fail("builder_files_changed");
            }
            for (const file of FILES)
                if (!names.includes(file))
                    await fs.writeFile(`${stage}/${file}`, files[file], { flag: "wx", mode: 420 });
        });
        await fs.rename(`${workspace.directory}/${record.staging}`, `${workspace.directory}/app`);
    }
    #dto(record, state = "prepared") {
        return { state, planId: record?.planId ?? null, files: record ? FILES.map(file => `app/${file}`) : [], previewUrl: null, error: null };
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
            if (previous) {
                if (previous.planId !== request.planId || previous.fingerprint !== fingerprint)
                    fail("builder_plan_changed");
            }
            if (!previous && (await fs.readdir(workspace.directory)).length)
                fail("builder_workspace_not_empty");
            const files = {};
            for (const file of ["server.mjs", "index.html"])
                files[file] = await fs.readFile(new URL(`./project-templates/task-board-v1/${file}`, import.meta.url), "utf8");
            files["package.json"] = JSON.stringify({ name: "clawdesk-task-board", version: "1.0.0", private: true, type: "module", engines: { node: ">=22.13.0" }, scripts: { start: "node server.mjs" }, license: "MIT" }, null, 2) + "\n";
            files["README.md"] = "# " + request.projectName.replace(/[\r\n]/g, " ") + "\n\nTask board template v1: create, list, rename, complete and delete tasks. Node.js >=22.13.0, built-in HTTP and SQLite, no external packages.\n\nRun locally: node server.mjs. Open http://127.0.0.1:3000. The default database is app/tasks.sqlite; DATA_FILE optionally selects another writable SQLite path and PORT changes the local port.\n\nPreview data is ephemeral and is removed when the preview stops. PROJECT-REQUIREMENTS.json preserves the conversation and rules as requirements; custom business rules are not automatically implemented by this template.\n";
            files["PROJECT-REQUIREMENTS.json"] = JSON.stringify({ projectName: request.projectName, brief: request.brief, rules: request.rules }, null, 2) + "\n";
            files.LICENSE = "MIT License\n\nCopyright (c) 2026 ClawDesk contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n";
            files[".clawdesk-build.json"] = JSON.stringify({ templateId: request.templateId, templateVersion: 1, planId: request.planId, runtime: "Node.js >=22.13.0", license: "MIT" }, null, 2) + "\n";
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
        return this.#with(id, async (workspace, state) => {
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
