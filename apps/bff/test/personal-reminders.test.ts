import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { nextWeeklyMinute, wallMinuteToInstant } from "@clawdesk/shared";
import { openDb } from "../src/db/client.js";
import { personalReminders } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { isQuiet, ReminderService } from "../src/schedules/reminder-service.js";
import { registerReminderRoutes } from "../src/routes/reminders.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");
function harness() {
  const opened = openDb(":memory:");
  const state = { now: NOW, mode: "personal", connected: true, owner: true, fail: false, reply: { messageId: "42" } as unknown, gate: undefined as Promise<void> | undefined };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const gateway = {
    get status() { return { state: state.connected ? "connected" : "disconnected" }; },
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params }); await state.gate;
      if (state.fail) throw new Error("synthetic post-send disconnect");
      return state.reply;
    },
  } as unknown as GatewayService;
  const deps = { db: opened.db, gateway, telegram: { ownerDelivery: () => state.owner ? { mode: "announce" as const, channel: "telegram" as const, to: "test-owner", bestEffort: true } : null }, mode: () => state.mode, now: () => state.now };
  return { ...opened, state, calls, deps, reminders: new ReminderService(deps) };
}
const create = (service: ReminderService, dueAt = NOW) => {
  const requestId = randomUUID();
  return service.create({ requestId, text: "Fixed private reminder", dueAt, timeZone: "UTC" }).reminders.find((r) => r.requestId === requestId)!;
};

describe("fixed owner reminders", () => {
  it("keeps the weekly local time through DST and materializes each occurrence once after restart", async () => {
    const h = harness();
    try {
      h.state.now = Date.parse("2026-10-25T13:00:00Z");
      const request = { requestId: randomUUID(), text: "Sunday", dueAt: h.state.now, timeZone: "America/New_York", repeatDays: [0] };
      const result = h.reminders.create(request);
      const series = result.series![0]!;
      expect(series.nextAt).toBe(Date.parse("2026-11-01T14:00:00Z"));
      expect(h.reminders.create(request).series).toEqual([series]);
      await h.reminders.tick();
      h.state.now = series.nextAt;
      const restarted = new ReminderService(h.deps);
      restarted.recover();
      await Promise.all([restarted.tick(), restarted.tick()]);
      await restarted.tick();
      expect(h.calls).toHaveLength(2);
      expect(h.calls[0]?.params.idempotencyKey).not.toBe(h.calls[1]?.params.idempotencyKey);
      const stop = { action: "stop_repeat" as const, requestId: randomUUID() };
      restarted.action(series.id, stop);
      restarted.action(series.id, stop);
      h.state.now += 7 * 86_400_000;
      await restarted.tick();
      expect(restarted.list().series).toEqual([]);
      expect(h.calls).toHaveLength(2);
    } finally { h.close(); }
  });

  it("rejects skipped wall minutes, chooses the first ambiguous minute and skips a missing weekly occurrence", () => {
    const zone = "America/New_York";
    expect(wallMinuteToInstant("2026-03-08T02:30", zone)).toBeNull();
    expect(wallMinuteToInstant("2026-11-01T01:30", zone)).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(nextWeeklyMinute(Date.parse("2026-03-01T07:30:00Z"), zone, [0], "02:30")).toBe(Date.parse("2026-03-15T06:30:00Z"));
  });

  it("migration creates an empty durable outbox; no implicit reminder is sent", async () => {
    const h = harness(); await h.reminders.tick(); expect(h.calls).toEqual([]); expect(h.reminders.list().reminders).toEqual([]); h.close();
  });
  it("uses only native send with a stable key and confirmed message id, never an agent turn", async () => {
    const h = harness(); const row = create(h.reminders);
    await Promise.all([h.reminders.tick(), h.reminders.tick()]); await h.reminders.tick();
    expect(h.calls).toEqual([{ method: "send", params: { channel: "telegram", accountId: "default", agentId: "main", to: "test-owner", message: row.text, idempotencyKey: `clawdesk-reminder:${row.id}` } }]);
    expect(h.reminders.list().reminders[0]).toMatchObject({ delivery: "sent", messageId: "42", sentAt: NOW }); h.close();
  });
  it("repeated create is idempotent and changing the payload conflicts", () => {
    const h = harness(); const row = create(h.reminders);
    h.reminders.create({ requestId: row.requestId, text: row.text, dueAt: row.dueAt, timeZone: row.timeZone });
    expect(h.reminders.list().reminders.length).toBe(1);
    expect(() => h.reminders.create({ requestId: row.requestId, text: "changed", dueAt: row.dueAt, timeZone: row.timeZone })).toThrow("different reminder"); h.close();
  });
  it("holds offline without sending, survives service restart and sends once on reconnect", async () => {
    const h = harness(); h.state.connected = false; create(h.reminders); await h.reminders.tick();
    expect(h.calls.length).toBe(0); expect(h.reminders.list().reminders[0]?.reason).toBe("gateway_offline");
    const restarted = new ReminderService(h.deps); restarted.recover(); h.state.connected = true; await restarted.tick();
    expect(h.calls.length).toBe(1); expect(restarted.list().reminders[0]?.delivery).toBe("sent"); h.close();
  });
  it("does not send without the approved owner or in company mode", async () => {
    const h = harness(); create(h.reminders); h.state.owner = false; await h.reminders.tick(); expect(h.calls.length).toBe(0);
    h.state.owner = true; h.state.mode = "company"; await h.reminders.tick(); expect(h.calls.length).toBe(0);
    expect(() => h.reminders.list()).toThrow("personal mode"); h.close();
  });
  it("expires offline work after its delivery window", async () => {
    const h = harness(); create(h.reminders); h.state.now += 86_400_001; await h.reminders.tick();
    expect(h.calls.length).toBe(0); expect(h.reminders.list().reminders[0]?.delivery).toBe("expired"); h.close();
  });
  it.each(["quiet", "expiry"] as const)("rechecks the clock after a slow send crosses %s for the next occurrence", async (boundary) => {
    const h = harness();
    create(h.reminders, NOW - 1);
    const second = create(h.reminders);
    if (boundary === "quiet") h.reminders.savePreferences({ quietHours: { enabled: true, start: "13:00", end: "14:00", timeZone: "UTC" } });
    let release!: () => void;
    h.state.gate = new Promise<void>((done) => { release = done; });
    const sending = h.reminders.tick();
    expect(h.calls.length).toBe(1);
    h.state.now = boundary === "quiet" ? NOW + 3_600_000 : NOW + 86_400_001;
    release();
    await sending;
    expect(h.calls.length).toBe(1);
    expect(h.reminders.list().reminders.find((row) => row.id === second.id)).toMatchObject(boundary === "quiet"
      ? { delivery: "deferred", reason: "quiet_hours" }
      : { delivery: "expired", reason: "delivery_window_expired" });
    h.close();
  });
  it("never retries ambiguous or interrupted sends, including after recovery", async () => {
    const h = harness(); create(h.reminders); h.state.fail = true; await h.reminders.tick();
    expect(h.reminders.list().reminders[0]?.delivery).toBe("unknown");
    const restarted = new ReminderService(h.deps); restarted.recover(); await restarted.tick(); expect(h.calls.length).toBe(1);
    const second = create(h.reminders, NOW + 1); h.db.update(personalReminders).set({ delivery: "sending" }).where(eq(personalReminders.id, second.id)).run();
    restarted.recover(); expect(restarted.list().reminders.find((r) => r.id === second.id)?.reason).toBe("interrupted_send"); h.close();
  });
  it("does not claim an unconfirmed response as sent", async () => {
    const h = harness(); create(h.reminders); h.state.reply = { ok: true }; await h.reminders.tick();
    expect(h.reminders.list().reminders[0]?.delivery).toBe("unknown"); h.close();
  });
  it("does not reset another worker's sent row from a stale batch", async () => {
    const h = harness(); const first = create(h.reminders); const second = create(h.reminders, NOW + 1); h.state.now++;
    let release!: () => void; h.state.gate = new Promise<void>((r) => { release = r; });
    const running = h.reminders.tick();
    h.db.update(personalReminders).set({ delivery: "sent", messageId: "other-worker" }).where(eq(personalReminders.id, second.id)).run();
    h.state.connected = false; release(); await running;
    const list = h.reminders.list().reminders;
    expect(list.find((r) => r.id === first.id)?.delivery).toBe("sent");
    expect(list.find((r) => r.id === second.id)).toMatchObject({ delivery: "sent", messageId: "other-worker" });
    expect(h.calls.length).toBe(1); h.close();
  });
  it("persists an interrupted claim across a real database close and reopen", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "clawdesk-reminder-"));
    try {
      const h = harness(); const file = path.join(directory, "test.sqlite"); const disk = openDb(file);
      const original = new ReminderService({ ...h.deps, db: disk.db }); const row = create(original);
      disk.db.update(personalReminders).set({ delivery: "sending" }).where(eq(personalReminders.id, row.id)).run(); disk.close();
      const reopened = openDb(file); const restarted = new ReminderService({ ...h.deps, db: reopened.db }); restarted.recover(); await restarted.tick();
      expect(restarted.list().reminders[0]?.delivery).toBe("unknown"); expect(h.calls.length).toBe(0);
      reopened.close(); h.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("keeps imminent open occurrences visible and explicitly marks truncated lists", () => {
    const h = harness(); const imminent = create(h.reminders);
    for (let i = 0; i < 201; i++) h.reminders.create({ requestId: randomUUID(), text: "Future", dueAt: NOW + (i + 1) * 60_000, timeZone: "UTC" });
    const list = h.reminders.list(); expect(list.partial).toBe(true); expect(list.reminders.length).toBe(200); expect(list.reminders[0]?.id).toBe(imminent.id); h.close();
  });
  it("caps each processing batch and continues oldest work on the next tick", async () => {
    const h = harness();
    for (let i = 0; i < 51; i++) create(h.reminders, NOW - i);
    await h.reminders.tick(); expect(h.calls.length).toBe(50); await h.reminders.tick(); expect(h.calls.length).toBe(51); h.close();
  });
  it("actions apply only to the occurrence and repeat clicks do not duplicate snoozes", async () => {
    const h = harness(); const row = create(h.reminders); const action = { requestId: randomUUID(), action: "snooze" as const, snoozeMinutes: 15 };
    h.reminders.action(row.id, action); h.reminders.action(row.id, action); await h.reminders.tick();
    const list = h.reminders.list().reminders; expect(list.length).toBe(2); expect(list.find((r) => r.id === row.id)?.action).toBe("snoozed");
    expect(list.find((r) => r.parentId === row.id)?.dueAt).toBe(NOW + 900_000); expect(h.calls.length).toBe(0);
    expect(() => h.reminders.action(row.id, { requestId: randomUUID(), action: "done" })).toThrow("already changed"); h.close();
  });
  it.each(["done", "skip"] as const)("%s before delivery prevents sending, and duplicate action survives restart", async (action) => {
    const h = harness(); const row = create(h.reminders); const request = { requestId: randomUUID(), action };
    h.reminders.action(row.id, request); const restarted = new ReminderService(h.deps); restarted.action(row.id, request); await restarted.tick();
    expect(h.calls.length).toBe(0); expect(restarted.list().reminders.length).toBe(1); h.close();
  });
  it("refuses action changes while a send is in flight", async () => {
    const h = harness(); let release!: () => void; h.state.gate = new Promise<void>((r) => { release = r; });
    const row = create(h.reminders); const running = h.reminders.tick();
    expect(() => h.reminders.action(row.id, { requestId: randomUUID(), action: "skip" })).toThrow("already changed");
    release(); await running; h.close();
  });
  it("defers only its own fixed deliveries and resumes outside quiet hours", async () => {
    const h = harness(); create(h.reminders); h.reminders.savePreferences({ quietHours: { enabled: true, start: "11:00", end: "13:00", timeZone: "UTC" } });
    await h.reminders.tick(); expect(h.calls.length).toBe(0); expect(h.reminders.list().reminders[0]?.delivery).toBe("deferred");
    h.state.now += 3_600_000; await h.reminders.tick(); expect(h.calls.length).toBe(1); h.close();
  });
  it("quiet clock respects overnight bounds, offsets and repeated/skipped DST hours", () => {
    const p = { quietHours: { enabled: true, start: "01:00", end: "03:00", timeZone: "America/New_York" } };
    expect(isQuiet(Date.parse("2026-11-01T05:30:00Z"), p)).toBe(true);
    expect(isQuiet(Date.parse("2026-11-01T06:30:00Z"), p)).toBe(true);
    expect(isQuiet(Date.parse("2026-03-08T07:00:00Z"), p)).toBe(false);
    p.quietHours = { enabled: true, start: "22:00", end: "08:00", timeZone: "Asia/Dushanbe" };
    expect(isQuiet(Date.parse("2026-10-17T18:00:00Z"), p)).toBe(true);
    expect(isQuiet(Date.parse("2026-10-18T03:00:00Z"), p)).toBe(false);
  });
  it("persists quiet-hour grace through an offline first allowed window, with a finite cap", async () => {
    const h = harness(); create(h.reminders); h.reminders.savePreferences({ quietHours: { enabled: true, start: "11:00", end: "13:00", timeZone: "UTC" } });
    h.state.now += 23 * 3_600_000; await h.reminders.tick();
    h.state.now += 2 * 3_600_000; h.state.connected = false; await h.reminders.tick();
    expect(h.reminders.list().reminders[0]?.delivery).toBe("pending");
    h.state.connected = true; await h.reminders.tick(); expect(h.calls.length).toBe(1); h.close();
  });
  it("expires even a full-day quiet reminder after the bounded extended window", async () => {
    const h = harness(); create(h.reminders); h.reminders.savePreferences({ quietHours: { enabled: true, start: "08:00", end: "08:00", timeZone: "UTC" } });
    await h.reminders.tick(); h.state.now += 48 * 3_600_000 + 1; await h.reminders.tick();
    expect(h.reminders.list().reminders[0]?.delivery).toBe("expired"); expect(h.calls.length).toBe(0); h.close();
  });
  it("rejects malformed timezone and clock at the route boundary", async () => {
    const h = harness(); const app = Fastify(); app.setErrorHandler((_, __, reply) => reply.code(400).send({ error: "invalid_request" })); registerReminderRoutes(app, h);
    const res = await app.inject({ method: "PUT", url: "/api/reminders/preferences", payload: { quietHours: { enabled: true, start: "24:00", end: "08:00", timeZone: "Invalid/Zone" } } });
    expect(res.statusCode).toBe(400);
    await app.close(); h.close();
  });
});
