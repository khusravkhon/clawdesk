import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BusinessRuleFields, CreateAcceptanceRequest, CreateProjectRequest, type ProjectChecksRunResult, type ProjectCheckTestDto, type ProjectExecutorRole, type ProjectExecutorsDto } from "@clawdesk/shared";
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

// P6.2/P6.3 task flow. The fake bridge runs tests written as `test("<name>", () => "<text>");`: a test passes
// when server.mjs contains <text>. That is enough to tell failing-first tests, fixes and weakened tests apart,
// and real enough JavaScript for the panel to compare the files test by test.

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function evaluate(files: Record<string, string>): ProjectChecksRunResult {
  const tests: ProjectCheckTestDto[] = [];
  for (const [file, data] of Object.entries(files).filter(([name]) => name.endsWith(".test.mjs")))
    for (const match of data.matchAll(/^test\("(.+?)", \(\) => "(.+?)"\);$/gm))
      tests.push({ id: `${file}::${match[1]}`, file, name: match[1]!, status: (files["server.mjs"] ?? "").includes(match[2]!) ? "passed" : "failed", message: "expected behaviour", fileHash: sha(data) });
  return { status: "completed", reason: null, tests, durationMs: 5, filesFingerprint: "f" };
}
const T = (name: string, text: string) => `\ntest(${JSON.stringify(name)}, () => ${JSON.stringify(text)});`;
const ruleFields = () => BusinessRuleFields.parse({ title: "Title required", statement: "A task needs a title", source: "Owner", role: "User", expectedResult: "400", allowedExample: "Buy bread", deniedExample: "Empty" });
const act = (revision: number) => ({ requestId: randomUUID(), revision });

describe("project tasks", () => {
  let root: string, db: Db, close: () => void, company: CompanyService, tasks: ProjectTasksService, projectId: string, ruleId: string;
  let app: Record<string, string>, work: Record<ProjectExecutorRole, Record<string, string>>, sent: { agentId: string; message: string }[], executors: ProjectExecutorsDto;
  const roleOf = (agentId: string): ProjectExecutorRole => executors.executors.find(item => item.agentId === agentId)!.role;
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
    app = { "server.mjs": "create;", "checks.test.mjs": T("TB-001 create", "create") };
    work = { qa: {}, developer: {}, reviewer: {} };
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
    work.qa = { ...app, "server.mjs": "create; validate;", "checks.test.mjs": app["checks.test.mjs"] + T("BR-001 rejects empty", "validate") };
    let task = await tasks.checkStage(projectId, created.id, act(0));
    expect(task).toMatchObject({ status: "qa", lastCheck: { ok: false, reasons: ["changed_code", "tests_not_failing"] } });
    await tasks.resend(projectId, created.id, act(task.revision));
    expect(sent.at(-1)!.message).toContain("изменён код приложения");

    // QA's test passes already: not a failing-first test.
    work.qa = { ...app, "checks.test.mjs": app["checks.test.mjs"] + T("BR-001 rejects empty", "create") };
    task = await tasks.checkStage(projectId, created.id, act(2));
    expect(task.lastCheck?.reasons).toEqual(["tests_not_failing"]);

    // A proper failing test: the developer gets app + QA's tests.
    work.qa = { ...app, "checks.test.mjs": app["checks.test.mjs"] + T("BR-001 rejects empty", "validate") };
    task = await tasks.checkStage(projectId, created.id, act(3));
    expect(task).toMatchObject({ status: "dev", lastCheck: { ok: true } });
    expect(work.developer).toEqual(work.qa);
    expect(sent.at(-1)).toMatchObject({ agentId: "tasks-work-project-developer" });
    expect(sent.at(-1)!.message).toContain("BR-001 rejects empty");

    // The developer weakens the test instead of fixing the code: refused.
    work.developer = { ...work.developer, "checks.test.mjs": app["checks.test.mjs"] + T("BR-001 rejects empty", "create") };
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

  it("sends accepted changes to the reviewer agent and makes its verdict count before acceptance", async () => {
    executors = { ...executors, executors: [...executors.executors, { role: "reviewer", agentId: "tasks-work-project-reviewer", name: "Reviewer", emoji: null }] };
    const created = await tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 1, note: "" });
    work.qa = { ...app, "checks.test.mjs": app["checks.test.mjs"] + T("BR-001 rejects empty", "validate") };
    let task = await tasks.checkStage(projectId, created.id, act(0));
    work.developer = { ...work.qa, "server.mjs": "create; validate;" };
    // Asking before the review stage is refused.
    await expect(tasks.collectReview(projectId, created.id, act(task.revision))).rejects.toThrow("task_closed");
    task = await tasks.checkStage(projectId, created.id, act(task.revision));
    // The panel accepted the developer's work: the reviewer gets the files and the request at once.
    expect(task).toMatchObject({ status: "review", reviewer: null });
    expect(task.reviewRequestedAt).toBeTypeOf("number");
    expect(work.reviewer["server.mjs"]).toBe("create; validate;");
    expect(work.reviewer["REVIEW-REQUEST.md"]).toContain("BR-001");
    expect(work.reviewer["REVIEW-REQUEST.md"]).toContain("+ create; validate;");
    expect(sent.at(-1)).toMatchObject({ agentId: "tasks-work-project-reviewer" });
    expect(sent.at(-1)!.message).toContain("REVIEW.md");

    // No REVIEW.md yet.
    await expect(tasks.collectReview(projectId, created.id, act(task.revision))).rejects.toThrow("review_not_written");
    // "Changes" plus an edit of the code: the edit is listed, never applied; accepting needs the owner's override.
    work.reviewer = { ...work.reviewer, "server.mjs": "create; validate; hack;", "REVIEW.md": "**НУЖНЫ ИЗМЕНЕНИЯ**\n- server.mjs: пробелы не учитываются" };
    task = await tasks.collectReview(projectId, created.id, act(task.revision));
    expect(task.reviewer).toMatchObject({ verdict: "changes", comment: "- server.mjs: пробелы не учитываются", changedFiles: ["server.mjs"] });
    await expect(tasks.accept(projectId, created.id, act(task.revision))).rejects.toThrow("review_changes_requested");

    // Returned to the developer: the old verdict goes; the next accepted work goes to review again.
    task = await tasks.returnToDeveloper(projectId, created.id, { ...act(task.revision), comment: "учти пробелы" });
    expect(task).toMatchObject({ status: "dev", reviewer: null, reviewRequestedAt: null });
    work.developer = { ...work.qa, "server.mjs": "create; validate; trim;" };
    task = await tasks.checkStage(projectId, created.id, act(task.revision));
    expect(work.reviewer["server.mjs"]).toBe("create; validate; trim;");
    expect(work.reviewer["REVIEW.md"]).toBeUndefined();
    work.reviewer = { ...work.reviewer, "REVIEW.md": "ОДОБРЕНО\nПроверил пустые и пробельные названия." };
    task = await tasks.collectReview(projectId, created.id, act(task.revision));
    expect(task.reviewer).toMatchObject({ verdict: "approve", changedFiles: [] });
    task = await tasks.accept(projectId, created.id, act(task.revision));
    expect(task.status).toBe("done");
    expect(app["server.mjs"]).toBe("create; validate; trim;");
    expect(app["REVIEW.md"]).toBeUndefined();
    expect(task.events.map(e => e.kind).filter(kind => kind === "review_requested" || kind === "reviewed")).toEqual(["review_requested", "reviewed", "review_requested", "reviewed"]);
  });

  it("asks the reviewer again on request, and accepts over a 'changes' verdict only with the owner's word", async () => {
    executors = { ...executors, executors: [...executors.executors, { role: "reviewer", agentId: "tasks-work-project-reviewer", name: "Reviewer", emoji: null }] };
    const created = await tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 1, note: "" });
    work.qa = { ...app, "checks.test.mjs": app["checks.test.mjs"] + T("BR-001 rejects empty", "validate") };
    let task = await tasks.checkStage(projectId, created.id, act(0));
    work.developer = { ...work.qa, "server.mjs": "create; validate;" };
    task = await tasks.checkStage(projectId, created.id, act(task.revision));
    work.reviewer = { "REVIEW.md": "Не уверен." };
    task = await tasks.askReviewer(projectId, created.id, act(task.revision));
    expect(work.reviewer["REVIEW.md"]).toBeUndefined();
    work.reviewer = { ...work.reviewer, "REVIEW.md": "Нужны изменения\nнет проверки длины" };
    task = await tasks.collectReview(projectId, created.id, act(task.revision));
    expect(task.reviewer?.verdict).toBe("changes");
    task = await tasks.accept(projectId, created.id, { ...act(task.revision), overrideReview: true });
    expect(task.status).toBe("done");
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
    work.qa = { ...app, "checks.test.mjs": app["checks.test.mjs"] + T("BR-001 rejects empty", "validate") };
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
    sqlite.exec("DROP TABLE google_doc_copies; DROP TABLE agent_charter_versions; ALTER TABLE teams DROP COLUMN lead_agent_id; ALTER TABLE teams DROP COLUMN owner_requests; DROP TABLE work_item_events; DROP TABLE work_items; DROP TABLE work_request_buttons; DROP TABLE resource_grants; DROP TABLE work_request_events; DROP TABLE work_request_spool; DROP TABLE work_requests; DROP TABLE project_task_events; DROP TABLE project_tasks; ALTER TABLE project_check_results DROP COLUMN test_hash; ALTER TABLE acceptance_test_links DROP COLUMN test_hash; ALTER TABLE project_check_runs DROP COLUMN isolation; DELETE FROM __drizzle_migrations WHERE created_at >= 1792348000000");
    sqlite.close();
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    company = new CompanyService({ db, space: { mode: () => "company" } as SpaceService, gateway: {} as GatewayService });
    tasks = build();
    expect(company.rules.list(projectId).rules.map(rule => [rule.code, rule.approvedAt !== null])).toEqual([["BR-001", true]]);
    expect(tasks.list(projectId)).toEqual({ tasks: [] });
    expect((await tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 1, note: "" })).code).toBe("TASK-001");
  });

  /** Runs a task on the rule's given version from QA to acceptance. */
  async function deliver(version: number, qaTests: string, code: string) {
    const created = await tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: version, note: "" });
    work.qa = { ...app, "checks.test.mjs": qaTests };
    let task = await tasks.checkStage(projectId, created.id, act(created.revision));
    expect(task.status).toBe("dev");
    work.developer = { ...work.developer, "server.mjs": code };
    task = await tasks.checkStage(projectId, created.id, act(task.revision));
    expect(task.status).toBe("review");
    return task;
  }
  const newVersion = (statement: string, approve = true) => {
    const current = company.rules.list(projectId).rules[0]!;
    const updated = company.rules.update(projectId, ruleId, { requestId: randomUUID(), revision: current.revision, fields: { ...current.fields, statement } });
    if (approve) company.rules.approve(projectId, ruleId, { requestId: randomUUID(), version: updated.version, revision: updated.revision, confirm: true });
  };

  it("changes an implemented rule: only its own tests are rewritten, data is confirmed, the change can be rolled back", async () => {
    app = { "server.mjs": "create; validate;", "checks.test.mjs": T("TB-001 create", "create") + T("TB-002 empty rejected", "validate") };
    // BR-001's scenario names the template test that protects it: that test belongs to the rule.
    company.acceptance.create(projectId, ruleId, CreateAcceptanceRequest.parse({ requestId: randomUUID(), ruleVersion: 1, fields: { title: "Empty rejected", kind: "denied", action: "Create with an empty title", expected: "400", testRef: "checks.test.mjs::TB-002 empty rejected" } }));
    let first = await deliver(1, app["checks.test.mjs"] + T("BR-001 trims", "trim"), "create; validate; trim;");
    expect(first.previousVersion).toBeNull();
    first = await tasks.accept(projectId, first.id, act(first.revision));
    expect(first).toMatchObject({ status: "done", canRollback: true });
    const implementedV1 = { ...app };

    newVersion("An empty title becomes Untitled");
    const impact = tasks.impact(projectId, ruleId);
    expect(impact).toMatchObject({ code: "BR-001", version: 2, approved: true, previousVersion: 1, changedFields: ["statement"], implementedBy: "TASK-001", files: ["checks.test.mjs", "server.mjs"], newScenarios: 0, activeTask: null, tests: [] });
    expect(impact.previousFields?.statement).toBe("A task needs a title");
    expect(impact.scenarios).toEqual([{ code: "AC-001", title: "Empty rejected", ruleVersion: 1, testRef: "checks.test.mjs::TB-002 empty rejected", status: "unlinked" }]);

    const change = await tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 2, note: "" });
    expect(change).toMatchObject({ code: "TASK-002", ruleVersion: 2, previousVersion: 1, outdated: false });
    expect(sent.at(-1)!.message).toContain("версия 1 → 2");
    expect(sent.at(-1)!.message).toContain("A task needs a title");
    expect(tasks.impact(projectId, ruleId).activeTask).toBe("TASK-002");
    expect(tasks.list(projectId).tasks.find(item => item.id === first.id)?.canRollback).toBe(false);

    // Weakening another rule's test is refused, and the agent is told which test to restore.
    work.qa = { ...app, "checks.test.mjs": T("TB-001 create", "") + T("BR-001 trims", "trim") + T("BR-001 empty becomes untitled", "untitled") };
    let task = await tasks.checkStage(projectId, change.id, act(change.revision));
    expect(task.lastCheck?.reasons).toContain("protected_tests_changed");
    task = await tasks.resend(projectId, change.id, act(task.revision));
    expect(sent.at(-1)!.message).toContain("TB-001 create: изменён");

    // Replacing the rule's own template test with one for the new behaviour is accepted.
    work.qa = { ...app, "checks.test.mjs": T("TB-001 create", "create") + T("BR-001 trims", "trim") + T("BR-001 empty becomes untitled", "untitled") };
    task = await tasks.checkStage(projectId, change.id, act(task.revision));
    expect(task.status).toBe("dev");
    expect(task.lastCheck?.testChanges.map(c => [c.name, c.change, c.rule])).toEqual([["BR-001 empty becomes untitled", "added", true], ["TB-002 empty rejected", "removed", true]]);
    expect(sent.at(-1)!.message).toContain("Данные, которые уже есть в приложении, не переноси");
    work.developer = { ...work.developer, "server.mjs": "create; trim; untitled;" };
    task = await tasks.checkStage(projectId, change.id, act(task.revision));
    expect(task.reviewTests?.map(c => [c.name, c.change])).toEqual([["BR-001 empty becomes untitled", "added"], ["TB-002 empty rejected", "removed"]]);

    // The panel migrates no data: accepting a change needs the owner's word.
    await expect(tasks.accept(projectId, change.id, act(task.revision))).rejects.toThrow("data_confirmation_required");
    task = await tasks.accept(projectId, change.id, { ...act(task.revision), confirmData: true });
    expect(task).toMatchObject({ status: "done", canRollback: true });
    expect(task.events.at(-1)).toMatchObject({ kind: "accepted", note: "data_confirmed" });
    expect(tasks.impact(projectId, ruleId)).toMatchObject({ previousVersion: null, implementedBy: "TASK-002" });

    // Only the latest accepted task rolls back, and only onto exactly the files it wrote.
    await expect(tasks.rollback(projectId, first.id, act(tasks.list(projectId).tasks.find(item => item.id === first.id)!.revision))).rejects.toThrow("rollback_unavailable");
    task = await tasks.rollback(projectId, change.id, act(task.revision));
    expect(task).toMatchObject({ status: "done", canRollback: false });
    expect(task.rolledBackAt).toEqual(expect.any(Number));
    expect(app).toEqual(implementedV1);
    expect(tasks.impact(projectId, ruleId)).toMatchObject({ previousVersion: 1, implementedBy: "TASK-001" });
    const back = tasks.list(projectId).tasks.find(item => item.id === first.id)!;
    expect(back.canRollback).toBe(true);
    app = { ...app, "README.md": "edited by hand" };
    await expect(tasks.rollback(projectId, first.id, act(back.revision))).rejects.toThrow("work_app_changed");
  });

  it("does not accept a task whose rule changed again, and starts tasks only on the current version", async () => {
    const task = await deliver(1, app["checks.test.mjs"] + T("BR-001 rejects empty", "validate"), "create; validate;");
    newVersion("Reworded", false);
    expect(tasks.list(projectId).tasks[0]).toMatchObject({ status: "review", outdated: true });
    await expect(tasks.accept(projectId, task.id, act(task.revision))).rejects.toThrow("rule_outdated");
    await tasks.cancel(projectId, task.id, act(task.revision));
    expect(tasks.list(projectId).tasks[0]).toMatchObject({ status: "cancelled", outdated: false });
    await expect(tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 1, note: "" })).rejects.toThrow("rule_outdated");
    await expect(tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 2, note: "" })).rejects.toThrow("rule_not_approved");
  });

  it("migrates from 0018 keeping tasks and their history", async () => {
    const created = await tasks.create(projectId, { requestId: randomUUID(), ruleId, ruleVersion: 1, note: "" });
    close();
    const sqlite = new Database(path.join(root, "panel.sqlite"));
    sqlite.exec([
      "ALTER TABLE project_tasks DROP COLUMN previous_version", "ALTER TABLE project_tasks DROP COLUMN rolled_back_at",
      "ALTER TABLE project_tasks DROP COLUMN review_requested_at", "ALTER TABLE project_tasks DROP COLUMN reviewer", "ALTER TABLE project_check_runs DROP COLUMN isolation",
      "ALTER TABLE project_check_results DROP COLUMN test_hash", "ALTER TABLE acceptance_test_links DROP COLUMN test_hash",
      "CREATE TABLE old_events (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `task_id` text NOT NULL REFERENCES `project_tasks`(`id`) ON DELETE CASCADE, `kind` text NOT NULL CHECK (`kind` IN ('created','sent','qa_checked','dev_checked','accepted','returned','cancelled')), `note` text DEFAULT '' NOT NULL, `created_at` integer NOT NULL, `request_id` text NOT NULL)",
      "INSERT INTO old_events SELECT * FROM project_task_events", "DROP TABLE project_task_events", "ALTER TABLE old_events RENAME TO project_task_events",
      "CREATE UNIQUE INDEX `project_task_event_request_uq` ON `project_task_events` (`task_id`, `request_id`)",
      "DROP TABLE google_doc_copies", "DROP TABLE agent_charter_versions", "ALTER TABLE teams DROP COLUMN lead_agent_id", "ALTER TABLE teams DROP COLUMN owner_requests",
      "DROP TABLE work_item_events", "DROP TABLE work_items", "DROP TABLE work_request_buttons", "DROP TABLE resource_grants", "DROP TABLE work_request_events", "DROP TABLE work_request_spool", "DROP TABLE work_requests",
      "DELETE FROM __drizzle_migrations WHERE created_at >= 1792349000000",
    ].join(";\n"));
    sqlite.close();
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    company = new CompanyService({ db, space: { mode: () => "company" } as SpaceService, gateway: {} as GatewayService });
    tasks = build();
    expect(tasks.list(projectId).tasks).toEqual([expect.objectContaining({ id: created.id, previousVersion: null, rolledBackAt: null, events: created.events })]);
    const check = new Database(path.join(root, "panel.sqlite"), { readonly: true });
    expect((check.prepare("SELECT sql FROM sqlite_master WHERE name = 'project_task_events'").get() as { sql: string }).sql).toContain("'rolled_back'");
    check.close();
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
    expect((await server.inject({ method: "POST", url: `/api/company/projects/${projectId}/tasks/${randomUUID()}/rollback`, payload: { requestId: randomUUID(), revision: 0 } })).statusCode).toBe(404);
    expect((await server.inject({ url: `/api/company/projects/${projectId}/rules/${ruleId}/impact` })).json()).toMatchObject({ code: "BR-001", version: 1, previousVersion: null, implementedBy: null, scenarios: [] });
    expect((await server.inject({ url: `/api/company/projects/${projectId}/rules/${ruleId}/impact?version=9` })).statusCode).toBe(404);
    await server.close();
  });
});
