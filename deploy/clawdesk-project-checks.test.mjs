import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { APP_BOOTSTRAP, CHECKS_BOOTSTRAP, attemptOf, checkIsolation, joinRuns, parseCheckOutput, selectCheckFiles } from "./clawdesk-project-checks.mjs";

const linux = { skip: process.platform !== "linux" && "The checks bootstrap runs in a Linux container" };
const line = (nonce, attempt, code, results) => `${nonce}A${attempt} ${JSON.stringify({ code, signal: null, timedOut: false, results })}`;
const result = (name, status, message = "") => ({ file: "checks.test.mjs", name, status, message });

test("a test that fails once and passes on the retry is flaky; failing twice is a failure", () => {
    const out = [
        "noise that is not a result",
        line("n1", 1, 1, [result("TB-001 a", "passed"), result("TB-002 b", "failed", "first"), result("TB-003 c", "failed", "boom")]),
        line("n1", 2, 1, [result("TB-001 a", "passed"), result("TB-002 b", "passed"), result("TB-003 c", "failed", "boom again")]),
        "n1DONE",
    ].join("\n");
    const run = parseCheckOutput(out, "n1", { "checks.test.mjs": "content" });
    assert.equal(run.status, "completed");
    assert.deepEqual(run.tests.map(t => [t.id, t.status, t.message]), [
        ["checks.test.mjs::TB-001 a", "passed", ""],
        ["checks.test.mjs::TB-002 b", "flaky", "first"],
        ["checks.test.mjs::TB-003 c", "failed", "boom again"],
    ]);
    assert.match(run.tests[0].fileHash, /^[a-f0-9]{64}$/);
});

test("results without the run's nonce, a crash, a timeout or no tests never read as success", () => {
    assert.deepEqual(parseCheckOutput(line("other", 1, 0, [result("x", "passed")]) + "\notherDONE", "n1", {}), { status: "blocked", reason: "runner_failed", tests: [] });
    assert.equal(parseCheckOutput(line("n1", 1, 0, [result("x", "passed")]), "n1", {}).reason, "runner_failed");
    assert.equal(parseCheckOutput(`n1E "boom"\nn1DONE`, "n1", {}).reason, "runner_failed");
    assert.equal(parseCheckOutput(`n1A1 ${JSON.stringify({ code: null, signal: "SIGTERM", timedOut: true, results: [] })}\nn1DONE`, "n1", {}).reason, "timeout");
    assert.equal(parseCheckOutput(line("n1", 1, 0, []) + "\nn1DONE", "n1", {}).reason, "no_tests");
});

test("duplicate test names get distinct IDs and files outside the copy have no hash", () => {
    const run = parseCheckOutput([line("n", 1, 0, [result("same", "passed"), result("same", "passed"), { file: "other.mjs", name: "x", status: "skipped", message: "" }]), "nDONE"].join("\n"), "n", { "checks.test.mjs": "a" });
    assert.deepEqual(run.tests.map(t => t.id), ["checks.test.mjs::same", "checks.test.mjs::same #2", "other.mjs::x"]);
    assert.equal(run.tests[2].fileHash, null);
});

test("only regular, flat project files are copied, never local databases or dotfiles", () => {
    const entry = (name, file = true) => ({ name, isFile: () => file });
    assert.deepEqual(selectCheckFiles([entry("server.mjs"), entry("tasks.sqlite"), entry("tasks.sqlite-wal"), entry(".clawdesk-build.json"), entry("dir", false), entry("checks.test.mjs")]), ["checks.test.mjs", "server.mjs"]);
});

async function runBootstrap(t, files) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-checks-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "project"));
    await fs.mkdir(path.join(root, "runner"));
    const nonce = "abc123";
    const payload = Buffer.from(JSON.stringify(files)).toString("base64");
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHECKS_BOOTSTRAP, payload, nonce], { env: { ...process.env, CLAWDESK_CHECKS_ROOT: path.join(root, "project"), CLAWDESK_CHECKS_RUNNER: path.join(root, "runner") }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", chunk => stdout += chunk);
    await new Promise(resolve => child.once("close", resolve));
    return parseCheckOutput(stdout, nonce, files);
}

async function templateFiles() {
    const files = {};
    for (const name of ["server.mjs", "index.html", "checks.test.mjs"])
        files[name] = await fs.readFile(new URL(`./project-templates/task-board-v1/${name}`, import.meta.url), "utf8");
    return files;
}

test("the task board's own checks pass on the template", linux, async t => {
    const run = await runBootstrap(t, await templateFiles());
    assert.equal(run.status, "completed");
    assert.equal(run.tests.length, 6);
    assert.ok(run.tests.every(item => item.status === "passed"), JSON.stringify(run.tests));
    assert.ok(run.tests.every(item => /^checks\.test\.mjs::TB-00\d /.test(item.id)));
});

test("breaking the empty-title rule in the code is caught by TB-002 and only by it", linux, async t => {
    const files = await templateFiles();
    const rule = `if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 200)\n                return send(res, 400, { error: "invalid_title" });\n            if (db.prepare("SELECT COUNT(*)`;
    assert.ok(files["server.mjs"].includes(rule), "template changed: update this test");
    files["server.mjs"] = files["server.mjs"].replace(rule, `if (typeof body.title !== "string" || body.title.trim().length > 200)\n                return send(res, 400, { error: "invalid_title" });\n            if (db.prepare("SELECT COUNT(*)`);
    const run = await runBootstrap(t, files);
    assert.equal(run.status, "completed");
    const failed = run.tests.filter(item => item.status !== "passed");
    assert.deepEqual(failed.map(item => [item.name.slice(0, 6), item.status]), [["TB-002", "failed"]]);
    assert.ok(failed[0].message.length > 0);
});

test("tests run apart from the app only when every test file can use an app the panel starts", () => {
    const aware = "const base = process.env.CLAWDESK_APP_URL;";
    const separate = checkIsolation({ "server.mjs": "app", "index.html": "<p>", "checks.test.mjs": aware, "more.test.mjs": aware });
    assert.equal(separate.mode, "separate");
    assert.deepEqual(Object.keys(separate.app), ["index.html", "server.mjs"]);
    assert.deepEqual(Object.keys(separate.tests), ["checks.test.mjs", "more.test.mjs"]);
    assert.equal(checkIsolation({ "server.mjs": "app", "checks.test.mjs": aware, "old.test.mjs": "spawn server.mjs" }).mode, "shared");
    assert.equal(checkIsolation({ "checks.test.mjs": aware }).mode, "shared");
    assert.equal(checkIsolation({ "server.mjs": "app" }).mode, "shared");
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`t${index}.test.mjs`, aware]));
    assert.equal(checkIsolation({ "server.mjs": "app", ...many }).mode, "shared");
});

test("per-file runs join into one run; a file without a result blocks the whole run", () => {
    const file = (attempt, code, results) => line("n", attempt, code, results) + "\nnDONE";
    const joined = joinRuns([
        { stdout: file(1, 0, [result("A a", "passed")]) },
        { stdout: file(1, 1, [{ ...result("B b", "failed", "x"), file: "more.test.mjs" }]) },
        { stdout: file(2, 0, [result("A a", "passed")]) },
        { stdout: file(2, 0, [{ ...result("B b", "passed"), file: "more.test.mjs" }]) },
    ], "n");
    const run = parseCheckOutput(joined, "n", {});
    assert.deepEqual(run.tests.map(t => [t.id, t.status]), [["checks.test.mjs::A a", "passed"], ["more.test.mjs::B b", "flaky"]]);
    assert.equal(attemptOf(file(1, 1, []), "n").code, 1);
    assert.equal(attemptOf("nA1 {}", "n"), null);
    assert.equal(parseCheckOutput(joinRuns([{ stdout: file(1, 0, [result("A a", "passed")]) }, { stdout: "crashed" }], "n"), "n", {}).reason, "runner_failed");
});

async function runSeparate(t, files) {
    const isolation = checkIsolation(files);
    assert.equal(isolation.mode, "separate");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-checks-app-"));
    t.after(async () => { await fs.chmod(path.join(root, "app"), 0o755).catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
    await fs.mkdir(path.join(root, "app"));
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const app = spawn(process.execPath, ["--input-type=module", "-e", APP_BOOTSTRAP, Buffer.from(JSON.stringify(isolation.app)).toString("base64")], { env: { ...process.env, CLAWDESK_CHECKS_ROOT: path.join(root, "app"), PORT: String(port), DATA_FILE: path.join(root, "tasks.sqlite") }, stdio: "ignore" });
    t.after(() => app.kill("SIGKILL"));
    process.env.CLAWDESK_APP_URL = `http://127.0.0.1:${port}`;
    try { return await runBootstrap(t, isolation.tests); }
    finally { delete process.env.CLAWDESK_APP_URL; }
}

test("the template's tests pass against an app they share no files with", linux, async t => {
    const run = await runSeparate(t, await templateFiles());
    assert.equal(run.status, "completed");
    assert.equal(run.tests.length, 6);
    assert.ok(run.tests.every(item => item.status === "passed"), JSON.stringify(run.tests));
});

test("an app that cannot start fails its tests instead of blocking the run", linux, async t => {
    const files = await templateFiles();
    files["server.mjs"] = "throw new Error('broken on purpose');";
    const run = await runSeparate(t, files);
    assert.equal(run.status, "completed");
    assert.ok(run.tests.length > 0 && run.tests.every(item => item.status === "failed"), JSON.stringify(run.tests));
});
