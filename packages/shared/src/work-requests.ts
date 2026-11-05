import { z } from "zod";

// Stage 6: requests up the company structure. An agent files a request (clawdesk_request_up); the panel
// routes it: department manager → main agent → owner, skipping levels that do not exist or are not
// running. The current addressee answers, denies, asks to clarify or passes it up; an agent addressee
// replies with clawdesk_request_reply, the owner here. A text answer never grants access.

export type WorkRequestKind = "question" | "decision";
/** open: waiting for the addressee; clarify: waiting for the requester's reply. */
export type WorkRequestStatus = "open" | "clarify" | "answered" | "denied" | "expired" | "cancelled";
export type WorkRequestLevelKind = "manager" | "main" | "owner";
export type WorkRequestLevelDto = { kind: WorkRequestLevelKind; agentId: string | null; name: string };
export type WorkRequestEventKind = "created" | "routed" | "skipped" | "escalated" | "clarify" | "reply" | "answered" | "denied" | "expired" | "cancelled" | "refused";
export type WorkRequestEventDto = { kind: WorkRequestEventKind; actor: string; text: string; at: number; delivery: "none" | "pending" | "delivered" | "failed" };
export type WorkRequestDto = {
  id: string;
  code: string;
  from: { agentId: string; name: string };
  kind: WorkRequestKind;
  subject: string;
  details: string;
  taskRef: string;
  status: WorkRequestStatus;
  revision: number;
  /** The route as computed when the request was filed; `level` is the current addressee. */
  route: WorkRequestLevelDto[];
  level: number;
  /** `by`: the agent ID or "owner"; `name`: how to show it. */
  answer: { by: string; name: string; text: string } | null;
  deadlineAt: number;
  createdAt: number;
  updatedAt: number;
  events: WorkRequestEventDto[];
};
export type WorkRequestsDto = { requests: WorkRequestDto[] };

/** The owner's action; the owner is the last level, so there is no "escalate" here. */
export const OwnerRequestAction = z.object({
  requestId: z.uuid(),
  revision: z.number().int().min(0),
  action: z.enum(["answer", "deny", "clarify", "cancel"]),
  text: z.string().trim().max(4000).default(""),
}).refine((value) => value.action === "cancel" || value.text.length > 0, { message: "text required", path: ["text"] });
export type OwnerRequestAction = z.infer<typeof OwnerRequestAction>;
