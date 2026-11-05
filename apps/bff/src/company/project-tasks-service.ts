import { createHash, randomUUID } from "node:crypto";
import type { AcceptProjectTaskRequest, AssignExecutorsRequest, BusinessRuleFields, CreateProjectTaskRequest, ProjectChecksRunResult, ProjectExecutorRole, ProjectExecutorsDto, ProjectFileChange, ProjectTaskActionRequest, ProjectTaskCheckDto, ProjectTaskDto, ProjectTaskReviewDto, ProjectTasksDto, ReturnProjectTaskRequest, RuleChangeImpactDto } from "@clawdesk/shared";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { acceptanceCases, acceptanceRevisions, acceptanceTestLinks, projectCheckResults, projectCheckRuns, projectRules, projectTaskEvents, projectTasks } from "../db/schema.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import { scenarioAutomatedStatus } from "./project-checks-service.js";
import type { ExecutorsPort } from "./project-executors.js";
import { changesBetween, developerBase, isTestFile, judgeDev, judgeQa, ruleTestsOf, testChangesBetween, type StageVerdict } from "./project-task-rules.js";
import type { RuleScope } from "./project-test-units.js";

// P6.2: a task on one approved rule version. QA writes tests in its copy; the panel accepts them only if
// they fail on the current code. The developer works on app + QA's tests; the panel accepts only if the
// test files are untouched and everything passes. The owner reviews the changes and accepts them into app/
// (on top of exactly the files the task started from) or returns the task to the developer.
// Stage completion is the owner's button: the panel never guesses that an agent has finished.
//
// P6.3: a task on a newer version of a rule the app already implements is a change. QA may rewrite the
// rule's own tests (named with its code or linked to its scenarios), never other tests; accepting needs
// the owner's word on existing data; a task whose rule changed again cannot be accepted; the latest
// accepted task can be rolled back to the files it started from.
//
// Review: when the project has a reviewer agent, the developer's accepted changes go to its own copy with
// REVIEW-REQUEST.md (rule, QA's tests, line diff); it writes REVIEW.md, the owner collects the verdict.
// The verdict is advice: the owner still accepts or returns, but accepting over "changes" needs their word.

export class ProjectTaskError extends Error {
  constructor(readonly code: "executors_required" | "rule_missing" | "rule_not_approved" | "task_active" | "task_missing" | "task_closed" | "revision_conflict" | "request_conflict" | "task_busy" | "gateway_unavailable" | "work_app_changed" | "rule_outdated" | "data_confirmation_required" | "rollback_unavailable" | "review_not_requested" | "review_not_written" | "review_changes_requested") { super(code); }
}

type Project = { id: string; name: string; description: string; departmentId: string | null };
type Rule = { id: string; code: string; version: number; fields: BusinessRuleFields; approvedAt: number | null };
type TaskRow = typeof projectTasks.$inferSelect;
export type TaskBridge = Pick<BridgeClient, "projectAppFiles" | "prepareProjectWork" | "snapshotProjectWork" | "runProjectChecks" | "applyProjectWork">;
const ACTIVE = ["qa", "dev", "review"] as const;
const FIELDS = ["title", "statement", "source", "role", "preconditions", "expectedResult", "exceptions", "allowedExample", "deniedExample", "openQuestions"] as const satisfies readonly (keyof BusinessRuleFields)[];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hashes = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha(data)]));
const code = (number: number) => `TASK-${String(number).padStart(3, "0")}`;
const ruleCode = (number: number) => `BR-${String(number).padStart(3, "0")}`;
/** The reviewer's copy: the developer's files plus these two, which never count as changes. */
export const REVIEW_REQUEST_FILE = "REVIEW-REQUEST.md", REVIEW_FILE = "REVIEW.md";
/** Work copies hold at most this much text (CHECK_PAYLOAD_LIMIT in the bridge). */
const COPY_LIMIT = 80_000;

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
    const rules = new Map(this.deps.db.select({ id: projectRules.id, number: projectRules.number, currentVersion: projectRules.currentVersion }).from(projectRules).where(eq(projectRules.projectId, projectId)).all().map(row => [row.id, row]));
    const active = rows.some(row => (ACTIVE as readonly string[]).includes(row.status));
    const rollbackable = active ? null : latestAccepted(rows);
    const scopes = new Map<string, RuleScope>();
    const scopeOf = (ruleId: string) => { if (!scopes.has(ruleId)) scopes.set(ruleId, this.#scope(projectId, ruleId)); return scopes.get(ruleId)!; };
    return {
      tasks: rows.map(row => {
        const rule = rules.get(row.ruleId);
        return this.#dto(row, events.filter(event => event.taskId === row.id), rule ? ruleCode(rule.number) : "BR-???", rule?.currentVersion ?? row.ruleVersion, row.id === rollbackable?.id, scopeOf);
      }),
    };
  }

  #dto(row: TaskRow, events: (typeof projectTaskEvents.$inferSelect)[], rule: string, currentVersion: number, canRollback: boolean, scopeOf: (ruleId: string) => RuleScope): ProjectTaskDto {
    const reviewing = row.status === "review" || row.status === "done";
    const reviewTests = reviewing ? testChangesBetween(row.baseFiles, row.devFiles ?? {}, scopeOf(row.ruleId)) : null;
    return {
      id: row.id, code: code(row.number), ruleId: row.ruleId, ruleCode: rule, ruleVersion: row.ruleVersion, previousVersion: row.previousVersion ?? null,
      outdated: (ACTIVE as readonly string[]).includes(row.status) && currentVersion !== row.ruleVersion,
      title: row.title, note: row.note, status: row.status, revision: row.revision,
      // Checks stored before P6.3 have no test-by-test changes.
      lastCheck: row.lastCheck ? { ...row.lastCheck, testChanges: row.lastCheck.testChanges ?? [], warnings: row.lastCheck.warnings ?? [] } : null,
      review: reviewing ? changesBetween(row.baseFiles, row.devFiles ?? {}) : null,
      reviewTests: reviewTests?.tests ?? null, reviewWarnings: reviewTests?.warnings ?? [],
      returnComment: row.returnComment, reviewRequestedAt: row.reviewRequestedAt ?? null, reviewer: row.reviewer ?? null, rolledBackAt: row.rolledBackAt ?? null, canRollback,
      events: events.map(event => ({ kind: event.kind, at: event.createdAt, note: event.note })), createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }

  /**
   * The tests a task on this rule may change: named with its code, or linked to any of its scenarios; tests
   * linked to another rule's current scenarios stay protected (see inRuleScope).
   */
  #scope(projectId: string, ruleId: string): RuleScope {
    const rules = this.deps.db.select().from(projectRules).where(eq(projectRules.projectId, projectId)).all();
    const own = rules.find(rule => rule.id === ruleId);
    const linked: string[] = [], otherLinked: string[] = [];
    if (!rules.length) return { code: own ? ruleCode(own.number) : "BR-???", linked, otherLinked };
    const cases = this.deps.db.select({ row: acceptanceCases, fields: acceptanceRevisions.fields }).from(acceptanceCases)
      .innerJoin(acceptanceRevisions, and(eq(acceptanceRevisions.caseId, acceptanceCases.id), eq(acceptanceRevisions.revision, acceptanceCases.revision)))
      .where(inArray(acceptanceCases.ruleId, rules.map(rule => rule.id))).all();
    const links = cases.length ? this.deps.db.select().from(acceptanceTestLinks).where(inArray(acceptanceTestLinks.caseId, cases.map(item => item.row.id))).all() : [];
    for (const { row, fields } of cases) {
      const mine = row.ruleId === ruleId;
      const current = rules.find(rule => rule.id === row.ruleId)?.currentVersion === row.ruleVersion;
      if (!mine && !current) continue;
      const target = mine ? linked : otherLinked;
      // Own scenarios: every revision's link (an older one may name the test of the old behaviour); others: the current revision.
      for (const link of links.filter(item => item.caseId === row.id && (mine || item.revision === row.revision))) target.push(link.testId);
      if (fields.testRef.trim()) target.push(fields.testRef.trim());
    }
    return { code: own ? ruleCode(own.number) : "BR-???", linked: [...new Set(linked)], otherLinked: [...new Set(otherLinked)] };
  }

  /** The rule version the app implements now: the latest accepted, not rolled back task on the rule. */
  #implemented(projectId: string, ruleId: string): TaskRow | null {
    const rows = this.deps.db.select().from(projectTasks).where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.ruleId, ruleId), eq(projectTasks.status, "done"))).all();
    return latestAccepted(rows);
  }

  /** Tests of the latest completed project run that belong to the rule. */
  #latestRuleTests(projectId: string, scope: RuleScope) {
    const run = this.deps.db.select().from(projectCheckRuns).where(and(eq(projectCheckRuns.projectId, projectId), eq(projectCheckRuns.status, "completed"))).orderBy(desc(projectCheckRuns.createdAt)).get();
    if (!run) return [];
    const results = this.deps.db.select().from(projectCheckResults).where(eq(projectCheckResults.runId, run.id)).all();
    return ruleTestsOf(results.map(row => ({ id: row.testId, file: row.file, name: row.name, status: row.status, message: row.message, fileHash: row.fileHash })), scope).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** P6.3: what a task on this rule version would change, for the owner before creating it. */
  impact(projectId: string, ruleId: string, version?: number): RuleChangeImpactDto {
    this.deps.checkProject(projectId, false);
    const current = this.deps.db.select().from(projectRules).where(and(eq(projectRules.id, ruleId), eq(projectRules.projectId, projectId))).get();
    if (!current) throw new ProjectTaskError("rule_missing");
    const rule = this.deps.rule(projectId, ruleId, version ?? current.currentVersion);
    if (!rule) throw new ProjectTaskError("rule_missing");
    const implemented = this.#implemented(projectId, ruleId);
    const previous = implemented && implemented.ruleVersion < rule.version ? this.deps.rule(projectId, ruleId, implemented.ruleVersion) : null;
    const scope = this.#scope(projectId, ruleId);
    const cases = this.deps.db.select({ row: acceptanceCases, fields: acceptanceRevisions.fields }).from(acceptanceCases)
      .innerJoin(acceptanceRevisions, and(eq(acceptanceRevisions.caseId, acceptanceCases.id), eq(acceptanceRevisions.revision, acceptanceCases.revision)))
      .where(eq(acceptanceCases.ruleId, ruleId)).orderBy(asc(acceptanceCases.number)).all();
    const active = this.deps.db.select({ number: projectTasks.number }).from(projectTasks).where(and(eq(projectTasks.projectId, projectId), inArray(projectTasks.status, [...ACTIVE]))).get();
    return {
      ruleId, code: rule.code, version: rule.version, approved: rule.approvedAt !== null, fields: rule.fields,
      previousVersion: previous?.version ?? null, previousFields: previous?.fields ?? null,
      changedFields: previous ? FIELDS.filter(field => previous.fields[field] !== rule.fields[field]) : [],
      implementedBy: implemented ? code(implemented.number) : null,
      files: implemented ? changesBetween(implemented.baseFiles, implemented.devFiles ?? {}).map(change => change.name) : [],
      tests: this.#latestRuleTests(projectId, scope).map(test => ({ id: test.id, name: test.name, status: test.status })),
      scenarios: previous ? cases.filter(item => item.row.ruleVersion === previous.version).map(({ row, fields }) => ({
        code: `AC-${String(row.number).padStart(3, "0")}`, title: fields.title, ruleVersion: row.ruleVersion, testRef: fields.testRef,
        status: scenarioAutomatedStatus(this.deps.db, projectId, row.id, row.revision, fields.testRef)?.status ?? null,
      })) : [],
      newScenarios: cases.filter(item => item.row.ruleVersion === rule.version).length,
      activeTask: active ? code(active.number) : null,
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

  #hasExecutor(projectId: string, role: ProjectExecutorRole): boolean {
    return this.deps.executors?.list(projectId).executors.some(item => item.role === role) ?? false;
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
    if (this.#outdated(projectId, { ruleId: rule.id, ruleVersion: rule.version })) throw new ProjectTaskError("rule_outdated");
    const qa = this.#executor(projectId, "qa");
    this.#executor(projectId, "developer");
    const { bridge, send } = this.#need();
    if (this.#busy.has(projectId)) throw new ProjectTaskError("task_busy");
    this.#busy.add(projectId);
    try {
      if (this.deps.db.select().from(projectTasks).where(and(eq(projectTasks.projectId, projectId), inArray(projectTasks.status, [...ACTIVE]))).get()) throw new ProjectTaskError("task_active");
      const implemented = this.#implemented(projectId, rule.id);
      const before = implemented && implemented.ruleVersion < rule.version ? this.deps.rule(projectId, rule.id, implemented.ruleVersion) : null;
      const { files } = await bridge.projectAppFiles(projectId);
      await bridge.prepareProjectWork(qa.agentId, files);
      const id = randomUUID(), now = Date.now();
      const last = this.deps.db.select({ number: projectTasks.number }).from(projectTasks).where(eq(projectTasks.projectId, projectId)).orderBy(desc(projectTasks.number)).get();
      const number = (last?.number ?? 0) + 1;
      this.deps.db.transaction((tx) => {
        tx.insert(projectTasks).values({ id, projectId, number, ruleId: rule.id, ruleVersion: rule.version, previousVersion: before?.version ?? null, title: rule.fields.title, note: request.note, status: "qa", baseFiles: files, createdAt: now, updatedAt: now, requestId: request.requestId }).run();
        tx.insert(projectTaskEvents).values({ taskId: id, kind: "created", note: before ? `change:${before.version}` : "", createdAt: now, requestId: request.requestId }).run();
      });
      const message = before ? changeQaMessage(code(number), before, rule, request.note, this.#latestRuleTests(projectId, this.#scope(projectId, rule.id)).map(test => test.name)) : qaMessage(code(number), rule, request.note);
      await this.#sendStage(projectId, id, "qa", qa.agentId, message, send);
      return this.#one(projectId, id);
    } finally { this.#busy.delete(projectId); }
  }

  async #sendStage(projectId: string, taskId: string, stage: ProjectExecutorRole, agentId: string, message: string, send: (agentId: string, message: string) => Promise<void>): Promise<void> {
    await send(agentId, message);
    this.deps.db.insert(projectTaskEvents).values({ taskId, kind: "sent", note: stage, createdAt: Date.now(), requestId: randomUUID() }).run();
  }

  /** Runs one action once per requestId on the task's current revision. */
  async #act(projectId: string, taskId: string, request: ProjectTaskActionRequest, writing: boolean, action: (row: TaskRow) => Promise<void>): Promise<ProjectTaskDto> {
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

  #save(row: TaskRow, patch: Partial<typeof projectTasks.$inferInsert>, event: { kind: (typeof projectTaskEvents.$inferInsert)["kind"]; note?: string; requestId: string }): void {
    this.deps.db.transaction((tx) => {
      const current = tx.select({ revision: projectTasks.revision }).from(projectTasks).where(eq(projectTasks.id, row.id)).get();
      if (current?.revision !== row.revision) throw new ProjectTaskError("revision_conflict");
      const now = Date.now();
      tx.update(projectTasks).set({ ...patch, revision: row.revision + 1, updatedAt: now }).where(eq(projectTasks.id, row.id)).run();
      tx.insert(projectTaskEvents).values({ taskId: row.id, kind: event.kind, note: event.note ?? "", createdAt: now, requestId: event.requestId }).run();
    });
  }

  #outdated(projectId: string, row: Pick<TaskRow, "ruleId" | "ruleVersion">): boolean {
    const rule = this.deps.db.select({ currentVersion: projectRules.currentVersion }).from(projectRules).where(and(eq(projectRules.id, row.ruleId), eq(projectRules.projectId, projectId))).get();
    return !rule || rule.currentVersion !== row.ruleVersion;
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
      const input = { base, next: snapshot.files, ignored: snapshot.ignored, run, scope: this.#scope(projectId, row.ruleId) };
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
        await this.#sendStage(projectId, row.id, "developer", this.#executor(projectId, "developer").agentId, devMessage(code(row.number), rule, row.note, verdict, row.previousVersion), send);
      } else {
        this.#save(row, { status: "review", devFiles: snapshot.files, lastCheck, reviewRequestedAt: null, reviewer: null }, { kind: "dev_checked", note: "ok", requestId: request.requestId });
        // With a reviewer agent the changes go to it at once; if that fails the owner can ask again.
        if (this.#hasExecutor(projectId, "reviewer")) {
          const next = this.#task(projectId, row.id);
          await this.#requestReview(projectId, next, rule, randomUUID()).catch(() => undefined);
        }
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

  /** Sends the developer's accepted changes to the reviewer agent (again, if it was asked before). */
  askReviewer(projectId: string, taskId: string, request: ProjectTaskActionRequest): Promise<ProjectTaskDto> {
    return this.#act(projectId, taskId, request, true, async (row) => {
      if (row.status !== "review" || !row.devFiles) throw new ProjectTaskError("task_closed");
      const rule = this.deps.rule(projectId, row.ruleId, row.ruleVersion);
      if (!rule) throw new ProjectTaskError("rule_missing");
      await this.#requestReview(projectId, row, rule, request.requestId);
    });
  }

  async #requestReview(projectId: string, row: TaskRow, rule: Rule, requestId: string): Promise<void> {
    const { bridge, send } = this.#need();
    const reviewer = this.#executor(projectId, "reviewer");
    const files = { ...row.devFiles! };
    delete files[REVIEW_FILE];
    files[REVIEW_REQUEST_FILE] = reviewRequest(code(row.number), rule, row, changesBetween(row.baseFiles, row.devFiles!), COPY_LIMIT - Object.values(files).reduce((size, data) => size + Buffer.byteLength(data), 0) - 64);
    await bridge.prepareProjectWork(reviewer.agentId, files);
    this.#save(row, { reviewRequestedAt: Date.now(), reviewer: null }, { kind: "review_requested", requestId });
    await this.#sendStage(projectId, row.id, "reviewer", reviewer.agentId, reviewMessage(code(row.number), rule), send);
  }

  /** Reads REVIEW.md from the reviewer's copy; files it edited are listed, never applied. */
  collectReview(projectId: string, taskId: string, request: ProjectTaskActionRequest): Promise<ProjectTaskDto> {
    return this.#act(projectId, taskId, request, true, async (row) => {
      if (row.status !== "review" || !row.devFiles) throw new ProjectTaskError("task_closed");
      if (row.reviewRequestedAt === null) throw new ProjectTaskError("review_not_requested");
      const { bridge } = this.#need();
      const snapshot = await bridge.snapshotProjectWork(this.#executor(projectId, "reviewer").agentId);
      const text = snapshot.files[REVIEW_FILE];
      if (text === undefined || !text.trim()) throw new ProjectTaskError("review_not_written");
      const review = parseReview(text, changedByReviewer(row.devFiles, snapshot.files));
      this.#save(row, { reviewer: review }, { kind: "reviewed", note: review.verdict, requestId: request.requestId });
    });
  }

  accept(projectId: string, taskId: string, request: AcceptProjectTaskRequest): Promise<ProjectTaskDto> {
    return this.#act(projectId, taskId, request, true, async (row) => {
      if (row.status !== "review" || !row.devFiles) throw new ProjectTaskError("task_closed");
      if (row.reviewer?.verdict === "changes" && request.overrideReview !== true) throw new ProjectTaskError("review_changes_requested");
      // A newer rule version means this work answers a question nobody asks any more.
      if (this.#outdated(projectId, row)) throw new ProjectTaskError("rule_outdated");
      // The panel changes code, never the app's data: the owner confirms the data still fits the changed rule.
      if (row.previousVersion !== null && request.confirmData !== true) throw new ProjectTaskError("data_confirmation_required");
      const { bridge } = this.#need();
      try { await bridge.applyProjectWork(projectId, row.devFiles, hashes(row.baseFiles)); }
      catch (error) {
        if ((error as { code?: string }).code === "work_app_changed") throw new ProjectTaskError("work_app_changed");
        throw error;
      }
      this.#save(row, { status: "done" }, { kind: "accepted", note: row.previousVersion !== null ? "data_confirmed" : "", requestId: request.requestId });
    });
  }

  /**
   * Returns app/ to the files the latest accepted task started from — only while app/ holds exactly what
   * that task wrote and no task is active. The rule's previous version becomes the implemented one again.
   */
  rollback(projectId: string, taskId: string, request: ProjectTaskActionRequest): Promise<ProjectTaskDto> {
    return this.#act(projectId, taskId, request, true, async (row) => {
      const rows = this.deps.db.select().from(projectTasks).where(and(eq(projectTasks.projectId, projectId), ne(projectTasks.status, "cancelled"))).all();
      if (row.status !== "done" || !row.devFiles || row.rolledBackAt !== null || rows.some(item => (ACTIVE as readonly string[]).includes(item.status)) || latestAccepted(rows)?.id !== row.id) throw new ProjectTaskError("rollback_unavailable");
      const { bridge } = this.#need();
      try { await bridge.applyProjectWork(projectId, row.baseFiles, hashes(row.devFiles)); }
      catch (error) {
        if ((error as { code?: string }).code === "work_app_changed") throw new ProjectTaskError("work_app_changed");
        throw error;
      }
      this.#save(row, { rolledBackAt: Date.now() }, { kind: "rolled_back", requestId: request.requestId });
    });
  }

  returnToDeveloper(projectId: string, taskId: string, request: ReturnProjectTaskRequest): Promise<ProjectTaskDto> {
    return this.#act(projectId, taskId, request, true, async (row) => {
      if (row.status !== "review") throw new ProjectTaskError("task_closed");
      const { send } = this.#need();
      const rule = this.deps.rule(projectId, row.ruleId, row.ruleVersion);
      if (!rule) throw new ProjectTaskError("rule_missing");
      this.#save(row, { status: "dev", returnComment: request.comment, devFiles: null, reviewRequestedAt: null, reviewer: null }, { kind: "returned", note: request.comment, requestId: request.requestId });
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

/** The accepted task whose files app/ holds now: done, not rolled back, accepted last. */
function latestAccepted(rows: TaskRow[]): TaskRow | null {
  return rows.filter(row => row.status === "done" && row.rolledBackAt === null).sort((a, b) => b.updatedAt - a.updatedAt || b.number - a.number)[0] ?? null;
}

function checkDto(stage: "qa" | "dev", verdict: StageVerdict, run: ProjectChecksRunResult, ignored: string[]): ProjectTaskCheckDto {
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const test of run.tests) counts[test.status]++;
  return {
    stage, ok: verdict.ok, reasons: verdict.reasons, changes: verdict.changes, ruleTests: verdict.ruleTests, otherProblems: verdict.otherProblems, testChanges: verdict.testChanges, warnings: verdict.warnings, ignored,
    run: { id: "", status: run.status, reason: run.reason, createdAt: Date.now(), durationMs: Math.round(run.durationMs), counts, isolation: run.isolation ?? null }, at: Date.now(),
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

/** P6.3: the rule changed after the app implemented it; QA replaces the tests of the old behaviour. */
export function changeQaMessage(task: string, before: Rule, rule: Rule, note: string, ruleTests: string[]): string {
  return [
    `Задача ${task} — изменение правила ${rule.code}: версия ${before.version} → ${rule.version}.`,
    "Было:",
    ruleText(before),
    "",
    "Стало:",
    ruleText(rule),
    note ? `Комментарий владельца: ${note}` : null,
    "",
    ruleTests.length ? `Сейчас правило защищают тесты: ${ruleTests.join("; ")}.` : "Тестов, которые сейчас защищают это правило, панель не нашла.",
    "Что сделать: в своей рабочей копии приведи тесты этого правила к новой версии — измени или удали те, что проверяют старое поведение, добавь проверки нового (разрешённый и запрещённый примеры, границы).",
    `Имя каждого нового теста начинается с «${rule.code} ». Хотя бы один тест правила должен падать на текущем коде, потому что код ещё делает по-старому.`,
    "Тесты других правил и общий код тестов (импорты, помощники, before/after) не меняй — панель сравнивает их побайтно; новые помощники добавлять можно. Код приложения не трогай.",
    "Когда закончишь, кратко перечисли, какие тесты изменены, удалены и добавлены. Проверит панель.",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function devMessage(task: string, rule: Rule, note: string, verdict: StageVerdict, previousVersion: number | null): string {
  return [
    previousVersion !== null ? `Задача ${task} — реализация изменения правила (версия ${previousVersion} → ${rule.version}).` : `Задача ${task} — реализация правила.`,
    ruleText(rule),
    note ? `Комментарий владельца: ${note}` : null,
    "",
    `QA добавил тесты, которые сейчас падают: ${verdict.ruleTests.filter(test => test.status === "failed").map(test => test.name).join("; ")}.`,
    "Что сделать: в своей рабочей копии измени код приложения так, чтобы прошли все тесты, включая эти.",
    previousVersion !== null ? "Данные, которые уже есть в приложении, не переноси и не удаляй: миграцию данных владелец решает отдельно." : null,
    "Тесты не меняй, не удаляй и не добавляй; файлы приложения не удаляй. Когда закончишь, кратко опиши изменения. Проверит панель.",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

/** REVIEW-REQUEST.md: the rule, QA's tests and the changes line by line, cut to fit the copy. */
export function reviewRequest(task: string, rule: Rule, row: Pick<TaskRow, "qaTests" | "previousVersion">, changes: ProjectFileChange[], limit: number): string {
  const head = [
    `# Ревью задачи ${task}`, "",
    row.previousVersion !== null ? `Изменение правила: версия ${row.previousVersion} → ${rule.version}.` : "Реализация нового правила.",
    "", ruleText(rule), "",
    `Тесты QA: ${Object.keys(row.qaTests ?? {}).sort().join(", ") || "—"}. Все тесты проекта проходят.`, "",
    "## Изменения", "",
  ].join("\n");
  const body = changes.map(change => `### ${change.name} — ${change.change === "added" ? "добавлен" : change.change === "removed" ? "удалён" : "изменён"}\n${change.diff === null ? (change.change === "removed" ? "" : "(слишком большой для построчного сравнения — читай файл целиком)") : "```diff\n" + change.diff + "\n```"}`).join("\n\n");
  const full = head + body + "\n";
  if (Buffer.byteLength(full) <= limit) return full;
  const note = "\n\n… изменения обрезаны: остальное смотри в файлах копии.\n";
  let cut = full.slice(0, Math.max(0, limit - Buffer.byteLength(note)));
  while (cut && Buffer.byteLength(cut) > limit - Buffer.byteLength(note)) cut = cut.slice(0, -100);
  return cut + note;
}

function reviewMessage(task: string, rule: Rule): string {
  return [
    `Задача ${task} — ревью изменений по правилу ${rule.code} «${rule.fields.title}».`,
    `В твоей рабочей копии файлы приложения после изменений разработчика и ${REVIEW_REQUEST_FILE} — правило, тесты QA и изменения построчно. Все тесты проходят.`,
    `Прочитай изменения и запиши отзыв в ${REVIEW_FILE}: первая строка — ОДОБРЕНО или НУЖНЫ ИЗМЕНЕНИЯ, дальше замечания (файл, что не так, почему важно). Код и тесты не меняй.`,
    "Когда закончишь, ответь одной фразой с вердиктом.",
  ].join("\n");
}

/** The verdict from the first non-empty line of REVIEW.md; anything but the two phrases is "unclear". */
export function parseReview(text: string, changedFiles: string[]): ProjectTaskReviewDto {
  const lines = text.replace(/\r/g, "").split("\n");
  const first = lines.findIndex(line => line.trim());
  const head = (lines[first] ?? "").trim().replace(/^[#*\s]+|[*.!:\s]+$/g, "").toUpperCase();
  const verdict = /^(ОДОБРЕНО|APPROVED?)$/.test(head) ? "approve" : /^(НУЖНЫ ИЗМЕНЕНИЯ|CHANGES REQUESTED|CHANGES)$/.test(head) ? "changes" : "unclear";
  const comment = (verdict === "unclear" ? lines.slice(first) : lines.slice(first + 1)).join("\n").trim().slice(0, 4000);
  return { verdict, comment, changedFiles, at: Date.now() };
}

/** Files the reviewer added, changed or removed in its copy, besides the two review files. */
export function changedByReviewer(devFiles: Record<string, string>, copy: Record<string, string>): string[] {
  const skip = new Set([REVIEW_FILE, REVIEW_REQUEST_FILE]);
  const names = new Set([...Object.keys(devFiles), ...Object.keys(copy)].filter(name => !skip.has(name)));
  return [...names].filter(name => devFiles[name] !== copy[name]).sort();
}

function returnMessage(task: string, rule: Rule, comment: string): string {
  return [`Задача ${task}: владелец вернул работу по правилу ${rule.code}.`, `Комментарий: ${comment}`, "Исправь это в своей рабочей копии, тесты не меняй, и кратко опиши изменения."].join("\n");
}

const REASON_TEXT: Record<string, string> = {
  layout: "в рабочей копии есть подпапки или ссылки — держи файлы плоско",
  no_changes: "изменений нет",
  removed_files: "удалены файлы",
  changed_code: "изменён код приложения — на этапе QA можно менять только *.test.mjs",
  tests_missing: "нет тестов этого правила (имя начинается с кода правила)",
  tests_not_failing: "ни один тест правила не падает на текущем коде",
  tests_flaky: "тест правила нестабилен",
  existing_failing: "другие тесты перестали проходить",
  changed_tests: "изменены тесты — на этапе разработки их менять нельзя",
  tests_failing: "не все тесты проходят",
  run_blocked: "прогон проверок не дал результата (сбой среды)",
  protected_tests_changed: "изменены или удалены тесты других правил — их менять нельзя",
  shared_test_code_changed: "изменён общий код тестов (импорты, помощники, before/after) — его менять нельзя, новый добавлять можно",
  tests_unreadable: "файл тестов не разбирается как JavaScript-модуль",
  tests_not_separate: "тесты запускают приложение сами — бери адрес приложения из CLAWDESK_APP_URL, как в checks.test.mjs, чтобы панель запускала его отдельно",
};

function findingsMessage(task: string, rule: Rule, check: ProjectTaskCheckDto | null): string {
  if (!check || check.ok) return [`Напоминание по задаче ${task} (правило ${rule.code}).`, ruleText(rule)].join("\n");
  const failing = [...check.ruleTests, ...check.otherProblems].filter(test => test.status !== "passed").slice(0, 8).map(test => `- ${test.name}: ${test.status}${test.message ? ` — ${test.message.split("\n")[0]}` : ""}`);
  const touched = (check.testChanges ?? []).filter(change => !change.rule && change.change !== "added").slice(0, 8).map(change => `- ${change.name}: ${change.change === "removed" ? "удалён" : "изменён"}`);
  return [
    `Задача ${task} (правило ${rule.code}): панель не приняла работу.`, ...check.reasons.map(reason => `- ${REASON_TEXT[reason] ?? reason}`),
    ...(failing.length ? ["Тесты:", ...failing] : []), ...(touched.length ? ["Верни как было:", ...touched] : []),
    "Исправь это в своей рабочей копии и кратко ответь, что изменено.",
  ].join("\n");
}
