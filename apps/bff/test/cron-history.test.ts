import { describe, expect, it, vi } from "vitest";
import { loadCronHistory } from "../src/dashboard/cron-history.js";
import { buildSchedules, dayKey, rangeDays } from "../src/dashboard/dashboard-service.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

const NOW = Date.UTC(2026, 9, 17, 7);
const today = "2026-10-17";
const record = (index: number) => ({ ts: NOW - index * 1000, jobId: "user", runId: `run-${index}`, status: "ok" });
function source(runs: unknown[], transform?: (page: Record<string, unknown>, offset: number) => Record<string, unknown>) {
  const request = vi.fn(async (method: string, params: { offset: number }) => {
    if (method === "cron.list") return { jobs: [{ id: "user" }, { id: "system", declarationKey: "heartbeat:main" }], total: 2, offset: 0, hasMore: false, nextOffset: null };
    const offset = params.offset;
    const entries = runs.slice(offset, offset + 200);
    const page = { entries, total: runs.length, offset, hasMore: offset + entries.length < runs.length, nextOffset: offset + entries.length < runs.length ? offset + entries.length : null };
    return transform?.(page, offset) ?? page;
  });
  return { request, gateway: { request } as unknown as Pick<GatewayService, "request"> };
}
const load = (gateway: Pick<GatewayService, "request">) => loadCronHistory(gateway, "2026-10-11", NOW, (ts) => dayKey(ts, "UTC"));

describe("paginated cron history", () => {
  it("counts all 451 runs across three supported offset pages and excludes system jobs", async () => {
    const rows = Array.from({ length: 451 }, (_, index) => record(index));
    rows.push({ ...record(452), jobId: "system" });
    const { gateway, request } = source(rows);
    const result = await load(gateway);
    expect(result.complete).toBe(true);
    expect(buildSchedules(result.jobs, result.entries, [today], "UTC", NOW).runs.ok).toBe(451);
    expect(request.mock.calls.filter(([method]) => method === "cron.runs").map(([, params]) => params.offset)).toEqual([0, 200, 400]);
  });

  it("keeps received counts with a partial marker after a later page fails", async () => {
    const { gateway } = source(Array.from({ length: 400 }, (_, i) => record(i)), (page, offset) => {
      if (offset) throw new Error("next page failed");
      return page;
    });
    const result = await load(gateway);
    expect(result.entries).toHaveLength(200);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe("unavailable");
  });

  it("rejects the first page failure instead of inventing zero runs", async () => {
    const { gateway } = source([], () => { throw new Error("history unavailable"); });
    await expect(load(gateway)).rejects.toThrow("history unavailable");
  });

  it("retains a legacy page but marks missing metadata incomplete", async () => {
    const { gateway } = source([record(0)], (page) => ({ entries: page.entries }));
    const result = await load(gateway);
    expect(result.entries).toHaveLength(1);
    expect(result.reason).toBe("pagination");
  });

  it("stops repeated pages and non-increasing cursors without looping", async () => {
    const repeated = Array.from({ length: 200 }, (_, i) => record(i));
    for (const mode of ["repeated", "cursor"]) {
      const { gateway, request } = source([...repeated, ...repeated], (page, offset) => mode === "cursor" ? { ...page, nextOffset: offset } : { ...page, entries: repeated });
      const result = await load(gateway);
      expect(result.complete).toBe(false);
      expect(result.entries).toHaveLength(200);
      expect(request.mock.calls.length).toBeLessThanOrEqual(3);
    }
  });

  it("deduplicates updated runs and labels a changing history as partial", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => record(i));
    rows[200] = { ...record(0), ts: NOW - 1, status: "error" };
    const { gateway } = source(rows);
    const result = await load(gateway);
    expect(result.entries).toHaveLength(200);
    expect(result.entries.find((entry) => entry.runId === "run-0")?.status).toBe("ok");
    expect(result.complete).toBe(false);
  });

  it("bounds large 90-day histories at 50 pages", async () => {
    const { gateway, request } = source(Array.from({ length: 10200 }, (_, i) => record(i)));
    const result = await loadCronHistory(gateway, "2026-07-20", NOW, (ts) => dayKey(ts, "UTC"));
    expect(result.entries).toHaveLength(10000);
    expect(result.reason).toBe("limit");
    expect(request.mock.calls.filter(([method]) => method === "cron.runs")).toHaveLength(50);
  });

  it("stops once descending history crosses the first local calendar day", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ ...record(i), ts: NOW - i * 86400000 }));
    const { gateway, request } = source(rows);
    const result = await load(gateway);
    expect(result.complete).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "cron.runs")).toHaveLength(1);
  });
});

describe("schedule calendar boundaries", () => {
  it("includes the first local midnight and excludes future or out-of-range entries", () => {
    const firstMidnight = Date.UTC(2026, 9, 10, 19);
    const rows = [firstMidnight - 1, firstMidnight, NOW, NOW + 1, NOW + 86400000].map((ts) => ({ ts, jobId: "user", status: "ok" }));
    const result = buildSchedules([{ id: "user" }], rows, rangeDays("7d", NOW, "Asia/Dushanbe"), "Asia/Dushanbe", NOW);
    expect(result.runs.ok).toBe(2);
    expect(result.daily[0]?.ok).toBe(1);
    expect(result.daily.at(-1)?.ok).toBe(1);
  });

  it("lists seven distinct calendar dates across DST fallback", () => {
    const days = rangeDays("7d", Date.UTC(2026, 10, 1, 5, 30), "America/New_York");
    expect(days).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  });
});

it("marks changing totals and ambiguous multi-page legacy identities incomplete", async () => {
  const rows = Array.from({ length: 201 }, (_, index) => ({ ts: NOW - index, jobId: "user", status: "ok" }));
  const { gateway } = source(rows);
  expect((await load(gateway)).reason).toBe("changed");
  const changed = source(Array.from({ length: 201 }, (_, index) => record(index)), (page, offset) => ({ ...page, total: offset ? 202 : 201 }));
  expect((await load(changed.gateway)).complete).toBe(false);
});

it("pages the job catalog too, including paused jobs beyond the first 200", async () => {
  const jobs = Array.from({ length: 201 }, (_, index) => ({ id: `job-${index}`, enabled: false }));
  const request = vi.fn(async (method: string, params: { offset: number }) => {
    if (method === "cron.runs") return { entries: [{ ...record(0), jobId: "job-200" }], offset: 0, total: 1, hasMore: false, nextOffset: null };
    const list = jobs.slice(params.offset, params.offset + 200);
    return { jobs: list, offset: params.offset, total: jobs.length, snapshotRevision: "same-revision", hasMore: params.offset === 0, nextOffset: params.offset === 0 ? 200 : null };
  });
  const result = await load({ request } as unknown as Pick<GatewayService, "request">);
  expect(result.complete).toBe(true);
  expect(result.jobs).toHaveLength(201);
  expect(buildSchedules(result.jobs, result.entries, [today], "UTC", NOW).runs.ok).toBe(1);
});

it("does not silently classify deleted jobs as user runs or claim complete totals", async () => {
  const { gateway } = source([{ ...record(0), jobId: "deleted-reminder" }]);
  const result = await load(gateway);
  expect(result.reason).toBe("unknown_jobs");
  expect(result.complete).toBe(false);
  expect(buildSchedules(result.jobs, result.entries, [today], "UTC", NOW).runs.ok).toBe(0);
});
