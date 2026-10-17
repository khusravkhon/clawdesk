import { describe, expect, it, vi } from "vitest";
import { DashboardService, type DashboardDeps } from "../src/dashboard/dashboard-service.js";

vi.mock("../src/routes/agents.js", () => ({ listAgents: async () => ({ agents: [] }) }));

function dashboard(failRuns = false) {
  const ts = Date.now();
  const request = vi.fn(async (method: string, params: { limit?: number }) => {
    if (method === "cron.runs") {
      if ((params.limit ?? 0) > 200) throw new Error("limit must be <= 200");
      if (failRuns) throw new Error("history unavailable");
      return { entries: [{ jobId: "reminder", ts, status: "ok" }] };
    }
    if (method === "cron.list") return { jobs: [{ id: "reminder" }] };
    return {};
  });
  const service = new DashboardService({ gateway: { request, status: { state: "disconnected", serverVersion: null } } } as unknown as DashboardDeps);
  return { service, request };
}

describe("dashboard schedule history", () => {
  it("loads successful runs within the Gateway page limit", async () => {
    const { service } = dashboard();
    const result = await service.get("7d", "UTC");
    expect(result.errors.schedules).toBeUndefined();
    expect(result.schedules?.runs.ok).toBe(1);
    expect(result.schedules?.historyComplete).toBe(false);
  });

  it("reports unavailable history instead of showing zero runs", async () => {
    const { service } = dashboard(true);
    const result = await service.get("7d", "UTC");
    expect(result.schedules).toBeNull();
    expect(result.errors.schedules).toBe("history unavailable");
  });
});
