import { z } from "zod";
import type { ProjectCheckRunSummaryDto, ProjectCheckTestDto } from "./project-checks.js";

// P6.2: work on an approved business rule by the project's executors. QA writes tests that fail on the
// current code, the developer makes them pass without touching tests, the owner reviews and accepts.
// Each executor works in its own copy; app/ changes only when the owner accepts a reviewed task.

export type ProjectExecutorRole = "qa" | "developer";
export type ProjectExecutorDto = { role: ProjectExecutorRole; agentId: string; name: string; emoji: string | null };
export type ProjectExecutorsDto = { teamId: string | null; executors: ProjectExecutorDto[]; sandboxed: boolean };
export const AssignExecutorsRequest = z.object({ requestId: z.uuid(), timezone: z.string().min(1).max(64) });
export type AssignExecutorsRequest = z.infer<typeof AssignExecutorsRequest>;

/** qa → (QA's tests fail as expected) → dev → (all checks pass, tests untouched) → review → done; review can return to dev. */
export type ProjectTaskStatus = "qa" | "dev" | "review" | "done" | "cancelled";
export type ProjectTaskStage = "qa" | "dev";
export type ProjectFileChange = { name: string; change: "added" | "modified" | "removed"; diff: string | null };
/** Why the panel did not accept a stage; codes are explained in the interface. */
export type ProjectTaskReason =
  | "layout" | "no_changes" | "removed_files" | "changed_code" | "tests_missing" | "tests_not_failing" | "tests_flaky"
  | "existing_failing" | "changed_tests" | "tests_failing" | "run_blocked";
export type ProjectTaskCheckDto = {
  stage: ProjectTaskStage;
  ok: boolean;
  reasons: ProjectTaskReason[];
  /** Files the stage changed relative to its starting point. */
  changes: ProjectFileChange[];
  /** Tests whose name starts with the rule's code. */
  ruleTests: ProjectCheckTestDto[];
  /** Other tests that did not pass. */
  otherProblems: ProjectCheckTestDto[];
  run: ProjectCheckRunSummaryDto | null;
  ignored: string[];
  at: number;
};
export type ProjectTaskEventDto = { kind: "created" | "sent" | "qa_checked" | "dev_checked" | "accepted" | "returned" | "cancelled"; at: number; note: string };
export type ProjectTaskDto = {
  id: string;
  code: string;
  ruleId: string;
  ruleCode: string;
  ruleVersion: number;
  title: string;
  note: string;
  status: ProjectTaskStatus;
  revision: number;
  lastCheck: ProjectTaskCheckDto | null;
  /** Files the developer stage changed against app/, shown for the review. */
  review: ProjectFileChange[] | null;
  returnComment: string;
  events: ProjectTaskEventDto[];
  createdAt: number;
  updatedAt: number;
};
export type ProjectTasksDto = { tasks: ProjectTaskDto[] };

export const CreateProjectTaskRequest = z.object({ requestId: z.uuid(), ruleId: z.uuid(), ruleVersion: z.number().int().min(1), note: z.string().trim().max(2000).default("") });
export type CreateProjectTaskRequest = z.infer<typeof CreateProjectTaskRequest>;
export const ProjectTaskActionRequest = z.object({ requestId: z.uuid(), revision: z.number().int().min(0) });
export type ProjectTaskActionRequest = z.infer<typeof ProjectTaskActionRequest>;
export const ReturnProjectTaskRequest = ProjectTaskActionRequest.extend({ comment: z.string().trim().min(1).max(2000) });
export type ReturnProjectTaskRequest = z.infer<typeof ReturnProjectTaskRequest>;
