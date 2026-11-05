// Checks of the task board's rules. Each test name starts with a permanent ID (TB-001…): the panel links
// acceptance scenarios to these IDs, so a test that protects a rule keeps its ID. Run: node --test
// The tests talk to the app only over HTTP. When CLAWDESK_APP_URL is set, the panel has started a fresh
// app for this file in a separate container; otherwise the tests start server.mjs themselves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let base, child, dataDir, output = "";

before(async () => {
    if (process.env.CLAWDESK_APP_URL) base = process.env.CLAWDESK_APP_URL;
    else {
        dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-board-checks-"));
        const reservation = net.createServer();
        await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        child = spawn(process.execPath, ["server.mjs"], {
            cwd: path.dirname(fileURLToPath(import.meta.url)),
            env: { ...process.env, PORT: String(port), DATA_FILE: path.join(dataDir, "tasks.sqlite") },
            stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr.on("data", chunk => output += chunk);
        base = `http://127.0.0.1:${port}`;
    }
    for (let attempt = 0; attempt < 200; attempt++) {
        try { if ((await fetch(base + "/api/tasks")).ok) return; } catch {}
        if (child && child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("The app did not start: " + output.slice(0, 500));
});

after(async () => {
    child?.kill();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

const call = (method, route, body) => fetch(base + route, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const create = async title => (await call("POST", "/api/tasks", { title })).json();

test("TB-001 задача создаётся с названием и появляется в списке", async () => {
    const response = await call("POST", "/api/tasks", { title: "Купить хлеб" });
    assert.equal(response.status, 201);
    const task = await response.json();
    assert.equal(task.title, "Купить хлеб");
    assert.equal(task.done, 0);
    const list = await (await call("GET", "/api/tasks")).json();
    assert.ok(list.some(item => item.id === task.id));
});

test("TB-002 пустое название задачи отклоняется", async () => {
    for (const title of ["", "   "]) assert.equal((await call("POST", "/api/tasks", { title })).status, 400, `title ${JSON.stringify(title)}`);
});

test("TB-003 название длиннее 200 символов отклоняется, 200 допускается", async () => {
    assert.equal((await call("POST", "/api/tasks", { title: "я".repeat(201) })).status, 400);
    assert.equal((await call("POST", "/api/tasks", { title: "я".repeat(200) })).status, 201);
});

test("TB-004 задачу можно переименовать, но не в пустое название", async () => {
    const task = await create("Старое название");
    const renamed = await call("PATCH", "/api/tasks/" + task.id, { title: "Новое название" });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).title, "Новое название");
    assert.equal((await call("PATCH", "/api/tasks/" + task.id, { title: " " })).status, 400);
});

test("TB-005 задачу можно отметить выполненной и вернуть обратно", async () => {
    const task = await create("Отметить");
    assert.equal((await (await call("PATCH", "/api/tasks/" + task.id, { done: true })).json()).done, 1);
    assert.equal((await (await call("PATCH", "/api/tasks/" + task.id, { done: false })).json()).done, 0);
});

test("TB-006 удалённая задача исчезает из списка, повторное удаление не находит её", async () => {
    const task = await create("Удалить");
    assert.equal((await call("DELETE", "/api/tasks/" + task.id)).status, 200);
    assert.equal((await call("DELETE", "/api/tasks/" + task.id)).status, 404);
    const list = await (await call("GET", "/api/tasks")).json();
    assert.ok(!list.some(item => item.id === task.id));
});
