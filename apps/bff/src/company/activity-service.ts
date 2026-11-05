import type { ActivityCountsDto, AgentActivityDto, AgentActivityState, CompanyActivityDto } from "@clawdesk/shared";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, companyAgentAssignments, departments, teams, workItems, workRequests } from "../db/schema.js";

// Stage 9: what each company agent is doing, for the work list and the office.
//
// RunTracker follows the Gateway's events: a run is active from its first event until "final", "error" or
// "aborted". A run that sends nothing for RUN_STALE_MS is no longer counted as working (its end may have
// been missed); after a reconnect the tracker starts empty, so nothing is shown as working until an event
// says so. The projection adds tasks and requests from the database. States are only what a source
// confirms: "working" needs a run, a tool name is shown only when the run reported it.

export const RUN_STALE_MS = 10 * 60_000;
const ERROR_SHOWN_MS = 30 * 60_000;
type GatewayEvent = { event: string; payload?: unknown };
type Run = { startedAt: number; lastAt: number; tool: string | null };

export class RunTracker {
  readonly #runs = new Map<string, Map<string, Run>>();
  readonly #errors = new Map<string, { at: number; message: string }>();
  readonly #last = new Map<string, number>();
  #version = 0;
  constructor(private readonly now: () => number = Date.now) {}

  get version(): number { return this.#version; }

  /** Feeds one Gateway event; returns true if anything an agent shows changed. */
  handle(event: GatewayEvent): boolean {
    const p = (event.payload ?? {}) as { sessionKey?: unknown; runId?: unknown; state?: unknown; stream?: unknown; data?: { name?: unknown; toolName?: unknown; phase?: unknown }; errorMessage?: unknown };
    const match = typeof p.sessionKey === "string" ? /^agent:([a-z0-9][a-z0-9_-]{0,79}):/.exec(p.sessionKey) : null;
    if (!match || typeof p.runId !== "string" || (event.event !== "chat" && event.event !== "agent")) return false;
    const agentId = match[1]!, now = this.now();
    const runs = this.#runs.get(agentId) ?? new Map<string, Run>();
    this.#last.set(agentId, now);
    if (event.event === "chat" && (p.state === "final" || p.state === "error" || p.state === "aborted")) {
      runs.delete(p.runId);
      if (p.state === "error") this.#errors.set(agentId, { at: now, message: typeof p.errorMessage === "string" ? p.errorMessage.slice(0, 200) : "" });
      else this.#errors.delete(agentId);
    } else {
      const run = runs.get(p.runId) ?? { startedAt: now, lastAt: now, tool: null };
      run.lastAt = now;
      if (event.event === "agent" && p.stream === "tool") {
        const name = typeof p.data?.name === "string" ? p.data.name : typeof p.data?.toolName === "string" ? p.data.toolName : null;
        if (name && (p.data?.phase === undefined || p.data.phase === "start")) run.tool = name.slice(0, 80);
      }
      runs.set(p.runId, run);
      this.#errors.delete(agentId);
    }
    if (runs.size) this.#runs.set(agentId, runs); else this.#runs.delete(agentId);
    this.#version++;
    return true;
  }

  /** After a reconnect nothing is known to be running until the Gateway says so again. */
  reset(): void { this.#runs.clear(); this.#version++; }

  /** Active, not stale runs of an agent, the latest tool and error. */
  of(agentId: string): { runs: number; tool: string | null; error: { at: number; message: string } | null; lastAt: number | null } {
    const now = this.now();
    const runs = [...(this.#runs.get(agentId)?.values() ?? [])].filter((run) => now - run.lastAt < RUN_STALE_MS);
    const latest = runs.sort((a, b) => b.lastAt - a.lastAt)[0];
    const error = this.#errors.get(agentId);
    return { runs: runs.length, tool: latest?.tool ?? null, error: error && now - error.at < ERROR_SHOWN_MS ? error : null, lastAt: this.#last.get(agentId) ?? null };
  }
}

const code = (prefix: string, number: number) => `${prefix}-${String(number).padStart(3, "0")}`;

export class ActivityService {
  #sequence = 0;
  #lastHash = "";
  #generation: number | null = null;
  constructor(private readonly deps: {
    db: Db;
    tracker: RunTracker;
    gatewayConnected: () => boolean;
    /** The Gateway connection's generation: a new one means a reconnect, after which runs are unknown. */
    generation?: () => number;
    /** Agents the Gateway has; null when it cannot be asked (then "unknown", not "offline"). */
    liveAgents: () => Promise<Set<string> | null>;
    now?: () => number;
  }) {}

  async snapshot(): Promise<CompanyActivityDto> {
    const { db, tracker } = this.deps;
    const now = this.deps.now?.() ?? Date.now();
    const generation = this.deps.generation?.() ?? 0;
    if (this.#generation !== null && generation !== this.#generation) tracker.reset();
    this.#generation = generation;
    const connected = this.deps.gatewayConnected();
    const live = connected ? await this.deps.liveAgents().catch(() => null) : null;
    const rows = db.select().from(agents).where(inArray(agents.role, ["specialist", "team_member"])).all();
    const teamRows = new Map(db.select().from(teams).all().map((team) => [team.id, team]));
    const departmentRows = new Map(db.select().from(departments).all().map((department) => [department.id, department]));
    const assignments = new Map(db.select().from(companyAgentAssignments).all().map((row) => [row.agentId, row.departmentId]));
    const items = db.select().from(workItems).where(inArray(workItems.status, ["queued", "running", "blocked"])).all();
    const requests = db.select().from(workRequests).where(inArray(workRequests.status, ["open", "clarify"])).all();
    const name = (agentId: string | null) => agentId === null ? "владелец" : agentId === "main" ? "Главный агент" : rows.find((row) => row.id === agentId)?.displayName ?? agentId;

    const project = (agentId: string, displayName: string, role: AgentActivityDto["role"], position: string | null, teamId: string | null): AgentActivityDto => {
      const team = teamId ? teamRows.get(teamId) : undefined;
      const departmentId = assignments.get(agentId) ?? team?.departmentId ?? null;
      const department = departmentId ? departmentRows.get(departmentId) : undefined;
      const run = tracker.of(agentId);
      const mine = items.filter((item) => item.executorAgentId === agentId);
      const current = mine.find((item) => item.status === "running" || item.status === "blocked");
      const queued = mine.filter((item) => item.status === "queued").length;
      const filed = requests.filter((request) => request.fromAgentId === agentId).sort((a, b) => b.createdAt - a.createdAt)[0];
      const inbox = requests.filter((request) => request.status === "open" && request.route[request.level]?.agentId === agentId).length;
      const addressee = filed ? filed.status === "clarify" ? agentId : filed.route[filed.level]?.agentId ?? null : undefined;
      let state: AgentActivityState, detail: string;
      if (!connected) { state = "unknown"; detail = "нет связи с Gateway: состояние неизвестно"; }
      else if (live && agentId !== "main" && !live.has(agentId)) { state = "offline"; detail = "Gateway не знает этого агента"; }
      else if (run.runs > 0) { state = "working"; detail = current ? `${code("WI", current.number)} «${current.title}»` : run.runs > 1 ? `выполняет ${run.runs} запуска` : "выполняет запрос"; }
      else if (run.error) { state = "error"; detail = run.error.message ? `ошибка запуска: ${run.error.message}` : "последний запуск завершился ошибкой"; }
      else if (filed && filed.status === "clarify") { state = "waiting_for_agent"; detail = `${code("REQ", filed.number)}: у него спросили уточнение`; }
      else if (filed && addressee === null) { state = "waiting_for_owner"; detail = `ждёт решения владельца: ${code("REQ", filed.number)} «${filed.subject}»`; }
      else if (filed) { state = "waiting_for_agent"; detail = `ждёт ответа от ${name(addressee ?? null)}: ${code("REQ", filed.number)}`; }
      else if (current?.status === "blocked") { state = "blocked"; detail = current.blockText ?? "задача заблокирована"; }
      else if (queued && !current) { state = "queued"; detail = `в очереди задач: ${queued}`; }
      else { state = "idle"; detail = current ? `${code("WI", current.number)} в работе, сейчас без запуска` : "свободен"; }
      return {
        agentId, name: displayName, role, position, team: team ? { id: team.id, name: team.name } : null, department: department ? { id: department.id, name: department.name } : null,
        state, detail, action: state === "working" && run.tool ? run.tool : null, runs: run.runs,
        task: current ? { code: code("WI", current.number), title: current.title, status: current.status } : null,
        request: filed ? { code: code("REQ", filed.number), addressee: name(addressee ?? null) } : null,
        inbox, lastActivityAt: run.lastAt,
      };
    };
    const list = [project("main", "Главный агент", "main", null, null), ...rows.map((row) => project(row.id, row.displayName, row.role as AgentActivityDto["role"], row.templateId, row.teamId))];
    const counts: ActivityCountsDto = { working: 0, idle: 0, waiting: 0, blocked: 0, error: 0, offline: 0 };
    for (const agent of list) {
      if (agent.state === "working") counts.working++;
      else if (agent.state === "idle" || agent.state === "queued") counts.idle++;
      else if (agent.state === "waiting_for_agent" || agent.state === "waiting_for_owner") counts.waiting++;
      else if (agent.state === "blocked") counts.blocked++;
      else if (agent.state === "error") counts.error++;
      else counts.offline++;
    }
    // The sequence only moves when something shown changed, so a client can drop an older snapshot.
    const hash = JSON.stringify([connected, list.map((agent) => [agent.agentId, agent.state, agent.detail, agent.action, agent.runs, agent.inbox, agent.task?.code, agent.task?.status, agent.request?.code])]);
    if (hash !== this.#lastHash) { this.#lastHash = hash; this.#sequence++; }
    return { sequence: this.#sequence, generatedAt: now, gatewayConnected: connected, agents: list, counts };
  }
}
