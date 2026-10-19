import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BusinessRuleFields, CreateAcceptanceRequest, CreateProjectRequest, RecordAcceptanceCheckRequest, UpdateProjectRequest } from "@clawdesk/shared";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanyService } from "../src/company/company-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { acceptanceCases, acceptanceChecks, acceptanceRevisions } from "../src/db/schema.js";
import type { SpaceService } from "../src/space/space-service.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { registerCompanyRoutes } from "../src/routes/company.js";

const ruleFields = () => BusinessRuleFields.parse({ title: "Discount", statement: "A manager may grant 10%", source: "Owner", role: "Manager", expectedResult: "Larger discounts require approval", allowedExample: "10%", deniedExample: "11% without approval" });
const create = () => CreateAcceptanceRequest.parse({ requestId: randomUUID(), ruleVersion: 1, fields: { title: "Reject excessive discount", kind: "denied", given: "Own active order", action: "Grant 11% without approval", expected: "Request rejected", testRef: "tests/orders.spec.ts:discount" } });
const check = (patch = {}) => RecordAcceptanceCheckRequest.parse({ requestId: randomUUID(), ruleVersion: 1, revision: 1, outcome: "passed", context: "Local test build abc123", observed: "Rejected with the expected message", evidence: "Owner test log: order-42, forbidden discount", confirm: true, ...patch });

describe("acceptance scenarios and manual checks", () => {
  let root: string, db: Db, close: () => void, company: CompanyService, projectId: string, ruleId: string, mode: "company" | "personal";
  const service = () => new CompanyService({ db, space: { mode: () => mode } as SpaceService, gateway: {} as GatewayService });
  const approve = (version = 1, revision = 0) => company.rules.approve(projectId, ruleId, { requestId: randomUUID(), version, revision, confirm: true });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-acceptance-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite"))); mode = "company"; company = service();
    projectId = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "CRM" })).id;
    ruleId = company.rules.create(projectId, { requestId: randomUUID(), fields: ruleFields() }).id;
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("creates planned scenarios idempotently and requires approval before recording results", () => {
    const req = create();
    const first = company.acceptance.create(projectId, ruleId, req);
    expect(first).toMatchObject({ code: "AC-001", ruleVersion: 1, revision: 1, latestCheck: null });
    expect(company.acceptance.create(projectId, ruleId, req)).toEqual(first);
    expect(() => company.acceptance.create(projectId, ruleId, { ...req, fields: { ...req.fields, title: "Other" } })).toThrow("request_conflict");
    expect(company.acceptance.create(projectId, ruleId, create()).code).toBe("AC-002");
    expect(() => company.acceptance.record(projectId, ruleId, first.id, check())).toThrow("rule_not_approved");
    expect(company.acceptance.list(projectId, ruleId).cases).toHaveLength(2);
    expect(db.select().from(acceptanceChecks).all()).toEqual([]);
  });

  it("records manual provenance and keeps every result without turning blocked into passed", () => {
    approve();
    const item = company.acceptance.create(projectId, ruleId, create());
    const req = check();
    const passed = company.acceptance.record(projectId, ruleId, item.id, req);
    expect(passed).toMatchObject({ source: "manual", checkedBy: "owner", revision: 1, outcome: "passed", context: req.context, evidence: req.evidence });
    expect(company.acceptance.record(projectId, ruleId, item.id, req)).toEqual(passed);
    expect(() => company.acceptance.record(projectId, ruleId, item.id, { ...req, observed: "Another payload" })).toThrow("request_conflict");
    const failed = company.acceptance.record(projectId, ruleId, item.id, check({ outcome: "failed", observed: "The discount was accepted" }));
    const blocked = company.acceptance.record(projectId, ruleId, item.id, check({ outcome: "blocked", observed: "The test environment is unavailable", evidence: "" }));
    expect(company.acceptance.list(projectId, ruleId).cases[0]?.latestCheck).toEqual(blocked);
    expect(company.acceptance.history(projectId, ruleId, item.id).revisions[0]?.checks.map(row => row.id)).toEqual([blocked.id, failed.id, passed.id]);
  });

  it("invalidates a previous result when the scenario changes and rejects stale recording", () => {
    approve();
    const item = company.acceptance.create(projectId, ruleId, create());
    const result = company.acceptance.record(projectId, ruleId, item.id, check());
    const req = { ...create(), revision: 1, fields: { ...item.fields, action: "Grant 11% on a closed order" } };
    const edited = company.acceptance.update(projectId, ruleId, item.id, req);
    expect(edited).toMatchObject({ id: item.id, code: item.code, revision: 2, latestCheck: null });
    expect(company.acceptance.update(projectId, ruleId, item.id, req)).toEqual(edited);
    expect(() => company.acceptance.record(projectId, ruleId, item.id, check())).toThrow("revision_conflict");
    expect(() => company.acceptance.update(projectId, ruleId, item.id, { ...req, requestId: randomUUID() })).toThrow("revision_conflict");
    expect(() => company.acceptance.update(projectId, ruleId, item.id, { ...req, revision: 2, requestId: randomUUID() })).toThrow("acceptance_unchanged");
    const history = company.acceptance.history(projectId, ruleId, item.id);
    expect(history.revisions[0]?.checks).toEqual([]);
    expect(history.revisions[1]).toMatchObject({ revision: 1, fields: item.fields, checks: [result] });
  });

  it("keeps old rule-version evidence read-only and gives the new version no inherited checks", () => {
    approve();
    const item = company.acceptance.create(projectId, ruleId, create());
    company.acceptance.record(projectId, ruleId, item.id, check());
    company.rules.update(projectId, ruleId, { requestId: randomUUID(), revision: 1, fields: { ...ruleFields(), statement: "A manager may grant 15%" } });
    const current = company.acceptance.list(projectId, ruleId);
    expect(current).toMatchObject({ selectedVersion: 2, currentVersion: 2, approved: false, cases: [] });
    const old = company.acceptance.list(projectId, ruleId, 1);
    expect(old.cases[0]?.latestCheck?.outcome).toBe("passed");
    expect(() => company.acceptance.record(projectId, ruleId, item.id, check())).toThrow("revision_conflict");
    expect(() => company.acceptance.update(projectId, ruleId, item.id, { ...create(), ruleVersion: 2, revision: 1 })).toThrow("revision_conflict");
    const next = company.acceptance.create(projectId, ruleId, { ...create(), ruleVersion: 2 });
    expect(next).toMatchObject({ code: "AC-002", latestCheck: null });
    expect(() => company.acceptance.record(projectId, ruleId, next.id, check({ ruleVersion: 2 }))).toThrow("rule_not_approved");
    approve(2, 2);
    expect(company.acceptance.record(projectId, ruleId, next.id, check({ ruleVersion: 2, outcome: "blocked", observed: "No matching build", evidence: "" })).outcome).toBe("blocked");
  });

  it("persists scenario revisions and evidence across database restart", () => {
    approve();
    const item = company.acceptance.create(projectId, ruleId, create());
    company.acceptance.record(projectId, ruleId, item.id, check());
    const before = company.acceptance.list(projectId, ruleId);
    const history = company.acceptance.history(projectId, ruleId, item.id);
    close(); ({ db, close } = openDb(path.join(root, "panel.sqlite"))); company = service();
    expect(company.acceptance.list(projectId, ruleId)).toEqual(before);
    expect(company.acceptance.history(projectId, ruleId, item.id)).toEqual(history);
  });

  it("enforces project/rule scope, archive guards and personal mode", () => {
    approve();
    const item = company.acceptance.create(projectId, ruleId, create());
    const otherProject = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Other" })).id;
    const otherRule = company.rules.create(projectId, { requestId: randomUUID(), fields: ruleFields() });
    expect(() => company.acceptance.list(otherProject, ruleId)).toThrow("rule_missing");
    expect(() => company.acceptance.history(projectId, otherRule.id, item.id)).toThrow("acceptance_missing");
    company.updateProject(projectId, UpdateProjectRequest.parse({ name: "CRM", status: "archived", revision: 0 }));
    expect(() => company.acceptance.create(projectId, ruleId, create())).toThrow("project_archived");
    expect(() => company.acceptance.update(projectId, ruleId, item.id, { ...create(), revision: 1 })).toThrow("project_archived");
    expect(() => company.acceptance.record(projectId, ruleId, item.id, check())).toThrow("project_archived");
    expect(company.acceptance.history(projectId, ruleId, item.id).revisions).toHaveLength(1);
    mode = "personal";
    expect(() => company.acceptance.list(projectId, ruleId)).toThrow("company_only");
    expect(() => company.acceptance.record(projectId, ruleId, item.id, check())).toThrow("company_only");
  });

  it("validates evidence, confirmation and query versions at the HTTP boundary", async () => {
    approve();
    const app = Fastify(); registerCompanyRoutes(app, company);
    const url = `/api/company/projects/${projectId}/rules/${ruleId}/acceptance`;
    try {
      expect((await app.inject({ url: `${url}?version=0` })).statusCode).toBe(400);
      expect((await app.inject({ url: `${url}?version=99` })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url, payload: { ...create(), fields: { ...create().fields, action: "" } } })).statusCode).toBe(400);
      const response = await app.inject({ method: "POST", url, payload: create() });
      expect(response.statusCode).toBe(201);
      const id = response.json().id;
      const runUrl = `${url}/${id}/checks`;
      for (const patch of [{ confirm: false }, { evidence: "" }, { observed: "" }, { context: "" }, { outcome: "automatic-success" }]) {
        expect((await app.inject({ method: "POST", url: runUrl, payload: { ...check(), ...patch } })).statusCode).toBe(400);
      }
      expect(db.select().from(acceptanceChecks).all()).toEqual([]);
      const recorded = await app.inject({ method: "POST", url: runUrl, payload: { ...check(), source: "automated", checkedBy: "agent" } });
      expect(recorded.json()).toMatchObject({ source: "manual", checkedBy: "owner" });
      expect((await app.inject({ url: `${url}/${id}/history` })).json().revisions[0].checks).toHaveLength(1);
    } finally { await app.close(); }
  });

  it("rolls back partial updates and enforces version foreign keys", () => {
    const item = company.acceptance.create(projectId, ruleId, create());
    db.run(sql`CREATE TRIGGER acceptance_failure BEFORE UPDATE ON acceptance_cases BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    expect(() => company.acceptance.update(projectId, ruleId, item.id, { ...create(), revision: 1, fields: { ...item.fields, title: "Next" } })).toThrow();
    expect(db.select().from(acceptanceRevisions).all()).toHaveLength(1);
    expect(company.acceptance.list(projectId, ruleId).cases[0]).toEqual(item);
    expect(() => db.insert(acceptanceCases).values({ id: randomUUID(), ruleId, ruleVersion: 99, number: 2, requestId: randomUUID(), requestPayload: "{}" }).run()).toThrow();
    expect(() => db.insert(acceptanceChecks).values({ caseId: item.id, revision: 99, outcome: "passed", context: "build", observed: "test", evidence: "log", createdAt: Date.now(), requestId: randomUUID(), requestPayload: "{}" }).run()).toThrow();
  });
});
