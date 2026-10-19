import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApproveBusinessRuleRequest, BusinessRuleFields, CreateBusinessRuleRequest, CreateProjectRequest, UpdateBusinessRuleRequest, UpdateProjectRequest } from "@clawdesk/shared";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanyService } from "../src/company/company-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { projectRules, projectRuleVersions } from "../src/db/schema.js";
import type { SpaceService } from "../src/space/space-service.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { registerCompanyRoutes } from "../src/routes/company.js";

const fields = (patch = {}) => BusinessRuleFields.parse({ title: "Discount limit", statement: "A manager may discount up to 10%", source: "Owner interview", role: "Manager", expectedResult: "A higher discount requires owner approval", allowedExample: "10% on own order", deniedExample: "11% without approval", ...patch });
const create = (patch = {}) => CreateBusinessRuleRequest.parse({ requestId: randomUUID(), fields: fields(), ...patch });

describe("versioned project rules", () => {
  let root: string, db: Db, close: () => void, company: CompanyService, projectId: string, mode: "company" | "personal";
  const service = () => new CompanyService({ db, space: { mode: () => mode } as SpaceService, gateway: {} as GatewayService });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-rules-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite"))); mode = "company"; company = service();
    projectId = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "CRM" })).id;
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("creates stable per-project IDs and replays creation without duplicating rules", () => {
    const req = create();
    const first = company.rules.create(projectId, req);
    expect(first).toMatchObject({ code: "BR-001", version: 1, revision: 0, approvedAt: null, createdBy: "owner" });
    expect(company.rules.create(projectId, req)).toEqual(first);
    expect(() => company.rules.create(projectId, { ...req, fields: fields({ title: "Changed" }) })).toThrow("request_conflict");
    expect(company.rules.create(projectId, create()).code).toBe("BR-002");
    const other = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Other" })).id;
    expect(company.rules.create(other, create()).code).toBe("BR-001");
    expect(() => company.rules.history(other, first.id)).toThrow("rule_missing");
  });

  it("blocks incomplete or unresolved approval and records one explicit owner decision", () => {
    const incomplete = company.rules.create(projectId, create({ fields: fields({ source: "" }) }));
    const unresolved = company.rules.create(projectId, create({ fields: fields({ openQuestions: "Whose approval is needed?" }) }));
    const approval = (rule: typeof incomplete) => ApproveBusinessRuleRequest.parse({ requestId: randomUUID(), revision: rule.revision, version: rule.version, confirm: true });
    expect(() => company.rules.approve(projectId, incomplete.id, approval(incomplete))).toThrow("rule_incomplete");
    expect(() => company.rules.approve(projectId, unresolved.id, approval(unresolved))).toThrow("rule_incomplete");
    const ready = company.rules.create(projectId, create());
    const req = approval(ready);
    const agreed = company.rules.approve(projectId, ready.id, req);
    expect(agreed).toMatchObject({ revision: 1, approvedBy: "owner", version: 1 });
    expect(agreed.approvedAt).toBeTypeOf("number");
    expect(company.rules.approve(projectId, ready.id, req)).toEqual(agreed);
    expect(() => company.rules.approve(projectId, ready.id, { ...req, revision: 1 })).toThrow("request_conflict");
    expect(() => company.rules.approve(projectId, ready.id, { ...req, requestId: randomUUID(), revision: 1 })).toThrow("rule_already_approved");
  });

  it("preserves the approved old version and requires reapproval after edits, including restart", () => {
    const first = company.rules.create(projectId, create());
    const approval = { requestId: randomUUID(), revision: 0, version: 1, confirm: true as const };
    const agreed = company.rules.approve(projectId, first.id, approval);
    const changed = company.rules.update(projectId, first.id, UpdateBusinessRuleRequest.parse({ requestId: randomUUID(), revision: 1, fields: fields({ statement: "Only the owner may grant 15%" }) }));
    expect(changed).toMatchObject({ id: first.id, code: first.code, version: 2, revision: 2, approvedAt: null, approvedBy: null });
    expect(() => company.rules.approve(projectId, first.id, approval)).toThrow("revision_conflict");
    const history = company.rules.history(projectId, first.id);
    expect(history.versions.map(row => row.version)).toEqual([2, 1]);
    expect(history.versions[1]).toMatchObject({ fields: first.fields, approvedAt: agreed.approvedAt, approvedBy: "owner" });
    close(); ({ db, close } = openDb(path.join(root, "panel.sqlite"))); company = service();
    expect(company.rules.history(projectId, first.id)).toEqual(history);
    expect(company.rules.list(projectId).rules[0]).toEqual(changed);
  });

  it("rejects stale edits and replays only the latest matching edit", () => {
    const first = company.rules.create(projectId, create());
    const req = UpdateBusinessRuleRequest.parse({ requestId: randomUUID(), revision: 0, fields: fields({ title: "New title" }) });
    const second = company.rules.update(projectId, first.id, req);
    expect(company.rules.update(projectId, first.id, req)).toEqual(second);
    expect(() => company.rules.update(projectId, first.id, { ...req, fields: fields({ title: "Other payload" }) })).toThrow("request_conflict");
    expect(() => company.rules.update(projectId, first.id, { ...req, requestId: randomUUID() })).toThrow("revision_conflict");
    expect(() => company.rules.update(projectId, first.id, { ...req, requestId: randomUUID(), revision: 1 })).toThrow("rule_unchanged");
    company.rules.update(projectId, first.id, { ...req, requestId: randomUUID(), revision: 1, fields: fields({ title: "Third" }) });
    expect(() => company.rules.update(projectId, first.id, req)).toThrow("revision_conflict");
    expect(company.rules.history(projectId, first.id).versions).toHaveLength(3);
  });

  it("keeps archived history readable and rejects all writes and personal mode", () => {
    const rule = company.rules.create(projectId, create());
    company.updateProject(projectId, UpdateProjectRequest.parse({ name: "CRM", status: "archived", revision: 0 }));
    expect(() => company.rules.create(projectId, create())).toThrow("project_archived");
    expect(() => company.rules.update(projectId, rule.id, UpdateBusinessRuleRequest.parse({ requestId: randomUUID(), revision: 0, fields: fields({ title: "Other" }) }))).toThrow("project_archived");
    expect(() => company.rules.approve(projectId, rule.id, { requestId: randomUUID(), revision: 0, version: 1, confirm: true })).toThrow("project_archived");
    expect(company.rules.history(projectId, rule.id).versions).toHaveLength(1);
    mode = "personal";
    expect(() => company.rules.list(projectId)).toThrow("company_only");
    expect(() => company.rules.create(projectId, create())).toThrow("company_only");
  });

  it("validates HTTP approval confirmation, text limits and cross-project rule IDs", async () => {
    const app = Fastify(); registerCompanyRoutes(app, company);
    const url = `/api/company/projects/${projectId}/rules`;
    try {
      expect((await app.inject({ method: "POST", url, payload: { requestId: randomUUID(), fields: { title: "", statement: "" } } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url, payload: { requestId: randomUUID(), fields: { title: "Long", statement: "x".repeat(4001) } } })).statusCode).toBe(400);
      const response = await app.inject({ method: "POST", url, payload: { ...create(), approvedAt: 123, approvedBy: "owner" } });
      expect(response.statusCode).toBe(201);
      const rule = response.json();
      expect(rule.approvedAt).toBeNull();
      const approveUrl = `${url}/${rule.id}/approve`;
      const req = { requestId: randomUUID(), revision: 0, version: 1 };
      expect((await app.inject({ method: "POST", url: approveUrl, payload: req })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: approveUrl, payload: { ...req, confirm: false } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: approveUrl, payload: { ...req, confirm: true } })).json().approvedBy).toBe("owner");
      expect((await app.inject({ url: `${url}/${rule.id}/history` })).json().versions).toHaveLength(1);
      const other = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Other" })).id;
      expect((await app.inject({ url: `/api/company/projects/${other}/rules/${rule.id}/history` })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("rolls back both the rule and version when a write fails partway", () => {
    db.run(sql`CREATE TRIGGER rule_version_failure BEFORE INSERT ON project_rule_versions BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    expect(() => company.rules.create(projectId, create())).toThrow();
    expect(db.select().from(projectRules).all()).toEqual([]);
    db.run(sql`DROP TRIGGER rule_version_failure`);
    const rule = company.rules.create(projectId, create());
    db.run(sql`CREATE TRIGGER rule_head_failure BEFORE UPDATE ON project_rules BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    expect(() => company.rules.update(projectId, rule.id, UpdateBusinessRuleRequest.parse({ requestId: randomUUID(), revision: 0, fields: fields({ title: "Next" }) }))).toThrow();
    expect(db.select().from(projectRuleVersions).all()).toHaveLength(1);
    expect(company.rules.list(projectId).rules[0]).toEqual(rule);
  });
});
