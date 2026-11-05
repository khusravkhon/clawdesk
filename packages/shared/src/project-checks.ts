import { z } from "zod";

// Automated checks of a generated project (P6.1): its own `node --test` suite run in a throwaway
// container. A test is identified by "<file>::<name>"; acceptance scenarios link to that ID.

export type ProjectCheckStatus = "passed" | "failed" | "flaky" | "skipped";
/** "blocked": the environment did not produce a trustworthy result (crash, timeout, no tests). */
export type ProjectCheckRunStatus = "completed" | "blocked";
export type ProjectCheckBlockedReason = "runner_failed" | "timeout" | "no_tests";
/**
 * "separate": the app ran in its own container and the tests, holding only the test files, reached it over
 * its loopback network; "shared": the tests started the app themselves, so app code ran next to the runner
 * and could have forged results. Null for runs from before the distinction.
 */
export type ProjectCheckIsolation = "separate" | "shared";
export type ProjectCheckTestDto = { id: string; file: string; name: string; status: ProjectCheckStatus; message: string; fileHash: string | null };
/** What the bridge returns for one run. */
export type ProjectChecksRunResult = { status: ProjectCheckRunStatus; reason: ProjectCheckBlockedReason | null; tests: ProjectCheckTestDto[]; durationMs: number; filesFingerprint: string; isolation?: ProjectCheckIsolation };
export type ProjectCheckRunSummaryDto = { id: string; status: ProjectCheckRunStatus; reason: ProjectCheckBlockedReason | null; createdAt: number; durationMs: number; counts: Record<ProjectCheckStatus, number>; isolation?: ProjectCheckIsolation | null };
export type ProjectCheckRunDto = ProjectCheckRunSummaryDto & { tests: ProjectCheckTestDto[] };
export type ProjectChecksDto = { latest: ProjectCheckRunDto | null; history: ProjectCheckRunSummaryDto[] };
export const RunProjectChecksRequest = z.object({ requestId: z.uuid() });
export type RunProjectChecksRequest = z.infer<typeof RunProjectChecksRequest>;

/**
 * A scenario's automated result, derived from its linked test and the latest run:
 * "unlinked" — the reference names no test known when the scenario was saved;
 * "changed" — the test itself (for links made before P6.3: its file) differs from when it was linked
 *   (needs a new scenario revision);
 * "not_run" — no run yet, or the linked test is missing from the latest run;
 * "blocked" — the latest run produced no trustworthy result.
 */
export type AutomatedCheckStatus = ProjectCheckStatus | "unlinked" | "changed" | "not_run" | "blocked";
export type AutomatedCheckDto = { testId: string; status: AutomatedCheckStatus; runId: string | null; runAt: number | null; message: string };
