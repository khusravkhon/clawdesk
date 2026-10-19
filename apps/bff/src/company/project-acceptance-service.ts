import { randomUUID } from "node:crypto";
import type { AcceptanceCaseDto, AcceptanceCheckDto, AcceptanceHistoryDto, AcceptanceSuiteDto, CreateAcceptanceRequest, RecordAcceptanceCheckRequest, UpdateAcceptanceRequest } from "@clawdesk/shared";
import { and, asc, desc, eq, max } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { acceptanceCases, acceptanceChecks, acceptanceRevisions, projectRules, projectRuleVersions } from "../db/schema.js";

export class AcceptanceError extends Error {
  constructor(readonly code: "rule_missing" | "rule_version_missing" | "acceptance_missing" | "revision_conflict" | "request_conflict" | "acceptance_unchanged" | "rule_not_approved") { super(code); }
}
const checkDto = (row: typeof acceptanceChecks.$inferSelect): AcceptanceCheckDto => ({ id: row.id, revision: row.revision, outcome: row.outcome, context: row.context, observed: row.observed, evidence: row.evidence, source: row.source, checkedBy: row.checkedBy, createdAt: row.createdAt });
const caseDto = (row: typeof acceptanceCases.$inferSelect, version: typeof acceptanceRevisions.$inferSelect, check: typeof acceptanceChecks.$inferSelect | null): AcceptanceCaseDto => ({ id: row.id, code: `AC-${String(row.number).padStart(3, "0")}`, ruleVersion: row.ruleVersion, revision: row.revision, fields: version.fields, createdAt: version.createdAt, latestCheck: check ? checkDto(check) : null });

/** Evidence is an owner's manual record tied to exact versions, never an automated test result. */
export class ProjectAcceptanceService {
  constructor(private readonly deps: { db: Db; checkProject: (id: string, writing: boolean) => unknown }) {}

  #rule(projectId: string, id: string, writing = false, version?: number) {
    this.deps.checkProject(projectId, writing);
    const rule = this.deps.db.select().from(projectRules).where(and(eq(projectRules.id, id), eq(projectRules.projectId, projectId))).get();
    if (!rule) throw new AcceptanceError("rule_missing");
    if (writing && rule.currentVersion !== version) throw new AcceptanceError("revision_conflict");
    return rule;
  }

  #case(ruleId: string, id: string) {
    const row = this.deps.db.select().from(acceptanceCases).where(and(eq(acceptanceCases.id, id), eq(acceptanceCases.ruleId, ruleId))).get();
    if (!row) throw new AcceptanceError("acceptance_missing");
    return row;
  }

  #current(row: typeof acceptanceCases.$inferSelect): AcceptanceCaseDto {
    const version = this.deps.db.select().from(acceptanceRevisions).where(and(eq(acceptanceRevisions.caseId, row.id), eq(acceptanceRevisions.revision, row.revision))).get();
    if (!version) throw new AcceptanceError("acceptance_missing");
    const check = this.deps.db.select().from(acceptanceChecks).where(and(eq(acceptanceChecks.caseId, row.id), eq(acceptanceChecks.revision, row.revision))).orderBy(desc(acceptanceChecks.id)).get();
    return caseDto(row, version, check ?? null);
  }

  list(projectId: string, ruleId: string, version?: number): AcceptanceSuiteDto {
    const rule = this.#rule(projectId, ruleId);
    const selectedVersion = version ?? rule.currentVersion;
    const selected = this.deps.db.select().from(projectRuleVersions).where(and(eq(projectRuleVersions.ruleId, ruleId), eq(projectRuleVersions.version, selectedVersion))).get();
    if (!selected) throw new AcceptanceError("rule_version_missing");
    const latest = this.deps.db.select({ caseId: acceptanceChecks.caseId, revision: acceptanceChecks.revision, id: max(acceptanceChecks.id).as("latest_id") }).from(acceptanceChecks).groupBy(acceptanceChecks.caseId, acceptanceChecks.revision).as("latest");
    const rows = this.deps.db.select({ row: acceptanceCases, fields: acceptanceRevisions, check: acceptanceChecks }).from(acceptanceCases)
      .innerJoin(acceptanceRevisions, and(eq(acceptanceRevisions.caseId, acceptanceCases.id), eq(acceptanceRevisions.revision, acceptanceCases.revision)))
      .leftJoin(latest, and(eq(latest.caseId, acceptanceCases.id), eq(latest.revision, acceptanceCases.revision)))
      .leftJoin(acceptanceChecks, eq(acceptanceChecks.id, latest.id))
      .where(and(eq(acceptanceCases.ruleId, ruleId), eq(acceptanceCases.ruleVersion, selectedVersion))).orderBy(asc(acceptanceCases.number)).all();
    const versions = this.deps.db.select({ version: projectRuleVersions.version }).from(projectRuleVersions).where(eq(projectRuleVersions.ruleId, ruleId)).orderBy(desc(projectRuleVersions.version)).all().map(row => row.version);
    return { currentVersion: rule.currentVersion, selectedVersion, versions, approved: selected.approvedAt !== null, statement: selected.fields.statement, cases: rows.map(row => caseDto(row.row, row.fields, row.check)) };
  }

  create(projectId: string, ruleId: string, request: CreateAcceptanceRequest): AcceptanceCaseDto {
    return this.deps.db.transaction((tx) => {
      this.#rule(projectId, ruleId, true, request.ruleVersion);
      const payload = JSON.stringify(request);
      const previous = tx.select().from(acceptanceCases).where(and(eq(acceptanceCases.ruleId, ruleId), eq(acceptanceCases.requestId, request.requestId))).get();
      if (previous) {
        if (previous.requestPayload !== payload) throw new AcceptanceError("request_conflict");
        return this.#current(previous);
      }
      const last = tx.select().from(acceptanceCases).where(eq(acceptanceCases.ruleId, ruleId)).orderBy(desc(acceptanceCases.number)).get();
      const id = randomUUID();
      tx.insert(acceptanceCases).values({ id, ruleId, ruleVersion: request.ruleVersion, number: (last?.number ?? 0) + 1, requestId: request.requestId, requestPayload: payload }).run();
      tx.insert(acceptanceRevisions).values({ caseId: id, revision: 1, fields: request.fields, createdAt: Date.now(), requestId: request.requestId, requestPayload: payload }).run();
      return this.#current(this.#case(ruleId, id));
    });
  }

  update(projectId: string, ruleId: string, id: string, request: UpdateAcceptanceRequest): AcceptanceCaseDto {
    return this.deps.db.transaction((tx) => {
      this.#rule(projectId, ruleId, true, request.ruleVersion);
      const row = this.#case(ruleId, id);
      if (row.ruleVersion !== request.ruleVersion) throw new AcceptanceError("revision_conflict");
      const payload = JSON.stringify(request);
      const previous = tx.select().from(acceptanceRevisions).where(and(eq(acceptanceRevisions.caseId, id), eq(acceptanceRevisions.requestId, request.requestId))).get();
      if (previous) {
        if (previous.requestPayload !== payload) throw new AcceptanceError("request_conflict");
        if (row.revision !== previous.revision) throw new AcceptanceError("revision_conflict");
        return this.#current(row);
      }
      if (row.revision !== request.revision) throw new AcceptanceError("revision_conflict");
      if (JSON.stringify(this.#current(row).fields) === JSON.stringify(request.fields)) throw new AcceptanceError("acceptance_unchanged");
      tx.insert(acceptanceRevisions).values({ caseId: id, revision: row.revision + 1, fields: request.fields, createdAt: Date.now(), requestId: request.requestId, requestPayload: payload }).run();
      tx.update(acceptanceCases).set({ revision: row.revision + 1 }).where(eq(acceptanceCases.id, id)).run();
      return this.#current(this.#case(ruleId, id));
    });
  }

  record(projectId: string, ruleId: string, id: string, request: RecordAcceptanceCheckRequest): AcceptanceCheckDto {
    return this.deps.db.transaction((tx) => {
      this.#rule(projectId, ruleId, true, request.ruleVersion);
      const row = this.#case(ruleId, id);
      if (row.ruleVersion !== request.ruleVersion || row.revision !== request.revision) throw new AcceptanceError("revision_conflict");
      const version = tx.select().from(projectRuleVersions).where(and(eq(projectRuleVersions.ruleId, ruleId), eq(projectRuleVersions.version, request.ruleVersion))).get();
      if (version?.approvedAt == null) throw new AcceptanceError("rule_not_approved");
      const payload = JSON.stringify(request);
      const previous = tx.select().from(acceptanceChecks).where(and(eq(acceptanceChecks.caseId, id), eq(acceptanceChecks.requestId, request.requestId))).get();
      if (previous) {
        if (previous.requestPayload !== payload) throw new AcceptanceError("request_conflict");
        return checkDto(previous);
      }
      const result = tx.insert(acceptanceChecks).values({ caseId: id, revision: row.revision, outcome: request.outcome, context: request.context, observed: request.observed, evidence: request.evidence, source: "manual", checkedBy: "owner", createdAt: Date.now(), requestId: request.requestId, requestPayload: payload }).returning().get();
      return checkDto(result);
    });
  }

  history(projectId: string, ruleId: string, id: string): AcceptanceHistoryDto {
    this.#rule(projectId, ruleId); this.#case(ruleId, id);
    const revisions = this.deps.db.select().from(acceptanceRevisions).where(eq(acceptanceRevisions.caseId, id)).orderBy(desc(acceptanceRevisions.revision)).all();
    const checks = this.deps.db.select().from(acceptanceChecks).where(eq(acceptanceChecks.caseId, id)).orderBy(desc(acceptanceChecks.id)).all();
    const groups = new Map<number, AcceptanceCheckDto[]>();
    for (const check of checks) { const group = groups.get(check.revision) ?? []; group.push(checkDto(check)); groups.set(check.revision, group); }
    return { revisions: revisions.map(row => ({ revision: row.revision, fields: row.fields, createdAt: row.createdAt, checks: groups.get(row.revision) ?? [] })) };
  }
}
