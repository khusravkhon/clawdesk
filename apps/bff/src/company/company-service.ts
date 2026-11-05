import { randomUUID } from "node:crypto";
import type { AssignAgentDepartmentRequest, AssignTeamDepartmentRequest, AssignTeamLeadRequest, AssignTeamProjectRequest, CompanyDto, CreateDepartmentRequest, CreateProjectRequest, DepartmentDto, UpdateDepartmentRequest, UpdateProjectRequest } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, companyAgentAssignments, companyProjects, departmentManagers, departments, teams } from "../db/schema.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { SpaceService } from "../space/space-service.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import type { PrepareProjectWorkspaceRequest, ProjectWorkspaceDto } from "@clawdesk/shared";
import { ProjectBriefFields, type ProjectBriefDto, type SaveProjectBriefRequest } from "@clawdesk/shared";
import { projectBriefs } from "../db/schema.js";
import { ProjectRulesService } from "./project-rules-service.js";
import { ProjectAcceptanceService } from "./project-acceptance-service.js";
import { ProjectBuilderService, type ProjectBuilderBridge } from "./project-builder-service.js";
import { ProjectChecksService, type ProjectChecksBridge } from "./project-checks-service.js";
import { ProjectExecutors } from "./project-executors.js";
import { ProjectTasksService, type TaskBridge } from "./project-tasks-service.js";
import { ProjectGitHubService, type ProjectGitHubBridge } from "./project-github-service.js";
import { ProjectInterviewService } from "./project-interview-service.js";
import { ProjectRuleAuditService } from "./project-rule-audit-service.js";
import type { OneShot } from "../chat/one-shot.js";
import { mainSessionKey } from "../chat/chat-service.js";
import type { Logger } from "pino";
import { randomUUID as newId } from "node:crypto";

export class CompanyError extends Error {
  constructor(readonly code: "company_only" | "department_missing" | "team_missing" | "revision_conflict" | "manager_invalid" | "manager_assigned" | "agent_invalid" | "agent_assigned" | "department_archived" | "gateway_unavailable" | "request_conflict" | "project_missing" | "project_archived" | "project_department_mismatch" | "team_project_assigned" | "lead_not_eligible") { super(code); }
}

/** Organizational metadata only: assigning a manager grants no tools or data access. */
export class CompanyService {
  readonly rules: ProjectRulesService;
  readonly acceptance: ProjectAcceptanceService;
  readonly builder: ProjectBuilderService;
  readonly checks: ProjectChecksService;
  readonly tasks: ProjectTasksService;
  readonly github: ProjectGitHubService;
  readonly interview: ProjectInterviewService;
  readonly audit: ProjectRuleAuditService;

  constructor(private readonly deps: { db: Db; gateway: GatewayService; space: SpaceService; logger?: Logger; sandboxEnabled?: boolean; model?: OneShot; bridge?: Pick<BridgeClient, "projectWorkspace" | "prepareProjectWorkspace"> & Partial<ProjectBuilderBridge> & Partial<ProjectChecksBridge> & Partial<TaskBridge> & Partial<Pick<BridgeClient, "ensureProjectWork">> & Partial<ProjectGitHubBridge> }) {
    this.rules = new ProjectRulesService({ db: deps.db, checkProject: (id, writing) => this.#briefProject(id, writing) });
    this.audit = new ProjectRuleAuditService({ db: deps.db, checkProject: (id, writing) => this.#briefProject(id, writing), rules: (id) => this.rules.list(id).rules, model: deps.model });
    this.acceptance = new ProjectAcceptanceService({ db: deps.db, checkProject: (id, writing) => this.#briefProject(id, writing) });
    this.checks = new ProjectChecksService({ db: deps.db, checkProject: (id, writing) => this.#briefProject(id, writing), bridge: deps.bridge?.runProjectChecks ? deps.bridge as ProjectChecksBridge : undefined });
    const bridge = deps.bridge;
    const taskBridge = bridge?.projectAppFiles && bridge.prepareProjectWork && bridge.snapshotProjectWork && bridge.runProjectChecks && bridge.applyProjectWork ? bridge as TaskBridge : undefined;
    this.tasks = new ProjectTasksService({
      db: deps.db,
      checkProject: (id, writing) => { const project = this.#briefProject(id, writing); return { id: project.id, name: project.name, description: project.description, departmentId: project.departmentId }; },
      rule: (projectId, ruleId, version) => {
        const rule = this.rules.list(projectId).rules.find(item => item.id === ruleId);
        const selected = rule && this.rules.history(projectId, ruleId).versions.find(item => item.version === version);
        return rule && selected ? { id: rule.id, code: rule.code, version: selected.version, fields: selected.fields, approvedAt: selected.approvedAt } : null;
      },
      executors: deps.logger && bridge?.ensureProjectWork ? new ProjectExecutors({ db: deps.db, gateway: deps.gateway, logger: deps.logger, sandboxEnabled: deps.sandboxEnabled ?? false, bridge: bridge as Pick<BridgeClient, "ensureProjectWork"> }) : undefined,
      bridge: taskBridge,
      conflicts: (projectId, ruleId) => this.audit.blocking(projectId, ruleId),
      send: taskBridge ? async (agentId, message) => { await deps.gateway.request("chat.send", { sessionKey: mainSessionKey(agentId), agentId, message, idempotencyKey: newId() }); } : undefined,
    });
    this.github = new ProjectGitHubService({ checkProject: (id, writing) => this.#briefProject(id, writing), bridge: bridge?.projectGitHub ? bridge as ProjectGitHubBridge : undefined });
    this.interview = new ProjectInterviewService({ db: deps.db, checkProject: (id, writing) => this.#briefProject(id, writing), brief: id => this.projectBrief(id), saveBrief: (id, request) => this.saveProjectBrief(id, request), model: deps.model });
    this.builder = new ProjectBuilderService({ db: deps.db, checkProject: (id, writing) => this.#briefProject(id, writing), brief: id => this.projectBrief(id), saveBrief: (id, request) => this.saveProjectBrief(id, request), rules: id => this.rules.list(id).rules, bridge: deps.bridge?.builderStatus ? deps.bridge as ProjectBuilderBridge : undefined });
  }

  #company(): void { if (this.deps.space.mode() !== "company") throw new CompanyError("company_only"); }

  #briefProject(id: string, writing = false) {
    this.#company();
    const project = this.deps.db.select().from(companyProjects).where(eq(companyProjects.id, id)).get();
    if (!project) throw new CompanyError("project_missing");
    if (writing && project.status === "archived") throw new CompanyError("project_archived");
    if (writing) this.#projectDepartment(project.departmentId);
    return project;
  }

  projectBrief(id: string): ProjectBriefDto {
    const project = this.#briefProject(id);
    const row = this.deps.db.select().from(projectBriefs).where(eq(projectBriefs.projectId, id)).get();
    return row ? { revision: row.revision, step: row.step, fields: row.fields, updatedAt: row.updatedAt }
      : { revision: 0, step: 0, fields: ProjectBriefFields.parse({ goal: project.description }), updatedAt: null };
  }

  saveProjectBrief(id: string, request: SaveProjectBriefRequest): ProjectBriefDto {
    return this.deps.db.transaction((tx) => {
      this.#briefProject(id, true);
      const before = tx.select().from(projectBriefs).where(eq(projectBriefs.projectId, id)).get();
      const payload = JSON.stringify(request);
      if (before?.requestId === request.requestId) {
        if (before.requestPayload !== payload) throw new CompanyError("request_conflict");
        return this.projectBrief(id);
      }
      if ((before?.revision ?? 0) !== request.revision) throw new CompanyError("revision_conflict");
      const values = { fields: request.fields, step: request.step, revision: request.revision + 1, requestId: request.requestId, requestPayload: payload, updatedAt: Date.now() };
      tx.insert(projectBriefs).values({ projectId: id, ...values }).onConflictDoUpdate({ target: projectBriefs.projectId, set: values }).run();
      return this.projectBrief(id);
    });
  }

  #workspaceProject(id: string, writing: boolean): void {
    this.#company();
    const project = this.deps.db.select().from(companyProjects).where(eq(companyProjects.id, id)).get();
    if (!project) throw new CompanyError("project_missing");
    if (writing && project.status === "archived") throw new CompanyError("project_archived");
    if (writing) this.#projectDepartment(project.departmentId);
    if (!this.deps.bridge) throw new CompanyError("gateway_unavailable");
  }

  projectWorkspace(id: string): Promise<ProjectWorkspaceDto> {
    this.#workspaceProject(id, false);
    return this.deps.bridge!.projectWorkspace(id);
  }

  prepareProjectWorkspace(id: string, request: PrepareProjectWorkspaceRequest): Promise<ProjectWorkspaceDto> {
    this.#workspaceProject(id, true);
    return this.deps.bridge!.prepareProjectWorkspace(id, request);
  }

  async #live(): Promise<Set<string>> {
    const list = await this.deps.gateway.request<{ agents: { id: string }[] }>("agents.list", {});
    return new Set(list.agents.map((agent) => agent.id));
  }

  #manager(id: string | null, departmentId: string, live: Set<string> | null): void {
    if (!id) return;
    if (!live) throw new CompanyError("gateway_unavailable");
    const { db } = this.deps;
    const agent = db.select().from(agents).where(eq(agents.id, id)).get();
    if (id === "main" || !live.has(id) || agent?.role !== "specialist" || agent.status !== "ready" || agent.teamId) throw new CompanyError("manager_invalid");
    const assignment = db.select().from(departmentManagers).where(eq(departmentManagers.agentId, id)).get();
    if (assignment && assignment.departmentId !== departmentId) throw new CompanyError("manager_assigned");
    const membership = db.select().from(companyAgentAssignments).where(eq(companyAgentAssignments.agentId, id)).get();
    if (membership?.departmentId && membership.departmentId !== departmentId) throw new CompanyError("agent_assigned");
  }

  #attachManager(agentId: string, departmentId: string): void {
    const { db } = this.deps;
    const before = db.select().from(companyAgentAssignments).where(eq(companyAgentAssignments.agentId, agentId)).get();
    if (before?.departmentId === departmentId) return;
    db.insert(companyAgentAssignments).values({ agentId, departmentId, revision: 1 }).onConflictDoUpdate({ target: companyAgentAssignments.agentId, set: { departmentId, revision: (before?.revision ?? 0) + 1 } }).run();
  }

  async list(): Promise<CompanyDto> {
    this.#company();
    const live = await this.#live().catch(() => null);
    const { db } = this.deps;
    const metadata = db.select().from(agents).all();
    const assignments = db.select().from(departmentManagers).all();
    const memberships = new Map(db.select().from(companyAgentAssignments).all().map((row) => [row.agentId, row]));
    const rows = db.select().from(departments).all();
    const list: DepartmentDto[] = rows.map((department) => {
      const id = assignments.find((assignment) => assignment.departmentId === department.id)?.agentId ?? null;
      const agent = metadata.find((item) => item.id === id);
      return {
        id: department.id, name: department.name, description: department.description, archived: department.archived, revision: department.revision,
        managerAgentId: id, managerName: agent?.displayName ?? null,
        managerState: !id ? "unassigned" : !live ? "unverified" : live.has(id) && agent?.status === "ready" ? "ready" : "missing",
      };
    });
    list.sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
    return {
      name: this.deps.space.get()?.name ?? "", gatewayAvailable: live !== null, departments: list,
      managers: metadata.filter((agent) => agent.id !== "main" && agent.role === "specialist" && !agent.teamId && agent.status === "ready" && live?.has(agent.id)).map((agent) => ({
        id: agent.id, name: agent.displayName, departmentId: memberships.get(agent.id)?.departmentId ?? null,
      })),
      agents: metadata.filter((agent) => agent.id !== "main" && agent.role === "specialist" && !agent.teamId).map((agent) => ({
        id: agent.id, name: agent.displayName, departmentId: memberships.get(agent.id)?.departmentId ?? null,
        revision: memberships.get(agent.id)?.revision ?? 0, managerOf: assignments.find((assignment) => assignment.agentId === agent.id)?.departmentId ?? null,
        available: agent.status === "ready" && !!live?.has(agent.id),
      })),
      projects: db.select().from(companyProjects).all().map((project) => ({ id: project.id, name: project.name, description: project.description, departmentId: project.departmentId, status: project.status, revision: project.revision })).sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived") || a.name.localeCompare(b.name)),
      teams: db.select().from(teams).all().map((team) => {
        const lead = team.leadAgentId ? metadata.find((agent) => agent.id === team.leadAgentId) : undefined;
        return {
          id: team.id, name: team.name, departmentId: team.departmentId, projectId: team.projectId, revision: team.organizationRevision,
          leadAgentId: lead ? lead.id : null, leadName: lead?.displayName ?? null,
          members: metadata.filter((agent) => agent.teamId === team.id).map((agent) => ({ id: agent.id, name: agent.displayName })),
        };
      }),
    };
  }

  async create(req: CreateDepartmentRequest): Promise<{ id: string }> {
    this.#company();
    const { db } = this.deps;
    const payload = JSON.stringify(req);
    const previous = db.select().from(departments).where(eq(departments.requestId, req.requestId)).get();
    if (previous) {
      if (previous.requestPayload !== payload) throw new CompanyError("request_conflict");
      return { id: previous.id };
    }
    const live = req.managerAgentId ? await this.#live().catch(() => null) : null;
    return db.transaction((tx) => {
      const existing = tx.select().from(departments).where(eq(departments.requestId, req.requestId)).get();
      if (existing) {
        if (existing.requestPayload !== payload) throw new CompanyError("request_conflict");
        return { id: existing.id };
      }
      const id = randomUUID();
      this.#manager(req.managerAgentId, id, live);
      if (req.archived && req.managerAgentId) throw new CompanyError("department_archived");
      tx.insert(departments).values({ id, requestId: req.requestId, requestPayload: payload, name: req.name, description: req.description, archived: req.archived }).run();
      if (req.managerAgentId) {
        tx.insert(departmentManagers).values({ departmentId: id, agentId: req.managerAgentId }).run();
        this.#attachManager(req.managerAgentId, id);
      }
      return { id };
    });
  }

  async update(id: string, req: UpdateDepartmentRequest): Promise<void> {
    this.#company();
    const { db } = this.deps;
    const currentManager = db.select().from(departmentManagers).where(eq(departmentManagers.departmentId, id)).get()?.agentId ?? null;
    const changedManager = currentManager !== req.managerAgentId;
    const live = changedManager && req.managerAgentId ? await this.#live().catch(() => null) : null;
    db.transaction((tx) => {
      const row = tx.select().from(departments).where(eq(departments.id, id)).get();
      if (!row) throw new CompanyError("department_missing");
      if (row.revision !== req.revision) throw new CompanyError("revision_conflict");
      if (changedManager) {
        if (req.archived && req.managerAgentId) throw new CompanyError("department_archived");
        this.#manager(req.managerAgentId, id, live);
        tx.delete(departmentManagers).where(eq(departmentManagers.departmentId, id)).run();
        if (req.managerAgentId) {
          tx.insert(departmentManagers).values({ departmentId: id, agentId: req.managerAgentId }).run();
          this.#attachManager(req.managerAgentId, id);
        }
      }
      tx.update(departments).set({ name: req.name, description: req.description, archived: req.archived, revision: row.revision + 1 }).where(eq(departments.id, id)).run();
    });
  }

  assignTeam(id: string, req: AssignTeamDepartmentRequest): void {
    this.#company();
    this.deps.db.transaction((tx) => {
      const team = tx.select().from(teams).where(eq(teams.id, id)).get();
      if (!team) throw new CompanyError("team_missing");
      if (team.organizationRevision !== req.revision) throw new CompanyError("revision_conflict");
      if (team.projectId) {
        const project = tx.select().from(companyProjects).where(eq(companyProjects.id, team.projectId)).get();
        if (project?.departmentId && project.departmentId !== req.departmentId) throw new CompanyError("project_department_mismatch");
      }
      if (req.departmentId) {
        const department = tx.select().from(departments).where(eq(departments.id, req.departmentId)).get();
        if (!department) throw new CompanyError("department_missing");
        if (department.archived) throw new CompanyError("department_archived");
      }
      tx.update(teams).set({ departmentId: req.departmentId, organizationRevision: team.organizationRevision + 1 }).where(eq(teams.id, id)).run();
    });
  }

  async assignAgent(id: string, req: AssignAgentDepartmentRequest): Promise<void> {
    this.#company();
    const live = req.departmentId ? await this.#live().catch(() => null) : null;
    this.deps.db.transaction((tx) => {
      const agent = tx.select().from(agents).where(eq(agents.id, id)).get();
      if (id === "main" || agent?.role !== "specialist" || agent.teamId || (req.departmentId && agent.status !== "ready")) throw new CompanyError("agent_invalid");
      const before = tx.select().from(companyAgentAssignments).where(eq(companyAgentAssignments.agentId, id)).get();
      if ((before?.revision ?? 0) !== req.revision) throw new CompanyError("revision_conflict");
      const manager = tx.select().from(departmentManagers).where(eq(departmentManagers.agentId, id)).get();
      if (manager && manager.departmentId !== req.departmentId) throw new CompanyError("manager_assigned");
      if (req.departmentId) {
        if (!live) throw new CompanyError("gateway_unavailable");
        if (!live.has(id)) throw new CompanyError("agent_invalid");
        const department = tx.select().from(departments).where(eq(departments.id, req.departmentId)).get();
        if (!department) throw new CompanyError("department_missing");
        if (department.archived) throw new CompanyError("department_archived");
      }
      tx.insert(companyAgentAssignments).values({ agentId: id, departmentId: req.departmentId, revision: 1 }).onConflictDoUpdate({ target: companyAgentAssignments.agentId, set: { departmentId: req.departmentId, revision: req.revision + 1 } }).run();
    });
  }

  #projectDepartment(id: string | null): void {
    if (!id) return;
    const department = this.deps.db.select().from(departments).where(eq(departments.id, id)).get();
    if (!department) throw new CompanyError("department_missing");
    if (department.archived) throw new CompanyError("department_archived");
  }

  createProject(req: CreateProjectRequest): { id: string } {
    this.#company();
    return this.deps.db.transaction((tx) => {
      const payload = JSON.stringify(req);
      const before = tx.select().from(companyProjects).where(eq(companyProjects.requestId, req.requestId)).get();
      if (before) {
        if (before.requestPayload !== payload) throw new CompanyError("request_conflict");
        return { id: before.id };
      }
      this.#projectDepartment(req.departmentId);
      const id = randomUUID();
      tx.insert(companyProjects).values({ id, requestId: req.requestId, requestPayload: payload, name: req.name, description: req.description, departmentId: req.departmentId, status: req.status }).run();
      return { id };
    });
  }

  updateProject(id: string, req: UpdateProjectRequest): void {
    this.#company();
    this.deps.db.transaction((tx) => {
      const before = tx.select().from(companyProjects).where(eq(companyProjects.id, id)).get();
      if (!before) throw new CompanyError("project_missing");
      if (before.revision !== req.revision) throw new CompanyError("revision_conflict");
      if (before.departmentId !== req.departmentId) this.#projectDepartment(req.departmentId);
      if (req.departmentId && tx.select().from(teams).where(eq(teams.projectId, id)).all().some((team) => team.departmentId !== req.departmentId)) throw new CompanyError("project_department_mismatch");
      tx.update(companyProjects).set({ name: req.name, description: req.description, departmentId: req.departmentId, status: req.status, revision: req.revision + 1 }).where(eq(companyProjects.id, id)).run();
    });
  }

  /**
   * Stage 4: makes an agent the team's lead (or removes the lead). The lead is a member of this team or a
   * standalone agent, never the main agent or another team's member; requests of the team go to it first.
   */
  assignTeamLead(id: string, req: AssignTeamLeadRequest): void {
    this.#company();
    this.deps.db.transaction((tx) => {
      const team = tx.select().from(teams).where(eq(teams.id, id)).get();
      if (!team) throw new CompanyError("team_missing");
      if (team.organizationRevision !== req.revision) throw new CompanyError("revision_conflict");
      if (req.agentId) {
        const agent = tx.select().from(agents).where(eq(agents.id, req.agentId)).get();
        if (!agent || agent.id === "main") throw new CompanyError("agent_invalid");
        if (agent.teamId ? agent.teamId !== id : agent.role !== "specialist") throw new CompanyError("lead_not_eligible");
      }
      tx.update(teams).set({ leadAgentId: req.agentId, organizationRevision: team.organizationRevision + 1 }).where(eq(teams.id, id)).run();
    });
  }

  assignTeamProject(id: string, req: AssignTeamProjectRequest): void {
    this.#company();
    this.deps.db.transaction((tx) => {
      const team = tx.select().from(teams).where(eq(teams.id, id)).get();
      if (!team) throw new CompanyError("team_missing");
      if (team.organizationRevision !== req.revision) throw new CompanyError("revision_conflict");
      let departmentId = team.departmentId;
      if (req.projectId) {
        const project = tx.select().from(companyProjects).where(eq(companyProjects.id, req.projectId)).get();
        if (!project) throw new CompanyError("project_missing");
        if (project.status === "archived") throw new CompanyError("project_archived");
        this.#projectDepartment(project.departmentId);
        if (project.departmentId && team.departmentId && project.departmentId !== team.departmentId) throw new CompanyError("project_department_mismatch");
        if (team.projectId && team.projectId !== req.projectId) throw new CompanyError("team_project_assigned");
        departmentId ??= project.departmentId;
      }
      tx.update(teams).set({ projectId: req.projectId, departmentId, organizationRevision: req.revision + 1 }).where(eq(teams.id, id)).run();
    });
  }
}
