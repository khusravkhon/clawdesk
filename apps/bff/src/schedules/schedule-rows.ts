import { eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { schedules } from "../db/schema.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import type { RawJob } from "./schedule-service.js";

const PAGE_SIZE = 200;
const MAX_PAGES = 50;
type Page = { jobs?: RawJob[]; hasMore?: boolean; nextOffset?: number | null };

/** Every cron job OpenClaw has, or null when the list is not certainly whole (then nothing may be pruned). */
export async function allCronJobs(gateway: Pick<GatewayService, "request">): Promise<RawJob[] | null> {
  const jobs: RawJob[] = [];
  let offset = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await gateway.request<Page>("cron.list", { includeDisabled: true, limit: PAGE_SIZE, offset, includeDeliveryPreviews: false });
      if (!Array.isArray(res?.jobs)) return null;
      jobs.push(...res.jobs);
      if (!res.hasMore) return jobs;
      if (!Number.isSafeInteger(res.nextOffset) || res.nextOffset! <= offset) return null;
      offset = res.nextOffset!;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The panel's schedule rows are a copy of jobs it created; an agent can change or delete those jobs
 * from chat (Telegram) without the panel. Before acting on the rows, drop the ones whose job is gone
 * and take the job's current state, so the panel never updates a deleted job or resumes one the
 * agent turned off. Returns the ids of existing jobs, or null when OpenClaw's list was unavailable
 * (rows are then left as they are).
 */
export async function syncScheduleRows(db: Db, gateway: Pick<GatewayService, "request">): Promise<Set<string> | null> {
  const jobs = await allCronJobs(gateway);
  if (!jobs) return null;
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const rows = db.select().from(schedules).where(isNotNull(schedules.openclawCronId)).all();
  const gone = rows.filter((row) => !byId.has(row.openclawCronId!)).map((row) => row.id);
  db.transaction((tx) => {
    if (gone.length) tx.delete(schedules).where(inArray(schedules.id, gone)).run();
    for (const row of rows) {
      const job = byId.get(row.openclawCronId!);
      if (!job) continue;
      const s = job.schedule;
      const cron = s?.kind === "cron" && s.expr ? { cron: s.expr, ...(s.tz ? { tz: s.tz } : {}) } : {};
      const prompt = typeof job.payload?.message === "string" ? { prompt: job.payload.message } : {};
      tx.update(schedules).set({ enabled: job.enabled !== false, ...cron, ...prompt }).where(eq(schedules.id, row.id)).run();
    }
  });
  return new Set(byId.keys());
}
