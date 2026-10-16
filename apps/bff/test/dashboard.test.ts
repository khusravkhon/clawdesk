import type { AgentListItemDto } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { buildAgents, buildSchedules, buildUsage, dayKey, isStaleFailure, rangeDays } from "../src/dashboard/dashboard-service.js";

const TZ = "Asia/Dushanbe";
// 2026-10-11 12:00 in Dushanbe (UTC+5).
const NOW = Date.UTC(2026, 9, 11, 7, 0, 0);

const agent = (id: string, extra: Partial<AgentListItemDto> = {}): AgentListItemDto => ({
  id,
  name: id,
  emoji: null,
  model: null,
  isDefault: id === "main",
  role: id === "main" ? "main" : "specialist",
  parentId: null,
  status: "ready",
  purpose: null,
  canAskMain: null,
  sandbox: null,
  folder: null,
  ...extra,
});

describe("rangeDays", () => {
  it("lists every day ending today in the panel time zone", () => {
    expect(rangeDays("7d", NOW, TZ)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
  });

  it("uses the local date, not UTC", () => {
    // 20:30 UTC on the 10th is already the 11th in Dushanbe.
    expect(dayKey(Date.UTC(2026, 9, 10, 20, 30), TZ)).toBe("2026-10-11");
  });
});

describe("buildUsage", () => {
  it("fills days without activity with zeros and sorts breakdowns by tokens", () => {
    const usage = buildUsage(
      {
        totals: { totalTokens: 1500, totalCost: 0.02, missingCostEntries: 1 },
        aggregates: {
          sessionCount: 3,
          messages: { total: 12, toolCalls: 4, errors: 1 },
          daily: [{ date: "2026-10-10", tokens: 1500, cost: 0.02, messages: 12, errors: 1 }],
          byAgent: [
            { agentId: "main", totals: { totalTokens: 500 } },
            { agentId: "coach", totals: { totalTokens: 1000, totalCost: 0.02 } },
          ],
          byModel: [{ provider: "google", model: "gemini-3.7-flash", count: 6, totals: { totalTokens: 1500 } }],
        },
      },
      ["2026-10-09", "2026-10-10", "2026-10-11"],
    );
    expect(usage.totals).toEqual({ tokens: 1500, tokenBreakdown: null, modelCalls: 6, cost: 0.02, messages: 12, toolCalls: 4, errors: 1, sessions: 3 });
    expect(usage.daily.map((d) => d.tokens)).toEqual([0, 1500, 0]);
    expect(usage.byAgent.map((a) => a.agentId)).toEqual(["coach", "main"]);
    expect(usage.byModel[0]).toEqual({ provider: "google", model: "gemini-3.7-flash", tokens: 1500, cost: 0, calls: 6 });
    expect(usage.costIncomplete).toBe(true);
  });

  it("survives an empty answer", () => {
    const usage = buildUsage({}, ["2026-10-11"]);
    expect(usage.totals.tokens).toBe(0);
    expect(usage.daily).toHaveLength(1);
    expect(usage.totals.tokenBreakdown).toBeNull();
    expect(usage.totals.modelCalls).toBeNull();
  });

  it("keeps cached context separate from fresh input and output, and counts model calls instead of transcript records", () => {
    const usage = buildUsage({
      totals: { input: 32631, output: 824, cacheRead: 90880, cacheWrite: 0, totalTokens: 124335, totalCost: 0.183356 },
      aggregates: { messages: { total: 13, toolCalls: 3 }, byModel: [{ model: "gpt-5.6-sol", count: 7 }] },
    }, ["2026-10-14"]);
    expect(usage.totals.tokenBreakdown).toEqual({ input: 32631, output: 824, cacheRead: 90880, cacheWrite: 0 });
    expect(usage.totals.tokens).toBe(124335);
    expect(usage.totals.modelCalls).toBe(7);
    expect(usage.totals.messages).toBe(13);
  });
});

describe("buildAgents", () => {
  it("reports working, failed and idle from the latest session", () => {
    const agents = buildAgents(
      [agent("main"), agent("coach"), agent("chef")],
      [
        { agentId: "main", updatedAt: 1, status: "done" },
        { agentId: "main", updatedAt: 2, hasActiveRun: true },
        { agentId: "coach", updatedAt: 5, status: "failed", lastRunError: "401" },
        { agentId: "coach", updatedAt: 3, status: "done" },
        { agentId: "chef", updatedAt: 9, status: "failed", archived: true },
      ],
      null,
    );
    expect(agents.map((a) => [a.id, a.state, a.sessions, a.lastError])).toEqual([
      ["main", "working", 2, null],
      ["coach", "failed", 2, "401"],
      ["chef", "idle", 0, null],
    ]);
  });
});

describe("isStaleFailure", () => {
  const openai401 = "unexpected status 401 Unauthorized: Missing bearer, url: https://api.openai.com/v1/responses";

  it("ignores a failure from a provider the agent no longer uses", () => {
    expect(isStaleFailure(openai401, "google/gemini-3.7-flash")).toBe(true);
    const [main] = buildAgents([agent("main", { model: "google/gemini-3.7-flash" })], [{ agentId: "main", updatedAt: 1, status: "failed", lastRunError: openai401 }], null);
    expect(main!.state).toBe("idle");
  });

  it("keeps a failure of the current provider", () => {
    expect(isStaleFailure(openai401, "openai/gpt-5.6-sol")).toBe(false);
    expect(isStaleFailure("rate limit", "google/gemini-3.7-flash")).toBe(false);
  });
});

describe("buildSchedules", () => {
  const days = rangeDays("7d", NOW, TZ);
  it("includes declared user reminders in upcoming tasks and run totals", () => {
    const result = buildSchedules([
      { id: "run", agentId: "trainer", declarationKey: "trainer:morning-run", nextRunAtMs: NOW + 5000 },
      { id: "memory", declarationKey: "memory-core:memory-dreaming-promotion" },
    ], [{ jobId: "run", ts: NOW, status: "ok" }], days, TZ);
    expect(result.upcoming.map((job) => job.id)).toEqual(["run"]);
    expect(result.runs.ok).toBe(1);
    expect(result.systemJobs).toBe(1);
  });
  const jobs = [
    { id: "hb", declarationKey: "heartbeat:main", agentId: "main", nextRunAtMs: NOW + 1000 },
    { id: "plan", name: "morning-plan", displayName: "Morning plan", agentId: "main", nextRunAtMs: NOW + 5000, state: { lastRunStatus: "ok" } },
    { id: "off", name: "paused", agentId: "coach", enabled: false, nextRunAtMs: NOW + 2000 },
  ];

  it("hides OpenClaw housekeeping jobs and orders upcoming by next run", () => {
    const s = buildSchedules(jobs, [], days, TZ);
    expect(s.systemJobs).toBe(1);
    expect(s.upcoming.map((j) => [j.id, j.nextRunAt])).toEqual([
      ["plan", NOW + 5000],
      ["off", null],
    ]);
  });

  it("counts only runs of panel jobs inside the range", () => {
    const s = buildSchedules(
      jobs,
      [
        { ts: NOW - 1000, jobId: "plan", status: "ok" },
        { ts: NOW - 2000, jobId: "plan", status: "error", error: "rate limit" },
        { ts: NOW - 3000, jobId: "hb", status: "ok" },
        { ts: NOW - 30 * 86_400_000, jobId: "plan", status: "ok" },
      ],
      days,
      TZ,
    );
    expect(s.runs).toEqual({ ok: 1, error: 1, skipped: 0 });
    expect(s.daily.at(-1)).toEqual({ date: "2026-10-11", ok: 1, error: 1, skipped: 0 });
    expect(s.recent.map((r) => [r.jobName, r.status])).toEqual([
      ["Morning plan", "ok"],
      ["Morning plan", "error"],
    ]);
  });
});
