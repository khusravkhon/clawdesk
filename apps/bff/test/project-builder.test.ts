import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BusinessRuleFields, CreateProjectRequest, ProjectBriefFields, ProjectPreviewRequest, UpdateProjectRequest, type ProjectBuilderRuntimeDto, type ProjectWorkspaceDto } from "@clawdesk/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { CompanyService } from "../src/company/company-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { projectBuilders } from "../src/db/schema.js";
import type { SpaceService } from "../src/space/space-service.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { registerCompanyRoutes } from "../src/routes/company.js";
import { BridgeError } from "../src/gateway/bridge-client.js";

const runtime = (): ProjectBuilderRuntimeDto => ({ state: "empty", planId: null, files: [], previewUrl: null, error: null });
describe("project builder guided workflow", () => {
  let root: string, db: Db, close: () => void, company: CompanyService, id: string;
  let mode: "new" | "existing", spaceMode: "company" | "personal";
  const bridge = {
    projectWorkspace: vi.fn(async (): Promise<ProjectWorkspaceDto> => ({ rootPath: "/projects", workspace: { name: "test", path: "/projects/test", mode, state: "ready" as const }, available: [], truncated: false })),
    prepareProjectWorkspace: vi.fn(), builderStatus: vi.fn(async () => runtime()),
    prepareProjectApp: vi.fn(async () => runtime()), startProjectPreview: vi.fn(async () => runtime()), stopProjectPreview: vi.fn(async () => runtime()),
    projectPreviewRequest: vi.fn(async () => ({ status: 200, contentType: "text/html", body: "test" })),
    analyzeProjectWorkspace: vi.fn(async () => ({ files: ["package.json"], dependencies: ["vue"], hasGit: true, truncated: false })),
  };
  const service = () => new CompanyService({ db, bridge, space: { mode: () => spaceMode } as SpaceService, gateway: {} as GatewayService });
  const req = (revision: number) => ({ requestId: randomUUID(), revision });
  const confirm = (revision: number) => ({ ...req(revision), confirm: true as const });
  const complete = () => company.saveProjectBrief(id, { requestId: randomUUID(), revision: company.projectBrief(id).revision, step: 3, fields: ProjectBriefFields.parse({ goal: "Tasks", audience: "Owner", scenarios: "Create tasks", inScope: "Tasks", outOfScope: "Roles", rules: "None", data: "Title", integrations: "None", constraints: "Local" }) });
  beforeEach(() => {
    vi.clearAllMocks(); mode = "new"; spaceMode = "company";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-builder-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite"))); company = service();
    id = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Tasks" })).id;
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("reuses saved brief, persists one conversational answer atomically and deduplicates requests", async () => {
    const initial = await company.builder.get(id);
    expect(initial.questions[0]?.field).toBe("goal");
    expect(db.select().from(projectBuilders).all()).toHaveLength(0);
    const answer = { ...req(0), field: "goal" as const, value: "Personal tasks" };
    const saved = await company.builder.answer(id, answer);
    expect(saved.revision).toBe(1); expect(saved.questions[0]?.field).toBe("audience");
    expect(company.projectBrief(id).fields.goal).toBe("Personal tasks");
    await company.builder.answer(id, answer);
    expect(company.projectBrief(id).revision).toBe(1);
    await expect(company.builder.answer(id, { ...answer, value: "Changed" })).rejects.toThrow("request_conflict");
    close(); ({ db, close } = openDb(path.join(root, "panel.sqlite"))); company = service();
    expect((await company.builder.get(id)).revision).toBe(1);
    expect(company.projectBrief(id).fields.goal).toBe("Personal tasks");
  });

  it("keeps planning and approval free of filesystem effects; prepare requires exact approved snapshot", async () => {
    complete();
    let state = await company.builder.plan(id, { ...req(0), templateId: "task-board-v1" });
    expect(state.plan?.brief.goal).toBe("Tasks"); expect(state.plan?.files).toContain("app/server.mjs");
    await expect(company.builder.prepare(id, confirm(1))).rejects.toThrow("builder_approval_required");
    state = await company.builder.approve(id, confirm(1));
    expect(state.plan?.approvedAt).toBeTypeOf("number");
    expect(bridge.prepareProjectApp).not.toHaveBeenCalled();
    const request = confirm(2);
    await company.builder.prepare(id, request); await company.builder.prepare(id, request);
    expect(bridge.prepareProjectApp).toHaveBeenCalledTimes(1);
    company.saveProjectBrief(id, { requestId: randomUUID(), revision: 1, step: 3, fields: { ...company.projectBrief(id).fields, goal: "Changed" } });
    expect((await company.builder.get(id)).stale).toBe(true);
    await expect(company.builder.start(id, req(3))).rejects.toThrow("builder_plan_stale");
  });

  it("permits incomplete proposal but blocks approval and unsolved business rules", async () => {
    await company.builder.plan(id, { ...req(0), templateId: "task-board-v1" });
    await expect(company.builder.approve(id, confirm(1))).rejects.toThrow("builder_incomplete");
    complete();
    company.rules.create(id, { requestId: randomUUID(), fields: BusinessRuleFields.parse({ title: "Task owner", statement: "Only owner deletes" }) });
    const state = await company.builder.plan(id, { ...req(1), templateId: "task-board-v1" });
    expect(state.blockers).toContain("rules_unapproved"); expect(state.plan?.rules[0]?.fields.statement).toBe("Only owner deletes");
    await expect(company.builder.approve(id, confirm(2))).rejects.toThrow("builder_incomplete");
    expect(bridge.prepareProjectApp).not.toHaveBeenCalled();
  });

  it("keeps existing project analysis read-only and forbids generation", async () => {
    mode = "existing";
    expect((await company.builder.get(id)).blockers).toContain("existing_project");
    expect(await company.builder.analyze(id)).toMatchObject({ dependencies: ["vue"], hasGit: true });
    await expect(company.builder.plan(id, { ...req(0), templateId: "task-board-v1" })).rejects.toThrow("builder_existing_project");
    expect(bridge.prepareProjectApp).not.toHaveBeenCalled();
  });

  it("checks current inputs again after asynchronous workspace inspection", async () => {
    complete(); await company.builder.plan(id, { ...req(0), templateId: "task-board-v1" }); await company.builder.approve(id, confirm(1));
    bridge.projectWorkspace.mockImplementationOnce(async () => {
      company.saveProjectBrief(id, { requestId: randomUUID(), revision: 1, step: 3, fields: { ...company.projectBrief(id).fields, data: "Changed data" } });
      return { rootPath: "/projects", workspace: { name: "test", path: "/projects/test", mode, state: "ready" as const }, available: [], truncated: false };
    });
    await expect(company.builder.prepare(id, confirm(2))).rejects.toThrow("builder_plan_stale");
    expect(bridge.prepareProjectApp).not.toHaveBeenCalled();
  });

  it("rejects unbounded/unknown preview bodies and arbitrary targets", () => {
    expect(ProjectPreviewRequest.safeParse({ method: "POST", path: "/api/tasks", body: { command: "run" } }).success).toBe(false);
    expect(ProjectPreviewRequest.safeParse({ method: "GET", path: "http://internal/" }).success).toBe(false);
    expect(ProjectPreviewRequest.safeParse({ method: "PATCH", path: "/api/tasks/one", body: { done: true } }).success).toBe(true);
  });

  it("treats a project without a workspace as an empty runtime while preserving real outages", async () => {
    bridge.projectWorkspace.mockResolvedValueOnce({ rootPath: "/projects", workspace: null, available: [], truncated: false });
    bridge.builderStatus.mockRejectedValueOnce(new BridgeError("workspace_required", "workspace_required"));
    const initial = await company.builder.get(id);
    expect(initial.runtime.state).toBe("empty"); expect(initial.blockers).toContain("workspace_required");
    bridge.builderStatus.mockRejectedValueOnce(new Error("offline"));
    expect((await company.builder.get(id)).runtime.error).toBe("gateway_unavailable");
  });

  it("enforces project scope, company mode and archived write restrictions", async () => {
    await expect(company.builder.get("missing")).rejects.toThrow("project_missing");
    expect(bridge.builderStatus).not.toHaveBeenCalled();
    spaceMode = "personal";
    await expect(company.builder.answer(id, { ...req(0), field: "goal", value: "Denied" })).rejects.toThrow("company_only");
    spaceMode = "company";
    company.updateProject(id, UpdateProjectRequest.parse({ name: "Tasks", status: "archived", revision: 0 }));
    await expect(company.builder.plan(id, { ...req(0), templateId: "task-board-v1" })).rejects.toThrow("project_archived");
    expect(() => company.builder.preview(id, { method: "POST", path: "/api/tasks", body: { title: "Denied" } })).toThrow("project_archived");
    expect((await company.builder.get(id)).revision).toBe(0);
    expect(bridge.prepareProjectApp).not.toHaveBeenCalled();
    expect(bridge.projectPreviewRequest).not.toHaveBeenCalled();
  });

  it("allows cleanup of an archived project's preview while keeping writes forbidden", async () => {
    complete();
    await company.builder.plan(id, { ...req(0), templateId: "task-board-v1" });
    await company.builder.approve(id, confirm(1));
    await company.builder.prepare(id, confirm(2));
    await company.builder.start(id, req(3));
    company.updateProject(id, UpdateProjectRequest.parse({ name: "Tasks", status: "archived", revision: 0 }));
    const stop = req(4);
    expect((await company.builder.stop(id, stop)).revision).toBe(5);
    await company.builder.stop(id, stop);
    expect(bridge.stopProjectPreview).toHaveBeenCalledTimes(1);
    await expect(company.builder.start(id, req(5))).rejects.toThrow("project_archived");
    await expect(company.builder.prepare(id, confirm(5))).rejects.toThrow("project_archived");
    expect(() => company.builder.preview(id, { method: "POST", path: "/api/tasks", body: { title: "Denied" } })).toThrow("project_archived");
    spaceMode = "personal";
    await expect(company.builder.stop(id, req(5))).rejects.toThrow("company_only");
  });

  it("rejects an approval when a business rule changes during workspace inspection", async () => {
    complete(); await company.builder.plan(id, { ...req(0), templateId: "task-board-v1" });
    bridge.projectWorkspace.mockImplementationOnce(async () => {
      company.rules.create(id, { requestId: randomUUID(), fields: BusinessRuleFields.parse({ title: "Owner", statement: "Only owner deletes" }) });
      return { rootPath: "/projects", workspace: { name: "test", path: "/projects/test", mode, state: "ready" as const }, available: [], truncated: false };
    });
    await expect(company.builder.approve(id, confirm(1))).rejects.toThrow("builder_plan_stale");
    expect((await company.builder.get(id)).plan?.approvedAt).toBeNull();
  });

  it("validates mutation routes and inherits the enclosing authentication hook", async () => {
    const app = Fastify();
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers.authorization !== "fixture") return reply.status(401).send({ error: "unauthorized" });
    });
    registerCompanyRoutes(app, company);
    try {
      const url = `/api/company/projects/${id}/builder/approve`;
      expect((await app.inject({ method: "POST", url, payload: confirm(0) })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url, headers: { authorization: "fixture" }, payload: { ...confirm(0), confirm: false } })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `/api/company/projects/${id}/builder`, headers: { authorization: "fixture" } })).statusCode).toBe(200);
      expect(db.select().from(projectBuilders).all()).toEqual([]);
    } finally { await app.close(); }
  });

  it("rolls back the answer when persisting the operation journal fails", async () => {
    db.run(sql`CREATE TRIGGER builder_failure BEFORE INSERT ON project_builder_requests BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    await expect(company.builder.answer(id, { ...req(0), field: "goal", value: "Must roll back" })).rejects.toThrow();
    expect(company.projectBrief(id).revision).toBe(0);
    expect(db.select().from(projectBuilders).all()).toEqual([]);
  });

  it("migrates the preceding schema without changing existing project requirements", () => {
    complete(); const before = company.projectBrief(id);
    close();
    const sqlite = new Database(path.join(root, "panel.sqlite"));
    // The schema before 0016 is also before every later migration (0017 project checks).
    sqlite.exec("DROP TABLE acceptance_test_links; DROP TABLE project_check_results; DROP TABLE project_check_runs; DELETE FROM __drizzle_migrations WHERE created_at = 1792347000000");
    sqlite.exec("DROP TABLE project_builder_requests; DROP TABLE project_builders; DELETE FROM __drizzle_migrations WHERE created_at = 1792346000000");
    sqlite.close();
    ({ db, close } = openDb(path.join(root, "panel.sqlite"))); company = service();
    expect(company.projectBrief(id)).toEqual(before);
    expect(db.select().from(projectBuilders).all()).toEqual([]);
  });
});
