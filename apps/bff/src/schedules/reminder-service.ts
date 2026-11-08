import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, asc, sql } from "drizzle-orm";
import { nextWeeklyMinute, zonedMinute, type CreateReminderRequest, type ReminderActionRequest, type ReminderListDto, type ReminderPreferences } from "@clawdesk/shared";
import type { Db } from "../db/client.js";
import { personalReminders, reminderSeries } from "../db/schema.js";
import { getSetting, putSetting } from "../db/settings.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { TelegramService } from "../telegram/telegram-service.js";

const PREFERENCES = "personal.reminders.preferences";
const DAY = 86_400_000;
export class ReminderError extends Error {
  constructor(readonly code: "personal_only" | "not_found" | "conflict" | "invalid_due_at", message: string) { super(message); }
}

/** Compare local clock minutes, so quiet hours follow timezone offset and DST transitions. */
export function isQuiet(at: number, preferences: ReminderPreferences): boolean {
  const quiet = preferences.quietHours;
  if (!quiet.enabled) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const minutes = Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
  const toMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const start = toMinutes(quiet.start), end = toMinutes(quiet.end);
  return start === end || (start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end);
}

export class ReminderService {
  #running: Promise<void> | undefined;
  #stopped = false;
  constructor(private readonly deps: { db: Db; gateway: GatewayService; telegram: Pick<TelegramService, "ownerDelivery">; mode: () => string; now?: () => number; timeZone?: () => string | undefined }) {}
  #now() { return this.deps.now?.() ?? Date.now(); }
  #personal() { if (this.deps.mode() !== "personal") throw new ReminderError("personal_only", "fixed reminders are available in personal mode"); }
  preferences(): ReminderPreferences {
    const quiet = getSetting<ReminderPreferences>(this.deps.db, PREFERENCES)?.quietHours;
    return { quietHours: { enabled: quiet?.enabled ?? false, start: quiet?.start ?? "22:00", end: quiet?.end ?? "08:00", timeZone: this.deps.timeZone?.() ?? quiet?.timeZone ?? "UTC" } };
  }
  list(): ReminderListDto {
    this.#personal();
    const { db } = this.deps;
    const rows = db.select().from(personalReminders).orderBy(
      sql`case when ${personalReminders.action} <> 'open' then 2 when ${personalReminders.seriesId} is not null and ${personalReminders.delivery} = 'sent' then 1 else 0 end`,
      sql`case when ${personalReminders.action} = 'open' and not (${personalReminders.seriesId} is not null and ${personalReminders.delivery} = 'sent') then ${personalReminders.dueAt} else -${personalReminders.dueAt} end`,
      asc(personalReminders.id),
    ).limit(201).all();
    const active = db.select().from(reminderSeries).where(sql`${reminderSeries.nextAt} IS NOT NULL`).orderBy(asc(reminderSeries.nextAt)).limit(201).all();
    const series = active.slice(0, 200).map(({ id, text, timeZone, days, nextAt }) => ({ id, text, timeZone, days, nextAt: nextAt! }));
    return {
      reminders: rows.slice(0, 200).map(({ actionRequestId: _, actionPayload: __, expiresAt: ___, ...row }) => row),
      preferences: this.preferences(), partial: rows.length > 200 || active.length > 200, telegramConfigured: !!this.deps.telegram.ownerDelivery(), series,
    };
  }
  savePreferences(preferences: ReminderPreferences): ReminderListDto { this.#personal(); putSetting(this.deps.db, PREFERENCES, preferences); return this.list(); }
  create(request: CreateReminderRequest): ReminderListDto {
    this.#personal();
    const { db } = this.deps;
    const { repeatDays, ...occurrence } = request;
    const existing = db.select().from(personalReminders).where(eq(personalReminders.requestId, request.requestId)).get();
    if (existing) {
      const series = existing.seriesId ? db.select().from(reminderSeries).where(eq(reminderSeries.id, existing.seriesId)).get() : undefined;
      if (existing.text !== request.text || existing.dueAt !== request.dueAt || existing.timeZone !== request.timeZone || JSON.stringify(series?.days) !== JSON.stringify(repeatDays)) {
        throw new ReminderError("conflict", "request id belongs to a different reminder");
      }
      return this.list();
    }
    const now = this.#now();
    if (request.dueAt < now - 60_000 || request.dueAt > now + 366 * DAY) throw new ReminderError("invalid_due_at", "choose a time within the next year");
    const id = randomUUID();
    db.transaction((tx) => {
      if (repeatDays) {
        const local = zonedMinute(request.dueAt, request.timeZone);
        const weekday = new Date(local.slice(0, 10) + "T00:00:00Z").getUTCDay();
        if (!repeatDays.includes(weekday)) throw new ReminderError("invalid_due_at", "the first date must match one of the selected weekdays");
        const clock = local.slice(11);
        const nextAt = nextWeeklyMinute(request.dueAt, request.timeZone, repeatDays, clock);
        tx.insert(reminderSeries).values({ id, text: request.text, timeZone: request.timeZone, days: repeatDays, clock, nextAt }).run();
      }
      tx.insert(personalReminders).values({ id, ...occurrence, seriesId: repeatDays ? id : null, expiresAt: request.dueAt + DAY }).run();
    });
    return this.list();
  }
  action(id: string, request: ReminderActionRequest): ReminderListDto {
    this.#personal();
    this.deps.db.transaction((db) => {
      if (request.action === "stop_repeat") {
        const series = db.select().from(reminderSeries).where(eq(reminderSeries.id, id)).get();
        if (!series) throw new ReminderError("not_found", "repeating reminder does not exist");
        if (series.nextAt === null) return;
        if (db.select({ id: reminderSeries.id }).from(reminderSeries).where(eq(reminderSeries.stopRequestId, request.requestId)).get()) {
          throw new ReminderError("conflict", "request id belongs to another repeat");
        }
        db.update(reminderSeries).set({ nextAt: null, stopRequestId: request.requestId }).where(eq(reminderSeries.id, id)).run();
        db.update(personalReminders).set({ action: "skipped" }).where(and(eq(personalReminders.seriesId, id), eq(personalReminders.action, "open"),
          inArray(personalReminders.delivery, ["pending", "deferred"]))).run();
        return;
      }
      const row = db.select().from(personalReminders).where(eq(personalReminders.id, id)).get();
      if (!row) throw new ReminderError("not_found", "reminder does not exist");
      const payload = JSON.stringify({ action: request.action, snoozeMinutes: request.snoozeMinutes ?? 15 });
      if (row.actionRequestId === request.requestId && row.actionPayload === payload) return;
      if (db.select().from(personalReminders).where(eq(personalReminders.actionRequestId, request.requestId)).get()
        || db.select().from(personalReminders).where(eq(personalReminders.requestId, request.requestId)).get()) throw new ReminderError("conflict", "request id belongs to another operation");
      if (row.action !== "open" || row.delivery === "sending") throw new ReminderError("conflict", "this occurrence has already changed");
      db.update(personalReminders).set({ action: request.action === "done" ? "done" : request.action === "skip" ? "skipped" : "snoozed", actionRequestId: request.requestId, actionPayload: payload }).where(eq(personalReminders.id, id)).run();
      if (request.action === "snooze") {
        const dueAt = this.#now() + (request.snoozeMinutes ?? 15) * 60_000;
        db.insert(personalReminders).values({ id: randomUUID(), requestId: request.requestId, text: row.text, dueAt, expiresAt: dueAt + DAY, timeZone: row.timeZone, parentId: row.id }).run();
      }
    });
    return this.list();
  }
  /** An interrupted send may already have reached Telegram. Never blindly repeat it. */
  recover(): void {
    this.deps.db.update(personalReminders).set({ delivery: "unknown", reason: "interrupted_send" }).where(eq(personalReminders.delivery, "sending")).run();
  }
  tick(): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#tick().finally(() => { this.#running = undefined; });
    return this.#running;
  }
  async #tick(): Promise<void> {
    if (this.#stopped || this.deps.mode() !== "personal") return;
    const batchNow = this.#now();
    this.#materializeSeries(batchNow);
    const rows = this.deps.db.select().from(personalReminders).where(and(eq(personalReminders.action, "open"), inArray(personalReminders.delivery, ["pending", "deferred"]), lte(personalReminders.dueAt, batchNow))).orderBy(asc(personalReminders.dueAt), asc(personalReminders.id)).limit(50).all();
    for (const row of rows) {
      if (this.#stopped || this.deps.mode() !== "personal") return;
      const now = this.#now();
      const update = (patch: Partial<typeof row>, claimed = false) => this.deps.db.update(personalReminders).set(patch).where(and(
        eq(personalReminders.id, row.id), eq(personalReminders.action, "open"),
        claimed ? eq(personalReminders.delivery, "sending") : inArray(personalReminders.delivery, ["pending", "deferred"]),
      )).run();
      // A reminder deferred overnight still gets its first allowed delivery window.
      // Extension is bounded: even an all-day quiet period cannot retain work indefinitely.
      const quiet = isQuiet(now, this.preferences());
      const expiresAt = quiet ? Math.min(row.dueAt + 2 * DAY, Math.max(row.expiresAt, now + DAY)) : row.expiresAt;
      if (now > expiresAt) { update({ delivery: "expired", reason: "delivery_window_expired" }); continue; }
      if (quiet) { update({ delivery: "deferred", reason: "quiet_hours", expiresAt }); continue; }
      const target = this.deps.telegram.ownerDelivery();
      if (this.deps.gateway.status.state !== "connected" || !target) { update({ delivery: "pending", reason: target ? "gateway_offline" : "owner_not_connected" }); continue; }
      const claim = this.deps.db.update(personalReminders).set({ delivery: "sending", reason: null }).where(and(eq(personalReminders.id, row.id), eq(personalReminders.action, "open"), inArray(personalReminders.delivery, ["pending", "deferred"]))).run();
      if (!claim.changes) continue;
      try {
        // The native send RPC delivers fixed text and does not invoke an agent turn.
        const result = await this.deps.gateway.request<{ messageId?: string | number }>("send", { channel: "telegram", accountId: "default", agentId: "main", to: target.to, message: row.text, idempotencyKey: `clawdesk-reminder:${row.id}` });
        if (typeof result?.messageId !== "string" && typeof result?.messageId !== "number") update({ delivery: "unknown", reason: "unconfirmed_response" }, true);
        else update({ delivery: "sent", sentAt: this.#now(), messageId: String(result.messageId), reason: null }, true);
      } catch {
        // Transport errors and server failures can happen after a successful upstream send.
        update({ delivery: "unknown", reason: "send_result_unknown" }, true);
      }
    }
  }

  #materializeSeries(now: number): void {
    this.deps.db.transaction((db) => {
      const due = db.select().from(reminderSeries).where(lte(reminderSeries.nextAt, now)).orderBy(asc(reminderSeries.nextAt)).limit(50).all();
      for (const series of due) {
        const dueAt = series.nextAt!;
        // Skip old occurrences after an extended outage. An interrupted send has its own recovery state.
        if (now <= dueAt + DAY) {
          db.insert(personalReminders).values({ id: randomUUID(), requestId: randomUUID(), text: series.text, dueAt, expiresAt: dueAt + DAY,
            timeZone: series.timeZone, seriesId: series.id }).run();
        }
        const nextAt = nextWeeklyMinute(now, series.timeZone, series.days, series.clock);
        db.update(reminderSeries).set({ nextAt }).where(eq(reminderSeries.id, series.id)).run();
      }
    });
  }
  async stop(): Promise<void> { this.#stopped = true; await this.#running; }
}
