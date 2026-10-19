import { AssignAgentDepartmentRequest, AssignTeamDepartmentRequest, AssignTeamProjectRequest, CreateDepartmentRequest, CreateProjectRequest, UpdateDepartmentRequest, UpdateProjectRequest } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { CompanyError, type CompanyService } from "../company/company-service.js";
import { PrepareProjectWorkspaceRequest } from "@clawdesk/shared";
import { SaveProjectBriefRequest } from "@clawdesk/shared";
import { ApproveBusinessRuleRequest, CreateBusinessRuleRequest, UpdateBusinessRuleRequest } from "@clawdesk/shared";
import { BridgeError } from "../gateway/bridge-client.js";
import { ProjectRuleError } from "../company/project-rules-service.js";
import { CreateAcceptanceRequest, RecordAcceptanceCheckRequest, UpdateAcceptanceRequest } from "@clawdesk/shared";
import { AcceptanceError } from "../company/project-acceptance-service.js";

const Params = z.object({ id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/) });
const RuleParams = Params.extend({ ruleId: z.uuid() });
const CaseParams = RuleParams.extend({ caseId: z.uuid() });
const SuiteQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

export function registerCompanyRoutes(app: FastifyInstance, company: CompanyService): void {
  app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.status(400).send({ error: "invalid_request", message: "request validation failed" });
      if (error instanceof BridgeError) {
        const known = new Set(["invalid_workspace", "workspace_unavailable", "workspace_already_linked", "workspace_in_use", "workspace_limit", "workspace_exists", "workspace_not_directory", "company_only"]);
        const code = known.has(error.code) ? error.code : "workspace_unavailable";
        return reply.status(code === "invalid_workspace" ? 400 : code === "workspace_unavailable" ? 503 : 409).send({ error: code, message: code });
      }
      if (!(error instanceof CompanyError) && !(error instanceof ProjectRuleError) && !(error instanceof AcceptanceError)) throw error;
      const status = error.code === "company_only" || error.code.endsWith("_missing") ? 404 : error.code === "gateway_unavailable" ? 503 : 409;
      return reply.status(status).send({ error: error.code, message: error.code });
    });
    scope.get("/api/company", () => company.list());
    scope.post("/api/company/departments", async (request, reply) => reply.status(201).send(await company.create(CreateDepartmentRequest.parse(request.body))));
    scope.put("/api/company/departments/:id", async (request) => {
      await company.update(Params.parse(request.params).id, UpdateDepartmentRequest.parse(request.body));
      return { ok: true };
    });
    scope.put("/api/company/teams/:id/department", async (request) => {
      company.assignTeam(Params.parse(request.params).id, AssignTeamDepartmentRequest.parse(request.body));
      return { ok: true };
    });
    scope.put("/api/company/agents/:id/department", async (request) => {
      await company.assignAgent(Params.parse(request.params).id, AssignAgentDepartmentRequest.parse(request.body));
      return { ok: true };
    });
    scope.post("/api/company/projects", async (request, reply) => reply.status(201).send(company.createProject(CreateProjectRequest.parse(request.body))));
    scope.get("/api/company/projects/:id/brief", (request) => company.projectBrief(Params.parse(request.params).id));
    scope.put("/api/company/projects/:id/brief", (request) => company.saveProjectBrief(Params.parse(request.params).id, SaveProjectBriefRequest.parse(request.body)));
    scope.get("/api/company/projects/:id/rules", (request) => company.rules.list(Params.parse(request.params).id));
    scope.get("/api/company/projects/:id/rules/:ruleId/acceptance", (request) => {
      const { id, ruleId } = RuleParams.parse(request.params);
      return company.acceptance.list(id, ruleId, SuiteQuery.parse(request.query).version);
    });
    scope.post("/api/company/projects/:id/rules/:ruleId/acceptance", (request, reply) => {
      const { id, ruleId } = RuleParams.parse(request.params);
      return reply.status(201).send(company.acceptance.create(id, ruleId, CreateAcceptanceRequest.parse(request.body)));
    });
    scope.put("/api/company/projects/:id/rules/:ruleId/acceptance/:caseId", (request) => {
      const { id, ruleId, caseId } = CaseParams.parse(request.params);
      return company.acceptance.update(id, ruleId, caseId, UpdateAcceptanceRequest.parse(request.body));
    });
    scope.post("/api/company/projects/:id/rules/:ruleId/acceptance/:caseId/checks", (request) => {
      const { id, ruleId, caseId } = CaseParams.parse(request.params);
      return company.acceptance.record(id, ruleId, caseId, RecordAcceptanceCheckRequest.parse(request.body));
    });
    scope.get("/api/company/projects/:id/rules/:ruleId/acceptance/:caseId/history", (request) => {
      const { id, ruleId, caseId } = CaseParams.parse(request.params);
      return company.acceptance.history(id, ruleId, caseId);
    });
    scope.post("/api/company/projects/:id/rules", (request, reply) => reply.status(201).send(company.rules.create(Params.parse(request.params).id, CreateBusinessRuleRequest.parse(request.body))));
    scope.get("/api/company/projects/:id/rules/:ruleId/history", (request) => {
      const { id, ruleId } = RuleParams.parse(request.params);
      return company.rules.history(id, ruleId);
    });
    scope.put("/api/company/projects/:id/rules/:ruleId", (request) => {
      const { id, ruleId } = RuleParams.parse(request.params);
      return company.rules.update(id, ruleId, UpdateBusinessRuleRequest.parse(request.body));
    });
    scope.post("/api/company/projects/:id/rules/:ruleId/approve", (request) => {
      const { id, ruleId } = RuleParams.parse(request.params);
      return company.rules.approve(id, ruleId, ApproveBusinessRuleRequest.parse(request.body));
    });
    scope.get("/api/company/projects/:id/workspace", (request) => company.projectWorkspace(Params.parse(request.params).id));
    scope.post("/api/company/projects/:id/workspace", (request) => company.prepareProjectWorkspace(Params.parse(request.params).id, PrepareProjectWorkspaceRequest.parse(request.body)));
    scope.put("/api/company/projects/:id", async (request) => {
      company.updateProject(Params.parse(request.params).id, UpdateProjectRequest.parse(request.body));
      return { ok: true };
    });
    scope.put("/api/company/teams/:id/project", async (request) => {
      company.assignTeamProject(Params.parse(request.params).id, AssignTeamProjectRequest.parse(request.body));
      return { ok: true };
    });
  });
}
