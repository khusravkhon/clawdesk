import { randomUUID } from "node:crypto";
import type { ApproveBusinessRuleRequest, BusinessRuleDto, BusinessRuleVersionDto, CreateBusinessRuleRequest, UpdateBusinessRuleRequest } from "@clawdesk/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { projectRules, projectRuleVersions } from "../db/schema.js";

export class ProjectRuleError extends Error {
  constructor(readonly code: "rule_missing" | "request_conflict" | "revision_conflict" | "rule_unchanged" | "rule_incomplete" | "rule_already_approved") { super(code); }
}
const versionDto = (row: typeof projectRuleVersions.$inferSelect): BusinessRuleVersionDto => ({ version: row.version, fields: row.fields, createdAt: row.createdAt, createdBy: row.createdBy, approvedAt: row.approvedAt, approvedBy: row.approvedBy });

/** Approval records the owner's meaning; it never grants execution access or proves application behavior. */
export class ProjectRulesService {
  constructor(private readonly deps: { db: Db; checkProject: (id: string, writing: boolean) => unknown }) {}

  #rule(projectId: string, id: string) {
    const row = this.deps.db.select().from(projectRules).where(and(eq(projectRules.id, id), eq(projectRules.projectId, projectId))).get();
    if (!row) throw new ProjectRuleError("rule_missing");
    return row;
  }

  #current(row: typeof projectRules.$inferSelect): BusinessRuleDto {
    const version = this.deps.db.select().from(projectRuleVersions).where(and(eq(projectRuleVersions.ruleId, row.id), eq(projectRuleVersions.version, row.currentVersion))).get();
    if (!version) throw new ProjectRuleError("rule_missing");
    return { id: row.id, code: `BR-${String(row.number).padStart(3, "0")}`, revision: row.revision, ...versionDto(version) };
  }

  list(projectId: string): { rules: BusinessRuleDto[] } {
    this.deps.checkProject(projectId, false);
    const rows = this.deps.db.select({ rule: projectRules, version: projectRuleVersions }).from(projectRules)
      .innerJoin(projectRuleVersions, and(eq(projectRuleVersions.ruleId, projectRules.id), eq(projectRuleVersions.version, projectRules.currentVersion)))
      .where(eq(projectRules.projectId, projectId)).orderBy(asc(projectRules.number)).all();
    return { rules: rows.map(({ rule, version }) => ({ id: rule.id, code: `BR-${String(rule.number).padStart(3, "0")}`, revision: rule.revision, ...versionDto(version) })) };
  }

  history(projectId: string, id: string): { versions: BusinessRuleVersionDto[] } {
    this.deps.checkProject(projectId, false); this.#rule(projectId, id);
    const rows = this.deps.db.select().from(projectRuleVersions).where(eq(projectRuleVersions.ruleId, id)).orderBy(desc(projectRuleVersions.version)).all();
    return { versions: rows.map(versionDto) };
  }

  create(projectId: string, request: CreateBusinessRuleRequest): BusinessRuleDto {
    return this.deps.db.transaction((tx) => {
      this.deps.checkProject(projectId, true);
      const payload = JSON.stringify(request);
      const before = tx.select().from(projectRules).where(and(eq(projectRules.projectId, projectId), eq(projectRules.requestId, request.requestId))).get();
      if (before) {
        if (before.requestPayload !== payload) throw new ProjectRuleError("request_conflict");
        return this.#current(before);
      }
      const last = tx.select().from(projectRules).where(eq(projectRules.projectId, projectId)).orderBy(desc(projectRules.number)).get();
      const id = randomUUID();
      tx.insert(projectRules).values({ id, projectId, number: (last?.number ?? 0) + 1, requestId: request.requestId, requestPayload: payload }).run();
      tx.insert(projectRuleVersions).values({ ruleId: id, version: 1, fields: request.fields, createdAt: Date.now(), createdBy: "owner", requestId: request.requestId, requestPayload: payload }).run();
      return this.#current(this.#rule(projectId, id));
    });
  }

  update(projectId: string, id: string, request: UpdateBusinessRuleRequest): BusinessRuleDto {
    return this.deps.db.transaction((tx) => {
      this.deps.checkProject(projectId, true);
      const row = this.#rule(projectId, id);
      const payload = JSON.stringify(request);
      const previous = tx.select().from(projectRuleVersions).where(and(eq(projectRuleVersions.ruleId, id), eq(projectRuleVersions.requestId, request.requestId))).get();
      if (previous) {
        if (previous.requestPayload !== payload) throw new ProjectRuleError("request_conflict");
        if (row.currentVersion !== previous.version) throw new ProjectRuleError("revision_conflict");
        return this.#current(row);
      }
      if (row.revision !== request.revision) throw new ProjectRuleError("revision_conflict");
      if (JSON.stringify(this.#current(row).fields) === JSON.stringify(request.fields)) throw new ProjectRuleError("rule_unchanged");
      const next = row.currentVersion + 1;
      tx.insert(projectRuleVersions).values({ ruleId: id, version: next, fields: request.fields, createdAt: Date.now(), createdBy: "owner", requestId: request.requestId, requestPayload: payload }).run();
      tx.update(projectRules).set({ currentVersion: next, revision: row.revision + 1 }).where(eq(projectRules.id, id)).run();
      return this.#current(this.#rule(projectId, id));
    });
  }

  approve(projectId: string, id: string, request: ApproveBusinessRuleRequest): BusinessRuleDto {
    return this.deps.db.transaction((tx) => {
      this.deps.checkProject(projectId, true);
      const row = this.#rule(projectId, id);
      if (row.currentVersion !== request.version) throw new ProjectRuleError("revision_conflict");
      const current = tx.select().from(projectRuleVersions).where(and(eq(projectRuleVersions.ruleId, id), eq(projectRuleVersions.version, row.currentVersion))).get()!;
      const payload = JSON.stringify(request);
      if (current.approvalRequestId === request.requestId) {
        if (current.approvalPayload !== payload) throw new ProjectRuleError("request_conflict");
        return this.#current(row);
      }
      if (row.revision !== request.revision) throw new ProjectRuleError("revision_conflict");
      if (current.approvedAt !== null) throw new ProjectRuleError("rule_already_approved");
      const fields = current.fields;
      if ([fields.source, fields.role, fields.expectedResult, fields.allowedExample, fields.deniedExample].some((value) => !value.trim()) || fields.openQuestions.trim()) throw new ProjectRuleError("rule_incomplete");
      tx.update(projectRuleVersions).set({ approvedAt: Date.now(), approvedBy: "owner", approvalRequestId: request.requestId, approvalPayload: payload }).where(and(eq(projectRuleVersions.ruleId, id), eq(projectRuleVersions.version, row.currentVersion))).run();
      tx.update(projectRules).set({ revision: row.revision + 1 }).where(eq(projectRules.id, id)).run();
      return this.#current(this.#rule(projectId, id));
    });
  }
}
