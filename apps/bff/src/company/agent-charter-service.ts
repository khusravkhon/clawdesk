import { AgentCharterFields, CHARTER_FIELDS, charterExpands, type AgentCharterDto, type AgentCharterFileState, type AgentPowersDto, type RepairAgentCharterRequest, type RestoreAgentCharterRequest, type SaveAgentCharterRequest } from "@clawdesk/shared";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agentCharterVersions, agents, agentSourceGrants, dataSources, departmentManagers, resourceGrants, teams } from "../db/schema.js";

// Stage 4: an agent's charter (see @clawdesk/shared agent-charter). Versions are kept; the current one is
// the latest. The panel writes it into AGENTS.md between markers and puts it back whenever the block no
// longer matches (after the owner edits the files, on a timer, on request), so an agent that rewrites its
// own file does not loosen its limits. Widening needs the owner's explicit word; tightening applies at once.

export class AgentCharterError extends Error {
  constructor(readonly code: "agent_missing" | "version_conflict" | "version_missing" | "expansion_confirmation_required" | "request_conflict" | "gateway_unavailable") { super(code); }
}

type Gateway = { request<T>(method: string, params: unknown): Promise<T> };
const FILE = "AGENTS.md";
type VersionRow = typeof agentCharterVersions.$inferSelect;
const START = "<!-- clawdesk:charter -->", END = "<!-- /clawdesk:charter -->";

/** What applies before the owner saves anything: unspecified freedom is no freedom for external actions. */
export const DEFAULT_CHARTER: AgentCharterFields = AgentCharterFields.parse({
  forbidden: "Внешние действия — публикации, письма и сообщения людям вне компании, платежи, изменение или удаление чужих данных — без одобрения владельца.",
  askPermission: "Перед любым действием за пределами своей рабочей папки, перед расходами и перед тем, что нельзя отменить.",
  escalateTo: "По структуре компании: тимлид, руководитель отдела, главный агент, владелец — обращением, а не в обход.",
  verifyBy: "Результат подтверждён файлом, тестом или ответом владельца; без подтверждения работа не считается выполненной.",
});

const LABELS: Record<keyof AgentCharterFields, string> = {
  responsibleFor: "За что отвечаешь", mustDo: "Что должен делать", mayDo: "Что можешь делать", forbidden: "Что запрещено",
  askPermission: "Когда спрашивать разрешение", escalateTo: "Кому передавать вопрос", verifyBy: "Как проверяется результат",
};

/** The block as it stands in AGENTS.md for this version. */
export function charterBlock(version: number, fields: AgentCharterFields): string {
  const body = CHARTER_FIELDS.filter((field) => fields[field].trim()).map((field) => `**${LABELS[field]}:**\n${fields[field].trim()}`);
  return [
    START,
    `## Обязанности и ограничения (версия ${version}, задаёт владелец в панели)`,
    "",
    ...body.flatMap((part) => [part, ""]),
    "Эти условия задаёт владелец. Текст описывает работу и не выдаёт доступов: доступ к папкам, документам и сервисам есть только тот, что выдан в панели. Не меняй этот блок — панель восстановит его; если условие мешает задаче, подай обращение.",
    END,
  ].join("\n");
}

/** AGENTS.md with the block replaced (or appended), everything else kept as is. */
export function withBlock(text: string, block: string): string {
  const start = text.indexOf(START), end = text.indexOf(END);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + END.length);
  return (text.trimEnd() ? `${text.trimEnd()}\n\n` : "") + block + "\n";
}

export function blockOf(text: string): string | null {
  const start = text.indexOf(START), end = text.indexOf(END);
  return start >= 0 && end > start ? text.slice(start, end + END.length) : null;
}

export class AgentCharterService {
  constructor(private readonly deps: { db: Db; gateway: Gateway; logger: Logger }) {}

  #agent(agentId: string) {
    // The main agent may have no panel row yet (it is created by OpenClaw, not by the builder).
    if (agentId === "main") this.deps.db.insert(agents).values({ id: "main", role: "main", displayName: "Главный агент", status: "ready", sandbox: false }).onConflictDoNothing().run();
    const row = this.deps.db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!row) throw new AgentCharterError("agent_missing");
    return row;
  }

  #current(agentId: string): VersionRow | null {
    return this.deps.db.select().from(agentCharterVersions).where(eq(agentCharterVersions.agentId, agentId)).orderBy(desc(agentCharterVersions.version)).get() ?? null;
  }

  /** The version an agent works under now (0: defaults), e.g. for a task that starts. */
  currentVersion(agentId: string): number {
    return this.#current(agentId)?.version ?? 0;
  }

  async get(agentId: string): Promise<AgentCharterDto> {
    const row = this.#agent(agentId);
    const current = this.#current(agentId);
    const history = this.deps.db.select().from(agentCharterVersions).where(eq(agentCharterVersions.agentId, agentId)).orderBy(asc(agentCharterVersions.version)).all();
    return {
      agentId, name: row.displayName, version: current?.version ?? 0, source: current?.source ?? "default", fields: current?.fields ?? DEFAULT_CHARTER,
      history: history.map((item) => ({ version: item.version, source: item.source, note: item.note, createdAt: item.createdAt, fields: item.fields })),
      file: await this.#fileState(agentId, current), powers: this.#powers(row),
    };
  }

  async #fileState(agentId: string, current: VersionRow | null): Promise<AgentCharterFileState> {
    if (!current) return "ok";
    let text: string;
    try { text = await this.#read(agentId); } catch { return "unavailable"; }
    const block = blockOf(text);
    if (block === null) return "missing";
    return block === charterBlock(current.version, current.fields) ? "ok" : "changed";
  }

  #powers(row: typeof agents.$inferSelect): AgentPowersDto {
    const { db } = this.deps;
    const folder = db.select({ name: dataSources.connectorRef }).from(agentSourceGrants).innerJoin(dataSources, eq(agentSourceGrants.sourceId, dataSources.id))
      .where(and(eq(agentSourceGrants.agentId, row.id), eq(dataSources.kind, "folder"))).get()?.name ?? null;
    const grants = db.select().from(resourceGrants).where(and(eq(resourceGrants.agentId, row.id), isNull(resourceGrants.revokedAt))).all().map((grant) => ({ resource: grant.resource, access: grant.access }));
    const team = row.teamId ? db.select().from(teams).where(eq(teams.id, row.teamId)).get() : undefined;
    return {
      sandbox: row.role === "main" ? false : row.sandbox, canAskMain: row.canAskMain, folder, grants, team: team?.name ?? null,
      lead: !!db.select({ id: teams.id }).from(teams).where(eq(teams.leadAgentId, row.id)).get(),
      manager: !!db.select().from(departmentManagers).where(eq(departmentManagers.agentId, row.id)).get(),
    };
  }

  async #read(agentId: string): Promise<string> {
    return (await this.deps.gateway.request<{ file?: { content?: string } }>("agents.files.get", { agentId, name: FILE })).file?.content ?? "";
  }

  /** Writes the current version's block into AGENTS.md when it differs; nothing to do before a first save. */
  async apply(agentId: string): Promise<boolean> {
    const current = this.#current(agentId);
    if (!current) return false;
    const text = await this.#read(agentId);
    const block = charterBlock(current.version, current.fields);
    if (blockOf(text) === block) return false;
    await this.deps.gateway.request("agents.files.set", { agentId, name: FILE, content: withBlock(text, block) });
    this.deps.logger.info({ agentId, version: current.version }, "agent charter written to AGENTS.md");
    return true;
  }

  async save(agentId: string, request: SaveAgentCharterRequest): Promise<AgentCharterDto> {
    this.#agent(agentId);
    return this.#commit(agentId, request.requestId, request.baseVersion, request.fields, "owner", request.note, request.confirmExpansion);
  }

  /** A new version with an earlier version's text: the history keeps every step. */
  async restore(agentId: string, request: RestoreAgentCharterRequest): Promise<AgentCharterDto> {
    this.#agent(agentId);
    const old = this.deps.db.select().from(agentCharterVersions).where(and(eq(agentCharterVersions.agentId, agentId), eq(agentCharterVersions.version, request.version))).get();
    const replay = this.#replay(agentId, request.requestId);
    if (replay) return replay;
    if (!old) throw new AgentCharterError("version_missing");
    return this.#commit(agentId, request.requestId, request.baseVersion, old.fields, "restore", `версия ${old.version}`, request.confirmExpansion);
  }

  async repair(agentId: string, _request: RepairAgentCharterRequest): Promise<AgentCharterDto> {
    this.#agent(agentId);
    try { await this.apply(agentId); } catch { throw new AgentCharterError("gateway_unavailable"); }
    return this.get(agentId);
  }

  #replay(agentId: string, requestId: string): Promise<AgentCharterDto> | null {
    const previous = this.deps.db.select().from(agentCharterVersions).where(and(eq(agentCharterVersions.agentId, agentId), eq(agentCharterVersions.requestId, requestId))).get();
    return previous ? this.get(agentId) : null;
  }

  async #commit(agentId: string, requestId: string, baseVersion: number, fields: AgentCharterFields, source: "owner" | "restore", note: string, confirmExpansion?: boolean): Promise<AgentCharterDto> {
    const replay = this.#replay(agentId, requestId);
    if (replay) return replay;
    this.deps.db.transaction((tx) => {
      const current = tx.select().from(agentCharterVersions).where(eq(agentCharterVersions.agentId, agentId)).orderBy(desc(agentCharterVersions.version)).get();
      const version = current?.version ?? 0;
      if (version !== baseVersion) throw new AgentCharterError("version_conflict");
      if (charterExpands(current?.fields ?? DEFAULT_CHARTER, fields) && confirmExpansion !== true) throw new AgentCharterError("expansion_confirmation_required");
      tx.insert(agentCharterVersions).values({ agentId, version: version + 1, fields, source, note, createdAt: Date.now(), requestId }).run();
    });
    // The record is the truth; the file follows now or at the next sweep.
    await this.apply(agentId).catch((error: Error) => this.deps.logger.warn({ err: error, agentId }, "could not write the agent charter now; the next sweep retries"));
    return this.get(agentId);
  }

  /** Puts every saved charter back into its agent's AGENTS.md where it no longer matches. */
  async sweep(): Promise<number> {
    const ids = [...new Set(this.deps.db.select({ agentId: agentCharterVersions.agentId }).from(agentCharterVersions).all().map((row) => row.agentId))];
    let fixed = 0;
    for (const agentId of ids) {
      if (!this.deps.db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).get()) continue;
      try { if (await this.apply(agentId)) fixed++; }
      catch (error) { this.deps.logger.warn({ err: error, agentId }, "could not check the agent charter"); }
    }
    return fixed;
  }
}
