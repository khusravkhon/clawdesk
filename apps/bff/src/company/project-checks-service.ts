import { randomUUID } from "node:crypto";
import type { AutomatedCheckDto, ProjectCheckRunDto, ProjectCheckRunSummaryDto, ProjectCheckStatus, ProjectChecksDto, ProjectChecksRunResult, RunProjectChecksRequest } from "@clawdesk/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { acceptanceTestLinks, projectCheckResults, projectCheckRuns } from "../db/schema.js";
import { testHashes } from "./project-test-units.js";

// P6.1: runs of a generated project's own checks and what they mean for acceptance scenarios.
// A run is stored as it happened (also "blocked" ones); a scenario's automated status is derived
// from the test it links to and the latest run, never stored, so it cannot drift from the evidence.

export class ProjectChecksError extends Error {
  constructor(readonly code: "checks_busy" | "request_conflict" | "gateway_unavailable") { super(code); }
}
/** With projectAppFiles the panel reads the files first and runs exactly those, so it can hash each test (P6.3). */
export type ProjectChecksBridge = { runProjectChecks(projectId: string, files?: Record<string, string>): Promise<ProjectChecksRunResult>; projectAppFiles?(projectId: string): Promise<{ files: Record<string, string> }> };

const HISTORY = 20;
type Tx = Pick<Db, "select" | "insert">;
const emptyCounts = (): Record<ProjectCheckStatus, number> => ({ passed: 0, failed: 0, flaky: 0, skipped: 0 });

export class ProjectChecksService {
  #busy = new Set<string>();
  constructor(private readonly deps: { db: Db; checkProject: (id: string, writing: boolean) => unknown; bridge?: ProjectChecksBridge }) {}

  list(projectId: string): ProjectChecksDto {
    this.deps.checkProject(projectId, false);
    const runs = this.deps.db.select().from(projectCheckRuns).where(eq(projectCheckRuns.projectId, projectId)).orderBy(desc(projectCheckRuns.createdAt)).limit(HISTORY).all();
    const results = runs.length ? this.deps.db.select().from(projectCheckResults).where(inArray(projectCheckResults.runId, runs.map(run => run.id))).all() : [];
    const summaries = runs.map(run => summary(run, results.filter(result => result.runId === run.id)));
    const latest = runs[0] ? { ...summaries[0]!, tests: results.filter(result => result.runId === runs[0]!.id).map(testDto).sort((a, b) => a.id.localeCompare(b.id)) } : null;
    return { latest, history: summaries };
  }

  async run(projectId: string, request: RunProjectChecksRequest): Promise<ProjectCheckRunDto> {
    this.deps.checkProject(projectId, true);
    const previous = this.deps.db.select().from(projectCheckRuns).where(and(eq(projectCheckRuns.projectId, projectId), eq(projectCheckRuns.requestId, request.requestId))).get();
    if (previous) return this.#runDto(previous.id);
    if (!this.deps.bridge) throw new ProjectChecksError("gateway_unavailable");
    if (this.#busy.has(projectId)) throw new ProjectChecksError("checks_busy");
    this.#busy.add(projectId);
    try {
      const files = this.deps.bridge.projectAppFiles ? (await this.deps.bridge.projectAppFiles(projectId)).files : null;
      const result = files ? await this.deps.bridge.runProjectChecks(projectId, files) : await this.deps.bridge.runProjectChecks(projectId);
      const hashes = files ? testHashes(files, result.tests) : new Map<string, string | null>();
      const id = randomUUID();
      this.deps.db.transaction((tx) => {
        tx.insert(projectCheckRuns).values({ id, projectId, status: result.status, reason: result.reason, filesFingerprint: result.filesFingerprint, durationMs: Math.max(0, Math.round(result.durationMs)), createdAt: Date.now(), requestId: request.requestId }).run();
        for (const test of result.tests) tx.insert(projectCheckResults).values({ runId: id, testId: test.id.slice(0, 1000), file: test.file.slice(0, 200), name: test.name.slice(0, 800), status: test.status, message: test.message.slice(0, 1000), fileHash: test.fileHash, testHash: hashes.get(test.id) ?? null }).onConflictDoNothing().run();
      });
      return this.#runDto(id);
    } finally { this.#busy.delete(projectId); }
  }

  #runDto(id: string): ProjectCheckRunDto {
    const run = this.deps.db.select().from(projectCheckRuns).where(eq(projectCheckRuns.id, id)).get()!;
    const results = this.deps.db.select().from(projectCheckResults).where(eq(projectCheckResults.runId, id)).all();
    return { ...summary(run, results), tests: results.map(testDto).sort((a, b) => a.id.localeCompare(b.id)) };
  }
}

function summary(run: typeof projectCheckRuns.$inferSelect, results: (typeof projectCheckResults.$inferSelect)[]): ProjectCheckRunSummaryDto {
  const counts = emptyCounts();
  for (const result of results) counts[result.status]++;
  return { id: run.id, status: run.status, reason: run.reason, createdAt: run.createdAt, durationMs: run.durationMs, counts };
}
const testDto = (row: typeof projectCheckResults.$inferSelect) => ({ id: row.testId, file: row.file, name: row.name, status: row.status, message: row.message, fileHash: row.fileHash });

function latestRun(db: Tx, projectId: string, completedOnly = false) {
  return db.select().from(projectCheckRuns).where(completedOnly ? and(eq(projectCheckRuns.projectId, projectId), eq(projectCheckRuns.status, "completed")) : eq(projectCheckRuns.projectId, projectId)).orderBy(desc(projectCheckRuns.createdAt)).get();
}

/**
 * Called when a scenario revision is saved: if its test reference names a test of the latest completed
 * run, that test (and its own block's hash, else its file's) becomes the one this revision protects.
 */
export function linkScenarioTest(db: Tx, projectId: string, caseId: string, revision: number, testRef: string): void {
  const testId = testRef.trim();
  if (!testId) return;
  const run = latestRun(db, projectId, true);
  if (!run) return;
  const result = db.select().from(projectCheckResults).where(and(eq(projectCheckResults.runId, run.id), eq(projectCheckResults.testId, testId))).get();
  if (!result?.fileHash) return;
  db.insert(acceptanceTestLinks).values({ caseId, revision, testId, fileHash: result.fileHash, testHash: result.testHash, runId: run.id, createdAt: Date.now() }).onConflictDoNothing().run();
}

/** A scenario revision's automated status against the latest run (see AutomatedCheckStatus). */
export function scenarioAutomatedStatus(db: Tx, projectId: string, caseId: string, revision: number, testRef: string): AutomatedCheckDto | null {
  const testId = testRef.trim();
  if (!testId) return null;
  const link = db.select().from(acceptanceTestLinks).where(and(eq(acceptanceTestLinks.caseId, caseId), eq(acceptanceTestLinks.revision, revision))).get();
  if (!link) return { testId, status: "unlinked", runId: null, runAt: null, message: "" };
  const run = latestRun(db, projectId);
  if (!run) return { testId, status: "not_run", runId: null, runAt: null, message: "" };
  if (run.status === "blocked") return { testId, status: "blocked", runId: run.id, runAt: run.createdAt, message: run.reason ?? "" };
  const result = db.select().from(projectCheckResults).where(and(eq(projectCheckResults.runId, run.id), eq(projectCheckResults.testId, link.testId))).get();
  if (!result) return { testId, status: "not_run", runId: run.id, runAt: run.createdAt, message: "" };
  // A link with the test's own hash survives edits to other tests in its file; older links compare the whole file.
  if (link.testHash ? result.testHash !== link.testHash : result.fileHash !== link.fileHash) return { testId, status: "changed", runId: run.id, runAt: run.createdAt, message: "" };
  return { testId, status: result.status, runId: run.id, runAt: run.createdAt, message: result.message };
}
