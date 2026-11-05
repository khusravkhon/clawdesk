// Stage 9: one state per company agent for the work list and the office. It combines confirmed runs from
// the Gateway's events with tasks and requests from the database; "working" needs a run the Gateway
// reported, never silence. Both views read the same snapshot; the stream only tells them it changed.

export type AgentActivityState = "idle" | "queued" | "working" | "waiting_for_agent" | "waiting_for_owner" | "blocked" | "error" | "offline" | "unknown";
export type AgentActivityDto = {
  agentId: string;
  name: string;
  role: "main" | "specialist" | "team_member";
  /** The template or team role (developer, qa, manager…), when there is one. */
  position: string | null;
  team: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  state: AgentActivityState;
  /** Why: the task in work, whom it waits for, the error. Plain text. */
  detail: string;
  /** Confirmed by an event of the agent's run (a tool it is using), else null. */
  action: string | null;
  /** Runs the Gateway reported started and not finished. */
  runs: number;
  task: { code: string; title: string; status: string } | null;
  request: { code: string; addressee: string } | null;
  /** Requests addressed to this agent and waiting for its answer. */
  inbox: number;
  lastActivityAt: number | null;
};
export type ActivityCountsDto = Record<"working" | "idle" | "waiting" | "blocked" | "error" | "offline", number>;
export type CompanyActivityDto = { sequence: number; generatedAt: number; gatewayConnected: boolean; agents: AgentActivityDto[]; counts: ActivityCountsDto };
