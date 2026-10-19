import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AnswerProjectBuilderRequest, BuilderMutationRequest, BusinessRuleDto, ConfirmProjectBuilderRequest, PlanProjectBuilderRequest, PrepareProjectAppRequest, ProjectBriefDto, ProjectBuilderDto, ProjectBuilderPlanDto, ProjectBuilderRuntimeDto, ProjectBuilderSnapshot, ProjectPreviewRequest, ProjectPreviewResponse, ProjectWorkspaceDto } from "@clawdesk/shared";
import type { Db } from "../db/client.js";
import { projectBuilderRequests, projectBuilders } from "../db/schema.js";
import { BridgeError } from "../gateway/bridge-client.js";

export class ProjectBuilderError extends Error {
  constructor(readonly code: "builder_incomplete" | "builder_plan_missing" | "builder_plan_stale" | "builder_approval_required" | "builder_existing_project" | "builder_workspace_required" | "revision_conflict" | "request_conflict" | "gateway_unavailable" | "builder_busy") { super(code); }
}
export type ProjectBuilderBridge = {
  projectWorkspace(id: string): Promise<ProjectWorkspaceDto>;
  builderStatus(id: string): Promise<ProjectBuilderRuntimeDto>;
  prepareProjectApp(id: string, request: PrepareProjectAppRequest): Promise<ProjectBuilderRuntimeDto>;
  startProjectPreview(id: string, request: { planId: string }): Promise<ProjectBuilderRuntimeDto>;
  stopProjectPreview(id: string): Promise<ProjectBuilderRuntimeDto>;
  projectPreviewRequest(id: string, request: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown }): Promise<ProjectPreviewResponse>;
  analyzeProjectWorkspace(id: string): Promise<import("@clawdesk/shared").ProjectWorkspaceAnalysisDto>;
};
const questions: ProjectBuilderDto["questions"] = [
  { field: "goal", prompt: "Какое приложение создаём и какую задачу оно должно решить?" },
  { field: "audience", prompt: "Кто будет пользоваться приложением?" },
  { field: "scenarios", prompt: "Что пользователь должен сделать в приложении? Опишите основной сценарий." },
  { field: "inScope", prompt: "Какие функции должны войти в первую версию?" },
  { field: "outOfScope", prompt: "Что пока не включаем в первую версию?" },
  { field: "rules", prompt: "Какие условия и ограничения должны соблюдать пользователи? Если их нет, так и напишите." },
  { field: "data", prompt: "Какие данные нужно хранить?" },
  { field: "integrations", prompt: "Нужны ли подключения к другим сервисам? Если нет, напишите «нет»." },
  { field: "constraints", prompt: "Есть ли ограничения для запуска? Если нет, напишите «нет»." },
];
const template: ProjectBuilderDto["templates"][number] = {
  id: "task-board-v1", name: "Доска задач", description: "Наш локальный шаблон для списка задач и отслеживания их выполнения.",
  features: ["Создание, переименование и удаление задач", "Переключение состояния задачи", "Сохранение задач в локальной SQLite", "Локальный запуск и интерактивный просмотр"],
  limitations: ["Первая версия — только доска задач: другие сценарии требуют отдельной разработки", "Без авторизации, ролей, внешних интеграций и публичного размещения", "Записанные бизнес-правила сохраняются как требования; их реализация не считается доказанной шаблоном", "Данные в изолированном просмотре временные: остановка удаляет задачи; для постоянного хранения запускайте созданное приложение отдельно", "После создания файлов новый план не перезаписывает приложение: нужна отдельная новая папка"],
};
const files = ["server.mjs", "index.html", "package.json", "README.md", "PROJECT-REQUIREMENTS.json", "LICENSE", ".clawdesk-build.json"].map(file => `app/${file}`);
const emptyRuntime = (): ProjectBuilderRuntimeDto => ({ state: "empty", planId: null, files: [], previewUrl: null, error: null });

export class ProjectBuilderService {
  #busy = new Set<string>();
  constructor(private readonly deps: {
    db: Db; checkProject: (id: string, writing: boolean) => { name: string; revision: number };
    brief: (id: string) => ProjectBriefDto;
    saveBrief: (id: string, request: { requestId: string; revision: number; step: number; fields: ProjectBriefDto["fields"] }) => ProjectBriefDto;
    rules: (id: string) => BusinessRuleDto[];
    bridge?: ProjectBuilderBridge;
  }) {}

  #row(id: string) { return this.deps.db.select().from(projectBuilders).where(eq(projectBuilders.projectId, id)).get(); }
  #bridge() { if (!this.deps.bridge) throw new ProjectBuilderError("gateway_unavailable"); return this.deps.bridge; }

  async #context(id: string) {
    const workspace = await this.deps.bridge?.projectWorkspace(id).catch(() => null);
    const project = this.deps.checkProject(id, false);
    const brief = this.deps.brief(id), rules = this.deps.rules(id);
    const snapshot: ProjectBuilderSnapshot = { projectRevision: project.revision, briefRevision: brief.revision, rules: rules.map(r => ({ id: r.id, version: r.version, revision: r.revision, approvedAt: r.approvedAt })), workspace: workspace?.workspace ? { path: workspace.workspace.path, mode: workspace.workspace.mode, state: workspace.workspace.state } : null };
    const missing = questions.filter(q => !brief.fields[q.field].trim());
    const blockers: string[] = missing.length ? ["brief_incomplete"] : [];
    if (brief.fields.openQuestions.trim()) blockers.push("open_questions");
    if (rules.some(r => !r.approvedAt || r.fields.openQuestions.trim())) blockers.push("rules_unapproved");
    if (!snapshot.workspace || snapshot.workspace.state !== "ready") blockers.push("workspace_required");
    if (snapshot.workspace?.mode === "existing") blockers.push("existing_project");
    return { project, brief, rules, snapshot, questions: missing, blockers, workspace: workspace?.workspace ?? null };
  }

  async get(id: string): Promise<ProjectBuilderDto> {
    this.deps.checkProject(id, false);
    let runtime = await this.deps.bridge?.builderStatus(id).catch((error: unknown) => ({ ...emptyRuntime(), state: "failed" as const, error: error instanceof BridgeError ? error.code : "gateway_unavailable" })) ?? { ...emptyRuntime(), state: "failed" as const, error: "gateway_unavailable" };
    const context = await this.#context(id), row = this.#row(id);
    if (!context.workspace && runtime.error === "workspace_required") runtime = emptyRuntime();
    return { revision: row?.revision ?? 0, brief: context.brief, questions: context.questions, templates: [template], plan: row?.plan ?? null, stale: !!row?.plan && JSON.stringify(row.plan.snapshot) !== JSON.stringify(context.snapshot), blockers: context.blockers, workspace: context.workspace, runtime: { ...runtime, previewUrl: runtime.state === "running" ? `/api/company/projects/${encodeURIComponent(id)}/builder/preview` : null } };
  }

  async #mutate(id: string, operation: string, request: BuilderMutationRequest, action: () => Promise<ProjectBuilderPlanDto | null>, commit?: () => void): Promise<ProjectBuilderDto> {
    this.deps.checkProject(id, operation !== "stop");
    if (this.#busy.has(id)) throw new ProjectBuilderError("builder_busy");
    this.#busy.add(id);
    try {
      const payload = JSON.stringify({ operation, request });
      const existing = this.deps.db.select().from(projectBuilderRequests).where(and(eq(projectBuilderRequests.projectId, id), eq(projectBuilderRequests.requestId, request.requestId))).get();
      if (existing) {
        if (existing.payload !== payload) throw new ProjectBuilderError("request_conflict");
        return await this.get(id);
      }
      if ((this.#row(id)?.revision ?? 0) !== request.revision) throw new ProjectBuilderError("revision_conflict");
      const plan = await action();
      this.deps.checkProject(id, operation !== "stop");
      this.deps.db.transaction(tx => {
        if ((this.#row(id)?.revision ?? 0) !== request.revision) throw new ProjectBuilderError("revision_conflict");
        commit?.();
        const values = { revision: request.revision + 1, plan };
        tx.insert(projectBuilders).values({ projectId: id, ...values }).onConflictDoUpdate({ target: projectBuilders.projectId, set: values }).run();
        tx.insert(projectBuilderRequests).values({ projectId: id, requestId: request.requestId, payload }).run();
      });
      return await this.get(id);
    } finally { this.#busy.delete(id); }
  }

  answer(id: string, request: AnswerProjectBuilderRequest) {
    return this.#mutate(id, "answer", request, async () => this.#row(id)?.plan ?? null, () => {
        const brief = this.deps.brief(id);
        this.deps.saveBrief(id, { requestId: request.requestId, revision: brief.revision, step: brief.step, fields: { ...brief.fields, [request.field]: request.value } });
    });
  }

  plan(id: string, request: PlanProjectBuilderRequest) {
    return this.#mutate(id, "plan", request, async () => {
      const context = await this.#context(id);
      if (context.snapshot.workspace?.mode === "existing") throw new ProjectBuilderError("builder_existing_project");
      return { id: randomUUID(), templateId: request.templateId, projectName: context.project.name, features: [...template.features], limitations: [...template.limitations], files: [...files], brief: context.brief.fields, rules: context.rules, snapshot: context.snapshot, createdAt: Date.now(), approvedAt: null };
    });
  }

  async #validPlan(id: string, requireApproval: boolean) {
    const context = await this.#context(id);
    this.deps.checkProject(id, true);
    const plan = this.#row(id)?.plan;
    if (!plan) throw new ProjectBuilderError("builder_plan_missing");
    if (JSON.stringify(plan.snapshot) !== JSON.stringify(context.snapshot)) throw new ProjectBuilderError("builder_plan_stale");
    if (context.snapshot.workspace?.mode === "existing") throw new ProjectBuilderError("builder_existing_project");
    if (!context.snapshot.workspace || context.snapshot.workspace.state !== "ready") throw new ProjectBuilderError("builder_workspace_required");
    if (context.blockers.length) throw new ProjectBuilderError("builder_incomplete");
    if (requireApproval && !plan.approvedAt) throw new ProjectBuilderError("builder_approval_required");
    return { plan, context };
  }

  approve(id: string, request: ConfirmProjectBuilderRequest) {
    return this.#mutate(id, "approve", request, async () => ({ ...(await this.#validPlan(id, false)).plan, approvedAt: Date.now() }));
  }

  prepare(id: string, request: ConfirmProjectBuilderRequest) {
    return this.#mutate(id, "prepare", request, async () => {
      const { plan, context } = await this.#validPlan(id, true);
      await this.#bridge().prepareProjectApp(id, { planId: plan.id, templateId: plan.templateId, projectName: plan.projectName, brief: context.brief.fields, rules: context.rules });
      return plan;
    });
  }

  start(id: string, request: BuilderMutationRequest) {
    return this.#mutate(id, "start", request, async () => {
      const { plan } = await this.#validPlan(id, true);
      await this.#bridge().startProjectPreview(id, { planId: plan.id });
      return plan;
    });
  }

  stop(id: string, request: BuilderMutationRequest) {
    return this.#mutate(id, "stop", request, async () => { await this.#bridge().stopProjectPreview(id); return this.#row(id)?.plan ?? null; });
  }

  preview(id: string, request: ProjectPreviewRequest | { method: "GET"; path: "/" }) {
    this.deps.checkProject(id, request.method !== "GET");
    return this.#bridge().projectPreviewRequest(id, request);
  }

  analyze(id: string) {
    this.deps.checkProject(id, false);
    return this.#bridge().analyzeProjectWorkspace(id);
  }
}
