import type { GatewayService } from "../gateway/gateway-service.js";
import type { RawCronJob, RawCronRun } from "./dashboard-service.js";

export type HistoryReason = "limit" | "unavailable" | "pagination" | "changed" | "unknown_jobs";
export type CronHistory = { jobs: RawCronJob[]; entries: RawCronRun[]; complete: boolean; reason: HistoryReason | null };
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const TIME_BUDGET_MS = 8000;
const validTimestamp = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
type Page<T> = { entries?: T[]; jobs?: T[]; offset?: number; total?: number; hasMore?: boolean; nextOffset?: number | null; snapshotRevision?: string };

/** Offset is supported by OpenClaw 2026.8.1; a moving history has no snapshot token. */
export async function loadCronHistory(gateway: Pick<GatewayService, "request">, firstDay: string, now: number, dateKey: (ts: number) => string): Promise<CronHistory> {
  const started = performance.now();
  let reason: HistoryReason | null = null;
  const partial = (value: HistoryReason) => { reason ??= value; };
  async function pages<T>(method: "cron.list" | "cron.runs", key: "jobs" | "entries"): Promise<T[]> {
    const result: T[] = [];
    let offset = 0;
    let firstTotal: number | undefined;
    let firstRevision: string | undefined;
    let previousTimestamp = Infinity;
    const fingerprints = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const remaining = TIME_BUDGET_MS - (performance.now() - started);
      if (remaining <= 0) {
        if (!pageNumber) throw new Error("Schedule history unavailable");
        partial("limit"); break;
      }
      let page: Page<T>;
      try {
        page = await gateway.request<Page<T>>(method, method === "cron.runs"
          ? { scope: "all", limit: PAGE_SIZE, offset, sortDir: "desc" }
          : { includeDisabled: true, limit: PAGE_SIZE, offset, includeDeliveryPreviews: false }, { timeoutMs: Math.max(1, Math.floor(remaining)) });
      } catch (error) {
        if (!pageNumber) throw error;
        partial("unavailable"); break;
      }
      const items = page?.[key];
      if (!Array.isArray(items)) {
        if (!pageNumber) throw new Error("Schedule history unavailable");
        partial("pagination"); break;
      }
      if (items.length > PAGE_SIZE) { partial("pagination"); break; }
      if (items.some((item) => !item || typeof item !== "object")) {
        if (!pageNumber) throw new Error("Schedule history unavailable");
        partial("pagination"); break;
      }
      const fingerprint = JSON.stringify(items.map((item) => {
        const row = item as RawCronRun & RawCronJob;
        return [row.id, row.jobId, row.runId, row.runAtMs, row.ts];
      }));
      if (items.length && fingerprints.has(fingerprint)) { partial("pagination"); break; }
      fingerprints.add(fingerprint);
      result.push(...items);
      if (method === "cron.runs") for (const item of items) {
        const ts = (item as RawCronRun).ts;
        if (!validTimestamp(ts) || ts > previousTimestamp) partial("changed");
        previousTimestamp = ts;
      }
      const metadataValid = Number.isSafeInteger(page.total) && page.total! >= 0 && page.offset === offset && typeof page.hasMore === "boolean";
      if (!metadataValid) { partial("pagination"); break; }
      if (firstTotal !== undefined && firstTotal !== page.total) partial("changed");
      firstTotal ??= page.total;
      if (firstRevision && firstRevision !== page.snapshotRevision) partial("changed");
      if (method === "cron.list" && pageNumber > 0 && (!firstRevision || !page.snapshotRevision)) partial("pagination");
      firstRevision ??= page.snapshotRevision;
      if (!page.hasMore) {
        if (page.nextOffset !== null || offset + items.length !== page.total) partial("pagination");
        break;
      }
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset! <= offset || page.nextOffset !== offset + items.length || !items.length) { partial("pagination"); break; }
      if (method === "cron.runs" && items.some((item) => {
        const ts = (item as RawCronRun).ts;
        return validTimestamp(ts) && ts <= now && dateKey(ts) < firstDay;
      })) break;
      offset = page.nextOffset!;
      if (pageNumber === MAX_PAGES - 1) partial("limit");
    }
    return result;
  }
  const jobsRaw = await pages<RawCronJob>("cron.list", "jobs");
  const jobs = [...new Map(jobsRaw.map((job) => [job.id, job])).values()];
  if (jobs.length !== jobsRaw.length) partial("changed");
  const raw = await pages<RawCronRun>("cron.runs", "entries");
  const runs = new Map<string, RawCronRun>();
  if (raw.length > PAGE_SIZE && raw.some((run) => !run.runId && run.runAtMs === undefined)) partial("changed");
  for (const run of raw) {
    if (!run || !validTimestamp(run.ts) || typeof run.jobId !== "string") { partial("pagination"); continue; }
    const id = JSON.stringify([run.jobId, run.runId ?? run.runAtMs ?? run.ts]);
    const previous = runs.get(id);
    if (!previous || previous.ts < run.ts) runs.set(id, run);
  }
  if (runs.size !== raw.length) partial("changed");
  const knownJobs = new Set(jobs.map((job) => job.id));
  if ([...runs.values()].some((run) => !knownJobs.has(run.jobId) && run.ts <= now && dateKey(run.ts) >= firstDay)) partial("unknown_jobs");
  return { jobs, entries: [...runs.values()], complete: reason === null, reason };
}
