import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BusinessRuleFields, CreateAcceptanceRequest, CreateProjectRequest, type ProjectChecksRunResult, type ProjectCheckTestDto } from "@clawdesk/shared";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanyService } from "../src/company/company-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { BridgeError } from "../src/gateway/bridge-client.js";
import type { SpaceService } from "../src/space/space-service.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { registerCompanyRoutes } from "../src/routes/company.js";

// P6.1: automated checks of a generated project and what they mean for its acceptance scenarios.

const TB002 = "checks.test.mjs::TB-002 пустое название задачи отклоняется";
const test = (id: string, status: ProjectCheckTestDto["status"] = "passed", fileHash = "h1", message = ""): ProjectCheckTestDto => ({ id, file: id.split("::")[0]!, name: id.split("::")[1]!, status, message, fileHash });
const completed = (tests: ProjectCheckTestDto[]): ProjectChecksRunResult => ({ status: "completed", reason: null, tests, durationMs: 1234, filesFingerprint: "f" });
const ruleFields = () => BusinessRuleFields.parse({ title: "Empty title", statement: "A task needs a title", source: "Owner", role: "User", expectedResult: "Rejected", allowedExample: "Buy bread", deniedExample: "Empty" });
const scenario = (testRef: string) => CreateAcceptanceRequest.parse({ requestId: randomUUID(), ruleVersion: 1, fields: { title: "Empty title rejected", kind: "denied", action: "Create a task with an empty title", expected: "400", testRef } });

describe("project checks", () => {
  let root: string, db: Db, close: () => void, company: CompanyService, projectId: string, ruleId: string, mode: "company" | "personal";
  let next: (() => Promise<ProjectChecksRunResult>) | null, calls: number;
  const bridge = { runProjectChecks: async () => { calls++; if (!next) throw new Error("no run prepared"); return next(); } };
  const runWith = (result: ProjectChecksRunResult) => { next = async () => result; return company.checks.run(projectId, { requestId: randomUUID() }); };
  const automated = () => company.acceptance.list(projectId, ruleId).cases.map(item => item.automated?.status ?? null);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-checks-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite"))); mode = "company"; next = null; calls = 0;
    company = new CompanyService({ db, space: { mode: () => mode } as SpaceService, gateway: {} as GatewayService, bridge: bridge as never });
    projectId = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Tasks" })).id;
    ruleId = company.rules.create(projectId, { requestId: randomUUID(), fields: ruleFields() }).id;
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("stores each run once per request and lists the latest with its tests and a history", async () => {
    expect(company.checks.list(projectId)).toEqual({ latest: null, history: [] });
    const requestId = randomUUID();
    next = async () => completed([test(TB002), test("checks.test.mjs::TB-001 a", "failed", "h1", "boom"), test("checks.test.mjs::TB-003 b", "flaky")]);
    const first = await company.checks.run(projectId, { requestId });
    expect(first).toMatchObject({ status: "completed", durationMs: 1234, counts: { passed: 1, failed: 1, flaky: 1, skipped: 0 } });
    expect(await company.checks.run(projectId, { requestId })).toEqual(first);
    expect(calls).toBe(1);
    const blocked = await runWith({ status: "blocked", reason: "timeout", tests: [], durationMs: 120000, filesFingerprint: "f" });
    const list = company.checks.list(projectId);
    expect(list.latest).toMatchObject({ id: blocked.id, status: "blocked", reason: "timeout", tests: [] });
    expect(list.history.map(run => run.id)).toEqual([blocked.id, first.id]);
  });

  it("refuses a second run of the same project while one is going", async () => {
    let release!: () => void;
    next = () => new Promise(resolve => { release = () => resolve(completed([test(TB002)])); });
    const running = company.checks.run(projectId, { requestId: randomUUID() });
    await expect(company.checks.run(projectId, { requestId: randomUUID() })).rejects.toThrow("checks_busy");
    release();
    await running;
  });

  it("links a scenario to a test it names and follows that test through later runs", async () => {
    company.acceptance.create(projectId, ruleId, scenario(TB002));
    expect(automated()).toEqual(["unlinked"]);
    await runWith(completed([test(TB002)]));
    const linked = company.acceptance.create(projectId, ruleId, scenario(TB002));
    expect(automated()).toEqual(["unlinked", "passed"]);
    await runWith(completed([test(TB002, "failed", "h1", "expected 400, got 201")]));
    expect(company.acceptance.list(projectId, ruleId).cases[1]?.automated).toMatchObject({ testId: TB002, status: "failed", message: "expected 400, got 201" });
    await runWith(completed([test(TB002, "flaky")]));
    expect(automated()[1]).toBe("flaky");
    await runWith({ status: "blocked", reason: "runner_failed", tests: [], durationMs: 5, filesFingerprint: "f" });
    expect(automated()[1]).toBe("blocked");
    await runWith(completed([test("checks.test.mjs::TB-001 a")]));
    expect(automated()[1]).toBe("not_run");
    expect(linked.automated?.status).toBe("passed");
  });

  it("a protected test whose file changed is not a pass until a new scenario revision accepts it", async () => {
    await runWith(completed([test(TB002)]));
    const item = company.acceptance.create(projectId, ruleId, scenario(TB002));
    await runWith(completed([test(TB002, "passed", "h2")]));
    expect(automated()).toEqual(["changed"]);
    const updated = company.acceptance.update(projectId, ruleId, item.id, { ...scenario(TB002), revision: 1, fields: { ...scenario(TB002).fields, expected: "400 invalid_title" } });
    expect(updated.revision).toBe(2);
    expect(automated()).toEqual(["passed"]);
  });

  it("runs exactly the app files it read and links a scenario to its own test, so edits to other tests keep it valid (P6.3)", async () => {
    const source = (tb2: string, tb3: string) => `import { test } from "node:test";\ntest("TB-002 пустое название задачи отклоняется", () => { ${tb2} });\ntest("TB-003 b", () => { ${tb3} });\n`;
    let files: Record<string, string> = { "server.mjs": "x", "checks.test.mjs": source("a()", "b()") };
    const given: Record<string, string>[] = [];
    const reading = new CompanyService({ db, space: { mode: () => mode } as SpaceService, gateway: {} as GatewayService, bridge: {
      projectAppFiles: async () => ({ files: { ...files } }),
      runProjectChecks: async (_: string, sent?: Record<string, string>) => { given.push(sent!); return completed([test(TB002, "passed", sent!["checks.test.mjs"]!), test("checks.test.mjs::TB-003 b", "passed", sent!["checks.test.mjs"]!)]); },
    } as never });
    await reading.checks.run(projectId, { requestId: randomUUID() });
    expect(given).toEqual([files]);
    reading.acceptance.create(projectId, ruleId, scenario(TB002));
    const status = () => reading.acceptance.list(projectId, ruleId).cases[0]?.automated?.status;
    expect(status()).toBe("passed");
    files = { ...files, "checks.test.mjs": source("a()", "b(); c()") };
    await reading.checks.run(projectId, { requestId: randomUUID() });
    expect(status()).toBe("passed");
    files = { ...files, "checks.test.mjs": source("return", "b(); c()") };
    await reading.checks.run(projectId, { requestId: randomUUID() });
    expect(status()).toBe("changed");
  });

  it("scenarios without a test reference have no automated status", async () => {
    await runWith(completed([test(TB002)]));
    company.acceptance.create(projectId, ruleId, scenario(""));
    expect(automated()).toEqual([null]);
  });

  it("migrates from 0016 keeping scenarios, which then have no link until saved again", async () => {
    company.acceptance.create(projectId, ruleId, scenario(TB002));
    close();
    const sqlite = new Database(path.join(root, "panel.sqlite"));
    sqlite.exec("DROP TABLE agent_charter_versions; ALTER TABLE teams DROP COLUMN lead_agent_id; ALTER TABLE teams DROP COLUMN owner_requests; DROP TABLE work_item_events; DROP TABLE work_items; DROP TABLE work_request_buttons; DROP TABLE resource_grants; DROP TABLE work_request_events; DROP TABLE work_request_spool; DROP TABLE work_requests; DROP TABLE project_task_events; DROP TABLE project_tasks; DELETE FROM __drizzle_migrations WHERE created_at >= 1792348000000");
    sqlite.exec("DROP TABLE acceptance_test_links; DROP TABLE project_check_results; DROP TABLE project_check_runs; DELETE FROM __drizzle_migrations WHERE created_at = 1792347000000");
    sqlite.close();
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    company = new CompanyService({ db, space: { mode: () => mode } as SpaceService, gateway: {} as GatewayService, bridge: bridge as never });
    expect(company.acceptance.list(projectId, ruleId).cases.map(item => [item.code, item.automated?.status])).toEqual([["AC-001", "unlinked"]]);
    expect(company.checks.list(projectId)).toEqual({ latest: null, history: [] });
  });

  it("is company-only and maps bridge refusals to clear errors", async () => {
    const app = Fastify(); registerCompanyRoutes(app, company);
    next = async () => { throw new BridgeError("checks_unsupported", "checks_unsupported"); };
    const refused = await app.inject({ method: "POST", url: `/api/company/projects/${projectId}/checks/run`, payload: { requestId: randomUUID() } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "checks_unsupported" });
    expect((await app.inject({ method: "POST", url: `/api/company/projects/${projectId}/checks/run`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/company/projects/${projectId}/checks` })).json()).toEqual({ latest: null, history: [] });
    mode = "personal";
    expect((await app.inject({ url: `/api/company/projects/${projectId}/checks` })).statusCode).toBe(404);
    await app.close();
  });
});
