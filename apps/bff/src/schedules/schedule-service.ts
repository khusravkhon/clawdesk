import { randomUUID } from "node:crypto";
import type { CreateScheduleRequest, ScheduleDto, ScheduleListDto, ScheduleRunDto, UpdateScheduleRequest } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agents, schedules } from "../db/schema.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { TelegramService } from "../telegram/telegram-service.js";

// Schedules (screen 10): OpenClaw cron jobs of the panel's agents. OpenClaw's own housekeeping
// jobs (heartbeat, memory, skill review — they carry a declaration key) are counted, not shown.

export type RawJob = {
  id: string;
  agentId?: string;
  name?: string;
  displayName?: string;
  declarationKey?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string; everyMs?: number };
  payload?: { kind?: string; message?: string };
  delivery?: { mode?: string; channel?: string };
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  state?: { nextRunAtMs?: number; lastRunAtMs?: number; lastRunStatus?: string; lastError?: string };
};

type RawRun = { ts: number; status?: string; durationMs?: number; error?: string; summary?: string; runAtMs?: number };

const STATUS = new Set(["ok", "error", "skipped"]);
const status = (s: string | undefined) => (s && STATUS.has(s) ? (s as "ok" | "error" | "skipped") : null);

export function toSchedule(job: RawJob): ScheduleDto | null {
  if (job.declarationKey || !job.agentId) return null;
  const s = job.schedule ?? {};
  return {
    id: job.id,
    agentId: job.agentId,
    label: job.displayName ?? job.name ?? job.id,
    prompt: job.payload?.message ?? "",
    cron: s.kind === "cron" && s.expr ? s.expr : null,
    everyMs: s.kind === "every" && s.everyMs ? s.everyMs : null,
    tz: s.tz ?? null,
    enabled: job.enabled !== false,
    nextRunAt: job.enabled === false ? null : (job.nextRunAtMs ?? job.state?.nextRunAtMs ?? null),
    lastRunAt: job.lastRunAtMs ?? job.state?.lastRunAtMs ?? null,
    lastStatus: status(job.state?.lastRunStatus),
    lastError: job.state?.lastError ?? null,
    deliversToTelegram: job.delivery?.channel === "telegram",
  };
}

export class ScheduleService {
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  constructor(
    private readonly deps: { gateway: GatewayService; db: Db; telegram: TelegramService; logger: Logger },
  ) {}

  async list(): Promise<ScheduleListDto> {
    const res = await this.deps.gateway.request<{ jobs?: RawJob[] }>("cron.list", { includeDisabled: true });
    const jobs = res.jobs ?? [];
    const mapped = jobs.map(toSchedule).filter((s) => s !== null);
    return {
      schedules: mapped.sort((a, b) => a.agentId.localeCompare(b.agentId) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)),
      systemJobs: jobs.length - mapped.length,
      timeZone: this.timeZone,
    };
  }

  async create(req: CreateScheduleRequest): Promise<ScheduleListDto> {
    const delivery = this.deps.telegram.ownerDelivery();
    const job = await this.deps.gateway.request<{ id: string }>("cron.add", {
      name: `${req.agentId}:custom-${randomUUID().slice(0, 8)}`,
      displayName: req.label,
      agentId: req.agentId,
      enabled: true,
      schedule: { kind: "cron", expr: req.cron, tz: req.tz },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: req.prompt },
      // Without Telegram the results stay in the agent's own sessions.
      delivery: delivery ?? { mode: "none" },
    });
    // The panel row lets Telegram routing find the job later; only agents the panel knows have rows.
    if (this.deps.db.select().from(agents).where(eq(agents.id, req.agentId)).get()) {
      this.deps.db
        .insert(schedules)
        .values({
          id: randomUUID(),
          agentId: req.agentId,
          cron: req.cron,
          tz: req.tz,
          prompt: req.prompt,
          deliverTo: delivery ? `telegram:${delivery.to}` : null,
          openclawCronId: job.id,
        })
        .run();
    }
    this.deps.logger.info({ agentId: req.agentId, cron: req.cron }, "schedule created");
    return this.list();
  }

  async update(id: string, req: UpdateScheduleRequest): Promise<ScheduleListDto> {
    const current = (await this.list()).schedules.find((s) => s.id === id);
    if (!current) throw new ScheduleError("not_found", "this schedule does not exist or belongs to OpenClaw");
    const patch: Record<string, unknown> = {};
    if (req.label !== undefined) patch.displayName = req.label;
    if (req.enabled !== undefined) patch.enabled = req.enabled;
    if (req.prompt !== undefined) patch.payload = { kind: "agentTurn", message: req.prompt };
    if (req.cron !== undefined || req.tz !== undefined) {
      const expr = req.cron ?? current.cron;
      if (!expr) throw new ScheduleError("not_editable", "this schedule does not run at set times");
      patch.schedule = { kind: "cron", expr, tz: req.tz ?? current.tz ?? this.timeZone };
    }
    await this.deps.gateway.request("cron.update", { id, patch });
    const row = this.deps.db.select().from(schedules).where(eq(schedules.openclawCronId, id)).get();
    if (row) {
      this.deps.db
        .update(schedules)
        .set({
          ...(req.cron ? { cron: req.cron } : {}),
          ...(req.tz ? { tz: req.tz } : {}),
          ...(req.prompt ? { prompt: req.prompt } : {}),
          ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
        })
        .where(eq(schedules.id, row.id))
        .run();
    }
    return this.list();
  }

  async remove(id: string): Promise<ScheduleListDto> {
    await this.deps.gateway.request("cron.remove", { id });
    this.deps.db.delete(schedules).where(eq(schedules.openclawCronId, id)).run();
    this.deps.logger.info({ id }, "schedule removed");
    return this.list();
  }

  async runNow(id: string): Promise<void> {
    await this.deps.gateway.request("cron.run", { id });
  }

  async runs(id: string): Promise<ScheduleRunDto[]> {
    const res = await this.deps.gateway.request<{ entries?: RawRun[] }>("cron.runs", { scope: "job", id, limit: 10, sortDir: "desc" });
    return (res.entries ?? []).flatMap((r) => {
      const s = status(r.status);
      return s ? [{ at: r.runAtMs ?? r.ts, status: s, durationMs: r.durationMs ?? null, error: r.error ?? null, summary: r.summary ?? null }] : [];
    });
  }
}

export class ScheduleError extends Error {
  constructor(
    readonly code: "not_found" | "not_editable",
    message: string,
  ) {
    super(message);
  }
}
