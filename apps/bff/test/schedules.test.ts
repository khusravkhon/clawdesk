import { CreateScheduleRequest } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { toSchedule } from "../src/schedules/schedule-service.js";

describe("toSchedule", () => {
  it("shows panel jobs with their time, task and last result", () => {
    expect(
      toSchedule({
        id: "j1",
        agentId: "main",
        name: "main:custom-1",
        displayName: "План на день",
        enabled: true,
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Dushanbe" },
        payload: { kind: "agentTurn", message: "Составь план на день" },
        delivery: { mode: "announce", channel: "telegram" },
        nextRunAtMs: 100,
        state: { lastRunAtMs: 50, lastRunStatus: "ok" },
      }),
    ).toEqual({
      id: "j1",
      agentId: "main",
      label: "План на день",
      prompt: "Составь план на день",
      cron: "0 8 * * *",
      everyMs: null,
      tz: "Asia/Dushanbe",
      enabled: true,
      nextRunAt: 100,
      lastRunAt: 50,
      lastStatus: "ok",
      lastError: null,
      deliversToTelegram: true,
    });
  });

  it("hides OpenClaw's own jobs and paused jobs have no next run", () => {
    expect(toSchedule({ id: "hb", agentId: "main", declarationKey: "heartbeat:main" })).toBeNull();
    expect(toSchedule({ id: "p", agentId: "coach", enabled: false, nextRunAtMs: 5, schedule: { kind: "every", everyMs: 60_000 } })).toMatchObject({
      enabled: false,
      nextRunAt: null,
      cron: null,
      everyMs: 60_000,
    });
  });

  it("shows reminders created in chat with a declaration key, including paused pool training", () => {
    expect(toSchedule({ id: "morning", agentId: "trainer", declarationKey: "trainer:morning-run", payload: { kind: "agentTurn", message: "Run" } }))
      .toMatchObject({ id: "morning", agentId: "trainer", prompt: "Run" });
    expect(toSchedule({ id: "pool", agentId: "trainer", declarationKey: "trainer:pool-tuth", enabled: false }))
      .toMatchObject({ id: "pool", enabled: false, nextRunAt: null });
  });

  it("shows a one-time command without an explicit agent and keeps its exact date", () => {
    expect(toSchedule({ id: "enable-pool", declarationKey: "trainer:enable-pool-2027", schedule: { kind: "at", at: "2026-12-31T19:05:00.000Z" }, payload: { kind: "command" } }))
      .toMatchObject({ id: "enable-pool", agentId: "main", at: "2026-12-31T19:05:00.000Z", cron: null });
  });

  it("keeps actual housekeeping hidden even when it uses an agentTurn payload", () => {
    expect(toSchedule({ id: "memory", declarationKey: "memory-core:memory-dreaming-promotion", payload: { kind: "agentTurn" } })).toBeNull();
    expect(toSchedule({ id: "review", agentId: "trainer", declarationKey: "skill-collection-review:trainer" })).toBeNull();
    expect(toSchedule({ id: "heartbeat", payload: { kind: "heartbeat" } })).toBeNull();
  });
});

describe("CreateScheduleRequest", () => {
  it("accepts the times the screen can set, nothing else", () => {
    const base = { agentId: "main", label: "x", prompt: "y", tz: "UTC" };
    expect(CreateScheduleRequest.safeParse({ ...base, cron: "30 7 * * 1,2,3,4,5" }).success).toBe(true);
    expect(CreateScheduleRequest.safeParse({ ...base, cron: "*/5 * * * *" }).success).toBe(false);
  });
});
