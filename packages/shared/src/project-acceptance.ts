import { z } from "zod";

export const AcceptanceFields = z.object({
  title: z.string().trim().min(1).max(160),
  kind: z.enum(["allowed", "denied", "boundary"]),
  given: z.string().trim().max(4000).default(""),
  action: z.string().trim().min(1).max(4000),
  expected: z.string().trim().min(1).max(4000),
  testRef: z.string().trim().max(1000).default(""),
});
export type AcceptanceFields = z.infer<typeof AcceptanceFields>;
export const CreateAcceptanceRequest = z.object({ requestId: z.uuid(), ruleVersion: z.number().int().min(1), fields: AcceptanceFields });
export type CreateAcceptanceRequest = z.infer<typeof CreateAcceptanceRequest>;
export const UpdateAcceptanceRequest = CreateAcceptanceRequest.extend({ revision: z.number().int().min(1) });
export type UpdateAcceptanceRequest = z.infer<typeof UpdateAcceptanceRequest>;
export const RecordAcceptanceCheckRequest = z.object({
  requestId: z.uuid(), ruleVersion: z.number().int().min(1), revision: z.number().int().min(1),
  outcome: z.enum(["passed", "failed", "blocked"]),
  context: z.string().trim().min(1).max(1000),
  observed: z.string().trim().min(1).max(4000),
  evidence: z.string().trim().max(2000).default(""),
  confirm: z.literal(true),
}).refine(value => value.outcome === "blocked" || value.evidence.length > 0, { message: "Evidence is required for performed checks", path: ["evidence"] });
export type RecordAcceptanceCheckRequest = z.infer<typeof RecordAcceptanceCheckRequest>;
export type AcceptanceCheckDto = { id: number; revision: number; outcome: "passed" | "failed" | "blocked"; context: string; observed: string; evidence: string; source: "manual"; checkedBy: "owner"; createdAt: number };
/** automated: the linked test's result in the latest run, or null when the scenario names no test. */
export type AcceptanceCaseDto = { id: string; code: string; ruleVersion: number; revision: number; fields: AcceptanceFields; createdAt: number; latestCheck: AcceptanceCheckDto | null; automated: import("./project-checks.js").AutomatedCheckDto | null };
export type AcceptanceSuiteDto = { currentVersion: number; selectedVersion: number; versions: number[]; approved: boolean; statement: string; cases: AcceptanceCaseDto[] };
export type AcceptanceHistoryDto = { revisions: { revision: number; fields: AcceptanceFields; createdAt: number; checks: AcceptanceCheckDto[] }[] };
