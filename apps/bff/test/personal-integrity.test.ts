import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { BudgetService } from "../src/budget/budget-service.js";
import { openDb } from "../src/db/client.js";
import { agents, schedules, spaces } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { MemoryNoteService } from "../src/library/memory-note-service.js";
import { LibraryService } from "../src/library/library-service.js";
import { registerLibraryRoutes } from "../src/routes/library.js";
import { registerVideoRoutes } from "../src/routes/video.js";
import type { VideoService } from "../src/video/video-service.js";

const logger = { warn() {}, info() {} } as never;
const NOW = Date.parse("2026-10-16T12:00:00Z");

function budgetHarness() {
  const opened = openDb(":memory:");
  const state = { unavailable: false, incomplete: false, cost: { "2026-10-16": 5 } as Record<string, number> };
  const requests: { startDate: string; endDate: string; timeZone: string }[] = [];
  const changes: boolean[] = [];
  const gateway = { request: async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.usage") {
      requests.push(params as typeof requests[number]);
      if (state.unavailable) throw new Error("synthetic usage outage");
      return { totals: { missingCostEntries: state.incomplete ? 1 : 0 }, aggregates: { daily: Object.entries(state.cost).map(([date, cost]) => ({ date, cost })) } };
    }
    if (method === "cron.update") changes.push((params.patch as { enabled: boolean }).enabled);
    return {};
  } } as unknown as GatewayService;
  opened.db.insert(agents).values({ id: "trainer", displayName: "Trainer", role: "specialist", status: "ready" }).run();
  opened.db.insert(schedules).values({ id: "schedule", agentId: "trainer", cron: "0 8 * * *", tz: "UTC", prompt: "Reminder", openclawCronId: "cron", enabled: true }).run();
  return { ...opened, state, changes, requests, budget: new BudgetService({ db: opened.db, gateway, logger }) };
}

function notesHarness() {
  const opened = openDb(":memory:");
  const state = { failRead: false, failWrite: false, beforeWrite: null as (() => Promise<void>) | null };
  const files = new Map<string, string>();
  const writes: string[] = [];
  const gateway = { request: async (method: string, params: Record<string, unknown>) => {
    const key = `${params.agentId}:${params.name}`;
    if (method === "agents.files.get") {
      if (state.failRead) throw new Error("synthetic read failure");
      return { file: { content: files.get(key) ?? "" } };
    }
    if (method === "agents.files.set") {
      if (state.failWrite) throw new Error("synthetic write failure");
      await state.beforeWrite?.();
      writes.push(String(params.agentId));
      files.set(key, String(params.content));
    }
    return {};
  } } as unknown as GatewayService;
  const deps = { db: opened.db, gateway, logger };
  return { ...opened, state, files, writes, deps, notes: new MemoryNoteService(deps) };
}

describe("personal budget integrity", () => {
  it("reports unknown usage without inventing a successful zero-cost report", async () => {
    const h = budgetHarness();
    try {
      h.state.unavailable = true;
      expect(await h.budget.status("UTC", NOW)).toMatchObject({ usageAvailable: false, lastUsageAt: null, costIncomplete: true });
    } finally { h.close(); }
  });

  it("does not carry yesterday's cached spending into a new day", async () => {
    const h = budgetHarness();
    try {
      await h.budget.status("UTC", NOW);
      h.state.unavailable = true;
      expect(await h.budget.status("UTC", NOW + 86_400_000)).toMatchObject({ usageAvailable: false, spentTodayUsd: 0, spentMonthUsd: 5, lastUsageAt: NOW });
    } finally { h.close(); }
  });

  it("returns a clear 503 for video work when budget usage is unavailable", async () => {
    const h = budgetHarness();
    const app = Fastify();
    try {
      await h.budget.save({ dailyUsd: 100, monthlyUsd: 0 }, "UTC", NOW);
      h.state.unavailable = true;
      const video = { create: () => { throw new Error("must not queue a video"); } } as unknown as VideoService;
      registerVideoRoutes(app, { video, budget: h.budget });
      const result = await app.inject({ method: "POST", url: "/api/video/jobs", payload: { agentId: "trainer", url: "https://youtu.be/dQw4w9WgXcQ" } });
      expect(result.statusCode).toBe(503);
      expect(result.json()).toMatchObject({ error: "budget_usage_unavailable" });
    } finally { await app.close(); h.close(); }
  });

  it("keeps a budget pause during a usage outage and resumes after a verified report", async () => {
    const h = budgetHarness();
    try {
      await h.budget.save({ dailyUsd: 1, monthlyUsd: 0 }, "UTC", NOW);
      h.state.unavailable = true;
      const unavailable = await h.budget.enforce("UTC", NOW + 1000);
      expect(h.changes).toEqual([false]);
      expect(unavailable).toMatchObject({ usageAvailable: false, costIncomplete: true, spentTodayUsd: 5, lastUsageAt: NOW, pausedSchedules: 1 });
      await expect(h.budget.guard("UTC", NOW + 1000)).rejects.toMatchObject({ name: "BudgetUsageUnavailableError" });
      h.state.unavailable = false;
      h.state.cost = {};
      await h.budget.enforce("UTC", NOW + 2000);
      expect(h.changes).toEqual([false, true]);
    } finally { h.close(); }
  });

  it("holds automatic work when cost is incomplete, but allows explicitly removing limits", async () => {
    const h = budgetHarness();
    try {
      h.state.incomplete = true;
      await h.budget.save({ dailyUsd: 100, monthlyUsd: 0 }, "UTC", NOW);
      expect(h.changes).toEqual([false]);
      await expect(h.budget.guard("UTC", NOW)).rejects.toMatchObject({ name: "BudgetUsageUnavailableError" });
      h.state.unavailable = true;
      await h.budget.save({ dailyUsd: 0, monthlyUsd: 0 }, "UTC", NOW);
      expect(h.changes).toEqual([false, true]);
      await expect(h.budget.guard("UTC", NOW)).resolves.toBeUndefined();
    } finally { h.close(); }
  });

  it.each([
    ["2026-10-31T12:00:00Z", "UTC", "2026-10-01", "2026-10-31"],
    ["2026-04-30T12:00:00Z", "UTC", "2026-04-01", "2026-04-30"],
    ["2024-02-29T12:00:00Z", "UTC", "2024-02-01", "2024-02-29"],
    ["2026-02-28T12:00:00Z", "UTC", "2026-02-01", "2026-02-28"],
    ["2026-10-31T20:00:00Z", "Asia/Dushanbe", "2026-11-01", "2026-11-01"],
    ["2026-03-31T12:00:00Z", "Europe/Berlin", "2026-03-01", "2026-03-31"],
  ])("counts a complete calendar month at %s in %s", async (iso, timeZone, startDate, endDate) => {
    const h = budgetHarness();
    try {
      h.state.cost = { [startDate]: 10, "2023-01-01": 99 };
      const result = await h.budget.status(timeZone, Date.parse(iso));
      expect(h.requests.at(-1)).toMatchObject({ startDate, endDate, timeZone });
      expect(result.spentMonthUsd).toBe(10);
    } finally { h.close(); }
  });

  it("uses the owner's configured time zone for background and browser requests", async () => {
    const h = budgetHarness();
    try {
      h.db.insert(spaces).values({ id: "default", mode: "personal", name: "Personal", locale: "ru", timezone: "Asia/Dushanbe" }).run();
      const now = Date.parse("2026-10-31T20:00:00Z");
      await h.budget.enforce("UTC", now);
      await h.budget.status("America/Los_Angeles", now);
      expect(h.requests).toHaveLength(2);
      for (const request of h.requests) expect(request).toMatchObject({ timeZone: "Asia/Dushanbe", startDate: "2026-11-01", endDate: "2026-11-01" });
    } finally { h.close(); }
  });
});

describe("personal memory integrity", () => {
  it("does not update or remove another agent's note", async () => {
    const h = notesHarness();
    try {
      const added = await h.notes.add("trainer", { text: "Original" });
      const id = added.notes[0]!.id;
      await expect(h.notes.update("dietitian", id, { text: "Wrong agent" })).rejects.toMatchObject({ code: "not_found" });
      await expect(h.notes.remove("dietitian", id)).rejects.toMatchObject({ code: "not_found" });
      expect(h.notes.list("trainer").notes[0]!.text).toBe("Original");
      expect(h.writes).toEqual(["trainer"]);
    } finally { h.close(); }
  });

  it.each(["failRead", "failWrite"] as const)("marks saved changes pending after %s and retries without duplicates", async (failure) => {
    const h = notesHarness();
    try {
      h.files.set("trainer:USER.md", "# USER.md\nAn existing fact.\n");
      const added = await h.notes.add("trainer", { text: "Original" });
      h.state[failure] = true;
      const pending = await h.notes.update("trainer", added.notes[0]!.id, { text: "Corrected" });
      expect(pending).toMatchObject({ applied: false });
      expect(h.notes.list("trainer").applied).toBe(false);
      expect(h.files.get("trainer:USER.md")).not.toContain("Corrected");
      h.state[failure] = false;
      const recovered = new MemoryNoteService(h.deps);
      await recovered.retryPending();
      expect(recovered.list("trainer")).toMatchObject({ applied: true, notes: [{ text: "Corrected" }] });
      expect(h.files.get("trainer:USER.md")).toContain("An existing fact.");
      expect(h.files.get("trainer:USER.md")!.match(/Corrected/g)).toHaveLength(1);
    } finally { h.close(); }
  });

  it("retries removal of the last note after restart", async () => {
    const h = notesHarness();
    try {
      const added = await h.notes.add("trainer", { text: "Remove me" });
      h.state.failWrite = true;
      expect(await h.notes.remove("trainer", added.notes[0]!.id)).toMatchObject({ applied: false, notes: [] });
      h.state.failWrite = false;
      const recovered = new MemoryNoteService(h.deps);
      await recovered.retryPending();
      expect(recovered.list("trainer")).toMatchObject({ applied: true, notes: [] });
      expect(h.files.get("trainer:USER.md")).not.toContain("Remove me");
    } finally { h.close(); }
  });

  it("serializes concurrent note writes so both changes reach the file", async () => {
    const h = notesHarness();
    try {
      let releaseFirst!: () => void;
      let firstStarted!: () => void;
      const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const started = new Promise<void>((resolve) => { firstStarted = resolve; });
      let writes = 0;
      h.state.beforeWrite = async () => {
        if (++writes === 1) { firstStarted(); await blocked; }
      };
      const first = h.notes.add("trainer", { text: "First" });
      await started;
      const second = h.notes.add("trainer", { text: "Second" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseFirst();
      await Promise.all([first, second]);
      const file = h.files.get("trainer:USER.md")!;
      expect(file).toContain("First");
      expect(file).toContain("Second");
      expect(h.notes.list("trainer").applied).toBe(true);
    } finally { h.close(); }
  });

  it("retries through the API without recreating a note", async () => {
    const h = notesHarness();
    const app = Fastify();
    try {
      h.state.failWrite = true;
      await h.notes.add("trainer", { text: "Saved once" });
      h.state.failWrite = false;
      registerLibraryRoutes(app, { library: new LibraryService(h.db), notes: h.notes, budget: new BudgetService(h.deps) });
      const result = await app.inject({ method: "POST", url: "/api/memory/trainer/notes/sync" });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ applied: true, notes: [{ text: "Saved once" }] });
      expect(h.notes.list("trainer").notes).toHaveLength(1);
    } finally { await app.close(); h.close(); }
  });
});
