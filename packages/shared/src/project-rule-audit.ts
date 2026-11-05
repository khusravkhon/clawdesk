import { z } from "zod";

// P3: contradictions between a project's business rules, and finding a rule by the owner's own phrase.
// The main agent's model reads the current versions of all rules and names pairs (or groups) that give
// different outcomes for the same situation, with a concrete example and the choice the owner has to make.
// An open contradiction blocks starting a task on any rule in it; it ends when the owner says the rules do
// not contradict, or when one of the rules gets a new version (then a new check is due).

/** open — waits for the owner; dismissed — the owner says they agree; superseded — a newer check replaced it. */
export type RuleConflictStatus = "open" | "dismissed" | "superseded";
export type RuleConflictDto = {
  id: string;
  /** The rules and the versions the check read. */
  rules: { ruleId: string; code: string; version: number }[];
  explanation: string;
  /** A situation where the rules give different results. */
  example: string;
  /** What the owner has to decide. */
  question: string;
  status: RuleConflictStatus;
  /** A rule has a newer version than the check read: the conflict no longer blocks, a new check is due. */
  outdated: boolean;
  note: string;
  createdAt: number;
  decidedAt: number | null;
};
export type RuleAuditStatus = "idle" | "checking" | "checked" | "failed";
export type RuleAuditDto = {
  status: RuleAuditStatus;
  failure: "model_unavailable" | "invalid_reply" | "timeout" | "interrupted" | null;
  revision: number;
  checkedAt: number | null;
  /** Rules changed since the last check (or never checked while there are rules). */
  stale: boolean;
  conflicts: RuleConflictDto[];
};
export const RuleAuditCheckRequest = z.object({ requestId: z.uuid(), revision: z.number().int().min(0) });
export type RuleAuditCheckRequest = z.infer<typeof RuleAuditCheckRequest>;
export const DismissRuleConflictRequest = z.object({ note: z.string().trim().min(1).max(1000) });
export type DismissRuleConflictRequest = z.infer<typeof DismissRuleConflictRequest>;

/** What the model must return. */
export const RuleAuditReply = z.object({
  conflicts: z.array(z.object({
    rules: z.array(z.string().regex(/^BR-\d{3,}$/)).min(2).max(4),
    explanation: z.string().trim().min(3).max(800),
    example: z.string().trim().max(800).default(""),
    question: z.string().trim().max(500).default(""),
  })).max(10),
});
export type RuleAuditReply = z.infer<typeof RuleAuditReply>;

/** A rule found for the owner's phrase ("Теперь скидка 15% только руководителю" → BR-003). */
export type RuleMatchDto = { ruleId: string; code: string; title: string; score: number; matched: string[] };
export const RuleSearchQuery = z.object({ q: z.string().trim().min(2).max(500) });
