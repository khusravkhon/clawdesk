import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityService, RUN_STALE_MS, RunTracker } from "../src/company/activity-service.js";
import { WorkItemsService } from "../src/company/work-items-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { agents, departments, teams, workRequests } from "../src/db/schema.js";
import { registerActivityRoutes } from "../src/routes/activity.js";

// Stage 9: one state per agent, confirmed by Gateway events or the database, never guessed from silence.

const chat = (agentId: string, runId: string, state: string, extra: Record<string, unknown> = {}) => ({ event: "chat", payload: { sessionKey: `agent:${agentId}:main`, runId, state, ...extra } });
const tool = (agentId: string, runId: string, name: string) => ({ event: "agent", payload: { sessionKey: `agent:${agentId}:main`, runId, stream: "tool", data: { name, phase: "start" } } });

describe("agent activity", () => {
  let root: string, db: Db, close: () => void, clock: number, tracker: RunTracker, service: ActivityService, connected: boolean, live: Set<string> | null, generation: number;
  const state = async (): Promise<Record<string, [string, string]>> => Object.fromEntries((await service.snapshot()).agents.map((agent) => [agent.agentId, [agent.state, agent.detail]]));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-activity-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    clock = 1_000_000; connected = true; live = new Set(["main", "dev", "qa", "writer"]); generation = 1;
    db.insert(departments).values({ id: "it", requestId: randomUUID(), requestPayload: "{}", name: "IT" }).run();
    db.insert(teams).values({ id: "shop", name: "Shop", departmentId: "it" }).run();
    db.insert(agents).values([
      { id: "dev", role: "team_member", teamId: "shop", templateId: "developer", displayName: "Разработчик" },
      { id: "qa", role: "team_member", teamId: "shop", templateId: "qa", displayName: "QA" },
      { id: "writer", role: "specialist", displayName: "Автор" },
      { id: "gone", role: "specialist", displayName: "Удалённый" },
    ]).run();
    tracker = new RunTracker(() => clock);
    service = new ActivityService({ db, tracker, gatewayConnected: () => connected, liveAgents: async () => live, generation: () => generation, now: () => clock });
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("works only while a reported run is active; a tool is shown only when the run used it", async () => {
    expect((await state()).dev).toEqual(["idle", "свободен"]);
    expect(tracker.handle(chat("dev", "r1", "status"))).toBe(true);
    let dev = (await service.snapshot()).agents.find((agent) => agent.agentId === "dev")!;
    expect([dev.state, dev.action, dev.runs, dev.team?.name, dev.department?.name, dev.position]).toEqual(["working", null, 1, "Shop", "IT", "developer"]);
    tracker.handle(tool("dev", "r1", "exec"));
    tracker.handle(chat("dev", "r2", "delta"));
    dev = (await service.snapshot()).agents.find((agent) => agent.agentId === "dev")!;
    expect([dev.state, dev.runs, dev.detail]).toEqual(["working", 2, "выполняет 2 запуска"]);
    tracker.handle(chat("dev", "r1", "final"));
    tracker.handle(chat("dev", "r2", "aborted"));
    expect((await state()).dev).toEqual(["idle", "свободен"]);
    // An error is shown until the next run; events of other sessions or kinds are ignored.
    tracker.handle(chat("qa", "r3", "error", { errorMessage: "rate limited" }));
    expect((await state()).qa).toEqual(["error", "ошибка запуска: rate limited"]);
    expect(tracker.handle({ event: "presence", payload: { sessionKey: "agent:qa:main", runId: "x" } })).toBe(false);
    expect(tracker.handle(chat("qa", "r4", "status")) && (await state()).qa![0]).toBe("working");
  });

  it("does not show a run as working forever, nor after a reconnect", async () => {
    tracker.handle(chat("dev", "r1", "status"));
    clock += RUN_STALE_MS + 1;
    expect((await state()).dev![0]).toBe("idle");
    tracker.handle(chat("dev", "r2", "status"));
    expect((await state()).dev![0]).toBe("working");
    generation = 2;
    expect((await state()).dev![0]).toBe("idle");
    connected = false;
    expect((await state()).dev).toEqual(["unknown", "нет связи с Gateway: состояние неизвестно"]);
    connected = true;
    expect((await state()).gone).toEqual(["offline", "Gateway не знает этого агента"]);
  });

  it("derives waiting, blocked and queued from requests and tasks", async () => {
    const items = new WorkItemsService({ db, companyMode: () => true, now: () => clock });
    const task = (title: string, executorAgentId: string) => items.create({ requestId: randomUUID(), title, description: "d", criteria: "c", executorAgentId, deadlineAt: null, start: true });
    const first = task("Отчёт", "writer"); clock++; task("Второй", "writer"); task("Для QA", "qa"); task("Ещё QA", "qa");
    let snapshot = await service.snapshot();
    const writer = snapshot.agents.find((agent) => agent.agentId === "writer")!;
    expect([writer.state, writer.detail, writer.task]).toEqual(["idle", "WI-001 в работе, сейчас без запуска", { code: "WI-001", title: "Отчёт", status: "running" }]);
    tracker.handle(chat("writer", "r1", "status"));
    expect((await state()).writer).toEqual(["working", "WI-001 «Отчёт»"]);
    tracker.handle(chat("writer", "r1", "final"));
    const request = (number: number, fromAgentId: string, level: number, status: "open" | "clarify" = "open") => db.insert(workRequests).values({ id: randomUUID(), number, fromAgentId, kind: "question", subject: `Тема ${number}`, subjectKey: `тема ${number}`, details: "d", status, route: [{ kind: "main", agentId: "main" }, { kind: "owner", agentId: null }], level, deadlineAt: clock + 1, createdAt: clock + number, updatedAt: clock, spoolId: randomUUID() }).run();
    request(1, "writer", 1);
    request(2, "dev", 0);
    request(3, "qa", 0, "clarify");
    snapshot = await service.snapshot();
    const by = Object.fromEntries(snapshot.agents.map((agent) => [agent.agentId, agent]));
    expect([by.writer!.state, by.writer!.detail]).toEqual(["waiting_for_owner", "ждёт решения владельца: REQ-001 «Тема 1»"]);
    expect([by.dev!.state, by.dev!.detail, by.dev!.request]).toEqual(["waiting_for_agent", "ждёт ответа от Главный агент: REQ-002", { code: "REQ-002", addressee: "Главный агент" }]);
    expect(by.qa!.state).toBe("waiting_for_agent");
    expect(by.main!.inbox).toBe(1);
    expect(snapshot.counts).toMatchObject({ waiting: 3, offline: 1 });
    // The sequence moves only when something shown changes.
    const sequence = (await service.snapshot()).sequence;
    expect((await service.snapshot()).sequence).toBe(sequence);
    items.act(first.id, { requestId: randomUUID(), revision: items.list().items.find((item) => item.id === first.id)!.revision, action: "cancel", comment: "" });
    expect((await service.snapshot()).sequence).toBe(sequence + 1);
  });

  it("serves the snapshot over HTTP", async () => {
    const app = Fastify(); registerActivityRoutes(app, { activity: service });
    const body = (await app.inject({ url: "/api/company/activity" })).json();
    expect(body).toMatchObject({ gatewayConnected: true, counts: { idle: 4, offline: 1 } });
    expect(body.agents.map((agent: { agentId: string }) => agent.agentId)).toEqual(["main", "dev", "qa", "writer", "gone"]);
    await app.close();
  });
});
