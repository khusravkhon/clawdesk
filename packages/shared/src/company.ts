import { z } from "zod";

const EntityId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const DepartmentFields = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(""),
  managerAgentId: EntityId.nullable().default(null),
  archived: z.boolean().default(false),
});
export const CreateDepartmentRequest = DepartmentFields.extend({ requestId: z.uuid() });
export type CreateDepartmentRequest = z.infer<typeof CreateDepartmentRequest>;
export const UpdateDepartmentRequest = DepartmentFields.extend({ revision: z.number().int().min(0) });
export type UpdateDepartmentRequest = z.infer<typeof UpdateDepartmentRequest>;
export const AssignTeamDepartmentRequest = z.object({ departmentId: EntityId.nullable(), revision: z.number().int().min(0) });
export type AssignTeamDepartmentRequest = z.infer<typeof AssignTeamDepartmentRequest>;
export const AssignAgentDepartmentRequest = AssignTeamDepartmentRequest;
export type AssignAgentDepartmentRequest = z.infer<typeof AssignAgentDepartmentRequest>;
export const ProjectStatus = z.enum(["draft", "planned", "archived"]);
export const ProjectFields = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(4000).default(""),
  departmentId: EntityId.nullable().default(null),
  status: ProjectStatus.default("draft"),
});
export const CreateProjectRequest = ProjectFields.extend({ requestId: z.uuid() });
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export const UpdateProjectRequest = ProjectFields.extend({ revision: z.number().int().min(0) });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;
export const AssignTeamProjectRequest = z.object({ projectId: EntityId.nullable(), revision: z.number().int().min(0) });
export type AssignTeamProjectRequest = z.infer<typeof AssignTeamProjectRequest>;
export type ProjectDto = z.infer<typeof ProjectFields> & { id: string; revision: number };
const BriefText = z.string().trim().max(4000).default("");
export const ProjectBriefFields = z.object({
  goal: BriefText, audience: BriefText, scenarios: BriefText,
  inScope: BriefText, outOfScope: BriefText, rules: BriefText,
  data: BriefText, integrations: BriefText, constraints: BriefText, openQuestions: BriefText,
});
export type ProjectBriefFields = z.infer<typeof ProjectBriefFields>;
export const SaveProjectBriefRequest = z.object({
  requestId: z.uuid(), revision: z.number().int().min(0), step: z.number().int().min(0).max(3), fields: ProjectBriefFields,
});
export type SaveProjectBriefRequest = z.infer<typeof SaveProjectBriefRequest>;
export type ProjectBriefDto = { revision: number; step: number; fields: ProjectBriefFields; updatedAt: number | null };
const RuleText = z.string().trim().max(4000).default("");
export const BusinessRuleFields = z.object({
  title: z.string().trim().min(1).max(160), statement: z.string().trim().min(1).max(4000),
  source: RuleText, role: RuleText, preconditions: RuleText, expectedResult: RuleText,
  exceptions: RuleText, allowedExample: RuleText, deniedExample: RuleText, openQuestions: RuleText,
});
export type BusinessRuleFields = z.infer<typeof BusinessRuleFields>;
export const CreateBusinessRuleRequest = z.object({ requestId: z.uuid(), fields: BusinessRuleFields });
export type CreateBusinessRuleRequest = z.infer<typeof CreateBusinessRuleRequest>;
export const UpdateBusinessRuleRequest = CreateBusinessRuleRequest.extend({ revision: z.number().int().min(0) });
export type UpdateBusinessRuleRequest = z.infer<typeof UpdateBusinessRuleRequest>;
export const ApproveBusinessRuleRequest = z.object({ requestId: z.uuid(), revision: z.number().int().min(0), version: z.number().int().min(1), confirm: z.literal(true) });
export type ApproveBusinessRuleRequest = z.infer<typeof ApproveBusinessRuleRequest>;
export type BusinessRuleVersionDto = { version: number; fields: BusinessRuleFields; createdAt: number; createdBy: "owner"; approvedAt: number | null; approvedBy: "owner" | null };
export type BusinessRuleDto = BusinessRuleVersionDto & { id: string; code: string; revision: number };
export const PrepareProjectWorkspaceRequest = z.object({
  requestId: z.uuid(),
  mode: z.enum(["new", "existing"]),
  name: z.string().min(1).max(60).regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u),
});
export type PrepareProjectWorkspaceRequest = z.infer<typeof PrepareProjectWorkspaceRequest>;
export type ProjectWorkspaceDto = {
  rootPath: string;
  workspace: { name: string; path: string; mode: "new" | "existing"; state: "ready" | "missing" | "changed" } | null;
  available: string[];
  truncated: boolean;
};

export type DepartmentDto = {
  id: string; name: string; description: string; archived: boolean; revision: number;
  managerAgentId: string | null; managerName: string | null;
  managerState: "ready" | "missing" | "unverified" | "unassigned";
};
export type CompanyDto = {
  name: string; gatewayAvailable: boolean;
  departments: DepartmentDto[];
  projects: ProjectDto[];
  managers: { id: string; name: string; departmentId: string | null }[];
  agents: { id: string; name: string; departmentId: string | null; revision: number; managerOf: string | null; available: boolean }[];
  teams: { id: string; name: string; departmentId: string | null; projectId: string | null; revision: number }[];
};
