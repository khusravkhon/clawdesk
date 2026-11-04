import { z } from "zod";
import type { BusinessRuleFields } from "./company.js";
import type { AutomatedCheckStatus, ProjectCheckRunSummaryDto, ProjectCheckStatus, ProjectCheckTestDto } from "./project-checks.js";

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
  | "existing_failing" | "changed_tests" | "tests_failing" | "run_blocked"
  | "protected_tests_changed" | "shared_test_code_changed" | "tests_unreadable";
/** Accepted, but worth the owner's attention in the review. */
export type ProjectTaskWarning = "shared_test_code_added";
/** One test added, modified or removed by the task; `rule` — it belongs to the task's rule (P6.3). */
export type ProjectTestChangeDto = { id: string; file: string; name: string; change: "added" | "modified" | "removed"; rule: boolean };
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
  /** Test by test: what the stage added, modified or removed. */
  testChanges: ProjectTestChangeDto[];
  warnings: ProjectTaskWarning[];
  run: ProjectCheckRunSummaryDto | null;
  ignored: string[];
  at: number;
};
export type ProjectTaskEventDto = { kind: "created" | "sent" | "qa_checked" | "dev_checked" | "accepted" | "returned" | "cancelled" | "rolled_back"; at: number; note: string };
export type ProjectTaskDto = {
  id: string;
  code: string;
  ruleId: string;
  ruleCode: string;
  ruleVersion: number;
  /** P6.3: the rule version the app implemented when the task started (an accepted earlier task), or null for a new rule. */
  previousVersion: number | null;
  /** The rule has a newer version than the task's: the task cannot be accepted. */
  outdated: boolean;
  title: string;
  note: string;
  status: ProjectTaskStatus;
  revision: number;
  lastCheck: ProjectTaskCheckDto | null;
  /** Files the developer stage changed against app/, shown for the review. */
  review: ProjectFileChange[] | null;
  /** The same review test by test, with shared test code changes. */
  reviewTests: ProjectTestChangeDto[] | null;
  reviewWarnings: ProjectTaskWarning[];
  returnComment: string;
  /** When the owner returned app/ to the files the task started from. */
  rolledBackAt: number | null;
  /** The latest accepted task, app/ unchanged since and no task active: it can be rolled back. */
  canRollback: boolean;
  events: ProjectTaskEventDto[];
  createdAt: number;
  updatedAt: number;
};
export type ProjectTasksDto = { tasks: ProjectTaskDto[] };

export const CreateProjectTaskRequest = z.object({ requestId: z.uuid(), ruleId: z.uuid(), ruleVersion: z.number().int().min(1), note: z.string().trim().max(2000).default("") });
export type CreateProjectTaskRequest = z.infer<typeof CreateProjectTaskRequest>;
export const ProjectTaskActionRequest = z.object({ requestId: z.uuid(), revision: z.number().int().min(0) });
export type ProjectTaskActionRequest = z.infer<typeof ProjectTaskActionRequest>;
/** A change of an implemented rule needs the owner's word on existing data: the panel migrates nothing. */
export const AcceptProjectTaskRequest = ProjectTaskActionRequest.extend({ confirmData: z.boolean().optional() });
export type AcceptProjectTaskRequest = z.infer<typeof AcceptProjectTaskRequest>;
export const ReturnProjectTaskRequest = ProjectTaskActionRequest.extend({ comment: z.string().trim().min(1).max(2000) });
export type ReturnProjectTaskRequest = z.infer<typeof ReturnProjectTaskRequest>;

/**
 * P6.3: what changing a rule touches, before a task is created. The previous version is the one the
 * app implements (the latest accepted, not rolled back task on the rule); without one the rule is new.
 */
export type RuleChangeImpactDto = {
  ruleId: string;
  code: string;
  version: number;
  approved: boolean;
  fields: BusinessRuleFields;
  previousVersion: number | null;
  previousFields: BusinessRuleFields | null;
  /** Field names that differ between the previous and this version. */
  changedFields: (keyof BusinessRuleFields)[];
  /** Task that implemented the previous version, and the app files it changed. */
  implementedBy: string | null;
  files: string[];
  /** Tests of the latest completed run that belong to the rule (by code or by a scenario link). */
  tests: { id: string; name: string; status: ProjectCheckStatus }[];
  /** Scenarios of the previous version and their automated status now. */
  scenarios: { code: string; title: string; ruleVersion: number; testRef: string; status: AutomatedCheckStatus | null }[];
  /** Scenarios already written for this version. */
  newScenarios: number;
  activeTask: string | null;
};
