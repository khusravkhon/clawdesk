import { describe, expect, it } from "vitest";
import { BudgetService } from "../src/budget/budget-service.js";
import { openDb } from "../src/db/client.js";
import { agents, schedules } from "../src/db/schema.js";
import { getSetting, putSetting } from "../src/db/settings.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { syncScheduleRows } from "../src/schedules/schedule-rows.js";
import { TelegramService } from "../src/telegram/telegram-service.js";

const logger = { warn() {}, info() {} } as never;
type Job = { id: string; enabled?: boolean; schedule?: { kind: string; expr?: string; tz?: string }; payload?: { kind: string; message?: string } };

// The owner asked an agent in Telegram to change or delete a schedule the panel created: the
// panel's own row must follow OpenClaw, not act on a job that is gone or was turned off.
function harness(jobs: Job[] | null) {
  const { db } = openDb(":memory:");
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const pages: number[] = [];
  const gateway = { request: async (method: string, params: Record<string, unknown>) => {
    if (method === "cron.list") {
      if (!jobs) throw new Error("gateway down");
      pages.push(params.offset as number);
      const offset = params.offset as number;
      const page = jobs.slice(offset, offset + (params.limit as number));
      const hasMore = offset + page.length < jobs.length;
      return { jobs: page, hasMore, nextOffset: hasMore ? offset + page.length : null };
    }
    if (method === "cron.update") updates.push(params as never);
    if (method === "sessions.usage") return { totals: { missingCostEntries: 0 }, aggregates: { daily: [] } };
    return {};
  } } as unknown as GatewayService;
  db.insert(agents).values({ id: "trainer", displayName: "Trainer", role: "specialist", status: "ready" }).run();
  db.insert(schedules).values([
    { id: "kept", agentId: "trainer", cron: "0 8 * * *", tz: "UTC", prompt: "Old", openclawCronId: "job-kept", enabled: true },
    { id: "gone", agentId: "trainer", cron: "0 9 * * *", tz: "UTC", prompt: "Gone", openclawCronId: "job-gone", enabled: true },
  ]).run();
  return { db, gateway, updates, pages };
}

describe("schedule rows follow OpenClaw", () => {
  it("drops rows of deleted jobs and takes the current time, task and state of the rest", async () => {
    const h = harness([{ id: "job-kept", enabled: false, schedule: { kind: "cron", expr: "30 17 * * *", tz: "Asia/Dushanbe" }, payload: { kind: "agentTurn", message: "New" } }]);
    expect(await syncScheduleRows(h.db, h.gateway)).toEqual(new Set(["job-kept"]));
    expect(h.db.select().from(schedules).all()).toEqual([
      expect.objectContaining({ id: "kept", cron: "30 17 * * *", tz: "Asia/Dushanbe", prompt: "New", enabled: false }),
    ]);
  });

  it("reads every page before deciding a job is gone", async () => {
    const filler = Array.from({ length: 250 }, (_, i) => ({ id: `other-${i}` }));
    const h = harness([...filler, { id: "job-kept" }, { id: "job-gone" }]);
    await syncScheduleRows(h.db, h.gateway);
    expect(h.pages).toEqual([0, 200]);
    expect(h.db.select().from(schedules).all()).toHaveLength(2);
  });

  it("leaves rows alone when OpenClaw's list is unavailable", async () => {
    const h = harness(null);
    expect(await syncScheduleRows(h.db, h.gateway)).toBeNull();
    expect(h.db.select().from(schedules).all()).toHaveLength(2);
  });

  it("connecting Telegram routes only schedules that still exist", async () => {
    const h = harness([{ id: "job-kept" }]);
    h.db.update(schedules).set({ deliverTo: null }).run();
    const telegram = new TelegramService(h.gateway, h.db, logger);
    expect(await telegram.routeSchedules("42")).toBe(1);
    expect(h.updates.map((u) => u.id)).toEqual(["job-kept"]);
  });

  it("the spending limit forgets deleted jobs and never resumes one the agent turned off", async () => {
    const h = harness([{ id: "job-kept", enabled: false }]);
    putSetting(h.db, "budget.pausedJobs", ["job-gone"]);
    await new BudgetService({ db: h.db, gateway: h.gateway, logger }).enforce("UTC");
    expect(getSetting(h.db, "budget.pausedJobs")).toEqual([]);
    expect(h.updates).toEqual([]);
  });
});
