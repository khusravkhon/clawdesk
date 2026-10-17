import type { TodayDto } from "@clawdesk/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../src/app.js";
import type { MemoryNoteService } from "../src/library/memory-note-service.js";
import { registerTodayRoutes } from "../src/routes/today.js";
import { TodayService } from "../src/today/today-service.js";
import { ApprovalsService } from "../src/approvals/approvals-service.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import pino from "pino";

const memory = { job: { state: "ready" as const, percent: 100, error: null, updatedAt: 50 }, checkedAt: 40, error: null, agents: [{ agentId: "main", provider: "local", files: 1, chunks: 1, index: "ready" as const, embeddings: "ready" as const }] };
const reminders = { reminders: [], partial: false, preferences: { quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "Asia/Dushanbe" } } };
const scheduleList = { schedules: [], systemJobs: 0, timeZone: "Asia/Dushanbe" };
function sources() {
  return {
    connection: vi.fn(async () => ({ gateway: "connected", telegram: [] })),
    approvals: vi.fn(async () => ({ count: 2 })),
    notes: vi.fn(() => ({ count: 4, pendingAgents: ["trainer"] })),
    search: vi.fn(async () => memory),
    reminders: vi.fn(() => reminders),
    schedules: vi.fn(async () => scheduleList),
  };
}

describe("personal daily observations", () => {
  it("preserves the real memory check timestamp instead of stamping a cached GET", async () => {
    const readers = sources();
    const service = new TodayService(readers, () => "Asia/Dushanbe", () => 100);
    const dto = await service.get();
    expect(dto.search.checkedAt).toBe(40);
    expect(dto.connection.checkedAt).toBe(100);
    expect(dto.notes.data).toEqual({ count: 4, pendingAgents: ["trainer"] });
  });

  it("keeps successful sections and marks failed sections unknown with last successful values", async () => {
    const readers = sources();
    let now = 100;
    const service = new TodayService(readers, () => "UTC", () => now);
    await service.get();
    now = 200;
    readers.approvals.mockRejectedValue(new Error("private upstream failure"));
    readers.search.mockRejectedValue(new Error("offline"));
    const dto = await service.get();
    expect(dto.approvals).toEqual({ state: "unknown", checkedAt: 100, data: { count: 2 } });
    expect(dto.search.state).toBe("unknown");
    expect(dto.search.checkedAt).toBe(40);
    expect(dto.reminders.state).toBe("available");
    expect(JSON.stringify(dto)).not.toContain("private upstream");
  });

  it("uses null rather than an empty list or zero before the first successful observation", async () => {
    const readers = sources();
    readers.approvals.mockRejectedValue(new Error("offline"));
    const dto = await new TodayService(readers, () => "UTC").get();
    expect(dto.approvals).toEqual({ state: "unknown", checkedAt: null, data: null });
  });

  it("coalesces simultaneous reads and starts a new observation afterward", async () => {
    const readers = sources();
    let resolve!: (value: { count: number }) => void;
    readers.approvals.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const service = new TodayService(readers, () => "UTC");
    const first = service.get();
    expect(service.get()).toBe(first);
    expect(readers.connection).toHaveBeenCalledTimes(1);
    resolve({ count: 1 });
    await first;
    await service.get();
    expect(readers.connection).toHaveBeenCalledTimes(2);
  });
});

describe("daily routes and approval readiness", () => {
  it("counts both approval queues but fails closed when either queue is unavailable", async () => {
    const request = vi.fn(async (method: string) => method.startsWith("exec") ? [{ id: "one" }] : []);
    const service = new ApprovalsService({ request } as unknown as GatewayService, pino({ enabled: false }));
    expect(await service.pendingCount()).toBe(1);
    request.mockRejectedValueOnce(new Error("offline"));
    await expect(service.pendingCount()).rejects.toThrow("offline");
  });

  it("company mode has no daily endpoint data and executes no personal reader", async () => {
    const app = Fastify();
    const mode = vi.fn(() => "company");
    const request = vi.fn();
    registerTodayRoutes(app, { space: { mode }, gateway: { request } } as unknown as AppDeps & { notes: MemoryNoteService });
    const response = await app.inject({ method: "GET", url: "/api/today" });
    expect(response.statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns partial observations when Gateway is offline, retaining local reminder controls", async () => {
    const app = Fastify();
    const db = { selectDistinct: () => ({ from: () => ({ all: () => [] }) }), select: () => ({ from: () => ({ where: () => ({ all: () => [] }) }) }) };
    const deps = {
      db, gateway: { status: { state: "disconnected" }, request: vi.fn().mockRejectedValue(new Error("offline")) },
      space: { mode: () => "personal", get: () => ({ timezone: "Asia/Dushanbe" }) },
      reminders: { list: () => reminders }, approvals: { pendingCount: vi.fn().mockRejectedValue(new Error("offline")) },
      notes: { list: vi.fn() },
    } as unknown as AppDeps & { notes: MemoryNoteService };
    registerTodayRoutes(app, deps);
    const response = await app.inject({ method: "GET", url: "/api/today" });
    expect(response.statusCode).toBe(200);
    const dto = response.json<TodayDto>();
    expect(dto.connection.state).toBe("unknown");
    expect(dto.search.data).toBeNull();
    expect(dto.approvals.data).toBeNull();
    expect(dto.reminders).toMatchObject({ state: "available", data: reminders });
    expect(dto.notes).toMatchObject({ state: "available", data: { count: 0, pendingAgents: [] } });
    await app.close();
  });
});
