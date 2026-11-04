import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectWork } from "./clawdesk-project-work.mjs";

const linux = { skip: process.platform !== "linux" && "Work copies are opened through /proc/self/fd" };

async function fixture(t, workspaces = {}) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-work-"));
    t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ agents: { entries: Object.fromEntries(Object.entries(workspaces).map(([id, dir]) => [id, { workspace: dir.startsWith("/") ? dir : path.join(stateDir, dir) }])) } }));
    for (const id of ["qa-agent", "dev-agent"]) await fs.mkdir(path.join(stateDir, "workspace", id), { recursive: true });
    return { stateDir, work: new ProjectWork({ stateDir, configPath }) };
}

test("each executor's copy is the folder project in its own workspace, refilled per stage", linux, async t => {
    const { stateDir, work } = await fixture(t);
    assert.deepEqual(await work.ensure("qa-agent"), { path: "/workspace/project" });
    const dir = path.join(stateDir, "workspace", "qa-agent", "project");
    await fs.writeFile(path.join(dir, "leftover.txt"), "from the previous stage");
    await fs.mkdir(path.join(dir, "nested"));
    await work.prepare("qa-agent", { "server.mjs": "code", "checks.test.mjs": "tests" });
    assert.deepEqual((await fs.readdir(dir)).sort(), ["checks.test.mjs", "server.mjs"]);
    await work.prepare("dev-agent", { "server.mjs": "other" });
    assert.equal(await fs.readFile(path.join(stateDir, "workspace", "dev-agent", "project", "server.mjs"), "utf8"), "other");
    assert.equal(await fs.readFile(path.join(dir, "server.mjs"), "utf8"), "code");
});

test("a snapshot reads flat regular files and reports, never follows, anything else", linux, async t => {
    const { stateDir, work } = await fixture(t);
    await work.prepare("dev-agent", { "server.mjs": "code" });
    const dir = path.join(stateDir, "workspace", "dev-agent", "project");
    await fs.writeFile(path.join(dir, "tasks.sqlite"), "local db");
    await fs.writeFile(path.join(dir, ".hidden"), "dotfile");
    await fs.mkdir(path.join(dir, "lib"));
    await fs.symlink("/etc/passwd", path.join(dir, "passwd.mjs"));
    const snapshot = await work.snapshot("dev-agent");
    assert.deepEqual(snapshot.files, { "server.mjs": "code" });
    assert.deepEqual(snapshot.ignored, ["lib", "passwd.mjs"]);
});

test("an executor replacing its project folder with a link outside is refused, not followed", linux, async t => {
    const { stateDir, work } = await fixture(t);
    const outside = path.join(stateDir, "company-projects", "victim", "app");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "server.mjs"), "the real app");
    await fs.symlink(outside, path.join(stateDir, "workspace", "qa-agent", "project"));
    await assert.rejects(work.snapshot("qa-agent"), { code: "work_layout" });
    await assert.rejects(work.prepare("qa-agent", { "server.mjs": "overwrite" }), { code: "work_layout" });
    assert.equal(await fs.readFile(path.join(outside, "server.mjs"), "utf8"), "the real app");
});

test("uses the workspace from the config, but never one outside the state folder", linux, async t => {
    const { stateDir, work } = await fixture(t, { "qa-agent": "custom/qa", "escape-agent": "/etc" });
    await fs.mkdir(path.join(stateDir, "custom", "qa"), { recursive: true });
    await work.prepare("qa-agent", { "a.mjs": "x" });
    assert.equal(await fs.readFile(path.join(stateDir, "custom", "qa", "project", "a.mjs"), "utf8"), "x");
    await assert.rejects(work.ensure("escape-agent"), { code: "work_missing" });
    await assert.rejects(work.ensure("../main"), { code: "invalid_work_request" });
});

test("refuses unsafe names, oversized copies and missing copies", linux, async t => {
    const { stateDir, work } = await fixture(t);
    await assert.rejects(work.prepare("qa-agent", { "../escape.mjs": "x" }), { code: "invalid_work_request" });
    await assert.rejects(work.prepare("qa-agent", { "big.mjs": "x".repeat(90_000) }), { code: "checks_too_large" });
    await assert.rejects(work.snapshot("dev-agent"), { code: "work_missing" });
    await work.ensure("qa-agent");
    await fs.writeFile(path.join(stateDir, "workspace", "qa-agent", "project", "big.mjs"), "x".repeat(90_000));
    await assert.rejects(work.snapshot("qa-agent"), { code: "checks_too_large" });
});
