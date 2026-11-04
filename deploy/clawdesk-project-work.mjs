import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ProjectFolderError } from "./clawdesk-project-folders.mjs";
import { CHECK_FILE, CHECK_PAYLOAD_LIMIT, selectCheckFiles } from "./clawdesk-project-checks.mjs";
import { withDirectoryWithin } from "./clawdesk-file-sync.mjs";

// Work copies of a project's executors (P6.2): the folder "project" inside the executor agent's own
// workspace, which its sandbox already mounts read-write at /workspace (OpenClaw allows bind sources
// only inside the agent's workspace, and reserves /workspace for its own mounts). The project's app/
// is never reachable from a sandbox; the panel copies files in and reads them back.
// The agent controls its workspace, so every path is opened without following links: a "project"
// replaced by a symlink, a nested directory or a link inside the copy is reported, never followed.

export const WORK_DIR = "project";
const AGENT = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = (code, status = 409) => { throw new ProjectFolderError(code, status); };
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export class ProjectWork {
    constructor({ stateDir, configPath }) {
        this.stateDir = path.resolve(stateDir);
        this.configPath = configPath;
    }
    /** The agent's workspace relative to the state dir (from the OpenClaw config, else the default). */
    async #workspace(agentId) {
        if (typeof agentId !== "string" || !AGENT.test(agentId))
            fail("invalid_work_request", 400);
        let configured;
        try {
            configured = JSON.parse(await fs.readFile(this.configPath, "utf8")).agents?.entries?.[agentId]?.workspace;
        }
        catch { /* No readable config: the default location below. */ }
        const relative = path.relative(this.stateDir, path.resolve(configured ?? path.join(this.stateDir, "workspace", agentId)));
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
            fail("work_missing");
        return relative.split(path.sep).join("/");
    }
    async #within(agentId, run, create = false) {
        const workspace = await this.#workspace(agentId);
        try {
            return await withDirectoryWithin(this.stateDir, `${workspace}/${WORK_DIR}`, run, create);
        }
        catch (error) {
            if (error.code === "ENOENT")
                fail("work_missing");
            if (error.code === "ELOOP" || error.code === "ENOTDIR" || error.message === "unsafe file path")
                fail("work_layout");
            throw error;
        }
    }
    /** Creates the agent's work copy folder if missing; the agent sees it at /workspace/project. */
    ensure(agentId) {
        return this.#within(agentId, async () => ({ path: `/workspace/${WORK_DIR}` }), true);
    }
    /** Replaces the copy's contents with `files` (name → text). */
    async prepare(agentId, files) {
        checkFiles(files);
        return this.#within(agentId, async (dir) => {
            for (const entry of await fs.readdir(dir))
                await fs.rm(`${dir}/${entry}`, { recursive: true, force: true });
            for (const [name, data] of Object.entries(files))
                await fs.writeFile(`${dir}/${name}`, data, { flag: "wx", mode: 0o644 });
            return { path: `/workspace/${WORK_DIR}`, files: Object.keys(files).sort() };
        }, true);
    }
    /**
     * The copy as the executor left it: flat regular files (no dotfiles, no local databases). Other
     * entries are listed in `ignored` (a directory or link is never followed) so the panel can refuse.
     */
    snapshot(agentId) {
        return this.#within(agentId, async (dir) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const names = selectCheckFiles(entries);
            const ignored = entries.filter(entry => !names.includes(entry.name) && !(entry.isFile() && (entry.name.startsWith(".") || /\.sqlite(?:-(?:wal|shm|journal))?$/.test(entry.name)))).map(entry => entry.name).sort();
            const files = {};
            let size = 0;
            for (const name of names) {
                const handle = await fs.open(`${dir}/${name}`, READ);
                try {
                    const stat = await handle.stat();
                    if (!stat.isFile())
                        continue;
                    size += stat.size;
                    if (stat.size > CHECK_PAYLOAD_LIMIT || size > CHECK_PAYLOAD_LIMIT)
                        fail("checks_too_large", 413);
                    files[name] = await handle.readFile("utf8");
                }
                finally {
                    await handle.close();
                }
            }
            return { files, ignored, hashes: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, hash(data)])) };
        });
    }
}

function checkFiles(files) {
    if (!files || typeof files !== "object" || Array.isArray(files))
        fail("invalid_work_request", 400);
    let size = 0;
    for (const [name, data] of Object.entries(files)) {
        if (!CHECK_FILE.test(name) || typeof data !== "string")
            fail("invalid_work_request", 400);
        size += Buffer.byteLength(data);
    }
    if (size > CHECK_PAYLOAD_LIMIT)
        fail("checks_too_large", 413);
}
