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
});

describe("CreateScheduleRequest", () => {
  it("accepts the times the screen can set, nothing else", () => {
    const base = { agentId: "main", label: "x", prompt: "y", tz: "UTC" };
    expect(CreateScheduleRequest.safeParse({ ...base, cron: "30 7 * * 1,2,3,4,5" }).success).toBe(true);
    expect(CreateScheduleRequest.safeParse({ ...base, cron: "*/5 * * * *" }).success).toBe(false);
  });
});
