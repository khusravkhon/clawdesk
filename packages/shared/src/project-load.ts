import { z } from "zod";

// P9 (acceptance 15): a load check of a generated app with its conditions and result. The verdict never
// claims more than was run: without a stated target load it says so; a target stated as a total number of
// users (not simultaneous ones) is not confirmed by any run; errors or slow answers fail it.

export const RunLoadCheckRequest = z.object({ requestId: z.uuid(), concurrency: z.number().int().min(1).max(50), durationSeconds: z.number().int().min(2).max(20) });
export type RunLoadCheckRequest = z.infer<typeof RunLoadCheckRequest>;
export type LoadConditionsDto = { concurrency: number; durationMs: number; appCpus: number; appMemoryMb: number; requests: string[]; data: string; network: string };
export type LoadResultDto = { requests: number; errors: number; statuses: Record<string, number>; p50: number | null; p95: number | null; p99: number | null; max: number | null; rps: number; elapsedMs: number };
/** What the brief says about the load, read from its words (see expectedLoad). */
export type LoadTargetDto = { simultaneous: number | null; total: number | null; evidence: string | null };
/**
 * confirmed — the stated simultaneous load ran without errors and fast enough; not_confirmed — less was run
 * than stated, or only a total number of users is stated; no_target — nothing is stated, only these
 * conditions were checked; failed — errors over 1% or p95 over 1 s; blocked — the run gave no result.
 */
export type LoadVerdict = "confirmed" | "not_confirmed" | "no_target" | "failed" | "blocked";
export type LoadRunDto = { id: string; createdAt: number; conditions: LoadConditionsDto; result: LoadResultDto | null; error: string | null; target: LoadTargetDto; verdict: LoadVerdict };
export type LoadRunsDto = { runs: LoadRunDto[]; target: LoadTargetDto };

const SIMULTANEOUS = /(\d[\d\s]{0,8})\s*(?:человек|пользовател[а-я]*|users?|клиент[а-я]*)?\s*(?:одновременн|сразу|в один момент|at once|concurrent|simultaneous)/iu;
const SIMULTANEOUS_AFTER = /(?:одновременн[а-я]*|сразу|at once|concurrent(?:ly)?|simultaneous(?:ly)?)\s*(?:работают|работает|зайдут|заходят|до|около|up to|about)?\s*(\d[\d\s]{0,8})/iu;
const TOTAL = /(\d[\d\s]{0,8})\s*(?:человек|пользовател[а-я]*|сотрудник[а-я]*|клиент[а-я]*|users?)/iu;

/** The load the brief states: simultaneous users if said so, else a total number of users. */
export function expectedLoad(text: string): LoadTargetDto {
  for (const sentence of text.split(/(?<=[.!?\n;])\s+|\n+/u).map((part) => part.trim()).filter(Boolean)) {
    const simultaneous = SIMULTANEOUS.exec(sentence) ?? SIMULTANEOUS_AFTER.exec(sentence);
    if (simultaneous) return { simultaneous: Number(simultaneous[1]!.replace(/\s/g, "")), total: null, evidence: sentence.slice(0, 200) };
  }
  for (const sentence of text.split(/(?<=[.!?\n;])\s+|\n+/u).map((part) => part.trim()).filter(Boolean)) {
    const total = TOTAL.exec(sentence);
    if (total) return { simultaneous: null, total: Number(total[1]!.replace(/\s/g, "")), evidence: sentence.slice(0, 200) };
  }
  return { simultaneous: null, total: null, evidence: null };
}

export function loadVerdict(conditions: LoadConditionsDto, result: LoadResultDto | null, target: LoadTargetDto): LoadVerdict {
  if (!result || result.requests === 0) return "blocked";
  if (result.errors / result.requests > 0.01 || (result.p95 ?? Infinity) > 1000) return "failed";
  if (target.simultaneous !== null) return conditions.concurrency >= target.simultaneous ? "confirmed" : "not_confirmed";
  return target.total !== null ? "not_confirmed" : "no_target";
}
