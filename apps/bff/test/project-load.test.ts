import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CreateProjectRequest, ProjectBriefFields, expectedLoad, loadVerdict, type LoadConditionsDto, type LoadResultDto } from "@clawdesk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanyService } from "../src/company/company-service.js";
import { openDb, type Db } from "../src/db/client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import type { SpaceService } from "../src/space/space-service.js";

// P9 (acceptance 15): the verdict never claims more than was run.

const conditions = (concurrency: number): LoadConditionsDto => ({ concurrency, durationMs: 5000, appCpus: 0.5, appMemoryMb: 192, requests: ["GET /api/tasks", "POST /api/tasks"], data: "x", network: "x" });
const result = (patch: Partial<LoadResultDto> = {}): LoadResultDto => ({ requests: 1000, errors: 0, statuses: { "200": 500, "201": 500 }, p50: 20, p95: 80, p99: 120, max: 200, rps: 200, elapsedMs: 5000, ...patch });

describe("load checks", () => {
  it("reads the target load from the brief's words", () => {
    expect(expectedLoad("Около 20 человек одновременно, всего 300 пользователей")).toMatchObject({ simultaneous: 20, total: null });
    expect(expectedLoad("Одновременно до 15 сотрудников.")).toMatchObject({ simultaneous: 15 });
    expect(expectedLoad("Всего 2 000 пользователей в месяц")).toMatchObject({ simultaneous: null, total: 2000 });
    expect(expectedLoad("Только я")).toEqual({ simultaneous: null, total: null, evidence: null });
  });

  it("confirms only a stated simultaneous load that ran cleanly and fast", () => {
    expect(loadVerdict(conditions(20), result(), { simultaneous: 20, total: null, evidence: "" })).toBe("confirmed");
    expect(loadVerdict(conditions(10), result(), { simultaneous: 20, total: null, evidence: "" })).toBe("not_confirmed");
    expect(loadVerdict(conditions(50), result(), { simultaneous: null, total: 2000, evidence: "" })).toBe("not_confirmed");
    expect(loadVerdict(conditions(5), result(), { simultaneous: null, total: null, evidence: null })).toBe("no_target");
    expect(loadVerdict(conditions(20), result({ errors: 20 }), { simultaneous: 20, total: null, evidence: "" })).toBe("failed");
    expect(loadVerdict(conditions(20), result({ p95: 1500 }), { simultaneous: 20, total: null, evidence: "" })).toBe("failed");
    expect(loadVerdict(conditions(20), null, { simultaneous: 20, total: null, evidence: "" })).toBe("blocked");
  });

  describe("service", () => {
    let root: string, db: Db, close: () => void, company: CompanyService, projectId: string, calls: unknown[], answer: { result: LoadResultDto | null; error: string | null };
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-load-"));
      ({ db, close } = openDb(path.join(root, "panel.sqlite")));
      calls = []; answer = { result: result(), error: null };
      const bridge = { projectWorkspace: async () => ({ rootPath: "/p", workspace: null, available: [], truncated: false }), prepareProjectWorkspace: async () => ({}) as never, projectLoad: async (_: string, request: { concurrency: number; durationMs: number }) => { calls.push(request); return { conditions: conditions(request.concurrency), ...answer }; } };
      company = new CompanyService({ db, bridge, space: { mode: () => "company" } as SpaceService, gateway: {} as GatewayService });
      projectId = company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Доска" })).id;
      company.saveProjectBrief(projectId, { requestId: randomUUID(), revision: 0, step: 2, fields: ProjectBriefFields.parse({ goal: "Задачи", constraints: "Одновременно 10 человек" }) });
    });
    afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

    it("stores each run with its conditions and the brief's target, and repeats a request once", async () => {
      const request = { requestId: randomUUID(), concurrency: 10, durationSeconds: 5 };
      const run = await company.load.run(projectId, request);
      expect(run).toMatchObject({ verdict: "confirmed", conditions: { concurrency: 10, appCpus: 0.5 }, target: { simultaneous: 10 } });
      expect(calls).toEqual([{ concurrency: 10, durationMs: 5000 }]);
      expect((await company.load.run(projectId, request)).id).toBe(run.id);
      expect(calls).toHaveLength(1);
      answer = { result: null, error: "runner_failed" };
      expect((await company.load.run(projectId, { requestId: randomUUID(), concurrency: 5, durationSeconds: 2 })).verdict).toBe("blocked");
      expect(company.load.list(projectId)).toMatchObject({ target: { simultaneous: 10 }, runs: [{ verdict: "blocked" }, { verdict: "confirmed" }] });
    });
  });
});
