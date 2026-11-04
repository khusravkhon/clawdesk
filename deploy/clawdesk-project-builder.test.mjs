import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import vm from "node:vm";
import { ProjectFolders } from "./clawdesk-project-folders.mjs";
import { ProjectBuilder, PROJECT_TEMPLATE_FILES } from "./clawdesk-project-builder.mjs";

const linux = { skip: process.platform !== "linux" && "Directory handle confinement requires Linux /proc" };
const request = { templateId: "task-board-v1", planId: "plan-1", projectName: "Мои задачи", brief: { purpose: "Учёт задач" }, rules: [] };
const gatewayId = "a".repeat(64), previewId = "b".repeat(64);

function runner(stateDir, options = {}) {
    const calls = [];
    let preview = null;
    const gateway = {
        Id: gatewayId, Image: "sha256:" + "c".repeat(64),
        Config: { Labels: { "com.docker.compose.project": "fixture", "com.docker.compose.service": "gateway" }, Env: ["OPENCLAW_GATEWAY_TOKEN=fixture-token", `OPENCLAW_STATE_DIR=${stateDir}`] },
        Mounts: [{ Source: "/fixture/state", Destination: stateDir }],
    };
    const command = async args => {
        calls.push(args);
        if (args[0] === "ps")
            return args.includes("label=com.docker.compose.service=gateway") ? gatewayId : preview ? previewId : "";
        if (args[0] === "inspect")
            return JSON.stringify(args[1] === gatewayId ? options.ambiguous ? [gateway, gateway] : [gateway] : [preview]);
        if (args[0] === "run") {
            const labels = Object.fromEntries(args.flatMap((value, index) => value === "--label" ? [args[index + 1].split("=")] : []));
            preview = { Id: previewId, Name: "/" + args[args.indexOf("--name") + 1], Config: { Labels: labels }, State: { Running: true } };
            if (options.foreign)
                preview.Config.Labels["clawdesk.preview.install"] = "other-install";
            return previewId;
        }
        if (args[0] === "exec") {
            if (options.unready)
                throw Error("probe_failed");
            return args.some(value => value.includes("const response=await fetch")) ? JSON.stringify({ status: 200, contentType: "application/json", body: "[]" }) : "";
        }
        if (args[0] === "rm") {
            preview = null;
            return "";
        }
        throw Error("Unexpected command: " + args[0]);
    };
    return { command, calls };
}

async function fixture(t, options = {}) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-builder-"));
    t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
    const folders = new ProjectFolders({ stateDir });
    await folders.status("project-a");
    const root = path.join(stateDir, "company-projects");
    if (options.existing)
        await fs.mkdir(path.join(root, "Fixture"));
    await folders.prepare({ projectId: "project-a", mode: options.existing ? "existing" : "new", name: "Fixture", requestId: randomUUID() });
    const runtime = runner(stateDir, options);
    const create = () => new ProjectBuilder({ folders, stateDir, command: runtime.command, identity: { stateDir, token: "fixture-token" } });
    return { stateDir, root, directory: path.join(root, "Fixture"), create, builder: create(), ...runtime };
}

test("prepares exactly the template files and repeats safely after restart", linux, async t => {
    const f = await fixture(t);
    assert.equal((await f.builder.status("project-a")).state, "empty");
    const prepared = await f.builder.prepare("project-a", request);
    assert.equal(prepared.state, "prepared");
    assert.deepEqual((await fs.readdir(path.join(f.directory, "app"))).sort(), [...PROJECT_TEMPLATE_FILES].sort());
    assert.deepEqual(await f.create().prepare("project-a", request), prepared);
    assert.equal((await f.create().status("project-a")).state, "prepared");
    await assert.rejects(f.builder.prepare("project-a", { ...request, projectName: "Changed" }), { code: "builder_plan_changed" });
    assert.equal(f.calls.some(args => args[0] === "run"), false);
});

test("recovers an interrupted final rename only during an explicit prepare", linux, async t => {
    const f = await fixture(t);
    const original = fs.rename;
    const mock = t.mock.method(fs, "rename", async (from, to) => {
        if (to.endsWith("/app"))
            throw Object.assign(Error("injected failure"), { code: "EIO" });
        return original(from, to);
    });
    await assert.rejects(f.builder.prepare("project-a", request));
    mock.mock.restore();
    const before = await fs.readdir(f.directory);
    assert.match(before[0], /^\.clawdesk-stage-/);
    await assert.rejects(f.create().status("project-a"), { code: "builder_files_changed" });
    assert.deepEqual(await fs.readdir(f.directory), before);
    assert.equal((await f.create().prepare("project-a", request)).state, "prepared");
    assert.deepEqual(await fs.readdir(f.directory), ["app"]);
});

test("recovers partially written staging files after generation interruption", linux, async t => {
    const f = await fixture(t);
    const original = fs.writeFile;
    const mock = t.mock.method(fs, "writeFile", async (file, ...args) => {
        if (String(file).endsWith("/index.html"))
            throw Object.assign(Error("injected full disk"), { code: "ENOSPC" });
        return original(file, ...args);
    });
    await assert.rejects(f.builder.prepare("project-a", request));
    mock.mock.restore();
    assert.equal((await f.create().prepare("project-a", request)).state, "prepared");
    assert.equal((await fs.readdir(path.join(f.directory, "app"))).length, PROJECT_TEMPLATE_FILES.length);
});

test("refuses foreign files and never overwrites changed generated source", linux, async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.directory, "owner.txt"), "keep");
    await assert.rejects(f.builder.prepare("project-a", request), { code: "builder_workspace_not_empty" });
    assert.equal(await fs.readFile(path.join(f.directory, "owner.txt"), "utf8"), "keep");
    await fs.unlink(path.join(f.directory, "owner.txt"));
    await f.builder.prepare("project-a", request);
    const source = path.join(f.directory, "app", "server.mjs");
    await fs.writeFile(source, "owner changes");
    await assert.rejects(f.builder.prepare("project-a", request), { code: "builder_files_changed" });
    await assert.rejects(f.builder.start("project-a", { planId: request.planId }), { code: "builder_files_changed" });
    assert.equal(await fs.readFile(source, "utf8"), "owner changes");
});

test("rejects symlink replacement and added files in generated source", linux, async t => {
    const f = await fixture(t);
    await f.builder.prepare("project-a", request);
    await fs.writeFile(path.join(f.directory, "app", "foreign.txt"), "keep");
    await assert.rejects(f.builder.prepare("project-a", request), { code: "builder_files_changed" });
    await fs.unlink(path.join(f.directory, "app", "foreign.txt"));
    await fs.unlink(path.join(f.directory, "app", "server.mjs"));
    await fs.writeFile(path.join(f.stateDir, "outside.mjs"), "outside");
    await fs.symlink(path.join(f.stateDir, "outside.mjs"), path.join(f.directory, "app", "server.mjs"));
    await assert.rejects(f.builder.start("project-a", { planId: request.planId }));
    assert.equal(await fs.readFile(path.join(f.stateDir, "outside.mjs"), "utf8"), "outside");
    assert.equal(f.calls.length, 0);
});

test("existing workspaces are analyzed without executing or writing project files", linux, async t => {
    const f = await fixture(t, { existing: true });
    const manifest = JSON.stringify({ scripts: { prepare: "touch HACKED" }, dependencies: { vue: "3" } });
    await fs.writeFile(path.join(f.directory, "package.json"), manifest);
    const analysis = await f.builder.analyze("project-a");
    assert.deepEqual(analysis.dependencies, ["vue"]);
    await assert.rejects(f.builder.prepare("project-a", request), { code: "builder_existing_readonly" });
    await assert.rejects(f.builder.start("project-a", { planId: request.planId }), { code: "builder_existing_readonly" });
    assert.deepEqual(await fs.readdir(f.directory), ["package.json"]);
    assert.equal(await fs.readFile(path.join(f.directory, "package.json"), "utf8"), manifest);
    assert.equal(f.calls.length, 0);
});

test("preview is hardened, probes readiness, and uses only its identified container", linux, async t => {
    const f = await fixture(t);
    await f.builder.prepare("project-a", request);
    assert.equal((await f.builder.start("project-a", { planId: request.planId })).state, "running");
    const args = f.calls.find(args => args[0] === "run");
    for (const flag of ["--pull=never", "--read-only", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus"])
        assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
    assert.equal(args.includes("-v") || args.includes("--volume") || args.includes("--publish"), false);
    assert.equal(args.some(value => value.includes("fixture-token")), false);
    assert.ok(f.calls.some(args => args[0] === "exec" && args.some(value => value.includes("attempt<30"))));
    await assert.rejects(f.builder.request("project-a", { method: "POST", path: "/api/tasks/../../outside" }), { code: "invalid_preview_request" });
    assert.equal((await f.builder.stop("project-a")).state, "stopped");
    assert.equal((await f.builder.status("project-a")).state, "stopped");
});

test("rejects ambiguous installation identities before creating a preview", linux, async t => {
    const f = await fixture(t, { ambiguous: true });
    await f.builder.prepare("project-a", request);
    await assert.rejects(f.builder.start("project-a", { planId: request.planId }), { code: "identity_ambiguous" });
    assert.equal(f.calls.some(args => args[0] === "run"), false);
});

test("keeps an owned running preview stoppable after generated files change", linux, async t => {
    const f = await fixture(t);
    await f.builder.prepare("project-a", request);
    await f.builder.start("project-a", { planId: request.planId });
    await fs.writeFile(path.join(f.directory, "app", "server.mjs"), "owner changes");
    const status = await f.builder.status("project-a");
    assert.equal(status.state, "running");
    assert.equal(status.error, "builder_files_changed");
    assert.equal(status.planId, request.planId);
    await assert.rejects(f.builder.request("project-a", { method: "GET", path: "/" }), { code: "builder_files_changed" });
    assert.equal((await f.builder.stop("project-a")).state, "stopped");
    assert.deepEqual(f.calls.find(args => args[0] === "rm"), ["rm", "-f", previewId]);
});

test("preview transport preserves UTF-8 across chunks and bounds raw bytes", linux, async t => {
    const f = await fixture(t);
    await f.builder.prepare("project-a", request);
    await f.builder.start("project-a", { planId: request.planId });
    await f.builder.request("project-a", { method: "GET", path: "/api/tasks" });
    const args = f.calls.find(args => args[0] === "exec" && args.some(value => value.includes("const chunks=[]")));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const client = new AsyncFunction("fetch", "process", "console", args[args.indexOf("-e") + 1]);
    const body = JSON.stringify([{ title: "Привет мир 👋" }]);
    const bytes = Buffer.from(body);
    let result;
    await client(async () => ({ status: 200, headers: new Map([["content-type", "application/json"]]), body: (async function* () { for (const byte of bytes) yield Uint8Array.of(byte); })() }), { argv: ["node", JSON.stringify({ method: "GET", path: "/api/tasks" })] }, { log: value => { result = JSON.parse(value); } });
    assert.equal(result.body, body);
    await assert.rejects(client(async () => ({ status: 200, headers: new Map(), body: (async function* () { yield Buffer.alloc(262145); })() }), { argv: ["node", "{}"] }, { log() {} }), /too large/);
});

test("does not return running when readiness fails, and removes only the owned preview", linux, async t => {
    const f = await fixture(t, { unready: true });
    await f.builder.prepare("project-a", request);
    await assert.rejects(f.builder.start("project-a", { planId: request.planId }));
    assert.deepEqual(f.calls.find(args => args[0] === "rm"), ["rm", "-f", previewId]);
    assert.equal((await f.builder.status("project-a")).state, "stopped");
});

test("refuses container identity substitution without removing another container", linux, async t => {
    const f = await fixture(t, { foreign: true });
    await f.builder.prepare("project-a", request);
    await assert.rejects(f.builder.start("project-a", { planId: request.planId }), { code: "preview_identity_changed" });
    assert.equal(f.calls.some(args => args[0] === "rm"), false);
});

test("template creates tasks through click and Enter without native form submission", async () => {
    const html = await fs.readFile(new URL("./project-templates/task-board-v1/index.html", import.meta.url), "utf8");
    assert.doesNotMatch(html, /<form\b/);
    const requests = [];
    const elements = { title: { value: "", reportValidity() { return !!this.value; } }, "add-task": {}, error: {}, tasks: { replaceChildren() {} } };
    const window = { addEventListener() {} };
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
        window, parent: window,
        document: { getElementById: id => elements[id] },
        fetch: async (path, options) => {
            requests.push({ path, ...options });
            return { ok: true, json: async () => options.method === "GET" ? [] : {} };
        },
    });
    await new Promise(resolve => setImmediate(resolve));
    elements.title.value = "По кнопке";
    await elements["add-task"].onclick();
    elements.title.value = "По Enter";
    let prevented = false;
    await elements.title.onkeydown({ key: "Enter", preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(requests.filter(item => item.method === "POST").map(item => JSON.parse(item.body).title), ["По кнопке", "По Enter"]);
    assert.equal(elements.title.value, "");
    await elements["add-task"].onclick();
    assert.equal(requests.filter(item => item.method === "POST").length, 2);
});

test("standalone template starts with its default writable database and supports task CRUD", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-template-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const file of ["server.mjs", "index.html"])
        await fs.copyFile(new URL(`./project-templates/task-board-v1/${file}`, import.meta.url), path.join(directory, file));
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const env = { ...process.env, PORT: String(port) };
    delete env.DATA_FILE;
    const child = spawn(process.execPath, ["server.mjs"], { cwd: directory, env, stdio: "pipe" });
    const closed = new Promise(resolve => child.once("close", resolve));
    let output = "";
    child.stderr.on("data", chunk => output += chunk);
    t.after(async () => { child.kill(); await closed; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            if ((await fetch(base + "/api/tasks")).ok) { ready = true; break; }
        } catch {}
        if (child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    const html = await (await fetch(base)).text();
    assert.match(html, /Content-Security-Policy/);
    const call = (method, route, body) => fetch(base + route, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await call("POST", "/api/tasks", { title: "" })).status, 400);
    const created = await call("POST", "/api/tasks", { title: "Первая задача" });
    assert.equal(created.status, 201);
    const task = await created.json();
    const changed = await (await call("PATCH", "/api/tasks/" + task.id, { title: "Новое название", done: true })).json();
    assert.equal(changed.title, "Новое название");
    assert.equal(changed.done, 1);
    assert.equal((await (await fetch(base + "/api/tasks")).json()).length, 1);
    assert.equal((await call("DELETE", "/api/tasks/" + task.id)).status, 200);
    assert.deepEqual(await (await fetch(base + "/api/tasks")).json(), []);
    assert.ok((await fs.stat(path.join(directory, "tasks.sqlite"))).isFile());
});
