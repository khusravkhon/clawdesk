import type { BudgetDto, SaveBudgetRequest } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { buildUsage, dayKey, type RawSessionsUsage } from "../dashboard/dashboard-service.js";
import type { Db } from "../db/client.js";
import { schedules, spaces } from "../db/schema.js";
import { getSetting, putSetting } from "../db/settings.js";
import type { GatewayService } from "../gateway/gateway-service.js";

// Spending limits. The owner sets what a day and a month may cost; once a limit is reached the
// panel stops starting work by itself — scheduled runs are paused and a new video job is refused.
// The owner's own messages are never blocked: a limit is there to stop runaway automatic work,
// not to lock the person out of their own assistant.
//
// The numbers come from the Gateway's own usage report, which can be a lower bound (it says when
// some entries have no cost). A limit is therefore a brake, not an accounting guarantee.

const LIMITS_SETTING = "budget.limits";
const PAUSED_SETTING = "budget.pausedJobs";
const USAGE_SETTING = "budget.lastUsage";

type Deps = { gateway: GatewayService; db: Db; logger: Logger };
type Limits = { dailyUsd: number; monthlyUsd: number };
type UsageSnapshot = { today: number; month: number; incomplete: boolean; day: string; timeZone: string; updatedAt: number; lastCompleteAt?: number | null };
const lastComplete = (cached: UsageSnapshot | null | undefined, timeZone: string) =>
  cached?.timeZone === timeZone ? cached.lastCompleteAt ?? (cached.incomplete ? null : cached.updatedAt) : null;

export class BudgetUsageUnavailableError extends Error {
  constructor() {
    super("budget_usage_unavailable");
    this.name = "BudgetUsageUnavailableError";
  }
}

export class BudgetExceededError extends Error {
  constructor(readonly reason: "daily" | "monthly") {
    super(`budget_exceeded_${reason}`);
    this.name = "BudgetExceededError";
  }
}

export class BudgetService {
  constructor(private readonly deps: Deps) {}

  limits(): Limits {
    const stored = getSetting<Partial<Limits>>(this.deps.db, LIMITS_SETTING);
    return { dailyUsd: Math.max(0, Number(stored?.dailyUsd) || 0), monthlyUsd: Math.max(0, Number(stored?.monthlyUsd) || 0) };
  }

  /** Small local summary for Today. A cache observation keeps its own date and never starts a usage RPC. */
  observation(timeZone: string, now = Date.now()) {
    const cached = getSetting<UsageSnapshot>(this.deps.db, USAGE_SETTING);
    const today = dayKey(now, timeZone);
    return {
      ...this.limits(),
      spentTodayUsd: cached?.timeZone === timeZone && cached.day === today ? cached.today : null,
      incomplete: cached?.incomplete ?? false,
      checkedAt: lastComplete(cached, timeZone),
    };
  }

  /** What has been spent today and this month, and whether a limit has been reached. */
  async status(timeZone: string, now = Date.now()): Promise<BudgetDto> {
    const limits = this.limits();
    const spent = await this.#spent(timeZone, now);
    const reason = this.#reason(limits, spent);
    return {
      ...limits,
      spentTodayUsd: spent.today,
      spentMonthUsd: spent.month,
      exceeded: reason !== "none",
      reason,
      pausedSchedules: this.#paused().length,
      costIncomplete: spent.incomplete,
      usageAvailable: spent.available,
      lastUsageAt: spent.lastCompleteAt,
    };
  }

  async save(request: SaveBudgetRequest, timeZone: string, now = Date.now()): Promise<BudgetDto> {
    putSetting(this.deps.db, LIMITS_SETTING, { dailyUsd: request.dailyUsd, monthlyUsd: request.monthlyUsd });
    this.deps.logger.info({ dailyUsd: request.dailyUsd, monthlyUsd: request.monthlyUsd }, "spending limits saved");
    // Saving a limit applies it at once: a higher limit resumes what a lower one had paused.
    return this.enforce(timeZone, now);
  }

  /** Throws when automatic work may not start right now. The owner's own actions do not call this. */
  async guard(timeZone: string, now = Date.now()): Promise<void> {
    const limits = this.limits();
    if (!limits.dailyUsd && !limits.monthlyUsd) return;
    const spent = await this.#spent(timeZone, now);
    if (!spent.available || spent.incomplete) throw new BudgetUsageUnavailableError();
    const reason = this.#reason(limits, spent);
    if (reason !== "none") throw new BudgetExceededError(reason);
  }

  /**
   * Pauses the panel's own scheduled jobs while a limit is reached and resumes exactly those it
   * paused once spending allows again. Jobs the owner disabled themselves are never resumed:
   * only ids this service wrote down are touched.
   */
  async enforce(timeZone: string, now = Date.now()): Promise<BudgetDto> {
    const status = await this.status(timeZone, now);
    const paused = this.#paused();
    const limited = status.dailyUsd > 0 || status.monthlyUsd > 0;
    if (status.exceeded || (limited && (!status.usageAvailable || status.costIncomplete))) {
      // Only jobs the panel created have an id here; a row without one has nothing to pause.
      const ours = this.deps.db.select({ id: schedules.openclawCronId, enabled: schedules.enabled }).from(schedules).all();
      const toPause = ours.filter((row) => row.id !== null && row.enabled && !paused.includes(row.id)).map((row) => row.id!);
      const stopped: string[] = [];
      for (const id of toPause) {
        try {
          await this.deps.gateway.request("cron.update", { id, patch: { enabled: false } });
          this.deps.db.update(schedules).set({ enabled: false }).where(eq(schedules.openclawCronId, id)).run();
          stopped.push(id);
        } catch (error) {
          // Not written down: a job that did not pause must not later be "resumed" by us.
          this.deps.logger.warn({ err: error as Error, id }, "could not pause a schedule for the spending limit");
        }
      }
      const all = [...new Set([...paused, ...stopped])];
      putSetting(this.deps.db, PAUSED_SETTING, all);
      if (stopped.length) this.deps.logger.warn({ paused: stopped.length, reason: status.reason }, "schedules paused: the spending limit is reached");
      return { ...status, pausedSchedules: all.length };
    }
    if (!paused.length) return status;
    const resumed: string[] = [];
    for (const id of paused) {
      try {
        await this.deps.gateway.request("cron.update", { id, patch: { enabled: true } });
        this.deps.db.update(schedules).set({ enabled: true }).where(eq(schedules.openclawCronId, id)).run();
        resumed.push(id);
      } catch (error) {
        this.deps.logger.warn({ err: error as Error, id }, "could not resume a schedule after the spending limit");
      }
    }
    const left = paused.filter((id) => !resumed.includes(id));
    putSetting(this.deps.db, PAUSED_SETTING, left);
    if (resumed.length) this.deps.logger.info({ resumed: resumed.length }, "schedules resumed: spending is under the limit again");
    return { ...status, pausedSchedules: left.length };
  }

  #paused(): string[] {
    const stored = getSetting<string[]>(this.deps.db, PAUSED_SETTING);
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
  }

  #reason(limits: Limits, spent: { today: number; month: number }): "daily" | "monthly" | "none" {
    if (limits.dailyUsd > 0 && spent.today >= limits.dailyUsd) return "daily";
    if (limits.monthlyUsd > 0 && spent.month >= limits.monthlyUsd) return "monthly";
    return "none";
  }

  /** Today's and this month's cost, in the owner's own time zone. */
  async #spent(timeZone: string, now: number): Promise<{ today: number; month: number; incomplete: boolean; available: boolean; lastCompleteAt: number | null }> {
    timeZone = this.deps.db.select({ timezone: spaces.timezone }).from(spaces).where(eq(spaces.id, "default")).get()?.timezone ?? timeZone;
    const today = dayKey(now, timeZone);
    const month = today.slice(0, 7);
    const days = Array.from({ length: Number(today.slice(8)) }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
    const cached = getSetting<UsageSnapshot>(this.deps.db, USAGE_SETTING);
    try {
      const raw = await this.deps.gateway.request<RawSessionsUsage>("sessions.usage", { agentScope: "all", startDate: days[0], endDate: today, mode: "specific", timeZone, limit: 500 });
      if (!Array.isArray(raw.aggregates?.daily)) throw new Error("usage report has no daily totals");
      const usage = buildUsage(raw, days);
      const incomplete = usage.costIncomplete
        || (usage.totals.tokens > 0 && (!raw.aggregates.daily.length || !Number.isFinite(raw.totals?.totalCost)))
        || raw.aggregates.daily.some((day) => (day.tokens ?? 0) > 0 && !Number.isFinite(day.cost));
      const snapshot: UsageSnapshot = {
        today: usage.daily.find((day) => day.date === today)?.cost ?? 0,
        month: usage.daily.reduce((sum, day) => sum + day.cost, 0),
        incomplete,
        day: today,
        timeZone,
        updatedAt: now,
        lastCompleteAt: incomplete ? lastComplete(cached, timeZone) : now,
      };
      putSetting(this.deps.db, USAGE_SETTING, snapshot);
      return { ...snapshot, available: true, lastCompleteAt: snapshot.lastCompleteAt ?? null };
    } catch (error) {
      // Without a usage report there is no basis to resume budget-paused work; the panel says so.
      this.deps.logger.warn({ err: error }, "could not read usage for the spending limit");
      const sameMonth = cached?.timeZone === timeZone && cached.day.slice(0, 7) === month;
      return {
        today: sameMonth && cached.day === today ? cached.today : 0,
        month: sameMonth ? cached.month : 0,
        incomplete: true,
        available: false,
        lastCompleteAt: lastComplete(cached, timeZone),
      };
    }
  }
}
