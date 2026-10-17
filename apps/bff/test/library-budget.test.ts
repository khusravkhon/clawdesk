import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetExceededError, BudgetService } from "../src/budget/budget-service.js";
import { openDb } from "../src/db/client.js";
import { agents, libraryItems, schedules } from "../src/db/schema.js";
import { getSetting } from "../src/db/settings.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { findSnippets, LibraryService } from "../src/library/library-service.js";
import { MemoryNoteError, MemoryNoteService, notesBlock, upsertNotesBlock } from "../src/library/memory-note-service.js";

const logger = { warn: () => {}, info: () => {}, child: () => logger } as never;

function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-stage7-"));
  const opened = openDb(path.join(dir, "panel.sqlite"));
  return { ...opened, cleanup: () => { opened.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

describe("the owner's library (screen 9)", () => {
  it("finds a Russian phrase whatever its case, and points at the source", () => {
    const { db: database, cleanup } = db();
    try {
      const library = new LibraryService(database);
      library.add({ agentId: "accountant", kind: "document", title: "budget.xlsx", source: "budget.xlsx", locator: "лист", text: "## Бюджет\nA1: Аренда офиса\nB1: 48000 рублей за октябрь" });
      library.add({ agentId: "trainer", kind: "video", title: "Приседания", source: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", locator: "таймкод", text: "[0:45] Держите спину ровно и не сводите колени" });

      const found = library.search("АРЕНДА");
      expect(found.hits).toHaveLength(1);
      expect(found.hits[0]).toMatchObject({ agentId: "accountant", kind: "document", source: "budget.xlsx", locator: "лист" });
      expect(found.hits[0]!.snippets[0]!.text).toContain("Аренда офиса");
      expect(found.searched).toBe(1);
      expect(found.partial).toBe(false);

      // A search for one agent never reaches another agent's materials.
      expect(library.search("аренда", "trainer").hits).toEqual([]);
      expect(library.search("спину", "trainer").hits).toHaveLength(1);
      // An empty query finds nothing and does not read material texts.
      expect(library.search("  ").hits).toEqual([]);
      expect(library.search("  ").searched).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("keeps nothing empty, lists what is recent and lets the owner prune it", () => {
    const { db: database, cleanup } = db();
    try {
      const library = new LibraryService(database);
      expect(library.add({ agentId: "main", kind: "document", title: "empty.txt", source: "empty.txt", text: "   " })).toBeNull();
      const id = library.add({ agentId: "main", kind: "document", title: "note.txt", source: "note.txt", text: "важное" })!;
      expect(library.recent("main")).toHaveLength(1);
      expect(library.recent("trainer")).toEqual([]);
      expect(library.remove(id)).toBe(true);
      expect(library.remove(id)).toBe(false);
      expect(database.select().from(libraryItems).all()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("returns pieces around each match, without overlapping them", () => {
    const text = `${"а".repeat(300)} искомое слово ${"б".repeat(300)} искомое снова`;
    const snippets = findSnippets(text, "искомое");
    expect(snippets).toHaveLength(2);
    expect(snippets[0]!.text).toContain("искомое слово");
    expect(snippets[1]!.from).toBeGreaterThan(snippets[0]!.from);
    expect(findSnippets("нет такого", "искомое")).toEqual([]);
  });
});

describe("notes the owner keeps for an agent (screen 4)", () => {
  function harness() {
    const { db: database, cleanup } = db();
    const files = new Map<string, string>();
    const gateway = {
      request: async (method: string, params: Record<string, unknown>) => {
        const key = `${params.agentId}:${params.name}`;
        if (method === "agents.files.get") return { file: { content: files.get(key) ?? "" } };
        if (method === "agents.files.set") files.set(key, String(params.content));
        return {};
      },
    } as unknown as GatewayService;
    return { notes: new MemoryNoteService({ db: database, gateway, logger }), db: database, files, cleanup };
  }

  it("writes the notes into the agent's USER.md with their source and date, keeping its own text", async () => {
    const { notes, files, db: database, cleanup } = harness();
    try {
      files.set("trainer:USER.md", "# USER.md\n\nЧто агент выучил сам: любит плавание.\n");
      await notes.add("trainer", { text: "Болит левое колено", source: "разговор 14 октября", happenedOn: "2026-10-14" });
      const state = await notes.add("trainer", { text: "Тренируется по вторникам" });

      expect(state.notes).toHaveLength(2);
      expect(state.applied).toBe(true);
      expect(getSetting<boolean>(database, "memory.notes.applied.trainer")).toBe(true);
      const file = files.get("trainer:USER.md")!;
      expect(file).toContain("Что агент выучил сам: любит плавание.");
      expect(file).toContain("- Болит левое колено (2026-10-14, разговор 14 октября)");
      expect(file).toContain("- Тренируется по вторникам");
      expect(file).toContain("Это записи владельца панели");
    } finally {
      cleanup();
    }
  });

  it("corrects and deletes a note, and takes the block away with the last one", async () => {
    const { notes, files, cleanup } = harness();
    try {
      files.set("trainer:USER.md", "# USER.md\n\nСвоё знание агента.\n");
      const added = await notes.add("trainer", { text: "Болит правое колено" });
      const id = added.notes[0]!.id;

      const corrected = await notes.update("trainer", id, { text: "Болит левое колено", source: "уточнил владелец" });
      expect(corrected.notes[0]).toMatchObject({ text: "Болит левое колено", source: "уточнил владелец" });
      expect(corrected.notes[0]!.updatedAt).not.toBeNull();
      expect(files.get("trainer:USER.md")).toContain("- Болит левое колено (уточнил владелец)");
      expect(files.get("trainer:USER.md")).not.toContain("правое");

      await notes.remove("trainer", id);
      const file = files.get("trainer:USER.md")!;
      expect(file).toContain("Своё знание агента.");
      expect(file).not.toContain("clawdesk:notes");
      await expect(notes.remove("trainer", id)).rejects.toBeInstanceOf(MemoryNoteError);
      await expect(notes.update("trainer", id, { text: "ничего" })).rejects.toBeInstanceOf(MemoryNoteError);
    } finally {
      cleanup();
    }
  });

  it("replaces only its own block and never touches the profile block next to it", () => {
    const profile = "<!-- clawdesk:start — edited in the ClawDesk panel -->\nПрофиль\n<!-- clawdesk:end -->";
    const first = upsertNotesBlock(`${profile}\n\nСвоё знание.\n`, notesBlock([{ id: "1", agentId: "a", text: "Факт", source: null, happenedOn: null, createdAt: 0, updatedAt: null }]));
    expect(first).toContain(profile);
    expect(first).toContain("- Факт");

    const second = upsertNotesBlock(first, notesBlock([{ id: "1", agentId: "a", text: "Другой факт", source: null, happenedOn: null, createdAt: 0, updatedAt: null }]));
    expect(second).toContain(profile);
    expect(second).toContain("- Другой факт");
    expect(second).not.toContain("- Факт\n");
    // Two writes do not leave two blocks behind.
    expect(second.match(/clawdesk:notes:start/g)).toHaveLength(1);
  });
});

describe("spending limits (screen 13)", () => {
  function harness(cost: Record<string, number>, options: { cronFails?: boolean } = {}) {
    const { db: database, cleanup } = db();
    const cron: { id: string; enabled: boolean }[] = [];
    const gateway = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "sessions.usage") {
          return { aggregates: { daily: Object.entries(cost).map(([date, value]) => ({ date, tokens: 100, cost: value })) }, totals: { totalCost: 0, totalTokens: 0 } };
        }
        if (method === "cron.update") {
          if (options.cronFails) throw new Error("gateway refused");
          cron.push({ id: String(params.id), enabled: (params.patch as { enabled: boolean }).enabled });
        }
        return {};
      },
    } as unknown as GatewayService;
    return { budget: new BudgetService({ gateway, db: database, logger }), db: database, cron, cleanup };
  }

  const TODAY = "2026-10-16T12:00:00Z";
  const day = (iso: string) => new Date(iso).getTime();

  it("reports what was spent today and this month, in the owner's time zone", async () => {
    const { budget, cleanup } = harness({ "2026-10-16": 1.5, "2026-10-15": 2.25, "2026-09-30": 10 });
    try {
      const status = await budget.status("UTC", day(TODAY));
      expect(status.spentTodayUsd).toBeCloseTo(1.5);
      // September is a different month and is not counted in.
      expect(status.spentMonthUsd).toBeCloseTo(3.75);
      expect(status).toMatchObject({ dailyUsd: 0, monthlyUsd: 0, exceeded: false, reason: "none", pausedSchedules: 0 });
    } finally {
      cleanup();
    }
  });

  it("pauses the panel's own schedules at the limit and brings exactly those back", async () => {
    const { budget, db: database, cron, cleanup } = harness({ "2026-10-16": 5 });
    try {
      // A schedule belongs to an agent, so the agent row has to be there first.
      database.insert(agents).values({ id: "trainer", displayName: "Тренер", role: "specialist", canAskMain: false, status: "ready" }).run();
      database.insert(schedules).values({ id: "s1", agentId: "trainer", cron: "0 8 * * *", tz: "UTC", prompt: "Утро", openclawCronId: "cron-1", enabled: true }).run();
      database.insert(schedules).values({ id: "s2", agentId: "trainer", cron: "0 20 * * *", tz: "UTC", prompt: "Вечер", openclawCronId: "cron-2", enabled: false }).run();
      database.insert(schedules).values({ id: "s3", agentId: "trainer", cron: "0 9 * * *", tz: "UTC", prompt: "Без задания", openclawCronId: null, enabled: true }).run();

      const over = await budget.save({ dailyUsd: 3, monthlyUsd: 0 }, "UTC", day(TODAY));
      expect(over).toMatchObject({ exceeded: true, reason: "daily", pausedSchedules: 1 });
      // Only the enabled job the panel created was touched; the owner's own disabled one was not.
      expect(cron).toEqual([{ id: "cron-1", enabled: false }]);
      await expect(budget.guard("UTC", day(TODAY))).rejects.toBeInstanceOf(BudgetExceededError);

      const under = await budget.save({ dailyUsd: 10, monthlyUsd: 0 }, "UTC", day(TODAY));
      expect(under).toMatchObject({ exceeded: false, pausedSchedules: 0 });
      expect(cron).toEqual([
        { id: "cron-1", enabled: false },
        { id: "cron-1", enabled: true },
      ]);
      await budget.guard("UTC", day(TODAY));
    } finally {
      cleanup();
    }
  });

  it("holds a job it could not pause, so it is tried again instead of being forgotten", async () => {
    const { budget, db: database, cleanup } = harness({ "2026-10-16": 5 }, { cronFails: true });
    try {
      database.insert(agents).values({ id: "trainer", displayName: "Тренер", role: "specialist", canAskMain: false, status: "ready" }).run();
      database.insert(schedules).values({ id: "s1", agentId: "trainer", cron: "0 8 * * *", tz: "UTC", prompt: "Утро", openclawCronId: "cron-1", enabled: true }).run();
      const status = await budget.save({ dailyUsd: 1, monthlyUsd: 0 }, "UTC", day(TODAY));
      expect(status.exceeded).toBe(true);
      // Nothing was paused, and the row stays enabled: the panel does not claim a pause it failed.
      expect(status.pausedSchedules).toBe(0);
      expect(database.select().from(schedules).all()[0]!.enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("without a limit nothing is guarded, and a monthly limit is its own reason", async () => {
    const { budget, cleanup } = harness({ "2026-10-16": 1, "2026-10-10": 40 });
    try {
      await budget.guard("UTC", day(TODAY));
      const status = await budget.save({ dailyUsd: 0, monthlyUsd: 10 }, "UTC", day(TODAY));
      expect(status).toMatchObject({ exceeded: true, reason: "monthly" });
      await expect(budget.guard("UTC", day(TODAY))).rejects.toMatchObject({ reason: "monthly" });
    } finally {
      cleanup();
    }
  });
});
