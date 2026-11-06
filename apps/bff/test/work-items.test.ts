import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkItemsService } from "../src/company/work-items-service.js";
import { WorkRequestsService } from "../src/company/work-requests-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { agents, teams } from "../src/db/schema.js";
import { registerWorkItemRoutes } from "../src/routes/work-items.js";

// Stage 6, part 2: company tasks. Reports and requests come through the same spool as requests do.

describe("company tasks", () => {
  let root: string, db: Db, close: () => void, items: WorkItemsService, requests: WorkRequestsService, clock: number;
  let spool: Record<string, unknown>[], sent: { agentId: string; message: string; key: string }[], n: number;
  const add = (entry: Record<string, unknown>) => { spool.push({ id: (++n).toString(16).padStart(32, "0"), ...entry }); };
  const report = (agentId: string, taskId: string, status: string, result = "Готово: см. docs/report.md") => add({ type: "task_report", agentId, taskId, status, result });
  const tick = () => requests.tick();
  const task = (title: string, executorAgentId = "analyst", start = true) => items.create({ requestId: randomUUID(), title, description: `Сделать: ${title}`, criteria: "Отчёт в папке", executorAgentId, deadlineAt: null, start });
  const act = (id: string, action: "start" | "cancel" | "accept" | "return" | "resume", comment = "") => items.act(id, { requestId: randomUUID(), revision: items.list().items.find((item) => item.id === id)!.revision, action, comment });
  const status = () => Object.fromEntries(items.list().items.map((item) => [item.code, item.status]));
  const to = (agentId: string) => sent.filter((item) => item.agentId === agentId).map((item) => item.message);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-items-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    clock = 1_000; spool = []; sent = []; n = 0;
    db.insert(agents).values([{ id: "analyst", role: "specialist", displayName: "Аналитик" }, { id: "writer", role: "team_member", displayName: "Автор" }]).run();
    const send = async (agentId: string, message: string, key: string) => { sent.push({ agentId, message, key }); };
    items = new WorkItemsService({ db, companyMode: () => true, send, now: () => clock });
    requests = new WorkRequestsService({
      db, companyMode: () => true, send, now: () => clock, tasks: items, liveAgents: async () => new Set(["main", "analyst", "writer"]),
      bridge: { requestsSpool: async () => ({ entries: [...spool], rejected: [] }), requestsAck: async (ids) => { spool = spool.filter((item) => !ids.includes(item.id as string)); } },
    });
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("a team member's done task goes to its team lead, who accepts or returns it; others cannot", async () => {
    db.insert(teams).values({ id: "content", name: "Контент", leadAgentId: "lead" }).run();
    db.insert(agents).values({ id: "lead", role: "team_member", teamId: "content", displayName: "Тимлид" }).run();
    db.update(agents).set({ teamId: "content" }).where(eq(agents.id, "writer")).run();
    const review = (agentId: string, taskId: string, decision: string, comment = "Проверил по критериям") => add({ type: "task_review", agentId, taskId, decision, comment });
    task("Пост", "writer");
    report("writer", "WI-001", "done");
    await tick();
    expect(status()).toEqual({ "WI-001": "review" });
    expect(to("lead").at(-1)).toContain("Задача WI-001 «Пост» — Автор сообщает, что сделано");
    expect(to("lead").at(-1)).toContain("Критерии приёмки: Отчёт в папке");
    expect(to("writer").some((message) => message.includes("передан на приёмку тимлиду (Тимлид)"))).toBe(true);
    // Not the lead, no comment, a wrong decision: refused.
    review("analyst", "WI-001", "accept");
    review("lead", "WI-001", "accept", "   ");
    review("lead", "WI-001", "maybe");
    await tick();
    expect(status()).toEqual({ "WI-001": "review" });
    expect(to("analyst").some((message) => message.includes("только тимлид команды исполнителя или владелец"))).toBe(true);
    // The lead returns it: back with the lead's comment in the start message.
    review("lead", "WI-001", "return", "Добавь ссылку на источник");
    await tick();
    expect(status()).toEqual({ "WI-001": "running" });
    expect(to("writer").at(-1)).toContain("Тимлид: Добавь ссылку на источник");
    report("writer", "WI-001", "done", "Готово, со ссылкой");
    await tick();
    review("lead", "WI-001", "accept");
    await tick();
    expect(status()).toEqual({ "WI-001": "done" });
    expect(to("writer").at(-1)).toContain("Тимлид Тимлид принял задачу WI-001");
    expect(items.list().items[0]!.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["reported", "returned", "accepted"]));
    // Without a lead the owner accepts, as before.
    task("Справка", "analyst");
    report("analyst", "WI-002", "done");
    await tick();
    expect(to("analyst").some((message) => message.includes("передан владельцу на приёмку"))).toBe(true);
  });

  it("runs one task per executor, queues the rest, and starts the next when the executor is free", async () => {
    const draft = task("Черновик", "analyst", false);
    const first = task("Первая"); clock++;
    const second = task("Вторая"); clock++;
    task("Для автора", "writer");
    expect(status()).toEqual({ "WI-001": "draft", "WI-002": "running", "WI-003": "queued", "WI-004": "running" });
    expect(items.list().items.find((item) => item.code === "WI-003")!.queuePosition).toBe(1);
    await tick();
    expect(to("analyst")[0]).toContain("Задача WI-002 от владельца: «Первая»");
    expect(to("analyst")[0]).toContain("clawdesk_task_report");

    // "Done" without a result is refused; with one it goes to acceptance and the next task starts.
    report("analyst", "WI-002", "done", "   ");
    report("writer", "WI-002", "done");
    await tick();
    expect(to("analyst").some((message) => message.includes("без результата не засчитывается"))).toBe(true);
    expect(to("writer").some((message) => message.includes("не твоя задача"))).toBe(true);
    report("analyst", "WI-002", "done");
    await tick();
    expect(status()).toMatchObject({ "WI-002": "review", "WI-003": "running" });
    expect(to("analyst").some((message) => message.includes("«Вторая»"))).toBe(true);

    // The owner returns it: back to the queue ahead of later tasks, the comment in its start message.
    act(first.id, "return", "Добавь итоги по месяцам");
    expect(status()).toMatchObject({ "WI-002": "queued", "WI-003": "running" });
    report("analyst", "WI-003", "failed", "Нет данных за март");
    await tick();
    expect(status()).toMatchObject({ "WI-002": "running", "WI-003": "failed" });
    expect(to("analyst").at(-1)).toContain("Работу вернули с замечанием: Владелец: Добавь итоги по месяцам");
    report("analyst", "WI-002", "done", "Итоги добавлены");
    await tick();
    act(first.id, "accept");
    expect(status()["WI-002"]).toBe("done");
    expect(items.list().items.find((item) => item.code === "WI-002")!.result).toBe("Итоги добавлены");
    // A failed task can be started again; a draft starts when the owner says so.
    act(second.id, "start");
    act(draft.id, "start");
    expect(status()).toMatchObject({ "WI-003": "running", "WI-001": "queued" });
    expect(() => act(first.id, "accept")).toThrow("wrong_state");
  });

  it("a request for the task blocks it; an answer continues it, a denial leaves it for the owner", async () => {
    const item = task("Отчёт");
    add({ type: "up", agentId: "analyst", kind: "question", subject: "Где данные?", details: "Нужны продажи", taskRef: "WI-001" });
    await tick();
    let current = items.list().items[0]!;
    expect(current).toMatchObject({ status: "blocked", block: { requestCode: "REQ-001", text: "ждёт ответа на REQ-001 («Где данные?»)" } });
    add({ type: "reply", agentId: "main", requestId: "REQ-001", action: "answer", text: "В папке Sales" });
    await tick();
    expect(items.list().items[0]!.status).toBe("running");
    expect(to("analyst").some((message) => message.includes("По REQ-001 получен ответ: задача WI-001"))).toBe(true);

    add({ type: "up", agentId: "analyst", kind: "decision", subject: "Какой формат?", details: "PDF или Excel", taskRef: "WI-001" });
    await tick();
    add({ type: "reply", agentId: "main", requestId: "REQ-002", action: "deny", text: "Решай сам" });
    await tick();
    current = items.list().items[0]!;
    expect(current).toMatchObject({ status: "blocked", block: { text: "REQ-002: отказано; решение — за владельцем" } });
    act(item.id, "resume", "Делай PDF");
    expect(items.list().items[0]!.status).toBe("running");
    // Another agent's request with this taskRef does not block it.
    add({ type: "up", agentId: "writer", kind: "question", subject: "x", details: "y", taskRef: "WI-001" });
    await tick();
    expect(items.list().items[0]!.status).toBe("running");
  });

  it("cancelling a task in work stops the executor's running turn once, before telling it", async () => {
    const log: string[] = [];
    let failSend = true;
    const service = new WorkItemsService({
      db, companyMode: () => true, now: () => clock,
      send: async (agentId, message) => { if (failSend && message.includes("отменил")) { failSend = false; throw new Error("offline"); } log.push(`send ${agentId}: ${message.slice(0, 30)}`); },
      abort: async (agentId) => { log.push(`abort ${agentId}`); },
    });
    const a = service.create({ requestId: randomUUID(), title: "A", description: "d", criteria: "c", executorAgentId: "analyst", deadlineAt: null, start: true });
    await service.deliver();
    service.act(a.id, { requestId: randomUUID(), revision: service.list().items[0]!.revision, action: "cancel", comment: "" });
    await service.deliver();
    expect(log.filter((line) => line.startsWith("abort"))).toEqual(["abort analyst"]);
    expect(log.indexOf("abort analyst")).toBeGreaterThan(log.findIndex((line) => line.includes("Задача WI-001")));
    // The retry of the lost cancel message does not stop the turn again.
    await service.deliver();
    expect(log.filter((line) => line.startsWith("abort"))).toEqual(["abort analyst"]);
    expect(log.some((line) => line.includes("Владелец отменил"))).toBe(true);
  });

  it("cancelling a task in work tells the executor and frees it; actions are idempotent and checked", async () => {
    const a = task("A"); clock++; task("B");
    const request = { requestId: randomUUID(), revision: a.revision, action: "cancel" as const, comment: "" };
    items.act(a.id, request);
    expect(items.act(a.id, request).status).toBe("cancelled");
    expect(status()).toMatchObject({ "WI-001": "cancelled", "WI-002": "running" });
    expect(() => items.act(a.id, { ...request, requestId: randomUUID() })).toThrow("revision_conflict");
    await tick();
    expect(to("analyst").some((message) => message.includes("Владелец отменил задачу WI-001"))).toBe(true);
    expect(new Set(sent.map((item) => item.key)).size).toBe(sent.length);
    expect(() => task("x", "ghost")).toThrow("executor_missing");
    for (let i = 0; i < 10; i++) task(`q${i}`);
    expect(() => task("too many")).toThrow("queue_full");

    const app = Fastify(); registerWorkItemRoutes(app, { workItems: items });
    expect((await app.inject({ url: "/api/company/work-items" })).json().executors.map((item: { agentId: string }) => item.agentId)).toEqual(["main", "analyst", "writer"]);
    expect((await app.inject({ method: "POST", url: "/api/company/work-items", payload: { requestId: randomUUID(), title: "", description: "d", criteria: "c", executorAgentId: "writer" } })).statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: "/api/company/work-items", payload: { requestId: randomUUID(), title: "Через API", description: "d", criteria: "c", executorAgentId: "writer", start: true } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: "running", executor: { name: "Автор" } });
    expect((await app.inject({ method: "POST", url: `/api/company/work-items/${created.json().id}/act`, payload: { requestId: randomUUID(), revision: created.json().revision, action: "return" } })).statusCode).toBe(400);
    await app.close();
  });

  it("marks an open task overdue after its deadline", () => {
    items.create({ requestId: randomUUID(), title: "Срочно", description: "d", criteria: "c", executorAgentId: "analyst", deadlineAt: 2_000, start: true });
    expect(items.list().items[0]!.overdue).toBe(false);
    clock = 3_000;
    expect(items.list().items[0]!.overdue).toBe(true);
  });
});
