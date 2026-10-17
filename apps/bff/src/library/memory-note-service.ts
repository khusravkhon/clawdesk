import { createHash, randomUUID } from "node:crypto";
import { MAX_MEMORY_NOTES, type MemoryNoteDto, type MemoryNotesDto, type SaveMemoryNoteRequest } from "@clawdesk/shared";
import { and, asc, eq, like } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { memoryNotes, settings } from "../db/schema.js";
import { getSetting, putSetting } from "../db/settings.js";
import type { GatewayService } from "../gateway/gateway-service.js";

// Notes the owner keeps for one agent. They live in our database, so the owner can correct or
// delete any of them, and the panel writes them into that agent's USER.md between its own markers,
// so the agent reads them as its own knowledge. Each note carries where it came from and the day
// it is about: a fact without a source is how an agent ends up repeating something wrong forever.

const START = "<!-- clawdesk:notes:start — edited in the ClawDesk panel -->";
const END = "<!-- clawdesk:notes:end -->";
const APPLIED_PREFIX = "memory.notes.applied.";
const APPLIED = (agentId: string) => `${APPLIED_PREFIX}${agentId}`;
const REVISION = (agentId: string) => `memory.notes.revision.${agentId}`;
const revision = (notes: MemoryNoteDto[]) => createHash("sha256").update(notesBlock(notes)).digest("hex");

export class MemoryNoteError extends Error {
  constructor(readonly code: "not_found" | "too_many") {
    super(code);
    this.name = "MemoryNoteError";
  }
}

/** Replaces the notes block, leaving everything the agent wrote itself untouched. */
export function upsertNotesBlock(current: string, block: string): string {
  const wrapped = block.trim() ? `${START}\n${block.trim()}\n${END}` : "";
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start >= 0 && end > start) {
    const before = current.slice(0, start);
    const after = current.slice(end + END.length);
    const joined = `${before}${wrapped}${after}`;
    return joined.replace(/\n{3,}/g, "\n\n").trim() ? `${joined.replace(/\n{3,}/g, "\n\n").trim()}\n` : "";
  }
  if (!wrapped) return current;
  const rest = current.trim();
  return rest ? `${rest}\n\n${wrapped}\n` : `${wrapped}\n`;
}

/** The block the agent reads: one line per note, each with its source and date. */
export function notesBlock(notes: MemoryNoteDto[]): string {
  if (!notes.length) return "";
  const lines = notes.map((note) => {
    const marks = [note.happenedOn, note.source].filter(Boolean).join(", ");
    return `- ${note.text}${marks ? ` (${marks})` : ""}`;
  });
  return [
    "## Что знает о владельце (ClawDesk)",
    "",
    "Это записи владельца панели: факты, источник и дата. Считай их верными,",
    "но если владелец говорит иное — верно то, что он сказал сейчас.",
    "",
    ...lines,
  ].join("\n");
}

type Deps = { db: Db; gateway: GatewayService; logger: Logger };
type Row = typeof memoryNotes.$inferSelect;

const toDto = (row: Row): MemoryNoteDto => ({
  id: row.id,
  agentId: row.agentId,
  text: row.text,
  source: row.source,
  happenedOn: row.happenedOn,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt?.getTime() ?? null,
});

export class MemoryNoteService {
  readonly #queues = new Map<string, Promise<void>>();
  #retrying: Promise<void> | null = null;
  constructor(private readonly deps: Deps) {}

  list(agentId: string): MemoryNotesDto {
    const notes = this.deps.db.select().from(memoryNotes).where(eq(memoryNotes.agentId, agentId)).orderBy(asc(memoryNotes.createdAt)).all().map(toDto);
    return { agentId, notes, applied: this.#applied(agentId, notes) };
  }

  async add(agentId: string, request: SaveMemoryNoteRequest): Promise<MemoryNotesDto> {
    return this.#serial(agentId, async () => {
      const current = this.deps.db.select({ id: memoryNotes.id }).from(memoryNotes).where(eq(memoryNotes.agentId, agentId)).all();
      if (current.length >= MAX_MEMORY_NOTES) throw new MemoryNoteError("too_many");
      this.deps.db
        .insert(memoryNotes)
        .values({ id: randomUUID(), agentId, text: request.text, source: request.source ?? null, happenedOn: request.happenedOn ?? null })
        .run();
      putSetting(this.deps.db, APPLIED(agentId), false);
      return this.#apply(agentId);
    });
  }

  async update(agentId: string, id: string, request: SaveMemoryNoteRequest): Promise<MemoryNotesDto> {
    return this.#serial(agentId, async () => {
      const changed = this.deps.db
        .update(memoryNotes)
        .set({ text: request.text, source: request.source ?? null, happenedOn: request.happenedOn ?? null, updatedAt: new Date() })
        .where(and(eq(memoryNotes.id, id), eq(memoryNotes.agentId, agentId)))
        .run();
      if (!changed.changes) throw new MemoryNoteError("not_found");
      putSetting(this.deps.db, APPLIED(agentId), false);
      return this.#apply(agentId);
    });
  }

  async remove(agentId: string, id: string): Promise<MemoryNotesDto> {
    return this.#serial(agentId, async () => {
      const changed = this.deps.db.delete(memoryNotes).where(and(eq(memoryNotes.id, id), eq(memoryNotes.agentId, agentId))).run();
      if (!changed.changes) throw new MemoryNoteError("not_found");
      putSetting(this.deps.db, APPLIED(agentId), false);
      return this.#apply(agentId);
    });
  }

  sync(agentId: string): Promise<MemoryNotesDto> {
    return this.#serial(agentId, () => this.#apply(agentId));
  }

  retryPending(): Promise<void> {
    return this.#retrying ??= this.#retryAll().finally(() => { this.#retrying = null; });
  }

  async #retryAll(): Promise<void> {
    const ids = new Set(this.deps.db.select({ id: memoryNotes.agentId }).from(memoryNotes).all().map((row) => row.id));
    for (const row of this.deps.db.select({ key: settings.key }).from(settings).where(like(settings.key, `${APPLIED_PREFIX}%`)).all()) ids.add(row.key.slice(APPLIED_PREFIX.length));
    for (const agentId of ids) {
      if (!this.list(agentId).applied) await this.sync(agentId);
    }
  }

  async drain(): Promise<void> {
    await this.#retrying?.catch(() => {});
    await Promise.all([...this.#queues.values()]);
  }

  async #serial<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const action = (this.#queues.get(agentId) ?? Promise.resolve()).then(work);
    const settled = action.then(() => {}, () => {});
    this.#queues.set(agentId, settled);
    try { return await action; } finally {
      if (this.#queues.get(agentId) === settled) this.#queues.delete(agentId);
    }
  }

  /**
   * Writes the current notes into the agent's USER.md. The file is read first, so whatever the
   * agent learned by itself stays; only the block between our markers is replaced.
   */
  async #apply(agentId: string): Promise<MemoryNotesDto> {
    const state = this.list(agentId);
    putSetting(this.deps.db, APPLIED(agentId), false);
    try {
      const file = await this.deps.gateway.request<{ file?: { content?: string } }>("agents.files.get", { agentId, name: "USER.md" });
      const content = upsertNotesBlock(file.file?.content ?? "", notesBlock(state.notes));
      await this.deps.gateway.request("agents.files.set", { agentId, name: "USER.md", content });
      this.deps.db.transaction(() => {
        putSetting(this.deps.db, REVISION(agentId), revision(state.notes));
        putSetting(this.deps.db, APPLIED(agentId), true);
      });
      this.deps.logger.info({ agentId, notes: state.notes.length }, "memory notes written to the agent");
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId }, "memory notes saved; synchronization pending");
    }
    return this.list(agentId);
  }

  /** Whether the panel has written this agent's current notes into its files. */
  #applied(agentId: string, notes: MemoryNoteDto[]): boolean {
    const applied = getSetting<boolean>(this.deps.db, APPLIED(agentId));
    return (applied === null && !notes.length) || (applied === true && getSetting<string>(this.deps.db, REVISION(agentId)) === revision(notes));
  }
}
