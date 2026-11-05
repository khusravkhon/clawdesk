import { randomUUID } from "node:crypto";
import { expectedLoad, loadVerdict, type LoadConditionsDto, type LoadResultDto, type LoadRunDto, type LoadRunsDto, type ProjectBriefDto, type RunLoadCheckRequest } from "@clawdesk/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { projectLoadRuns } from "../db/schema.js";

// P9 (acceptance 15): load checks of a generated app (bridge: ProjectBuilder.load). Each run is stored with its
// conditions, result and the target the brief stated at that time, so a report never mixes them up later.

export class ProjectLoadError extends Error {
  constructor(readonly code: "load_busy" | "gateway_unavailable" | "request_conflict") { super(code); }
}
export type LoadBridge = { projectLoad(projectId: string, request: { concurrency: number; durationMs: number }): Promise<{ conditions: LoadConditionsDto; result: LoadResultDto | null; error: string | null }> };

export class ProjectLoadService {
  #busy = new Set<string>();
  constructor(private readonly deps: { db: Db; checkProject: (id: string, writing: boolean) => unknown; brief: (id: string) => ProjectBriefDto; bridge?: LoadBridge; now?: () => number }) {}

  #target(projectId: string) {
    const fields = this.deps.brief(projectId).fields;
    return expectedLoad([fields.constraints, fields.audience, fields.scenarios, fields.goal].filter(Boolean).join("\n"));
  }

  list(projectId: string): LoadRunsDto {
    this.deps.checkProject(projectId, false);
    const rows = this.deps.db.select().from(projectLoadRuns).where(eq(projectLoadRuns.projectId, projectId)).orderBy(desc(projectLoadRuns.createdAt)).limit(10).all();
    return { runs: rows.map(dto), target: this.#target(projectId) };
  }

  async run(projectId: string, request: RunLoadCheckRequest): Promise<LoadRunDto> {
    this.deps.checkProject(projectId, true);
    const previous = this.deps.db.select().from(projectLoadRuns).where(and(eq(projectLoadRuns.projectId, projectId), eq(projectLoadRuns.requestId, request.requestId))).get();
    if (previous) return dto(previous);
    if (!this.deps.bridge) throw new ProjectLoadError("gateway_unavailable");
    if (this.#busy.has(projectId)) throw new ProjectLoadError("load_busy");
    this.#busy.add(projectId);
    try {
      const target = this.#target(projectId);
      const out = await this.deps.bridge.projectLoad(projectId, { concurrency: request.concurrency, durationMs: request.durationSeconds * 1000 });
      const row = { id: randomUUID(), projectId, conditions: out.conditions, result: out.result, error: out.error, target, verdict: loadVerdict(out.conditions, out.result, target), createdAt: this.deps.now?.() ?? Date.now(), requestId: request.requestId };
      this.deps.db.insert(projectLoadRuns).values(row).run();
      return dto(row);
    } finally { this.#busy.delete(projectId); }
  }
}

const dto = (row: typeof projectLoadRuns.$inferSelect): LoadRunDto => ({ id: row.id, createdAt: row.createdAt, conditions: row.conditions, result: row.result, error: row.error, target: row.target, verdict: row.verdict });
