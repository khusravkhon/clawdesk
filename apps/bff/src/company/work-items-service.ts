import { randomUUID } from "node:crypto";
import type { CreateWorkItemRequest, WorkItemActionRequest, WorkItemDto, WorkItemEventDto, WorkItemsDto } from "@clawdesk/shared";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, workItemEvents, workItems, workRequests, agentCharterVersions, teams } from "../db/schema.js";

// Stage 6, part 2: company tasks. The owner sets and starts a task; each executor works on one task at a
// time (running or blocked), the rest wait in its queue (first in, first out) and start when it is free —
// the one automatic continuation allowed in this version. The executor reports with clawdesk_task_report:
// "done" needs a result and goes to the owner's acceptance; "failed" ends it with the reason. A request the
// executor files with taskRef WI-… blocks the task; an answer (or a verified grant) unblocks it, a denial
// or expiry leaves it blocked for the owner to decide. Messages to the executor are events with a recipient,
// delivered with the event ID as the idempotency key, like requests' messages.

export class WorkItemError extends Error {
  constructor(readonly code: "company_only" | "item_missing" | "executor_missing" | "revision_conflict" | "request_conflict" | "wrong_state" | "queue_full") { super(code); }
}

type Tx = Pick<Db, "select" | "insert" | "update">;
type Row = typeof workItems.$inferSelect;
type RequestRow = typeof workRequests.$inferSelect;
type Report = { taskId?: unknown; status?: unknown; result?: unknown };
type Review = { taskId?: unknown; decision?: unknown; comment?: unknown };

const OCCUPYING = ["running", "blocked"] as const;
const OPEN = ["draft", "queued", "running", "blocked", "review"] as const;
const MAX_QUEUED_PER_EXECUTOR = 10;
const MAX_ATTEMPTS = 8;
const code = (number: number) => `WI-${String(number).padStart(3, "0")}`;
const requestCode = (number: number) => `REQ-${String(number).padStart(3, "0")}`;

export class WorkItemsService {
  constructor(private readonly deps: {
    db: Db;
    companyMode: () => boolean;
    send?: (agentId: string, message: string, idempotencyKey: string) => Promise<void>;
    now?: () => number;
  }) {}

  #now() { return this.deps.now?.() ?? Date.now(); }

  #name(agentId: string): string {
    if (agentId === "main") return "Главный агент";
    return this.deps.db.select({ name: agents.displayName }).from(agents).where(eq(agents.id, agentId)).get()?.name ?? agentId;
  }

  list(): WorkItemsDto {
    const { db } = this.deps;
    const rows = db.select().from(workItems).orderBy(desc(workItems.number)).limit(300).all();
    const events = rows.length ? db.select().from(workItemEvents).where(inArray(workItemEvents.itemId, rows.map((row) => row.id))).orderBy(asc(workItemEvents.id)).all() : [];
    const requests = new Map(db.select({ id: workRequests.id, number: workRequests.number }).from(workRequests).all().map((request) => [request.id, request.number]));
    const queues = new Map<string, string[]>();
    for (const row of [...rows].filter((item) => item.status === "queued").sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0) || a.number - b.number)) queues.set(row.executorAgentId, [...queues.get(row.executorAgentId) ?? [], row.id]);
    const executors = [{ agentId: "main", name: "Главный агент" }, ...db.select().from(agents).where(inArray(agents.role, ["specialist", "team_member"])).all().map((agent) => ({ agentId: agent.id, name: agent.displayName }))];
    return {
      items: rows.map((row) => this.#dto(row, events.filter((event) => event.itemId === row.id), row.blockRequestId ? requests.get(row.blockRequestId) ?? null : null, queues)),
      executors,
    };
  }

  #dto(row: Row, events: (typeof workItemEvents.$inferSelect)[], requestNumber: number | null, queues: Map<string, string[]>): WorkItemDto {
    const position = row.status === "queued" ? (queues.get(row.executorAgentId)?.indexOf(row.id) ?? -1) + 1 : 0;
    return {
      id: row.id, code: code(row.number), title: row.title, description: row.description, criteria: row.criteria,
      executor: { agentId: row.executorAgentId, name: this.#name(row.executorAgentId) }, status: row.status, revision: row.revision, charterVersion: row.charterVersion ?? null,
      block: row.status === "blocked" ? { text: row.blockText ?? "", requestCode: requestNumber !== null ? requestCode(requestNumber) : null } : null,
      result: row.result, returnComment: row.returnComment, queuePosition: position || null, deadlineAt: row.deadlineAt,
      overdue: row.deadlineAt !== null && row.deadlineAt < this.#now() && (OPEN as readonly string[]).includes(row.status),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      events: events.map((event): WorkItemEventDto => ({
        kind: event.kind, actor: event.actor, text: event.text, at: event.createdAt,
        delivery: !event.notifyAgentId ? "none" : event.deliveredAt ? "delivered" : event.attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      })),
    };
  }

  #one(tx: Tx, id: string): WorkItemDto {
    const row = tx.select().from(workItems).where(eq(workItems.id, id)).get()!;
    const events = tx.select().from(workItemEvents).where(eq(workItemEvents.itemId, id)).orderBy(asc(workItemEvents.id)).all();
    const request = row.blockRequestId ? tx.select({ number: workRequests.number }).from(workRequests).where(eq(workRequests.id, row.blockRequestId)).get() : undefined;
    const queued = tx.select().from(workItems).where(and(eq(workItems.executorAgentId, row.executorAgentId), eq(workItems.status, "queued"))).orderBy(asc(workItems.queuedAt), asc(workItems.number)).all();
    return this.#dto(row, events, request?.number ?? null, new Map([[row.executorAgentId, queued.map((item) => item.id)]]));
  }

  #event(tx: Tx, itemId: string, kind: (typeof workItemEvents.$inferInsert)["kind"], actor: string, text: string, notify?: { agentId: string; text: string }, requestKey?: string): void {
    tx.insert(workItemEvents).values({ itemId, kind, actor, text: text.slice(0, 4000), notifyAgentId: notify?.agentId ?? null, notifyText: notify?.text ?? null, createdAt: this.#now(), requestKey: requestKey ?? null }).run();
  }

  #set(tx: Tx, row: Row, patch: Partial<typeof workItems.$inferInsert>): void {
    tx.update(workItems).set({ ...patch, revision: row.revision + 1, updatedAt: this.#now() }).where(eq(workItems.id, row.id)).run();
  }

  #executorExists(agentId: string): boolean {
    return agentId === "main" || !!this.deps.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), inArray(agents.role, ["specialist", "team_member"]))).get();
  }

  create(request: CreateWorkItemRequest): WorkItemDto {
    if (!this.deps.companyMode()) throw new WorkItemError("company_only");
    const payload = JSON.stringify(request);
    return this.deps.db.transaction((tx) => {
      const previous = tx.select().from(workItems).where(eq(workItems.requestId, request.requestId)).get();
      if (previous) {
        if (previous.requestPayload !== payload) throw new WorkItemError("request_conflict");
        return this.#one(tx, previous.id);
      }
      if (!this.#executorExists(request.executorAgentId)) throw new WorkItemError("executor_missing");
      const last = tx.select({ number: workItems.number }).from(workItems).orderBy(desc(workItems.number)).get();
      const now = this.#now(), id = randomUUID();
      tx.insert(workItems).values({ id, number: (last?.number ?? 0) + 1, title: request.title, description: request.description, criteria: request.criteria, executorAgentId: request.executorAgentId, createdBy: "owner", status: "draft", deadlineAt: request.deadlineAt, createdAt: now, updatedAt: now, requestId: request.requestId, requestPayload: payload }).run();
      this.#event(tx, id, "created", "owner", "");
      if (request.start) this.#enqueue(tx, tx.select().from(workItems).where(eq(workItems.id, id)).get()!);
      return this.#one(tx, id);
    });
  }

  /** Into the executor's queue; it starts at once if the executor has nothing in work. */
  #enqueue(tx: Tx, row: Row, queuedAt = this.#now()): void {
    const waiting = tx.select({ id: workItems.id }).from(workItems).where(and(eq(workItems.executorAgentId, row.executorAgentId), eq(workItems.status, "queued"))).all();
    if (waiting.length >= MAX_QUEUED_PER_EXECUTOR) throw new WorkItemError("queue_full");
    this.#set(tx, row, { status: "queued", queuedAt });
    this.#event(tx, row.id, "queued", "panel", "");
    this.#pump(tx, row.executorAgentId);
  }

  /** Starts the executor's next queued task if it has none in work. */
  #pump(tx: Tx, executor: string): void {
    if (tx.select({ id: workItems.id }).from(workItems).where(and(eq(workItems.executorAgentId, executor), inArray(workItems.status, [...OCCUPYING]))).get()) return;
    const next = tx.select().from(workItems).where(and(eq(workItems.executorAgentId, executor), eq(workItems.status, "queued"))).orderBy(asc(workItems.queuedAt), asc(workItems.number)).get();
    if (!next) return;
    // The task keeps the conditions it started under: the executor's charter version at this moment.
    const charter = tx.select({ version: agentCharterVersions.version }).from(agentCharterVersions).where(eq(agentCharterVersions.agentId, executor)).orderBy(desc(agentCharterVersions.version)).get();
    this.#set(tx, next, { status: "running", charterVersion: charter?.version ?? 0 });
    this.#event(tx, next.id, "started", "panel", "", { agentId: executor, text: startMessage(code(next.number), next) });
  }

  act(id: string, request: WorkItemActionRequest): WorkItemDto {
    if (!this.deps.companyMode()) throw new WorkItemError("company_only");
    return this.deps.db.transaction((tx) => {
      const row = tx.select().from(workItems).where(eq(workItems.id, id)).get();
      if (!row) throw new WorkItemError("item_missing");
      if (tx.select().from(workItemEvents).where(and(eq(workItemEvents.itemId, id), eq(workItemEvents.requestKey, request.requestId))).get()) return this.#one(tx, id);
      if (row.revision !== request.revision) throw new WorkItemError("revision_conflict");
      const label = code(row.number), executor = row.executorAgentId;
      switch (request.action) {
        case "start": {
          if (row.status !== "draft" && row.status !== "failed") throw new WorkItemError("wrong_state");
          this.#event(tx, id, "queued", "owner", "", undefined, request.requestId);
          this.#enqueue(tx, row);
          break;
        }
        case "cancel": {
          if (!(OPEN as readonly string[]).includes(row.status)) throw new WorkItemError("wrong_state");
          const working = (OCCUPYING as readonly string[]).includes(row.status);
          this.#set(tx, row, { status: "cancelled" });
          this.#event(tx, id, "cancelled", "owner", request.comment, working ? { agentId: executor, text: `Владелец отменил задачу ${label} («${row.title}»). Прекрати работу над ней.${request.comment ? ` ${request.comment}` : ""}` } : undefined, request.requestId);
          if (working) this.#pump(tx, executor);
          break;
        }
        case "accept": {
          if (row.status !== "review") throw new WorkItemError("wrong_state");
          this.#set(tx, row, { status: "done" });
          this.#event(tx, id, "accepted", "owner", request.comment, { agentId: executor, text: `Владелец принял задачу ${label} («${row.title}»).${request.comment ? ` ${request.comment}` : ""}` }, request.requestId);
          break;
        }
        case "return": {
          if (row.status !== "review") throw new WorkItemError("wrong_state");
          // Back ahead of the queue (its original place in time), with the owner's comment in the start message.
          this.#set(tx, row, { returnComment: `Владелец: ${request.comment}` });
          this.#event(tx, id, "returned", "owner", request.comment, undefined, request.requestId);
          this.#enqueue(tx, { ...row, revision: row.revision + 1, returnComment: request.comment }, row.queuedAt ?? row.createdAt);
          break;
        }
        case "resume": {
          if (row.status !== "blocked") throw new WorkItemError("wrong_state");
          this.#set(tx, row, { status: "running", blockText: null, blockRequestId: null });
          this.#event(tx, id, "unblocked", "owner", request.comment, { agentId: executor, text: `Владелец решил продолжить ${label} («${row.title}») без ответа на обращение.${request.comment ? ` ${request.comment}` : ""} Продолжай работу.` }, request.requestId);
          break;
        }
      }
      return this.#one(tx, id);
    });
  }

  // --- From the requests service (same transaction as the request change) -------------------------

  /** A request filed with taskRef WI-… by that task's executor blocks the task until it is answered. */
  requestFiled(tx: Tx, request: RequestRow): void {
    const match = /^WI-(\d{1,6})$/.exec(request.taskRef.trim());
    if (!match) return;
    const row = tx.select().from(workItems).where(eq(workItems.number, Number(match[1]))).get();
    if (!row || row.executorAgentId !== request.fromAgentId || row.status !== "running") return;
    const text = `ждёт ответа на ${requestCode(request.number)} («${request.subject}»)`;
    this.#set(tx, row, { status: "blocked", blockText: text, blockRequestId: request.id });
    this.#event(tx, row.id, "blocked", request.fromAgentId, text);
  }

  /** The request a task waits for is decided: an answer continues the task; a denial or expiry leaves it for the owner. */
  requestClosed(tx: Tx, request: RequestRow): void {
    const rows = tx.select().from(workItems).where(and(eq(workItems.blockRequestId, request.id), eq(workItems.status, "blocked"))).all();
    const label = requestCode(request.number);
    for (const row of rows) {
      if (request.status === "answered") {
        this.#set(tx, row, { status: "running", blockText: null, blockRequestId: null });
        this.#event(tx, row.id, "unblocked", "panel", label, { agentId: row.executorAgentId, text: `По ${label} получен ответ: задача ${code(row.number)} («${row.title}») продолжается.` });
      } else {
        const why = request.status === "denied" ? "отказано" : request.status === "expired" ? "истёк срок" : "закрыто без ответа";
        this.#set(tx, row, { blockText: `${label}: ${why}; решение — за владельцем` });
        this.#event(tx, row.id, "blocked", "panel", `${label}: ${why}`);
      }
    }
  }

  /** clawdesk_task_report from the executor: done (with a result) → acceptance, failed → ended with the reason. */
  report(tx: Tx, agentId: string, entry: Report): { outcome: string; notify: string | null } {
    const match = typeof entry.taskId === "string" ? /^WI-(\d{1,6})$/.exec(entry.taskId) : null;
    const result = typeof entry.result === "string" ? entry.result.trim().slice(0, 4000) : "";
    if (!match || (entry.status !== "done" && entry.status !== "failed")) return { outcome: "invalid", notify: "Отчёт не принят: укажи taskId WI-…, status done или failed и результат." };
    const row = tx.select().from(workItems).where(eq(workItems.number, Number(match[1]))).get();
    if (!row) return { outcome: "missing", notify: `Задачи ${entry.taskId} нет.` };
    const label = code(row.number);
    if (row.executorAgentId !== agentId) return { outcome: `refused:${label}`, notify: `${label} — не твоя задача, отчитаться по ней может только исполнитель.` };
    if (row.status !== "running" && row.status !== "blocked") return { outcome: `wrong_state:${label}`, notify: `${label} сейчас не в работе (${row.status}); отчёт не нужен.` };
    if (!result) return { outcome: `no_result:${label}`, notify: `Отчёт по ${label} не принят: «сделано» без результата не засчитывается. Опиши, что сделано и где это посмотреть.` };
    // The executor's team lead accepts first (the owner can decide too); without a lead, the owner.
    const lead = entry.status === "done" ? this.#lead(tx, row.executorAgentId) : null;
    if (entry.status === "done") {
      this.#set(tx, row, { status: "review", result, blockText: null, blockRequestId: null });
      this.#event(tx, row.id, "reported", agentId, result, lead ? { agentId: lead, text: leadMessage(label, this.#name(row.executorAgentId), row, result) } : undefined);
    } else {
      this.#set(tx, row, { status: "failed", result, blockText: null, blockRequestId: null });
      this.#event(tx, row.id, "failed", agentId, result);
    }
    this.#pump(tx, row.executorAgentId);
    return { outcome: `${entry.status}:${label}`, notify: entry.status === "done" ? (lead ? `Отчёт по ${label} принят и передан на приёмку тимлиду (${this.#name(lead)}); владелец тоже может решить.` : `Отчёт по ${label} принят и передан владельцу на приёмку.`) : `${label} отмечена как не выполненная; владелец увидит причину.` };
  }

  /** The lead of the agent's team, when there is one and it is someone else that still exists. */
  #lead(tx: Tx, agentId: string): string | null {
    const agent = tx.select().from(agents).where(eq(agents.id, agentId)).get();
    const team = agent?.teamId ? tx.select().from(teams).where(eq(teams.id, agent.teamId)).get() : undefined;
    const lead = team?.leadAgentId;
    return lead && lead !== agentId && tx.select({ id: agents.id }).from(agents).where(eq(agents.id, lead)).get() ? lead : null;
  }

  /**
   * clawdesk_task_review from a team lead: accept (done) or return (back to the executor with the comment), the
   * same as the owner's buttons. Only the current lead of the executor's team, and only while the task is in review.
   */
  review(tx: Tx, agentId: string, entry: Review): { outcome: string; notify: string | null } {
    const match = typeof entry.taskId === "string" ? /^WI-(\d{1,6})$/.exec(entry.taskId) : null;
    const comment = typeof entry.comment === "string" ? entry.comment.trim().slice(0, 2000) : "";
    if (!match || (entry.decision !== "accept" && entry.decision !== "return") || !comment) return { outcome: "invalid", notify: "Решение не принято: укажи taskId WI-…, decision accept или return и комментарий." };
    const row = tx.select().from(workItems).where(eq(workItems.number, Number(match[1]))).get();
    if (!row) return { outcome: "missing", notify: `Задачи ${entry.taskId} нет.` };
    const label = code(row.number);
    if (this.#lead(tx, row.executorAgentId) !== agentId) return { outcome: `refused:${label}`, notify: `${label}: принять или вернуть её может только тимлид команды исполнителя или владелец.` };
    if (row.status !== "review") return { outcome: `wrong_state:${label}`, notify: `${label} сейчас не ждёт приёмки (${row.status}).` };
    const by = this.#name(agentId);
    if (entry.decision === "accept") {
      this.#set(tx, row, { status: "done" });
      this.#event(tx, row.id, "accepted", agentId, comment, { agentId: row.executorAgentId, text: `Тимлид ${by} принял задачу ${label} («${row.title}»). ${comment}` });
      return { outcome: `accepted:${label}`, notify: `${label} принята. Исполнитель узнает об этом.` };
    }
    this.#set(tx, row, { returnComment: `${by}: ${comment}` });
    this.#event(tx, row.id, "returned", agentId, comment);
    this.#enqueue(tx, { ...row, revision: row.revision + 1, returnComment: `${by}: ${comment}` }, row.queuedAt ?? row.createdAt);
    return { outcome: `returned:${label}`, notify: `${label} возвращена исполнителю с твоим замечанием.` };
  }

  /** Sends pending messages to executors (event ID as the idempotency key). */
  async deliver(): Promise<number> {
    const { send, db } = this.deps;
    if (!send) return 0;
    let sent = 0;
    for (const event of db.select().from(workItemEvents).where(and(isNull(workItemEvents.deliveredAt), lt(workItemEvents.attempts, MAX_ATTEMPTS))).orderBy(asc(workItemEvents.id)).limit(50).all().filter((item) => item.notifyAgentId)) {
      try {
        await send(event.notifyAgentId!, event.notifyText!, `clawdesk-task-event-${event.id}`);
        db.update(workItemEvents).set({ deliveredAt: this.#now(), attempts: event.attempts + 1 }).where(eq(workItemEvents.id, event.id)).run();
        sent++;
      } catch { db.update(workItemEvents).set({ attempts: event.attempts + 1 }).where(eq(workItemEvents.id, event.id)).run(); }
    }
    return sent;
  }
}

/** The lead's assignment: a team member says a task is done; the lead checks it against the criteria. */
function leadMessage(label: string, executor: string, row: Row, result: string): string {
  return [
    `Задача ${label} «${row.title}» — ${executor} сообщает, что сделано. Ты тимлид: проверь результат.`,
    `Что нужно было сделать: ${row.description}`,
    `Критерии приёмки: ${row.criteria}`,
    `Результат: ${result}`,
    "",
    `Реши инструментом clawdesk_task_review: taskId «${label}», decision accept (что проверил) или return (что исправить). Владелец тоже может решить сам.`,
  ].join("\n");
}

function startMessage(label: string, row: Row): string {
  return [
    `Задача ${label} от владельца: «${row.title}».`,
    `Что сделать: ${row.description}`,
    `Критерии приёмки: ${row.criteria}`,
    row.deadlineAt ? `Срок: ${new Date(row.deadlineAt).toISOString().slice(0, 16).replace("T", " ")} UTC.` : null,
    row.returnComment ? `Работу вернули с замечанием: ${row.returnComment}` : null,
    "",
    `Когда закончишь, сообщи результат инструментом clawdesk_task_report: taskId «${label}», status done и что сделано (где посмотреть результат), или status failed и почему не получилось. «Сделано» без результата не засчитывается; принимает тимлид твоей команды или владелец.`,
    `Если чего-то не хватает (сведений, решения, доступа), подай обращение clawdesk_request_up с taskRef «${label}»: задача подождёт ответа и продолжится, когда он придёт.`,
  ].filter((line): line is string => typeof line === "string").join("\n");
}
