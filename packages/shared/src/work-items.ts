import { z } from "zod";

// Stage 6, part 2: company tasks. The owner sets a task (what, acceptance criteria, executor, deadline) and
// starts it; an executor has one task in work at a time, the rest wait in its queue and start when it is
// free. The executor reports the result with clawdesk_task_report; "done" without a result is refused and
// a reported result goes to the owner's acceptance. A request the executor files with taskRef WI-… blocks
// the task until it is answered (then the task continues by itself).

/** draft → queued → running ⇄ blocked → review → done; review can return to running; failed and cancelled end it. */
export type WorkItemStatus = "draft" | "queued" | "running" | "blocked" | "review" | "done" | "failed" | "cancelled";
export type WorkItemEventKind = "created" | "queued" | "started" | "reported" | "blocked" | "unblocked" | "accepted" | "returned" | "failed" | "cancelled" | "refused";
export type WorkItemEventDto = { kind: WorkItemEventKind; actor: string; text: string; at: number; delivery: "none" | "pending" | "delivered" | "failed" };
export type WorkItemDto = {
  id: string;
  code: string;
  title: string;
  description: string;
  criteria: string;
  executor: { agentId: string; name: string };
  status: WorkItemStatus;
  revision: number;
  /** Why the task waits: the request it waits for (its code and state) or a reason. */
  block: { text: string; requestCode: string | null } | null;
  result: string;
  returnComment: string;
  /** Position in the executor's queue (1 = next), for queued tasks. */
  queuePosition: number | null;
  deadlineAt: number | null;
  overdue: boolean;
  createdAt: number;
  updatedAt: number;
  events: WorkItemEventDto[];
};
export type WorkItemsDto = { items: WorkItemDto[]; executors: { agentId: string; name: string }[] };

export const CreateWorkItemRequest = z.object({
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(4000),
  criteria: z.string().trim().min(1).max(2000),
  executorAgentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  deadlineAt: z.number().int().positive().nullable().default(null),
  /** Start right away (queued if the executor is busy) instead of saving a draft. */
  start: z.boolean().default(false),
});
export type CreateWorkItemRequest = z.infer<typeof CreateWorkItemRequest>;
export const WorkItemActionRequest = z.object({
  requestId: z.uuid(),
  revision: z.number().int().min(0),
  /** start: draft or failed → queue; resume: blocked → running (the owner decided without the request); accept: review → done. */
  action: z.enum(["start", "cancel", "accept", "return", "resume"]),
  comment: z.string().trim().max(2000).default(""),
}).refine((value) => value.action !== "return" || value.comment.length > 0, { message: "comment required", path: ["comment"] });
export type WorkItemActionRequest = z.infer<typeof WorkItemActionRequest>;
