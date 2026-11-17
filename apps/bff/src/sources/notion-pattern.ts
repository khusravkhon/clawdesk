import { randomUUID } from "node:crypto";
import type { NotionPattern, NotionPatternDto, SaveNotionPatternRequest } from "@clawdesk/shared";
import { and, eq, ne } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agents, schedules } from "../db/schema.js";
import { getSetting, putSetting } from "../db/settings.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { allCronJobs } from "../schedules/schedule-rows.js";

// How the owner's data in Notion is organised (data sources screen). The owner picks a pattern once; the
// panel then writes the same rules into every agent: the main agent keeps Notion in that structure (it is
// the only agent with Notion), juniors that may ask it hand their results over to be filed. Optional
// scheduled runs of the main agent send a daily digest of tasks and a weekly review.

const MAIN = "main";
const SETTING = "notion.pattern";
const START = "<!-- clawdesk:notion:start — set on the data sources screen of the ClawDesk panel -->";
const END = "<!-- clawdesk:notion:end -->";
const MAP_FILE = "notion-map.md";

type Saved = { pattern: NotionPattern | null; notes: string; digestHour: number | null; weeklyReview: boolean; jobs: { digest?: string; weekly?: string };
  /** Runs whose removal failed (Gateway down): removed on the next save or start. */
  stale: string[] };
const EMPTY: Saved = { pattern: null, notes: "", digestHour: null, weeklyReview: false, jobs: {}, stale: [] };

export class NotionPatternError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: "notion_not_connected", message: string) {
    super(message);
    this.name = "NotionPatternError";
  }
}

const TITLES: Record<NotionPattern, string> = {
  second_brain: "Second Brain",
  tasks_notes: "Задачи и заметки",
  custom: "своя структура владельца",
};

const STRUCTURE: Record<Exclude<NotionPattern, "custom">, string[]> = {
  second_brain: [
    "- **Входящие** — всё новое, когда неясно, куда это положить. Потом разносится по местам.",
    "- **Сферы** — постоянные области жизни (работа, здоровье, финансы, путешествия…). Новую сферу создавай, только если ни одна не подходит, и скажи об этом владельцу.",
    "- **Проекты** — у проекта есть цель и срок, он связан со сферой. Статусы бери из базы владельца (например: Начинать → Запланирован → В процессе → Готов).",
    "- **Задачи** — конкретный шаг: связан с проектом, со сроком, если он есть.",
    "- **Заметки** — идеи, сценарии, планы, конспекты; связывай с проектом или сферой.",
    "- **Источники** — ссылки, видео, статьи, книги; новые — со статусом «проверить».",
    "- **Архив** — законченное и неактуальное. Ничего не удаляй — переноси в архив.",
    "",
    "Цепочка: сфера → проект → задачи и заметки. Пример: «хочу снять видео на YouTube о …» → сфера «Соцсети» (нет — предложи создать) →",
    "проект «YouTube-канал …» → заметка со сценарием и идеями → задача «снять видео» со сроком.",
  ],
  tasks_notes: [
    "- **Задачи** — что сделать: статус и срок, если он есть.",
    "- **Заметки** — идеи, планы, сценарии, материалы.",
    "- **Проекты** (если они есть у владельца) — объединяют задачи и заметки одной цели.",
  ],
};

/** Rules for the main agent, the only one with Notion. */
export function mainBlock(saved: Saved): string | null {
  if (!saved.pattern) return null;
  // The block's markers stay unique: notes can not end the block early.
  const notes = saved.notes.replace(/<!--|-->/g, "").trim();
  const structure = saved.pattern === "custom"
    ? ["Владелец описал свою структуру так:", "", ...notes.split("\n").map((line) => `> ${line}`)]
    : [...STRUCTURE[saved.pattern], ...(notes ? ["", "Уточнения владельца:", "", ...notes.split("\n").map((line) => `> ${line}`)] : [])];
  return [
    START,
    "## Notion: как устроены данные владельца (ClawDesk)",
    "",
    `Владелец выбрал в панели шаблон «${TITLES[saved.pattern]}». Всё, что записываешь в Notion, клади по этому шаблону.`,
    "",
    ...structure,
    "",
    "### Правила",
    "",
    `1. **Карта.** Перед первой работой с Notion найди базы и страницы шаблона и запиши карту в файл \`${MAP_FILE}\` в своей рабочей папке:`,
    "   название, ссылка или ID, главные свойства (статусы, связи, даты). Дальше бери адреса из карты; если по карте что-то не находится — найди заново и обнови карту.",
    "   Если какой-то базы шаблона у владельца нет — предложи её создать и создавай только после его согласия.",
    "2. Не меняй устройство баз (свойства, статусы, связи) и не удаляй страницы без согласия владельца.",
    "3. Перед тем как создать страницу, проверь, нет ли такой же: дополняй её, не плоди дубли.",
    "4. После записи скажи владельцу, что и куда записано (раздел → страница, со ссылкой).",
    "5. Младшие агенты в Notion сами не пишут: они присылают «Запиши в Notion: …». Запиши по этим правилам и ответь, куда записал.",
    "   Данные из Notion (расходы, задачи, заметки) отдавай им по запросу — только то, что относится к их теме.",
    "6. Этот блок задаёт панель ClawDesk, не меняй его: владелец меняет шаблон на экране «Источники данных».",
    END,
  ].join("\n");
}

/** Rules for a junior that may ask the main agent. */
export function juniorBlock(pattern: NotionPattern | null): string | null {
  if (!pattern) return null;
  return [
    START,
    "## Notion владельца (ClawDesk)",
    "",
    `Владелец ведёт свои данные в Notion по шаблону «${TITLES[pattern]}». Notion ведёт главный ассистент.`,
    "",
    "- Когда результат стоит сохранить (план, сценарий, идея, задача со сроком, итог разбора), вызови `clawdesk_ask_main` с вопросом:",
    "  «Запиши в Notion: <что> — <куда по смыслу: сфера, проект, задача или заметка>». Владельцу скажи, куда записано, по ответу главного.",
    "- Нужны данные из Notion по твоей теме (расходы, задачи, заметки) — проси у главного так же.",
    "- Даже если у тебя есть свои инструменты Notion, записывай через главного: так структура не разъедется.",
    "- Свою копию результата храни у себя, как обычно.",
    END,
  ].join("\n");
}

/** The text with the Notion block replaced, added at the end, or removed (block null). */
export function setNotionBlock(text: string, block: string | null): string {
  const start = text.indexOf(START);
  if (start >= 0) {
    // The last end marker after the start; without one (deleted by hand) the block ran to the end of the file.
    const end = text.lastIndexOf(END);
    const before = text.slice(0, start).trimEnd();
    const after = end > start ? text.slice(end + END.length).trimStart() : "";
    const parts = [before, block ?? "", after].filter(Boolean);
    return parts.length ? `${parts.join("\n\n")}\n` : "";
  }
  if (!block) return text;
  return text.trimEnd() ? `${text.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

/** The junior block for a new agent, when the owner chose a pattern. */
export function juniorBlockFor(db: Db): string | null {
  return juniorBlock(getSetting<Saved>(db, SETTING)?.pattern ?? null);
}

const DIGEST_PROMPT =
  "Утренняя сводка из Notion по правилам блока «Notion: как устроены данные владельца»: задачи на сегодня, просроченные и со сроком в ближайшие 2 дня — " +
  "коротко, по проектам, самое срочное первым. В Notion ничего не меняй. Если задач нет — скажи это одной строкой.";
const WEEKLY_PROMPT =
  "Недельный обзор Notion по правилам блока «Notion: как устроены данные владельца»: что лежит неразобранным (во Входящих, если они есть) и куда это разнести, " +
  "проекты без движения больше недели, задачи без срока и просроченные. Предложи действия списком; ничего не переноси и не удаляй без ответа владельца.";

type Delivery = { mode: string; channel?: string; to?: string; bestEffort?: boolean };
export type NotionPatternDeps = {
  gateway: Pick<GatewayService, "request">;
  db: Db;
  logger: Logger;
  connected: () => Promise<boolean>;
  timeZone: () => string;
  /** The owner's Telegram chat for scheduled results; null: they stay in the agent's sessions. */
  delivery: () => Delivery | null;
  /** Sends the main agent a message (it builds the map right away instead of at the first task). */
  tellMain?: (message: string, idempotencyKey: string) => Promise<void>;
  /** Throws when the spending limit does not allow automatic work; called before a run is added. */
  guard?: () => Promise<void>;
};

type Kind = "digest" | "weekly";
const LABELS: Record<Kind, string> = { digest: "Notion: задачи на сегодня", weekly: "Notion: обзор недели" };
const PROMPTS: Record<Kind, string> = { digest: DIGEST_PROMPT, weekly: WEEKLY_PROMPT };

export class NotionPatternService {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: NotionPatternDeps) {}

  /** The saved choice; a run deleted elsewhere (schedules screen, the agent) shows as off. */
  async get(): Promise<NotionPatternDto> {
    return this.#locked(async () => this.#dto(await this.#current()));
  }

  async save(req: SaveNotionPatternRequest): Promise<NotionPatternDto> {
    return this.#locked(() => this.#save(req));
  }

  /** Notion was disconnected: rules and scheduled runs that need it go away. */
  async clear(): Promise<void> {
    await this.#locked(async () => {
      const saved = this.#saved();
      if (saved.pattern || Object.values(saved.jobs).some(Boolean) || saved.stale.length) await this.#save({ pattern: null, notes: "", digestHour: null, weeklyReview: false });
    });
  }

  /**
   * On start: every agent's block follows the saved pattern and this version's text (an edited block is
   * put back), runs whose removal failed are removed, and the runs follow the space's time zone.
   */
  async refresh(): Promise<void> {
    await this.#locked(async () => {
      const saved = await this.#current();
      await this.#writeBlocks(saved);
      const tz = this.deps.timeZone();
      for (const id of Object.values(saved.jobs)) {
        const row = id ? this.deps.db.select().from(schedules).where(eq(schedules.openclawCronId, id)).get() : undefined;
        if (!id || !row || row.tz === tz) continue;
        try {
          await this.deps.gateway.request("cron.update", { id, patch: { schedule: { kind: "cron", expr: row.cron, tz } } });
          this.deps.db.update(schedules).set({ tz }).where(eq(schedules.id, row.id)).run();
        } catch (error) {
          this.deps.logger.warn({ err: error, id }, "could not move a Notion scheduled run to the space's time zone");
        }
      }
      const stale = await this.#removeStale(saved.stale);
      if (stale.length !== saved.stale.length) putSetting(this.deps.db, SETTING, { ...saved, stale });
    });
  }

  /** One change at a time: two saves at once would both add a run. */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #dto(saved: Saved): NotionPatternDto {
    return { pattern: saved.pattern, notes: saved.notes, digestHour: saved.digestHour, weeklyReview: saved.weeklyReview, agents: this.#juniors().filter((a) => a.canAskMain).length };
  }

  async #save(req: SaveNotionPatternRequest): Promise<NotionPatternDto> {
    if (req.pattern && !(await this.deps.connected())) throw new NotionPatternError("notion_not_connected", "connect Notion first");
    const before = await this.#current();
    const next: Saved = req.pattern
      ? { pattern: req.pattern, notes: req.notes, digestHour: req.digestHour, weeklyReview: req.weeklyReview, jobs: {}, stale: [] }
      : { ...EMPTY, jobs: {}, stale: [] };
    // Written after every step: a failure halfway keeps the ids of runs already added or removed.
    const progress: Saved = { ...before, jobs: { ...before.jobs }, stale: [...before.stale] };
    const steps: [Kind, string | null][] = [
      ["digest", next.pattern && next.digestHour !== null ? `0 ${next.digestHour} * * *` : null],
      ["weekly", next.pattern && next.weeklyReview ? "0 18 * * 0" : null],
    ];
    for (const [kind, expr] of steps) {
      progress.jobs[kind] = await this.#job(kind, before.jobs[kind], expr, progress.stale);
      if (kind === "digest") progress.digestHour = expr ? next.digestHour : null;
      else progress.weeklyReview = !!expr;
      putSetting(this.deps.db, SETTING, progress);
    }
    next.jobs = progress.jobs;
    next.stale = await this.#removeStale(progress.stale);
    putSetting(this.deps.db, SETTING, next);
    await this.#writeBlocks(next);
    const changed = next.pattern !== before.pattern || next.notes !== before.notes;
    if (next.pattern && changed && this.deps.tellMain) {
      await this.deps
        .tellMain(
          `Владелец выбрал в панели шаблон Notion «${TITLES[next.pattern]}» — правила в блоке «Notion: как устроены данные владельца» твоего AGENTS.md. ` +
            `Составь сейчас карту \`${MAP_FILE}\`: найди в Notion базы и страницы шаблона. Ничего в Notion не создавай и не меняй. ` +
            "Коротко ответь владельцу, что нашёл и чего не хватает (и предложи это создать).",
          randomUUID(),
        )
        .catch((error: Error) => this.deps.logger.warn({ err: error }, "could not ask the main agent to map Notion"));
    }
    this.deps.logger.info({ pattern: next.pattern, digest: next.digestHour, weekly: next.weeklyReview }, "notion pattern saved");
    return this.#dto(next);
  }

  #saved(): Saved {
    const stored = getSetting<Partial<Saved>>(this.deps.db, SETTING);
    return { ...EMPTY, ...stored, jobs: { ...stored?.jobs }, stale: [...(stored?.stale ?? [])] };
  }

  /**
   * The saved choice with runs deleted elsewhere forgotten (their rows too), when OpenClaw's list is
   * certainly whole; otherwise as stored.
   */
  async #current(): Promise<Saved> {
    const saved = this.#saved();
    const jobs = await allCronJobs(this.deps.gateway);
    if (!jobs) return saved;
    const exists = new Set(jobs.map((job) => job.id));
    let changed = false;
    for (const kind of ["digest", "weekly"] as const) {
      const id = saved.jobs[kind];
      if (!id || exists.has(id)) continue;
      this.deps.db.delete(schedules).where(eq(schedules.openclawCronId, id)).run();
      saved.jobs[kind] = undefined;
      if (kind === "digest") saved.digestHour = null;
      else saved.weeklyReview = false;
      changed = true;
    }
    const stale = saved.stale.filter((id) => exists.has(id));
    if (stale.length !== saved.stale.length) {
      saved.stale = stale;
      changed = true;
    }
    if (changed) putSetting(this.deps.db, SETTING, saved);
    return saved;
  }

  #juniors() {
    return this.deps.db.select({ id: agents.id, canAskMain: agents.canAskMain }).from(agents).where(and(ne(agents.id, MAIN), ne(agents.role, "main"))).all();
  }

  async #writeBlocks(saved: Saved): Promise<void> {
    const targets: [string, string | null][] = [[MAIN, mainBlock(saved)], ...this.#juniors().map((a): [string, string | null] => [a.id, a.canAskMain ? juniorBlock(saved.pattern) : null])];
    for (const [agentId, block] of targets) {
      try {
        const current = (await this.deps.gateway.request<{ file?: { content?: string } }>("agents.files.get", { agentId, name: "AGENTS.md" })).file?.content ?? "";
        const next = setNotionBlock(current, block);
        if (next !== current) await this.deps.gateway.request("agents.files.set", { agentId, name: "AGENTS.md", content: next });
      } catch (error) {
        // One agent the Gateway no longer has must not keep the rest without their rules.
        this.deps.logger.warn({ err: error, agentId }, "could not write the Notion rules");
      }
    }
  }

  /** Removes runs; the ids (and rows, so the limit can still pause them) of those that failed stay. */
  async #removeStale(ids: string[]): Promise<string[]> {
    const left: string[] = [];
    for (const id of ids) {
      try {
        await this.deps.gateway.request("cron.remove", { id });
        this.deps.db.delete(schedules).where(eq(schedules.openclawCronId, id)).run();
      } catch (error) {
        this.deps.logger.warn({ err: error, id }, "could not remove a Notion scheduled run; will retry");
        left.push(id);
      }
    }
    return left;
  }

  /**
   * Keeps one scheduled run in step with the choice: updated in place, added, or removed (expr null).
   * An update never turns the run on: the spending limit or the owner may have paused it.
   */
  async #job(kind: Kind, id: string | undefined, expr: string | null, stale: string[]): Promise<string | undefined> {
    const { gateway, db } = this.deps;
    if (!expr) {
      if (id) stale.push(id);
      return undefined;
    }
    const tz = this.deps.timeZone();
    const schedule = { kind: "cron", expr, tz };
    const prompt = PROMPTS[kind];
    if (id) {
      // A run deleted elsewhere was already forgotten by #current; any error here is a real failure.
      await gateway.request("cron.update", { id, patch: { displayName: LABELS[kind], schedule, payload: { kind: "agentTurn", message: prompt } } });
      db.update(schedules).set({ cron: expr, tz, prompt }).where(eq(schedules.openclawCronId, id)).run();
      return id;
    }
    await this.deps.guard?.();
    const delivery = this.deps.delivery();
    const job = await gateway.request<{ id: string }>("cron.add", {
      name: `${MAIN}:notion-${kind}`,
      displayName: LABELS[kind],
      agentId: MAIN,
      enabled: true,
      schedule,
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: prompt },
      delivery: delivery ?? { mode: "none" },
    });
    // A row lets the spending limit pause it and Telegram routing find it, like the panel's other schedules.
    if (db.select().from(agents).where(eq(agents.id, MAIN)).get()) {
      db.insert(schedules).values({
        id: randomUUID(), agentId: MAIN, cron: expr, tz, prompt,
        deliverTo: delivery?.to ? `telegram:${delivery.to}` : null, openclawCronId: job.id,
      }).run();
    }
    return job.id;
  }
}
