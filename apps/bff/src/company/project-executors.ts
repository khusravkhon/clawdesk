import { CreateAgentRequest, type AssignExecutorsRequest, type ProjectExecutorRole, type ProjectExecutorsDto } from "@clawdesk/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agents, teams } from "../db/schema.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { ProjectTaskError } from "./project-tasks-service.js";
import { createJuniorAgent, deleteJuniorAgent, slugBase, uniqueSlug } from "../provision/create-agent.js";

// A project's executors (P6.2): a team without GitHub, bound to the project, with a QA, a developer and a
// reviewer agent (projects assigned before the reviewer existed get it when executors are assigned again).
// Each agent works in its own copy, the folder "project" in its workspace (/workspace/project in its sandbox).
// No extra bind: OpenClaw allows bind sources only inside the agent's workspace, so app/ never reaches a sandbox.

export const EXECUTOR_TEMPLATES: Record<ProjectExecutorRole, string> = { qa: "project-qa", developer: "project-developer", reviewer: "project-reviewer" };
const ROLES = ["qa", "developer", "reviewer"] as const;
const WORK_PATH = "/workspace/project";

export type ExecutorsPort = {
  list(projectId: string): ProjectExecutorsDto;
  assign(project: { id: string; name: string; description: string; departmentId: string | null }, request: AssignExecutorsRequest): Promise<ProjectExecutorsDto>;
};

export class ProjectExecutors implements ExecutorsPort {
  #busy = new Set<string>();
  constructor(private readonly deps: { db: Db; gateway: GatewayService; logger: Logger; sandboxEnabled: boolean; bridge: Pick<BridgeClient, "ensureProjectWork"> }) {}

  list(projectId: string): ProjectExecutorsDto {
    const team = this.deps.db.select().from(teams).where(and(eq(teams.projectId, projectId), isNull(teams.repoUrl))).all()
      .find(row => this.#members(row.id).length);
    const members = team ? this.#members(team.id) : [];
    const executors = ROLES.flatMap(role => {
      const agent = members.find(member => member.templateId === EXECUTOR_TEMPLATES[role]);
      return agent ? [{ role, agentId: agent.id, name: agent.displayName, emoji: agent.avatar }] : [];
    });
    return { teamId: team?.id ?? null, executors, sandboxed: this.deps.sandboxEnabled };
  }

  #members(teamId: string) {
    return this.deps.db.select().from(agents).where(and(eq(agents.teamId, teamId), inArray(agents.templateId, Object.values(EXECUTOR_TEMPLATES)))).all();
  }

  async assign(project: { id: string; name: string; description: string; departmentId: string | null }, request: AssignExecutorsRequest): Promise<ProjectExecutorsDto> {
    const existing = this.list(project.id);
    if (existing.executors.length === ROLES.length) return existing;
    if (this.#busy.has(project.id)) throw new ProjectTaskError("task_busy");
    this.#busy.add(project.id);
    const { db, logger } = this.deps;
    const created: string[] = [];
    let teamId = existing.teamId;
    let teamCreated = false;
    try {
      if (!teamId) {
        const taken = new Set(db.select({ id: teams.id }).from(teams).all().map(row => row.id));
        teamId = uniqueSlug(`${slugBase({ id: "custom" }, project.name).slice(0, 24).replace(/-+$/, "") || "project"}-work`, taken);
        db.insert(teams).values({ id: teamId, name: `Исполнители: ${project.name}`.slice(0, 120), repoUrl: null, telegramGroupId: null, projectId: project.id, departmentId: project.departmentId }).run();
        teamCreated = true;
      }
      for (const role of ROLES) {
        if (existing.executors.some(item => item.role === role)) continue;
        const result = await createJuniorAgent(
          { ...this.deps, team: { id: teamId, binds: [], values: { projectName: project.name, projectBrief: project.description || "—", repoUrl: "—", repoPath: this.deps.sandboxEnabled ? WORK_PATH : "project", docsPath: "—", branch: "—" } } },
          CreateAgentRequest.parse({ templateId: EXECUTOR_TEMPLATES[role], mode: "company", values: {}, canAskMain: true, ai: "inherit", schedules: [], timezone: request.timezone, deliverToTelegram: false, folder: null }),
        );
        created.push(result.agentId);
        await this.deps.bridge.ensureProjectWork(result.agentId);
      }
      logger.info({ projectId: project.id, teamId, created }, "project executors assigned");
      return this.list(project.id);
    } catch (error) {
      logger.warn({ err: error, projectId: project.id }, "assigning project executors failed, undoing");
      for (const agentId of created.reverse()) await deleteJuniorAgent(this.deps, agentId).catch(() => undefined);
      if (teamCreated && teamId) db.delete(teams).where(eq(teams.id, teamId)).run();
      throw error;
    } finally { this.#busy.delete(project.id); }
  }
}
