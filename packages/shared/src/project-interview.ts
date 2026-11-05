import { z } from "zod";
import { ProjectBriefFields } from "./company.js";

// P2: the project's requirements interview with the model. After each round of answers the main agent's
// model asks 1–3 new questions (with examples and options), marks its guesses as assumptions and retells
// the first version ("We are building…"). Answers go into the brief's fields, so the step-by-step form and
// everything after it see them. The model only proposes: nothing it writes counts until the owner answers
// or accepts it. Without a model the step-by-step form keeps working.

export const BRIEF_FIELDS = ["goal", "audience", "scenarios", "inScope", "outOfScope", "rules", "data", "integrations", "constraints", "openQuestions"] as const satisfies readonly (keyof ProjectBriefFields)[];
export type BriefField = (typeof BRIEF_FIELDS)[number];

export type InterviewQuestionDto = {
  id: string;
  /** The brief field the answer goes into. */
  field: BriefField;
  text: string;
  /** Example answers or options the owner can pick or ignore. */
  options: string[];
};
export type InterviewAssumptionDto = { id: string; field: BriefField; text: string };
/** The retelling of the first version, in plain words. */
export type InterviewSummaryDto = {
  building: string;
  users: string;
  inFirstVersion: string[];
  notInFirstVersion: string[];
  scenarios: string[];
  openQuestions: string[];
};
/**
 * idle — not started; asking — the model is thinking (the panel polls); ready — questions are waiting;
 * done — the model has nothing more to ask; failed — the model did not answer usefully (the form still works).
 */
export type InterviewStatus = "idle" | "asking" | "ready" | "done" | "failed";
export type InterviewFailure = "model_unavailable" | "invalid_reply" | "timeout" | "interrupted";
export type ProjectInterviewDto = {
  status: InterviewStatus;
  revision: number;
  round: number;
  questions: InterviewQuestionDto[];
  assumptions: InterviewAssumptionDto[];
  summary: InterviewSummaryDto | null;
  /** Questions already answered, newest last: the model is told not to ask them again. */
  answered: { field: BriefField; question: string; answer: string; at: number }[];
  failure: InterviewFailure | null;
  updatedAt: number | null;
};

export const InterviewAskRequest = z.object({ requestId: z.uuid(), revision: z.number().int().min(0) });
export type InterviewAskRequest = z.infer<typeof InterviewAskRequest>;
export const InterviewAnswerRequest = z.object({
  requestId: z.uuid(),
  revision: z.number().int().min(0),
  /** Answers to the current questions; a skipped question is left out. */
  answers: z.array(z.object({ questionId: z.string().min(1).max(40), text: z.string().trim().min(1).max(2000) })).max(3),
  /** Assumptions the owner accepts (written into the brief) or rejects (dropped). */
  accept: z.array(z.string().min(1).max(40)).max(20).default([]),
  reject: z.array(z.string().min(1).max(40)).max(20).default([]),
  /** Ask the next round right away. */
  continue: z.boolean().default(true),
});
export type InterviewAnswerRequest = z.infer<typeof InterviewAnswerRequest>;

/** What the model must return; anything else is "invalid_reply". */
export const InterviewReply = z.object({
  questions: z.array(z.object({ field: z.enum(BRIEF_FIELDS), text: z.string().trim().min(3).max(500), options: z.array(z.string().trim().min(1).max(200)).max(5).default([]) })).max(3),
  assumptions: z.array(z.object({ field: z.enum(BRIEF_FIELDS), text: z.string().trim().min(3).max(500) })).max(8).default([]),
  summary: z.object({
    building: z.string().trim().max(600).default(""),
    users: z.string().trim().max(600).default(""),
    inFirstVersion: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
    notInFirstVersion: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
    scenarios: z.array(z.string().trim().min(1).max(400)).max(5).default([]),
    openQuestions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  }),
  done: z.boolean().default(false),
});
export type InterviewReply = z.infer<typeof InterviewReply>;
