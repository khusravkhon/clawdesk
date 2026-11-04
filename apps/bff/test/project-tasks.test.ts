import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BusinessRuleFields, CreateProjectRequest, type ProjectChecksRunResult, type ProjectCheckTestDto, type ProjectExecutorsDto } from "@clawdesk/shared";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanyService } from "../src/company/company-service.js";
import { ProjectTasksService } from "../src/company/project-tasks-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { BridgeError } from "../src/gateway/bridge-client.js";
import type { SpaceService } from "../src/space/space-service.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { registerCompanyRoutes } from "../src/routes/company.js";

// P6.2 task flow. The fake bridge runs "tests" written as lines "// TEST <name> => <text>": a test passes
// when server.mjs contains <text>. That is enough to tell failing-first tests, fixes and weakened tests apart.

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function evaluate(files: Record<string, string>): ProjectChecksRunResult {
  const tests: ProjectCheckTestDto[] = [];
  for (const [file, data] of Object.entries(files).filter(([name]) => name.endsWith(".test.mjs")))
    for (const match of data.matchAll(/^\/\/ TEST (.+?) => (.+)$/gm))
      tests.push({ id: `${file}::${match[1]}`, file, name: match[1]!, status: (files["server.mjs"] ?? "").includes(match[2]!) ? "passed" : "failed", message: "expected behaviour", fileHash: sha(data) });
  return { status: "completed", reason: null, tests, durationMs: 5, filesFingerprint: "f" };
}
const ruleFields = () => BusinessRuleFields.parse({ title: "Title required", statement: "A task needs a title", source: "Owner", role: "User", expectedResult: "400", allowedExample: "Buy bread", deniedExample: "Empty" });
const act = (revision: number) => ({ requestId: randomUUID(), revision });

describe("project tasks", () => {
  let root: string, db: Db, close: () => void, company: CompanyService, tasks: ProjectTasksService, projectId: string, ruleId: string;
  let app: Record<string, string>, work: Record<"qa" | "developer", Record<string, string>>, sent: { agentId: string; message: string }[], executors: ProjectExecutorsDto;
  const roleOf = (agentId: string): "qa" | "developer" => executors.executors.find(item => item.agentId === agentId)!.role;
  const bridge = {
    projectAppFiles: async () => ({ files: { ...app } }),
    prepareProjectWork: async (agentId: string, files: Record<string, string>) => { work[roleOf(agentId)] = { ...files }; return { path: "/workspace/project", files: Object.keys(files) }; },
    snapshotProjectWork: async (agentId: string) => ({ files: { ...work[roleOf(agentId)] }, ignored: [], hashes: {} }),
    runProjectChecks: async (_: string, files?: Record<string, string>) => evaluate(files ?? app),
    applyProjectWork: async (_: string, files: Record<string, string>, baseline: Record<string, string>) => {
      const same = Object.keys(app).length === Object.keys(baseline).length && Object.entries(app).every(([name, data]) => baseline[name] === sha(data));
      if (!same) throw new BridgeError("work_app_changed", "work_app_changed");
      app = { ...files };
      return { files: Object.keys(files), applied: true as const };
    },
  };
  const build = () => new ProjectTasksService({
    db,
    checkProject: (id) => { const p = company.rules.list(id) && { id, name: "Tasks", description: "", departmentId: null }; return p; },
    rule: (pid, rid, version) => {
      const rule = company.rules.list(pid).rules.find(item => item.id === rid);
      const selected = rule && company.rules.history(pid, rid).versions.find(item => item.version === version);
      return rule && selected ? { id: rule.id, code: rule.code, version: selected.version, fields: selected.fields, approvedAt: selected.approvedAt } : null;
    },
    executors: { list: () => executors, assign: async () => executors },
    bridge,
    send: async (agentId, message) => { sent.push({ agentId, message }); },
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-tasks-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    company = new CompanyService({ db, space: { mode: () => "company" } as SpaceService, gateway: {} as GatewayService });
    projectId = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Tasks" })).id;
    const rule = company.rules.create(projectId, { requestId: randomUUID(), fields: ruleFields() });
    ruleId = rule.id;
    company.rules.approve(projectId, ruleId, { requestId: randomUUID(), version: 1, revision: rule.revision, confirm: true });
    app = { "server.mjs": "create;", "checks.test.mjs": "// TEST TB-001 create => create" };
    work = { qa: {}, developer: {} };
    sent = [];
    executors = { teamId: "tasks-work", sandboxed: true, executors: [{ role: "qa", agentId: "tasks-work-project-qa", name: "QA", emoji: null }, { role: "developer", agentId: "tasks-work-project-developer", name: "Dev", emoji: null }] };
    tasks = build();
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("runs a rule from failing QA tests through an untouched-test fix to an accepted change in app/", async () => {
    const created = await tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 1, note: "keep it small" });
    expect(created).toMatchObject({ code: "TASK-001", ruleCode: "BR-001", status: "qa", revision: 0 });
    expect(work.qa).toEqual(app);
    expect(sent[0]).toMatchObject({ agentId: "tasks-work-project-qa" });
    expect(sent[0]!.message).toContain("BR-001 ");
    expect(sent[0]!.message).toContain("keep it small");

    // QA changes code: refused, the task stays with QA and remembers why.
    work.qa = { ...app, "server.mjs": "create; validate;", "checks.test.mjs": app["checks.test.mjs"] + "\n// TEST BR-001 rejects empty => validate" };
    let task = await tasks.checkStage(projectId, created.id, act(0));
    expect(task).toMatchObject({ status: "qa", lastCheck: { ok: false, reasons: ["changed_code", "tests_not_failing"] } });
    await tasks.resend(projectId, created.id, act(task.revision));
    expect(sent.at(-1)!.message).toContain("изменён код приложения");

    // QA's test passes already: not a failing-first test.
    work.qa = { ...app, "checks.test.mjs": app["checks.test.mjs"] + "\n// TEST BR-001 rejects empty => create" };
    task = await tasks.checkStage(projectId, created.id, act(2));
    expect(task.lastCheck?.reasons).toEqual(["tests_not_failing"]);

    // A proper failing test: the developer gets app + QA's tests.
    work.qa = { ...app, "checks.test.mjs": app["checks.test.mjs"] + "\n// TEST BR-001 rejects empty => validate" };
    task = await tasks.checkStage(projectId, created.id, act(3));
    expect(task).toMatchObject({ status: "dev", lastCheck: { ok: true } });
    expect(work.developer).toEqual(work.qa);
    expect(sent.at(-1)).toMatchObject({ agentId: "tasks-work-project-developer" });
    expect(sent.at(-1)!.message).toContain("BR-001 rejects empty");

    // The developer weakens the test instead of fixing the code: refused.
    work.developer = { ...work.developer, "checks.test.mjs": app["checks.test.mjs"] + "\n// TEST BR-001 rejects empty => create" };
    task = await tasks.checkStage(projectId, created.id, act(task.revision));
    expect(task).toMatchObject({ status: "dev", lastCheck: { reasons: ["changed_tests"] } });

    // A real fix: review shows the change against app/.
    work.developer = { ...work.qa, "server.mjs": "create; validate;" };
    task = await tasks.checkStage(projectId, created.id, act(task.revision));
    expect(task.status).toBe("review");
    expect(task.review?.map(c => [c.name, c.change])).toEqual([["checks.test.mjs", "modified"], ["server.mjs", "modified"]]);
    expect(task.review?.find(c => c.name === "server.mjs")?.diff).toBe("- create;\n+ create; validate;");

    task = await tasks.accept(projectId, created.id, act(task.revision));
    expect(task.status).toBe("done");
    expect(app["server.mjs"]).toBe("create; validate;");
    expect(task.events.map(e => e.kind)).toEqual(["created", "sent", "qa_checked", "sent", "qa_checked", "qa_checked", "sent", "dev_checked", "dev_checked", "accepted"]);
  });

  it("refuses to start without approval, executors or while another task is active", async () => {
    const draft = company.rules.create(projectId, { requestId: randomUUID(), fields: { ...ruleFields(), title: "Draft" } });
    await expect(tasks.create(projectId, { requestId: randomUUID(), ruleId: draft.id, ruleVersion: 1, note: "" })).rejects.toThrow("rule_not_approved");
    await expect(tasks.create(projectId, { requestId: randomUUID(), ruleId: randomUUID(), ruleVersion: 1, note: "" })).rejects.toThrow("rule_missing");
    executors = { ...executors, executors: executors.executors.slice(0, 1) };
    await expect(tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 1, note: "" })).rejects.toThrow("executors_required");
    executors = { ...executors, executors: [{ role: "qa", agentId: "q", name: "QA", emoji: null }, { role: "developer", agentId: "d", name: "Dev", emoji: null }] };
    const request = { requestId: randomUUID(), ruleId, ruleVersion: 1, note: "" };
    const first = await tasks.create(projectId, request);
    expect(await tasks.create(projectId, request)).toEqual(first);
    await expect(tasks.create(projectId, { ...request, note: "other" })).rejects.toThrow("request_conflict");
    await expect(tasks.create(projectId, { ...request, requestId: randomUUID() })).rejects.toThrow("task_active");
    await tasks.cancel(projectId, first.id, act(0));
    expect((await tasks.create(projectId, { ...request, requestId: randomUUID() })).code).toBe("TASK-002");
  });

  it("repeats an action once per request, rejects stale revisions and stale work on a changed app", async () => {
    const created = await tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 1, note: "" });
    work.qa = { ...app, "checks.test.mjs": app["checks.test.mjs"] + "\n// TEST BR-001 rejects empty => validate" };
    const request = act(0);
    const moved = await tasks.checkStage(projectId, created.id, request);
    const sentBefore = sent.length;
    expect(await tasks.checkStage(projectId, created.id, request)).toEqual(moved);
    expect(sent.length).toBe(sentBefore);
    await expect(tasks.checkStage(projectId, created.id, act(0))).rejects.toThrow("revision_conflict");
    work.developer = { ...work.developer, "server.mjs": "create; validate;" };
    let task = await tasks.checkStage(projectId, created.id, act(moved.revision));
    // The owner returns the work with a comment: back to the developer, who is told why.
    task = await tasks.returnToDeveloper(projectId, created.id, { ...act(task.revision), comment: "Please also trim spaces" });
    expect(task).toMatchObject({ status: "dev", returnComment: "Please also trim spaces" });
    expect(sent.at(-1)!.message).toContain("Please also trim spaces");
    task = await tasks.checkStage(projectId, created.id, act(task.revision));
    app = { ...app, "README.md": "changed meanwhile" };
    await expect(tasks.accept(projectId, created.id, act(task.revision))).rejects.toThrow("work_app_changed");
    expect((await tasks.list(projectId)).tasks[0]?.status).toBe("review");
  });

  it("migrates from 0017 keeping rules and checks, with no tasks yet", async () => {
    close();
    const sqlite = new Database(path.join(root, "panel.sqlite"));
    sqlite.exec("DROP TABLE project_task_events; DROP TABLE project_tasks; DELETE FROM __drizzle_migrations WHERE created_at = 1792348000000");
    sqlite.close();
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    company = new CompanyService({ db, space: { mode: () => "company" } as SpaceService, gateway: {} as GatewayService });
    tasks = build();
    expect(company.rules.list(projectId).rules.map(rule => [rule.code, rule.approvedAt !== null])).toEqual([["BR-001", true]]);
    expect(tasks.list(projectId)).toEqual({ tasks: [] });
    expect((await tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 1, note: "" })).code).toBe("TASK-001");
  });

  it("exposes executors and tasks over the company routes", async () => {
    const service = new CompanyService({ db, space: { mode: () => "company" } as SpaceService, gateway: {} as GatewayService });
    const server = Fastify(); registerCompanyRoutes(server, service);
    expect((await server.inject({ url: `/api/company/projects/${projectId}/executors` })).json()).toEqual({ teamId: null, executors: [], sandboxed: false });
    expect((await server.inject({ url: `/api/company/projects/${projectId}/tasks` })).json()).toEqual({ tasks: [] });
    const missing = await server.inject({ method: "POST", url: `/api/company/projects/${projectId}/tasks`, payload: { requestId: randomUUID(), ruleId, ruleVersion: 1 } });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ error: "executors_required" });
    expect((await server.inject({ method: "POST", url: `/api/company/projects/${projectId}/tasks/${randomUUID()}/accept`, payload: { requestId: randomUUID(), revision: 0 } })).statusCode).toBe(404);
    await server.close();
  });
});
