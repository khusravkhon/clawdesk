import { CreateAgentRequest, type CreateOrganizationalTeamRequest } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { companyProjects, departments, teams } from "../db/schema.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { createJuniorAgent, deleteJuniorAgent, slugBase, uniqueSlug } from "../provision/create-agent.js";

// Stage 3: a team without a repository. Its members are created from company specialist templates as team
// members (role team_member, the team's id), on the main agent's AI and sandboxed like every junior agent.
// Creating the team is all or nothing: a failure removes the agents made so far and the team. A repeat of
// the same request returns the team it made.

export class OrganizationalTeamError extends Error {
  constructor(readonly code: "department_missing" | "department_archived" | "project_missing" | "project_department_mismatch" | "team_busy" | "request_conflict" | "gateway_unavailable") { super(code); }
}

/**
 * The template fields a member needs, from the team's description and the member's purpose: specialists ask
 * "about the company" and one field of their own (audience, metrics, product…), the custom agent a purpose.
 */
export function memberValues(request: CreateOrganizationalTeamRequest, member: CreateOrganizationalTeamRequest["members"][number], departmentPurpose: string): Record<string, string> {
  const context = [departmentPurpose.trim(), request.context].filter(Boolean).join("\n\n");
  const purpose = member.purpose || request.context;
  return {
    ...(member.name ? { agentName: member.name } : member.templateId === "custom" ? { agentName: "Сотрудник" } : {}),
    companyContext: context, teamPurpose: request.context, purpose,
    audience: purpose, metrics: purpose, product: purpose, service: purpose, hiring: purpose, processes: purpose,
  };
}

export class OrganizationalTeams {
  #busy = false;
  readonly #made = new Map<string, { teamId: string; payload: string }>();
  constructor(private readonly deps: { db: Db; gateway?: GatewayService; logger?: Logger; sandboxEnabled: boolean }) {}

  async create(request: CreateOrganizationalTeamRequest): Promise<{ id: string }> {
    const { db, gateway, logger } = this.deps;
    if (!gateway || !logger) throw new OrganizationalTeamError("gateway_unavailable");
    const payload = JSON.stringify(request);
    const made = this.#made.get(request.requestId) ?? (() => {
      const row = db.select().from(teams).all().find((team) => team.requestId === request.requestId);
      return row ? { teamId: row.id, payload: row.requestPayload ?? "" } : undefined;
    })();
    if (made) {
      if (made.payload !== payload) throw new OrganizationalTeamError("request_conflict");
      return { id: made.teamId };
    }
    const department = request.departmentId ? db.select().from(departments).where(eq(departments.id, request.departmentId)).get() : null;
    if (request.departmentId && !department) throw new OrganizationalTeamError("department_missing");
    if (department?.archived) throw new OrganizationalTeamError("department_archived");
    const project = request.projectId ? db.select().from(companyProjects).where(eq(companyProjects.id, request.projectId)).get() : null;
    if (request.projectId && !project) throw new OrganizationalTeamError("project_missing");
    if (project?.departmentId && request.departmentId && project.departmentId !== request.departmentId) throw new OrganizationalTeamError("project_department_mismatch");
    if (this.#busy) throw new OrganizationalTeamError("team_busy");
    this.#busy = true;
    const taken = new Set(db.select({ id: teams.id }).from(teams).all().map((row) => row.id));
    const teamId = uniqueSlug(slugBase({ id: "custom" }, request.name).slice(0, 24).replace(/-+$/, "") || "team", taken);
    const created: string[] = [];
    try {
      db.insert(teams).values({ id: teamId, name: request.name, repoUrl: null, telegramGroupId: null, departmentId: request.departmentId ?? project?.departmentId ?? null, projectId: request.projectId, requestId: request.requestId, requestPayload: payload }).run();
      for (const member of request.members) {
        const result = await createJuniorAgent(
          { db, gateway, logger, sandboxEnabled: this.deps.sandboxEnabled, team: { id: teamId, binds: [], organizational: true, values: { teamName: request.name, teamPurpose: request.name, projectName: project?.name ?? "—", projectBrief: project?.description || "—", departmentPurpose: department?.description || "—" } } },
          CreateAgentRequest.parse({ templateId: member.templateId, mode: "company", values: memberValues(request, member, department?.description ?? ""), canAskMain: true, ai: "inherit", schedules: [], timezone: request.timezone, deliverToTelegram: false, folder: null }),
        );
        created.push(result.agentId);
      }
      if (request.lead !== null && created[request.lead]) db.update(teams).set({ leadAgentId: created[request.lead] }).where(eq(teams.id, teamId)).run();
      this.#made.set(request.requestId, { teamId, payload });
      logger.info({ teamId, created }, "organizational team created");
      return { id: teamId };
    } catch (error) {
      logger.warn({ err: error, teamId }, "creating the team failed, undoing");
      for (const agentId of created.reverse()) await deleteJuniorAgent({ db, gateway, logger }, agentId).catch(() => undefined);
      db.delete(teams).where(eq(teams.id, teamId)).run();
      throw error;
    } finally { this.#busy = false; }
  }
}
