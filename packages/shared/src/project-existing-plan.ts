import { z } from "zod";

// Acceptance 2 (project spec): for an existing project the panel reads first (files, stack, git), then the
// main agent's model proposes a limited change plan from that reading, the brief and the approved rules:
// what stays, what to change where, the risks and what to ask. The plan is shown, never executed: the
// existing code is not rewritten to a template, uncommitted work is not touched.

export const ExistingPlanReply = z.object({
  summary: z.string().trim().min(3).max(1200),
  keep: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  changes: z.array(z.object({
    area: z.string().trim().min(1).max(160),
    what: z.string().trim().min(3).max(800),
    files: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
    risk: z.enum(["low", "medium", "high"]).default("medium"),
  })).max(12),
  risks: z.array(z.string().trim().min(1).max(400)).max(10).default([]),
  questions: z.array(z.string().trim().min(1).max(400)).max(10).default([]),
});
export type ExistingPlanReply = z.infer<typeof ExistingPlanReply>;
/** A file the plan names, and whether the reading found it (otherwise it would be a new file). */
export type ExistingPlanDto = {
  status: "idle" | "planning" | "ready" | "failed";
  failure: "model_unavailable" | "invalid_reply" | "timeout" | "interrupted" | null;
  revision: number;
  plan: (Omit<ExistingPlanReply, "changes"> & { changes: (ExistingPlanReply["changes"][number] & { known: boolean[] })[] }) | null;
  basis: { files: number; dependencies: string[]; hasGit: boolean } | null;
  updatedAt: number | null;
};
export const ExistingPlanRequest = z.object({ requestId: z.uuid(), revision: z.number().int().min(0) });
export type ExistingPlanRequest = z.infer<typeof ExistingPlanRequest>;
