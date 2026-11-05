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
import { AnswerProjectBuilderRequest, BuilderMutationRequest, ConfirmProjectBuilderRequest, PlanProjectBuilderRequest, ProjectPreviewRequest } from "@clawdesk/shared";
import { ProjectBuilderError } from "../company/project-builder-service.js";
import { ProjectChecksError } from "../company/project-checks-service.js";
import { RunProjectChecksRequest, AssignExecutorsRequest, CreateProjectTaskRequest, ProjectTaskActionRequest, ReturnProjectTaskRequest, AcceptProjectTaskRequest } from "@clawdesk/shared";
import { ProjectTaskError } from "../company/project-tasks-service.js";
import { ConnectProjectRepoRequest, CreateProjectRepoRequest, ImportProjectRepoRequest, ProjectPullRequestRequest } from "@clawdesk/shared";
import { ProjectGitHubError } from "../company/project-github-service.js";

const Params = z.object({ id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/) });
const RuleParams = Params.extend({ ruleId: z.uuid() });
const CaseParams = RuleParams.extend({ caseId: z.uuid() });
const SuiteQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

export function registerCompanyRoutes(app: FastifyInstance, company: CompanyService): void {
  app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.status(400).send({ error: "invalid_request", message: "request validation failed" });
      if (error instanceof BridgeError) {
        const known = new Set(["invalid_workspace", "workspace_unavailable", "workspace_already_linked", "workspace_in_use", "workspace_limit", "workspace_exists", "workspace_not_directory", "company_only", "builder_files_changed", "builder_existing_readonly", "invalid_builder_request", "builder_plan_changed", "builder_workspace_not_empty", "preview_identity_changed", "preview_image_unavailable", "preview_unavailable", "preview_not_running", "invalid_preview_request", "existing_workspace_required", "workspace_required", "workspace_changed", "checks_unsupported", "checks_too_large", "checks_no_files", "work_app_changed", "work_missing", "work_layout", "invalid_work_request",
          "invalid_github_request", "invalid_token", "github_token_required", "github_token_rejected", "github_unreachable", "github_repo_exists", "github_repo_gone", "github_no_permission", "github_private_unavailable", "github_folder_has_git", "github_plan_changed", "github_already_connected", "github_not_connected", "github_nothing_to_push", "github_pull_request_failed", "github_git_failed", "github_project_too_large", "github_unavailable", "github_repo_not_found", "github_no_origin", "github_folder_has_no_git"]);
        const code = known.has(error.code) ? error.code : "workspace_unavailable";
        return reply.status(code.startsWith("invalid_") ? 400 : code === "workspace_unavailable" ? 503 : 409).send({ error: code, message: code });
      }
      if (!(error instanceof CompanyError) && !(error instanceof ProjectRuleError) && !(error instanceof AcceptanceError) && !(error instanceof ProjectBuilderError) && !(error instanceof ProjectChecksError) && !(error instanceof ProjectTaskError) && !(error instanceof ProjectGitHubError)) throw error;
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
    const TaskParams = Params.extend({ taskId: z.uuid() });
    scope.get("/api/company/projects/:id/executors", request => company.tasks.executors(Params.parse(request.params).id));
    scope.post("/api/company/projects/:id/executors", request => company.tasks.assignExecutors(Params.parse(request.params).id, AssignExecutorsRequest.parse(request.body)));
    scope.get("/api/company/projects/:id/tasks", request => company.tasks.list(Params.parse(request.params).id));
    scope.post("/api/company/projects/:id/tasks", async (request, reply) => reply.status(201).send(await company.tasks.create(Params.parse(request.params).id, CreateProjectTaskRequest.parse(request.body))));
    scope.get("/api/company/projects/:id/rules/:ruleId/impact", request => { const { id, ruleId } = RuleParams.parse(request.params); return company.tasks.impact(id, ruleId, SuiteQuery.parse(request.query).version); });
    scope.post("/api/company/projects/:id/tasks/:taskId/accept", request => { const { id, taskId } = TaskParams.parse(request.params); return company.tasks.accept(id, taskId, AcceptProjectTaskRequest.parse(request.body)); });
    for (const [action, run] of [["check", "checkStage"], ["resend", "resend"], ["cancel", "cancel"], ["rollback", "rollback"]] as const) {
      scope.post(`/api/company/projects/:id/tasks/:taskId/${action}`, request => { const { id, taskId } = TaskParams.parse(request.params); return company.tasks[run](id, taskId, ProjectTaskActionRequest.parse(request.body)); });
    }
    scope.post("/api/company/projects/:id/tasks/:taskId/return", request => { const { id, taskId } = TaskParams.parse(request.params); return company.tasks.returnToDeveloper(id, taskId, ReturnProjectTaskRequest.parse(request.body)); });
    // P7: GitHub for a project's folder.
    scope.get("/api/company/projects/:id/github", request => company.github.status(Params.parse(request.params).id));
    scope.get("/api/company/projects/:id/github/plan", request => company.github.plan(Params.parse(request.params).id));
    scope.get("/api/company/projects/:id/github/changes", request => company.github.changes(Params.parse(request.params).id));
    scope.post("/api/company/projects/:id/github/create", request => company.github.create(Params.parse(request.params).id, CreateProjectRepoRequest.parse(request.body)));
    scope.post("/api/company/projects/:id/github/connect", request => company.github.connect(Params.parse(request.params).id, ConnectProjectRepoRequest.parse(request.body)));
    scope.post("/api/company/projects/:id/github/import", request => company.github.importRepo(Params.parse(request.params).id, ImportProjectRepoRequest.parse(request.body)));
    scope.post("/api/company/projects/:id/github/pull-request", request => company.github.pullRequest(Params.parse(request.params).id, ProjectPullRequestRequest.parse(request.body)));
    scope.post("/api/company/projects/:id/github/disconnect", request => company.github.disconnect(Params.parse(request.params).id));
    scope.get("/api/company/projects/:id/checks", request => company.checks.list(Params.parse(request.params).id));
    scope.post("/api/company/projects/:id/checks/run", request => company.checks.run(Params.parse(request.params).id, RunProjectChecksRequest.parse(request.body)));
    scope.get("/api/company/projects/:id/builder", request => company.builder.get(Params.parse(request.params).id));
    scope.get("/api/company/projects/:id/builder/analysis", request => company.builder.analyze(Params.parse(request.params).id));
    scope.post("/api/company/projects/:id/builder/answer", request => company.builder.answer(Params.parse(request.params).id, AnswerProjectBuilderRequest.parse(request.body)));
    scope.post("/api/company/projects/:id/builder/plan", request => company.builder.plan(Params.parse(request.params).id, PlanProjectBuilderRequest.parse(request.body)));
    scope.post("/api/company/projects/:id/builder/approve", request => company.builder.approve(Params.parse(request.params).id, ConfirmProjectBuilderRequest.parse(request.body)));
    scope.post("/api/company/projects/:id/builder/prepare", request => company.builder.prepare(Params.parse(request.params).id, ConfirmProjectBuilderRequest.parse(request.body)));
    scope.post("/api/company/projects/:id/builder/preview/start", request => company.builder.start(Params.parse(request.params).id, BuilderMutationRequest.parse(request.body)));
    scope.post("/api/company/projects/:id/builder/preview/stop", request => company.builder.stop(Params.parse(request.params).id, BuilderMutationRequest.parse(request.body)));
    scope.get("/api/company/projects/:id/builder/preview", async (request, reply) => {
      const result = await company.builder.preview(Params.parse(request.params).id, { method: "GET", path: "/" });
      return reply.status(result.status).header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'").header("Cache-Control", "no-store").type(result.contentType).send(result.body);
    });
    scope.post("/api/company/projects/:id/builder/preview/request", request => company.builder.preview(Params.parse(request.params).id, ProjectPreviewRequest.parse(request.body)));
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
