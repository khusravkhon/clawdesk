import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { CreateDepartmentRequest, CreateProjectRequest, UpdateDepartmentRequest, UpdateProjectRequest } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanyService } from "../src/company/company-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { agents, companyAgentAssignments, companyProjects, departments, teams } from "../src/db/schema.js";
import { linkDepartmentAgent } from "../../web/src/company-assignment.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import type { SpaceService } from "../src/space/space-service.js";
import { registerCompanyRoutes } from "../src/routes/company.js";
import { BridgeError } from "../src/gateway/bridge-client.js";
import type { PrepareProjectWorkspaceRequest } from "@clawdesk/shared";
import { SaveProjectBriefRequest } from "@clawdesk/shared";
import { projectBriefs } from "../src/db/schema.js";
import { projectRules, projectRuleVersions } from "../src/db/schema.js";
import { acceptanceCases, acceptanceChecks } from "../src/db/schema.js";
import { BusinessRuleFields } from "@clawdesk/shared";

describe("company organization", () => {
  let root: string, db: Db, close: () => void, company: CompanyService;
  let online: boolean, mode: "company" | "personal", calls: string[];
  let workspaceCalls: string[], bridgeFailure: BridgeError | null;
  const create = (patch = {}) => CreateDepartmentRequest.parse({ requestId: randomUUID(), name: "IT", ...patch });
  const update = (patch = {}) => UpdateDepartmentRequest.parse({ name: "IT", revision: 0, ...patch });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-company-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    db.insert(teams).values({ id: "existing-team", name: "Existing team", repoUrl: "https://github.com/example/repo", telegramGroupId: "-100123456" }).run();
    db.insert(agents).values([
      { id: "main", role: "main", displayName: "Main" },
      { id: "boss", role: "specialist", displayName: "Boss", parentId: "main", status: "ready" },
      { id: "other", role: "specialist", displayName: "Other", parentId: "main", status: "ready" },
      { id: "dev", role: "team_member", teamId: "existing-team", displayName: "Developer" },
      { id: "missing", role: "specialist", displayName: "Missing" },
    ]).run();
    online = true; mode = "company"; calls = []; workspaceCalls = []; bridgeFailure = null;
    company = new CompanyService({
      db,
      bridge: {
        projectWorkspace: async (id) => { workspaceCalls.push(`get:${id}`); if (bridgeFailure) throw bridgeFailure; return { rootPath: "/fixture/projects", workspace: null, available: ["Existing"], truncated: false }; },
        prepareProjectWorkspace: async (id, request) => { workspaceCalls.push(`prepare:${id}:${request.name}`); if (bridgeFailure) throw bridgeFailure; return { rootPath: "/fixture/projects", workspace: { name: request.name, path: `/fixture/projects/${request.name}`, mode: request.mode, state: "ready" }, available: [], truncated: false }; },
      },
      space: { mode: () => mode, get: () => ({ name: "Example" }) } as unknown as SpaceService,
      gateway: { request: async (method: string) => {
        calls.push(method);
        expect(method).toBe("agents.list");
        if (!online) throw new Error("offline");
        return { agents: ["main", "boss", "other", "dev"].map((id) => ({ id })) };
      } } as unknown as GatewayService,
    });
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("creates drafts idempotently and leaves existing runtime metadata untouched", async () => {
    const before = db.select().from(agents).all();
    const req = create();
    const first = await company.create(req);
    expect(await company.create(req)).toEqual(first);
    await expect(company.create({ ...req, name: "Changed" })).rejects.toMatchObject({ code: "request_conflict" });
    const result = await company.list();
    expect(result.departments).toEqual([expect.objectContaining({ id: first.id, managerState: "unassigned" })]);
    expect(result.teams[0]).toMatchObject({ departmentId: null, revision: 0 });
    expect(db.select().from(agents).all()).toEqual(before);
    expect(calls).toEqual(["agents.list"]);
  });

  it("refuses invalid and duplicate managers without leaving partial departments", async () => {
    for (const managerAgentId of ["main", "dev", "missing", "unknown"]) {
      await expect(company.create(create({ managerAgentId }))).rejects.toMatchObject({ code: "manager_invalid" });
    }
    expect(db.select().from(departments).all()).toHaveLength(0);
    const first = await company.create(create({ managerAgentId: "boss" }));
    await expect(company.create(create({ managerAgentId: "boss" }))).rejects.toMatchObject({ code: "manager_assigned" });
    expect((await company.list()).departments).toEqual([expect.objectContaining({ id: first.id, managerAgentId: "boss", managerState: "ready" })]);
  });

  it("deduplicates concurrent creates after Gateway verification", async () => {
    const req = create({ managerAgentId: "boss" });
    const [first, second] = await Promise.all([company.create(req), company.create(req)]);
    expect(second).toEqual(first);
    expect(db.select().from(departments).all()).toHaveLength(1);
  });

  it("prevents conflicting edits and manager reassignment", async () => {
    const first = await company.create(create({ managerAgentId: "boss" }));
    const second = await company.create(create({ name: "Marketing", managerAgentId: "other" }));
    await expect(company.update(first.id, update({ managerAgentId: "other" }))).rejects.toMatchObject({ code: "manager_assigned" });
    await company.update(first.id, update({ name: "Engineering", managerAgentId: "boss" }));
    await expect(company.update(first.id, update({ name: "Stale" }))).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await company.list()).departments.find((department) => department.id === second.id)?.managerAgentId).toBe("other");
  });

  it("groups teams with revision checks and preserves archived teams and repository bindings", async () => {
    const { id } = await company.create(create());
    const original = db.select().from(teams).get()!;
    company.assignTeam(original.id, { departmentId: id, revision: 0 });
    expect(() => company.assignTeam(original.id, { departmentId: null, revision: 0 })).toThrow("revision_conflict");
    await company.update(id, update({ archived: true }));
    expect(() => company.assignTeam(original.id, { departmentId: id, revision: 1 })).toThrow("department_archived");
    expect(db.select().from(teams).get()).toMatchObject({ repoUrl: original.repoUrl, telegramGroupId: original.telegramGroupId, departmentId: id });
    company.assignTeam(original.id, { departmentId: null, revision: 1 });
    expect(db.select().from(teams).get()?.departmentId).toBeNull();
  });

  it("keeps organization readable offline without inventing manager availability", async () => {
    const { id } = await company.create(create({ managerAgentId: "boss" }));
    online = false;
    const result = await company.list();
    expect(result.gatewayAvailable).toBe(false);
    expect(result.departments[0]?.managerState).toBe("unverified");
    await company.update(id, update({ managerAgentId: "boss", description: "Offline edit" }));
    await expect(company.update(id, update({ revision: 1, managerAgentId: "other" }))).rejects.toMatchObject({ code: "gateway_unavailable" });
    expect((await company.list()).departments[0]?.managerAgentId).toBe("boss");
  });

  it("shows a draft again when its manager is deleted, preserving the department", async () => {
    await company.create(create({ managerAgentId: "boss" }));
    db.delete(agents).where(eq(agents.id, "boss")).run();
    expect((await company.list()).departments[0]).toMatchObject({ managerAgentId: null, managerState: "unassigned" });
  });

  it("does not expose or mutate organization in personal mode", async () => {
    mode = "personal";
    await expect(company.list()).rejects.toMatchObject({ code: "company_only" });
    await expect(company.create(create())).rejects.toMatchObject({ code: "company_only" });
    expect(() => company.assignTeam("existing-team", { departmentId: null, revision: 0 })).toThrow("company_only");
    expect(calls).toEqual([]);
  });

  it("assigns independent agents with optimistic revisions without changing runtime metadata", async () => {
    const first = await company.create(create());
    const second = await company.create(create({ name: "Marketing" }));
    const runtime = db.select().from(agents).all();
    await company.assignAgent("boss", { departmentId: first.id, revision: 0 });
    await expect(company.assignAgent("boss", { departmentId: second.id, revision: 0 })).rejects.toMatchObject({ code: "revision_conflict" });
    await company.assignAgent("boss", { departmentId: second.id, revision: 1 });
    expect((await company.list()).agents.find((agent) => agent.id === "boss")).toMatchObject({ departmentId: second.id, revision: 2 });
    await expect(company.update(first.id, update({ managerAgentId: "boss" }))).rejects.toMatchObject({ code: "agent_assigned" });
    await company.assignAgent("boss", { departmentId: null, revision: 2 });
    expect(db.select().from(agents).all()).toEqual(runtime);
  });

  it("keeps the manager in its department until its leadership is removed", async () => {
    const { id } = await company.create(create({ managerAgentId: "boss" }));
    expect((await company.list()).agents.find((agent) => agent.id === "boss")).toMatchObject({ departmentId: id, managerOf: id });
    await expect(company.assignAgent("boss", { departmentId: null, revision: 1 })).rejects.toMatchObject({ code: "manager_assigned" });
    await company.update(id, update({ managerAgentId: null }));
    expect((await company.list()).agents.find((agent) => agent.id === "boss")).toMatchObject({ departmentId: id, managerOf: null });
    await company.assignAgent("boss", { departmentId: null, revision: 1 });
    expect(db.select().from(companyAgentAssignments).get()?.departmentId).toBeNull();
  });

  it("rejects team members, archived departments and offline additions", async () => {
    const { id } = await company.create(create());
    await expect(company.assignAgent("dev", { departmentId: id, revision: 0 })).rejects.toMatchObject({ code: "agent_invalid" });
    online = false;
    await expect(company.assignAgent("boss", { departmentId: id, revision: 0 })).rejects.toMatchObject({ code: "gateway_unavailable" });
    online = true;
    await company.update(id, update({ archived: true }));
    await expect(company.assignAgent("boss", { departmentId: id, revision: 0 })).rejects.toMatchObject({ code: "department_archived" });
    expect(db.select().from(companyAgentAssignments).all()).toEqual([]);
  });

  it("retries the existing agent assignment and recognizes a lost successful response", async () => {
    const { id } = await company.create(create());
    const port = { get: () => company.list(), update: (departmentId: string, req: ReturnType<typeof update>) => company.update(departmentId, req), assignAgent: (agentId: string, req: { departmentId: string | null; revision: number }) => company.assignAgent(agentId, req) };
    await linkDepartmentAgent(port, id, "manager", "boss");
    await linkDepartmentAgent(port, id, "manager", "boss");
    expect(db.select().from(departments).get()?.revision).toBe(1);
    await expect(linkDepartmentAgent(port, id, "manager", "other")).rejects.toMatchObject({ code: "department_has_manager" });
    await linkDepartmentAgent(port, id, "member", "other");
    await linkDepartmentAgent(port, id, "member", "other");
    expect((await company.list()).agents.find((agent) => agent.id === "other")?.revision).toBe(1);
    expect(db.select().from(agents).all()).toHaveLength(5);
  });

  it("returns safe conflicts through HTTP and rejects malformed requests", async () => {
    const app = Fastify();
    registerCompanyRoutes(app, company);
    try {
      const req = create();
      const created = await app.inject({ method: "POST", url: "/api/company/departments", payload: req });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      expect((await app.inject({ method: "PUT", url: `/api/company/departments/${id}`, payload: update({ revision: 9 }) })).statusCode).toBe(409);
      expect((await app.inject({ url: "/api/company" })).json().departments).toHaveLength(1);
      expect((await app.inject({ method: "POST", url: "/api/company/departments", payload: { name: "" } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("creates a project without GitHub, department, team or Gateway", async () => {
    online = false;
    const req = CreateProjectRequest.parse({ requestId: randomUUID(), name: "Local app" });
    const first = company.createProject(req);
    expect(company.createProject(req)).toEqual(first);
    expect(() => company.createProject({ ...req, name: "Another" })).toThrow("request_conflict");
    expect(calls).toEqual([]);
    expect((await company.list()).projects).toEqual([{ id: first.id, name: "Local app", description: "", departmentId: null, status: "draft", revision: 0 }]);
    expect(db.select().from(teams).get()?.projectId).toBeNull();
  });

  it("reads an unsaved brief without creating rows and saves partial answers without Gateway", () => {
    online = false;
    const { id } = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "CRM", description: "Keep customer requests" }));
    expect(company.projectBrief(id)).toMatchObject({ revision: 0, step: 0, updatedAt: null, fields: { goal: "Keep customer requests", rules: "", openQuestions: "" } });
    expect(db.select().from(projectBriefs).all()).toEqual([]);
    const request = SaveProjectBriefRequest.parse({ requestId: randomUUID(), revision: 0, step: 1, fields: { goal: "Customer requests", audience: "Managers" } });
    const result = company.saveProjectBrief(id, request);
    expect(result).toMatchObject({ revision: 1, step: 1, fields: { goal: "Customer requests", audience: "Managers", scenarios: "", rules: "" } });
    expect(result.updatedAt).toBeTypeOf("number");
    expect(company.saveProjectBrief(id, request)).toEqual(result);
    expect(db.select().from(companyProjects).get()?.revision).toBe(0);
    expect(calls).toEqual([]); expect(workspaceCalls).toEqual([]);
  });

  it("rejects stale and reused brief requests without overwriting current answers", () => {
    const { id } = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "CRM" }));
    const first = SaveProjectBriefRequest.parse({ requestId: randomUUID(), revision: 0, step: 0, fields: { goal: "Original" } });
    company.saveProjectBrief(id, first);
    expect(() => company.saveProjectBrief(id, { ...first, fields: { ...first.fields, goal: "Changed payload" } })).toThrow("request_conflict");
    expect(() => company.saveProjectBrief(id, { ...first, requestId: randomUUID() })).toThrow("revision_conflict");
    const second = { ...first, requestId: randomUUID(), revision: 1, fields: { ...first.fields, goal: "Current", openQuestions: "Who approves?" } };
    company.saveProjectBrief(id, second);
    expect(() => company.saveProjectBrief(id, first)).toThrow("revision_conflict");
    expect(company.projectBrief(id)).toMatchObject({ revision: 2, fields: { goal: "Current", openQuestions: "Who approves?" } });
  });

  it("persists the saved answers and wizard step across database restart", () => {
    const { id } = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "CRM" }));
    const request = SaveProjectBriefRequest.parse({ requestId: randomUUID(), revision: 0, step: 3, fields: { goal: "CRM", rules: "Only assigned managers see requests", openQuestions: "Retention unknown" } });
    const before = company.saveProjectBrief(id, request);
    close(); ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    const restarted = new CompanyService({ db, space: { mode: () => mode } as SpaceService, gateway: {} as GatewayService });
    expect(restarted.projectBrief(id)).toEqual(before);
    expect(restarted.saveProjectBrief(id, request)).toEqual(before);
  });

  it("validates brief input and keeps archived project answers readable", async () => {
    const department = await company.create(create());
    const { id } = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "CRM", departmentId: department.id }));
    const request = { requestId: randomUUID(), revision: 0, step: 0, fields: { goal: "CRM" } };
    const app = Fastify(); registerCompanyRoutes(app, company);
    const url = `/api/company/projects/${id}/brief`;
    try {
      for (const patch of [{ step: 4 }, { revision: -1 }, { requestId: "bad" }, { fields: { rules: "x".repeat(4001) } }]) {
        expect((await app.inject({ method: "PUT", url, payload: { ...request, ...patch } })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: "PUT", url, payload: request })).statusCode).toBe(200);
      await company.update(department.id, update({ archived: true }));
      expect((await app.inject({ method: "PUT", url, payload: { ...request, requestId: randomUUID(), revision: 1 } })).json().error).toBe("department_archived");
      company.updateProject(id, UpdateProjectRequest.parse({ name: "CRM", departmentId: department.id, status: "archived", revision: 0 }));
      expect((await app.inject({ method: "PUT", url, payload: request })).json().error).toBe("project_archived");
      expect((await app.inject({ url })).json().fields.goal).toBe("CRM");
      expect((await app.inject({ url: "/api/company/projects/unknown/brief" })).statusCode).toBe(404);
      mode = "personal";
      expect((await app.inject({ url })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("prepares project folders through the bridge without agent or source changes", async () => {
    const { id } = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Local" }));
    const before = db.select().from(agents).all();
    const req: PrepareProjectWorkspaceRequest = { requestId: randomUUID(), mode: "new", name: "Local app" };
    expect((await company.projectWorkspace(id)).available).toEqual(["Existing"]);
    expect((await company.prepareProjectWorkspace(id, req)).workspace?.state).toBe("ready");
    expect(workspaceCalls).toEqual([`get:${id}`, `prepare:${id}:Local app`]);
    expect(calls).toEqual([]);
    expect(db.select().from(agents).all()).toEqual(before);
    expect(db.select().from(companyProjects).get()?.revision).toBe(0);
  });

  it("rejects workspace writes to unknown and archived projects or departments and personal mode", async () => {
    const req: PrepareProjectWorkspaceRequest = { requestId: randomUUID(), mode: "new", name: "Local" };
    expect(() => company.prepareProjectWorkspace("unknown", req)).toThrow("project_missing");
    const department = await company.create(create());
    const { id } = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Local", departmentId: department.id }));
    await company.update(department.id, update({ archived: true }));
    expect(() => company.prepareProjectWorkspace(id, req)).toThrow("department_archived");
    company.updateProject(id, UpdateProjectRequest.parse({ name: "Local", status: "archived", departmentId: department.id, revision: 0 }));
    expect(() => company.prepareProjectWorkspace(id, req)).toThrow("project_archived");
    await company.projectWorkspace(id);
    mode = "personal";
    expect(() => company.projectWorkspace(id)).toThrow("company_only");
    expect(workspaceCalls).toEqual([`get:${id}`]);
  });

  it("validates workspace HTTP input and returns safe bridge error codes", async () => {
    const { id } = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Local" }));
    const app = Fastify(); registerCompanyRoutes(app, company);
    const url = `/api/company/projects/${id}/workspace`;
    try {
      expect((await app.inject({ method: "POST", url, payload: { requestId: randomUUID(), mode: "new", name: "../outside" } })).statusCode).toBe(400);
      expect(workspaceCalls).toEqual([]);
      expect((await app.inject({ method: "POST", url, payload: { requestId: randomUUID(), mode: "existing", name: "Existing" } })).json().workspace.mode).toBe("existing");
      bridgeFailure = new BridgeError("workspace_in_use", "private detail");
      const conflict = await app.inject({ url });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ error: "workspace_in_use", message: "workspace_in_use" });
      bridgeFailure = new BridgeError("bridge_unavailable", "private connection info");
      const unavailable = await app.inject({ url });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.body).not.toContain("private");
    } finally { await app.close(); }
  });

  it("protects project edits and keeps linked teams when archived", async () => {
    const first = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "CRM" }));
    company.assignTeamProject("existing-team", { projectId: first.id, revision: 0 });
    company.updateProject(first.id, UpdateProjectRequest.parse({ name: "CRM", status: "archived", revision: 0 }));
    expect(() => company.updateProject(first.id, UpdateProjectRequest.parse({ name: "Stale", revision: 0 }))).toThrow("revision_conflict");
    expect(() => company.assignTeamProject("existing-team", { projectId: first.id, revision: 1 })).toThrow("project_archived");
    expect(db.select().from(teams).get()).toMatchObject({ projectId: first.id, repoUrl: "https://github.com/example/repo", telegramGroupId: "-100123456" });
    company.assignTeamProject("existing-team", { projectId: null, revision: 1 });
    expect(db.select().from(agents).all()).toHaveLength(5);
  });

  it("requires compatible departments and prevents silent project reassignment", async () => {
    const itDepartment = await company.create(create());
    const marketing = await company.create(create({ name: "Marketing" }));
    const first = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Mobile", departmentId: itDepartment.id }));
    const other = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Website" }));
    company.assignTeam("existing-team", { departmentId: marketing.id, revision: 0 });
    expect(() => company.assignTeamProject("existing-team", { projectId: first.id, revision: 1 })).toThrow("project_department_mismatch");
    expect(db.select().from(teams).get()).toMatchObject({ departmentId: marketing.id, projectId: null, organizationRevision: 1 });
    company.assignTeam("existing-team", { departmentId: itDepartment.id, revision: 1 });
    company.assignTeamProject("existing-team", { projectId: first.id, revision: 2 });
    expect(() => company.assignTeamProject("existing-team", { projectId: other.id, revision: 3 })).toThrow("team_project_assigned");
    expect(() => company.assignTeam("existing-team", { departmentId: marketing.id, revision: 3 })).toThrow("project_department_mismatch");
    expect(() => company.updateProject(first.id, UpdateProjectRequest.parse({ name: "Mobile", departmentId: marketing.id, revision: 0 }))).toThrow("project_department_mismatch");
    company.assignTeamProject("existing-team", { projectId: null, revision: 3 });
    company.assignTeam("existing-team", { departmentId: marketing.id, revision: 4 });
    expect(db.select().from(teams).get()).toMatchObject({ departmentId: marketing.id, projectId: null });
  });

  it("links a newly created team directly and atomically joins the project's department", async () => {
    const department = await company.create(create());
    const project = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Mobile", departmentId: department.id }));
    const before = db.select().from(teams).get()!;
    company.assignTeamProject("existing-team", { projectId: project.id, revision: 0 });
    expect(db.select().from(teams).get()).toEqual({ ...before, departmentId: department.id, projectId: project.id, organizationRevision: 1 });
    expect(() => company.assignTeamProject("existing-team", { projectId: null, revision: 0 })).toThrow("revision_conflict");
    company.assignTeamProject("existing-team", { projectId: null, revision: 1 });
    expect(db.select().from(teams).get()).toMatchObject({ departmentId: department.id, projectId: null, organizationRevision: 2 });
  });

  it("does not join a department when the target project or department is archived", async () => {
    const department = await company.create(create());
    const project = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Mobile", departmentId: department.id }));
    const before = db.select().from(teams).get();
    await company.update(department.id, update({ archived: true }));
    expect(() => company.assignTeamProject("existing-team", { projectId: project.id, revision: 0 })).toThrow("department_archived");
    expect(db.select().from(teams).get()).toEqual(before);
    const archived = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Archived", status: "archived" }));
    expect(() => company.assignTeamProject("existing-team", { projectId: archived.id, revision: 0 })).toThrow("project_archived");
    expect(db.select().from(teams).get()).toEqual(before);
  });

  it("rejects archived department projects and all project writes in personal mode", async () => {
    const department = await company.create(create());
    await company.update(department.id, update({ archived: true }));
    const req = CreateProjectRequest.parse({ requestId: randomUUID(), name: "App", departmentId: department.id });
    expect(() => company.createProject(req)).toThrow("department_archived");
    expect(db.select().from(companyProjects).all()).toHaveLength(0);
    mode = "personal";
    expect(() => company.createProject({ ...req, departmentId: null })).toThrow("company_only");
    expect(() => company.updateProject("none", UpdateProjectRequest.parse({ name: "App", revision: 0 }))).toThrow("company_only");
    expect(() => company.assignTeamProject("existing-team", { projectId: null, revision: 0 })).toThrow("company_only");
  });

  it("provides HTTP project creation, validation and team linking", async () => {
    const app = Fastify(); registerCompanyRoutes(app, company);
    try {
      const response = await app.inject({ method: "POST", url: "/api/company/projects", payload: { requestId: randomUUID(), name: "App" } });
      expect(response.statusCode).toBe(201);
      const id = response.json().id as string;
      expect((await app.inject({ method: "PUT", url: "/api/company/teams/existing-team/project", payload: { projectId: id, revision: 0 } })).statusCode).toBe(200);
      expect((await app.inject({ method: "PUT", url: `/api/company/projects/${id}`, payload: { name: "Updated", status: "planned", revision: 0 } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/company/projects", payload: { requestId: randomUUID(), name: " " } })).statusCode).toBe(400);
      expect((await app.inject({ url: "/api/company" })).json().projects[0]).toMatchObject({ name: "Updated", status: "planned" });
    } finally { await app.close(); }
  });
});

it.each([10, 11, 12, 13, 14, 15])("migrates a database before migration %s and preserves the prior copy", (cutoff) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-company-migration-"));
  const oldFolder = path.join(root, "old-migrations");
  const dbPath = path.join(root, "panel.sqlite");
  fs.mkdirSync(path.join(oldFolder, "meta"), { recursive: true });
  const currentFolder = path.resolve("drizzle");
  const journal = JSON.parse(fs.readFileSync(path.join(currentFolder, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < cutoff);
  fs.writeFileSync(path.join(oldFolder, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) fs.copyFileSync(path.join(currentFolder, `${entry.tag}.sql`), path.join(oldFolder, `${entry.tag}.sql`));
  let sqlite = new Database(dbPath);
  let opened: ReturnType<typeof openDb> | undefined;
  try {
    migrate(drizzle(sqlite), { migrationsFolder: oldFolder });
    sqlite.exec("INSERT INTO teams(id,name,repo_url,telegram_group_id) VALUES('legacy','Existing','https://github.com/a/b','-100123'); INSERT INTO agents(id,role,display_name,team_id) VALUES('dev','team_member','Developer','legacy')");
    if (cutoff >= 11) sqlite.exec("INSERT INTO agents(id,role,display_name,status) VALUES('manager','specialist','Manager','ready'); INSERT INTO departments(id,request_id,request_payload,name) VALUES('it','old-request','{}','IT'); INSERT INTO department_managers(department_id,agent_id) VALUES('it','manager')");
    if (cutoff >= 12) sqlite.exec("INSERT INTO company_agent_assignments(agent_id,department_id,revision) VALUES('manager','it',1)");
    if (cutoff >= 13) sqlite.exec("INSERT INTO company_projects(id,request_id,request_payload,name,description) VALUES('legacy-project','project-request','{}','Existing project','Keep description')");
    if (cutoff >= 14) sqlite.prepare("INSERT INTO project_briefs(project_id,fields,step,revision,request_id,request_payload,updated_at) VALUES('legacy-project',?,2,3,'old-brief','{}',123)").run(JSON.stringify(SaveProjectBriefRequest.parse({ requestId: randomUUID(), revision: 2, step: 2, fields: { goal: "Keep answers", rules: "Do not overwrite" } }).fields));
    if (cutoff >= 15) {
      sqlite.exec("INSERT INTO project_rules(id,project_id,number,current_version,revision,request_id,request_payload) VALUES('legacy-rule','legacy-project',1,1,1,'old-rule','{}')");
      sqlite.prepare("INSERT INTO project_rule_versions(rule_id,version,fields,created_at,request_id,request_payload,approved_at,approved_by) VALUES('legacy-rule',1,?,100,'old-version','{}',123,'owner')").run(JSON.stringify(BusinessRuleFields.parse({ title: "Keep rule", statement: "Do not overwrite approved rule" })));
    }
    sqlite.close();
    fs.copyFileSync(dbPath, path.join(root, "before.sqlite"));
    opened = openDb(dbPath);
    expect(opened.db.select().from(teams).get()).toMatchObject({ id: "legacy", departmentId: null, organizationRevision: 0, telegramGroupId: "-100123" });
    expect(opened.db.select().from(agents).get()).toMatchObject({ id: "dev", teamId: "legacy" });
    if (cutoff >= 11) expect(opened.db.select().from(companyAgentAssignments).get()).toMatchObject({ agentId: "manager", departmentId: "it", revision: 1 });
    expect(opened.db.select().from(teams).get()?.projectId).toBeNull();
    if (cutoff < 14) expect(opened.db.select().from(projectBriefs).all()).toEqual([]);
    else expect(opened.db.select().from(projectBriefs).get()).toMatchObject({ revision: 3, step: 2, fields: { goal: "Keep answers", rules: "Do not overwrite" } });
    if (cutoff < 15) {
      expect(opened.db.select().from(projectRules).all()).toEqual([]);
      expect(opened.db.select().from(projectRuleVersions).all()).toEqual([]);
    } else {
      expect(opened.db.select().from(projectRules).get()).toMatchObject({ id: "legacy-rule", currentVersion: 1, revision: 1 });
      expect(opened.db.select().from(projectRuleVersions).get()).toMatchObject({ approvedAt: 123, approvedBy: "owner", fields: { statement: "Do not overwrite approved rule" } });
    }
    expect(opened.db.select().from(acceptanceCases).all()).toEqual([]);
    expect(opened.db.select().from(acceptanceChecks).all()).toEqual([]);
    if (cutoff >= 13) expect(opened.db.select().from(companyProjects).get()).toMatchObject({ id: "legacy-project", description: "Keep description" });
    opened.close(); opened = undefined;
    sqlite = new Database(path.join(root, "before.sqlite"));
    expect(sqlite.prepare("SELECT telegram_group_id FROM teams").get()).toEqual({ telegram_group_id: "-100123" });
    if (cutoff < 13) expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='company_projects'").get()).toBeUndefined();
    if (cutoff < 14) expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='project_briefs'").get()).toBeUndefined();
    if (cutoff < 15) expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='project_rules'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='acceptance_cases'").get()).toBeUndefined();
  } finally { opened?.close(); if (sqlite.open) sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
