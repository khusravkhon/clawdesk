import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProjectFolders } from "./clawdesk-project-folders.mjs";
import { ProjectBuilder } from "./clawdesk-project-builder.mjs";

// Run only inside a disposable gateway fixture with its own state bind and identity.
const stateDir = process.env.OPENCLAW_STATE_DIR;
if (process.env.CLAWDESK_BUILDER_SMOKE !== "fixture" || stateDir !== "/fixture-state")
    throw new Error("Disposable builder fixture required");

const folders = new ProjectFolders({ stateDir });
const builder = new ProjectBuilder({ folders, stateDir });
const projectId = "smoke-project";
const planId = "smoke-plan";
await folders.status(projectId);
await folders.prepare({ projectId, name: "Fixture", mode: "new", requestId: randomUUID() });
assert.equal((await builder.prepare(projectId, { templateId: "task-board-v1", planId, projectName: "Smoke", brief: {}, rules: [] })).state, "prepared");
try {
    assert.equal((await builder.start(projectId, { planId })).state, "running");
    assert.equal((await builder.status(projectId)).state, "running");
    const call = async (method, path, body) => {
        const response = await builder.request(projectId, { method, path, ...(body === undefined ? {} : { body }) });
        assert.ok(response.status < 400, `Unexpected response ${response.status}`);
        return JSON.parse(response.body);
    };
    assert.deepEqual(await call("GET", "/api/tasks"), []);
    const task = await call("POST", "/api/tasks", { title: "Создано из шаблона" });
    const changed = await call("PATCH", "/api/tasks/" + task.id, { title: "Проверено", done: true });
    assert.equal(changed.title, "Проверено");
    assert.equal(changed.done, 1);
    assert.equal((await call("GET", "/api/tasks")).length, 1);
    await call("DELETE", "/api/tasks/" + task.id);
    assert.deepEqual(await call("GET", "/api/tasks"), []);
    const html = await builder.request(projectId, { method: "GET", path: "/" });
    assert.match(html.body, /Content-Security-Policy/);
    console.log("Builder fixture: generation, real sandbox readiness, proxy task CRUD, HTML and running status passed");
}
finally {
    assert.equal((await builder.stop(projectId)).state, "stopped");
}
assert.equal((await builder.status(projectId)).state, "stopped");
console.log("Builder fixture: owned sandbox removed and stopped status passed");
