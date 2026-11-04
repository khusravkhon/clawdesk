import { createHash, randomUUID } from "node:crypto";
import type { AssignExecutorsRequest, BusinessRuleFields, CreateProjectTaskRequest, ProjectChecksRunResult, ProjectExecutorRole, ProjectExecutorsDto, ProjectTaskActionRequest, ProjectTaskCheckDto, ProjectTaskDto, ProjectTasksDto, ReturnProjectTaskRequest } from "@clawdesk/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { projectRules, projectTaskEvents, projectTasks } from "../db/schema.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import type { ExecutorsPort } from "./project-executors.js";
import { changesBetween, developerBase, isTestFile, judgeDev, judgeQa, type StageVerdict } from "./project-task-rules.js";

// P6.2: a task on one approved rule version. QA writes tests in its copy; the panel accepts them only if
// they fail on the current code. The developer works on app + QA's tests; the panel accepts only if the
// test files are untouched and everything passes. The owner reviews the changes and accepts them into app/
// (on top of exactly the files the task started from) or returns the task to the developer.
// Stage completion is the owner's button: the panel never guesses that an agent has finished.

export class ProjectTaskError extends Error {
  constructor(readonly code: "executors_required" | "rule_missing" | "rule_not_approved" | "task_active" | "task_missing" | "task_closed" | "revision_conflict" | "request_conflict" | "task_busy" | "gateway_unavailable" | "work_app_changed") { super(code); }
}

type Project = { id: string; name: string; description: string; departmentId: string | null };
type Rule = { id: string; code: string; version: number; fields: BusinessRuleFields; approvedAt: number | null };
export type TaskBridge = Pick<BridgeClient, "projectAppFiles" | "prepareProjectWork" | "snapshotProjectWork" | "runProjectChecks" | "applyProjectWork">;
const ACTIVE = ["qa", "dev", "review"] as const;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const code = (number: number) => `TASK-${String(number).padStart(3, "0")}`;

export class ProjectTasksService {
  #busy = new Set<string>();
  constructor(private readonly deps: {
    db: Db;
    checkProject: (id: string, writing: boolean) => Project;
    rule: (projectId: string, ruleId: string, version: number) => Rule | null;
    executors?: ExecutorsPort;
    bridge?: TaskBridge;
    send?: (agentId: string, message: string) => Promise<void>;
  }) {}

  executors(projectId: string): ProjectExecutorsDto {
    this.deps.checkProject(projectId, false);
    return this.deps.executors?.list(projectId) ?? { teamId: null, executors: [], sandboxed: false };
  }

  assignExecutors(projectId: string, request: AssignExecutorsRequest): Promise<ProjectExecutorsDto> {
    const project = this.deps.checkProject(projectId, true);
    if (!this.deps.executors) throw new ProjectTaskError("gateway_unavailable");
    return this.deps.executors.assign(project, request);
  }

  list(projectId: string): ProjectTasksDto {
    this.deps.checkProject(projectId, false);
    const rows = this.deps.db.select().from(projectTasks).where(eq(projectTasks.projectId, projectId)).orderBy(desc(projectTasks.number)).all();
    const events = rows.length ? this.deps.db.select().from(projectTaskEvents).where(inArray(projectTaskEvents.taskId, rows.map(row => row.id))).orderBy(asc(projectTaskEvents.id)).all() : [];
    const codes = new Map(this.deps.db.select({ id: projectRules.id, number: projectRules.number }).from(projectRules).where(eq(projectRules.projectId, projectId)).all().map(row => [row.id, `BR-${String(row.number).padStart(3, "0")}`]));
    return { tasks: rows.map(row => this.#dto(row, events.filter(event => event.taskId === row.id), codes.get(row.ruleId) ?? "BR-???")) };
  }

  #dto(row: typeof projectTasks.$inferSelect, events: (typeof projectTaskEvents.$inferSelect)[], ruleCode: string): ProjectTaskDto {
    return {
      id: row.id, code: code(row.number), ruleId: row.ruleId, ruleCode, ruleVersion: row.ruleVersion, title: row.title, note: row.note, status: row.status, revision: row.revision,
      lastCheck: row.lastCheck ?? null,
      review: row.status === "review" || row.status === "done" ? changesBetween(row.baseFiles, row.devFiles ?? {}) : null,
      returnComment: row.returnComment, events: events.map(event => ({ kind: event.kind, at: event.createdAt, note: event.note })), createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }

  #task(projectId: string, taskId: string) {
    const row = this.deps.db.select().from(projectTasks).where(and(eq(projectTasks.id, taskId), eq(projectTasks.projectId, projectId))).get();
    if (!row) throw new ProjectTaskError("task_missing");
    return row;
  }

  #one(projectId: string, taskId: string): ProjectTaskDto {
    return this.list(projectId).tasks.find(task => task.id === taskId)!;
  }

  #executor(projectId: string, role: ProjectExecutorRole) {
    const executor = this.deps.executors?.list(projectId).executors.find(item => item.role === role);
    if (!executor) throw new ProjectTaskError("executors_required");
    return executor;
  }

  #need() {
    if (!this.deps.bridge || !this.deps.send) throw new ProjectTaskError("gateway_unavailable");
    return { bridge: this.deps.bridge, send: this.deps.send };
  }

  async create(projectId: string, request: CreateProjectTaskRequest): Promise<ProjectTaskDto> {
    this.deps.checkProject(projectId, true);
    const previous = this.deps.db.select().from(projectTasks).where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.requestId, request.requestId))).get();
    if (previous) {
      if (previous.ruleId !== request.ruleId || previous.ruleVersion !== request.ruleVersion || previous.note !== request.note) throw new ProjectTaskError("request_conflict");
      return this.#one(projectId, previous.id);
    }
    const rule = this.deps.rule(projectId, request.ruleId, request.ruleVersion);
    if (!rule) throw new ProjectTaskError("rule_missing");
    if (rule.approvedAt === null) throw new ProjectTaskError("rule_not_approved");
    const qa = this.#executor(projectId, "qa");
    this.#executor(projectId, "developer");
    const { bridge, send } = this.#need();
    if (this.#busy.has(projectId)) throw new ProjectTaskError("task_busy");
    this.#busy.add(projectId);
    try {
      if (this.deps.db.select().from(projectTasks).where(and(eq(projectTasks.projectId, projectId), inArray(projectTasks.status, [...ACTIVE]))).get()) throw new ProjectTaskError("task_active");
      const { files } = await bridge.projectAppFiles(projectId);
      await bridge.prepareProjectWork(qa.agentId, files);
      const id = randomUUID(), now = Date.now();
      const last = this.deps.db.select({ number: projectTasks.number }).from(projectTasks).where(eq(projectTasks.projectId, projectId)).orderBy(desc(projectTasks.number)).get();
      const number = (last?.number ?? 0) + 1;
      this.deps.db.transaction((tx) => {
        tx.insert(projectTasks).values({ id, projectId, number, ruleId: rule.id, ruleVersion: rule.version, title: rule.fields.title, note: request.note, status: "qa", baseFiles: files, createdAt: now, updatedAt: now, requestId: request.requestId }).run();
        tx.insert(projectTaskEvents).values({ taskId: id, kind: "created", note: "", createdAt: now, requestId: request.requestId }).run();
      });
      await this.#sendStage(projectId, id, "qa", qa.agentId, qaMessage(code(number), rule, request.note), send);
      return this.#one(projectId, id);
    } finally { this.#busy.delete(projectId); }
  }

  async #sendStage(projectId: string, taskId: string, stage: ProjectExecutorRole, agentId: string, message: string, send: (agentId: string, message: string) => Promise<void>): Promise<void> {
    await send(agentId, message);
    this.deps.db.insert(projectTaskEvents).values({ taskId, kind: "sent", note: stage, createdAt: Date.now(), requestId: randomUUID() }).run();
  }

  /** Runs one action once per requestId on the task's current revision. */
  async #act(projectId: string, taskId: string, request: ProjectTaskActionRequest, writing: boolean, action: (row: typeof projectTasks.$inferSelect) => Promise<void>): Promise<ProjectTaskDto> {
    this.deps.checkProject(projectId, writing);
    const row = this.#task(projectId, taskId);
    if (this.deps.db.select().from(projectTaskEvents).where(and(eq(projectTaskEvents.taskId, taskId), eq(projectTaskEvents.requestId, request.requestId))).get()) return this.#one(projectId, taskId);
    if (row.revision !== request.revision) throw new ProjectTaskError("revision_conflict");
    if (this.#busy.has(projectId)) throw new ProjectTaskError("task_busy");
    this.#busy.add(projectId);
    try { await action(row); }
    finally { this.#busy.delete(projectId); }
    return this.#one(projectId, taskId);
  }

  #save(row: typeof projectTasks.$inferSelect, patch: Partial<typeof projectTasks.$inferInsert>, event: { kind: (typeof projectTaskEvents.$inferInsert)["kind"]; note?: string; requestId: string }): void {
    this.deps.db.transaction((tx) => {
      const current = tx.select({ revision: projectTasks.revision }).from(projectTasks).where(eq(projectTasks.id, row.id)).get();
      if (current?.revision !== row.revision) throw new ProjectTaskError("revision_conflict");
      const now = Date.now();
      tx.update(projectTasks).set({ ...patch, revision: row.revision + 1, updatedAt: now }).where(eq(projectTasks.id, row.id)).run();
      tx.insert(projectTaskEvents).values({ taskId: row.id, kind: event.kind, note: event.note ?? "", createdAt: now, requestId: event.requestId }).run();
    });
  }

  /** "Check the QA's work" or "check the developer's work", depending on the task's stage. */
  checkStage(projectId: string, taskId: string, request: ProjectTaskActionRequest): Promise<ProjectTaskDto> {
    return this.#act(projectId, taskId, request, true, async (row) => {
      if (row.status !== "qa" && row.status !== "dev") throw new ProjectTaskError("task_closed");
      const { bridge, send } = this.#need();
      const rule = this.deps.rule(projectId, row.ruleId, row.ruleVersion);
      if (!rule) throw new ProjectTaskError("rule_missing");
      const stage = row.status;
      const role: ProjectExecutorRole = stage === "qa" ? "qa" : "developer";
      const snapshot = await bridge.snapshotProjectWork(this.#executor(projectId, role).agentId);
      const base = stage === "qa" ? row.baseFiles : developerBase(row.baseFiles, row.qaTests ?? {});
      const run = await bridge.runProjectChecks(projectId, snapshot.files);
      const input = { base, next: snapshot.files, ignored: snapshot.ignored, run, ruleCode: rule.code };
      const verdict = stage === "qa" ? judgeQa(input) : judgeDev(input);
      const lastCheck = checkDto(stage, verdict, run, snapshot.ignored);
      if (!verdict.ok) {
        this.#save(row, { lastCheck }, { kind: stage === "qa" ? "qa_checked" : "dev_checked", note: verdict.reasons.join(","), requestId: request.requestId });
        return;
      }
      if (stage === "qa") {
        const qaTests = Object.fromEntries(Object.entries(snapshot.files).filter(([name]) => isTestFile(name) && row.baseFiles[name] !== snapshot.files[name]));
        await bridge.prepareProjectWork(this.#executor(projectId, "developer").agentId, developerBase(row.baseFiles, qaTests));
        this.#save(row, { status: "dev", qaTests, lastCheck }, { kind: "qa_checked", note: "ok", requestId: request.requestId });
        await this.#sendStage(projectId, row.id, "developer", this.#executor(projectId, "developer").agentId, devMessage(code(row.number), rule, row.note, verdict), send);
      } else {
        this.#save(row, { status: "review", devFiles: snapshot.files, lastCheck }, { kind: "dev_checked", note: "ok", requestId: request.requestId });
      }
    });
  }

  /** Sends the current stage's assignment again, with the panel's last findings if there were any. */
  resend(projectId: string, taskId: string, request: ProjectTaskActionRequest): Promise<ProjectTaskDto> {
    return this.#act(projectId, taskId, request, true, async (row) => {
      if (row.status !== "qa" && row.status !== "dev") throw new ProjectTaskError("task_closed");
      const { send } = this.#need();
      const rule = this.deps.rule(projectId, row.ruleId, row.ruleVersion);
      if (!rule) throw new ProjectTaskError("rule_missing");
      const role: ProjectExecutorRole = row.status === "qa" ? "qa" : "developer";
      await send(this.#executor(projectId, role).agentId, findingsMessage(code(row.number), rule, row.lastCheck));
      this.#save(row, {}, { kind: "sent", note: role, requestId: request.requestId });
    });
  }

  accept(projectId: string, taskId: string, request: ProjectTaskActionRequest): Promise<ProjectTaskDto> {
    return this.#act(projectId, taskId, request, true, async (row) => {
      if (row.status !== "review" || !row.devFiles) throw new ProjectTaskError("task_closed");
      const { bridge } = this.#need();
      const baseline = Object.fromEntries(Object.entries(row.baseFiles).map(([name, data]) => [name, sha(data)]));
      try { await bridge.applyProjectWork(projectId, row.devFiles, baseline); }
      catch (error) {
        if ((error as { code?: string }).code === "work_app_changed") throw new ProjectTaskError("work_app_changed");
        throw error;
      }
      this.#save(row, { status: "done" }, { kind: "accepted", requestId: request.requestId });
    });
  }

  returnToDeveloper(projectId: string, taskId: string, request: ReturnProjectTaskRequest): Promise<ProjectTaskDto> {
    return this.#act(projectId, taskId, request, true, async (row) => {
      if (row.status !== "review") throw new ProjectTaskError("task_closed");
      const { send } = this.#need();
      const rule = this.deps.rule(projectId, row.ruleId, row.ruleVersion);
      if (!rule) throw new ProjectTaskError("rule_missing");
      this.#save(row, { status: "dev", returnComment: request.comment, devFiles: null }, { kind: "returned", note: request.comment, requestId: request.requestId });
      await this.#sendStage(projectId, row.id, "developer", this.#executor(projectId, "developer").agentId, returnMessage(code(row.number), rule, request.comment), send);
    });
  }

  cancel(projectId: string, taskId: string, request: ProjectTaskActionRequest): Promise<ProjectTaskDto> {
    return this.#act(projectId, taskId, request, false, async (row) => {
      if (row.status === "done" || row.status === "cancelled") throw new ProjectTaskError("task_closed");
      this.#save(row, { status: "cancelled" }, { kind: "cancelled", requestId: request.requestId });
    });
  }
}

function checkDto(stage: "qa" | "dev", verdict: StageVerdict, run: ProjectChecksRunResult, ignored: string[]): ProjectTaskCheckDto {
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const test of run.tests) counts[test.status]++;
  return {
    stage, ok: verdict.ok, reasons: verdict.reasons, changes: verdict.changes, ruleTests: verdict.ruleTests, otherProblems: verdict.otherProblems, ignored,
    run: { id: "", status: run.status, reason: run.reason, createdAt: Date.now(), durationMs: Math.round(run.durationMs), counts }, at: Date.now(),
  };
}

function ruleText(rule: Rule): string {
  const f = rule.fields;
  return [
    `Правило ${rule.code} (версия ${rule.version}): «${f.title}»`,
    `Формулировка: ${f.statement}`,
    f.role && `Кто: ${f.role}`,
    f.preconditions && `Предусловия: ${f.preconditions}`,
    f.expectedResult && `Ожидаемый результат: ${f.expectedResult}`,
    f.exceptions && `Исключения: ${f.exceptions}`,
    f.allowedExample && `Разрешённый пример: ${f.allowedExample}`,
    f.deniedExample && `Запрещённый пример: ${f.deniedExample}`,
  ].filter(Boolean).join("\n");
}

export function qaMessage(task: string, rule: Rule, note: string): string {
  return [
    `Задача ${task} — тесты к правилу.`,
    ruleText(rule),
    note ? `Комментарий владельца: ${note}` : null,
    "",
    "Что сделать: в своей рабочей копии напиши тесты, которые проверяют это правило (разрешённый и запрещённый примеры, границы, исключения).",
    `Имя каждого нового теста начинается с «${rule.code} ». Хотя бы один из них должен падать на текущем коде именно потому, что правило ещё не выполнено.`,
    "Меняй только файлы *.test.mjs, код приложения не трогай, существующие тесты не удаляй и не ослабляй.",
    "Когда закончишь, кратко перечисли добавленные тесты. Проверит панель.",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function devMessage(task: string, rule: Rule, note: string, verdict: StageVerdict): string {
  return [
    `Задача ${task} — реализация правила.`,
    ruleText(rule),
    note ? `Комментарий владельца: ${note}` : null,
    "",
    `QA добавил тесты, которые сейчас падают: ${verdict.ruleTests.filter(test => test.status === "failed").map(test => test.name).join("; ")}.`,
    "Что сделать: в своей рабочей копии измени код приложения так, чтобы прошли все тесты, включая эти.",
    "Тесты не меняй, не удаляй и не добавляй; файлы приложения не удаляй. Когда закончишь, кратко опиши изменения. Проверит панель.",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function returnMessage(task: string, rule: Rule, comment: string): string {
  return [`Задача ${task}: владелец вернул работу по правилу ${rule.code}.`, `Комментарий: ${comment}`, "Исправь это в своей рабочей копии, тесты не меняй, и кратко опиши изменения."].join("\n");
}

const REASON_TEXT: Record<string, string> = {
  layout: "в рабочей копии есть подпапки или ссылки — держи файлы плоско",
  no_changes: "изменений нет",
  removed_files: "удалены файлы",
  changed_code: "изменён код приложения — на этапе QA можно менять только *.test.mjs",
  tests_missing: "нет тестов, имя которых начинается с кода правила",
  tests_not_failing: "ни один тест правила не падает на текущем коде",
  tests_flaky: "тест правила нестабилен",
  existing_failing: "другие тесты перестали проходить",
  changed_tests: "изменены тесты — на этапе разработки их менять нельзя",
  tests_failing: "не все тесты проходят",
  run_blocked: "прогон проверок не дал результата (сбой среды)",
};

function findingsMessage(task: string, rule: Rule, check: ProjectTaskCheckDto | null): string {
  if (!check || check.ok) return [`Напоминание по задаче ${task} (правило ${rule.code}).`, ruleText(rule)].join("\n");
  const failing = [...check.ruleTests, ...check.otherProblems].filter(test => test.status !== "passed").slice(0, 8).map(test => `- ${test.name}: ${test.status}${test.message ? ` — ${test.message.split("\n")[0]}` : ""}`);
  return [`Задача ${task} (правило ${rule.code}): панель не приняла работу.`, ...check.reasons.map(reason => `- ${REASON_TEXT[reason] ?? reason}`), ...(failing.length ? ["Тесты:", ...failing] : []), "Исправь это в своей рабочей копии и кратко ответь, что изменено."].join("\n");
}
