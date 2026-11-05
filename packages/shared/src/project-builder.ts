import { z } from "zod";
import { ProjectBriefFields, type ProjectBriefDto, type BusinessRuleDto, type ProjectWorkspaceDto } from "./company.js";

export const BuilderMutationRequest = z.object({ requestId: z.uuid(), revision: z.number().int().min(0) });
export type BuilderMutationRequest = z.infer<typeof BuilderMutationRequest>;
export const AnswerProjectBuilderRequest = BuilderMutationRequest.extend({ field: ProjectBriefFields.keyof(), value: z.string().trim().min(1).max(4000) });
export type AnswerProjectBuilderRequest = z.infer<typeof AnswerProjectBuilderRequest>;
/** P4: when the foundation leaves needs out of the first version, the plan needs the owner's word on it. */
export const PlanProjectBuilderRequest = BuilderMutationRequest.extend({ templateId: z.literal("task-board-v1"), acknowledgeGaps: z.boolean().optional() });
export type PlanProjectBuilderRequest = z.infer<typeof PlanProjectBuilderRequest>;
export const ConfirmProjectBuilderRequest = BuilderMutationRequest.extend({ confirm: z.literal(true) });
export type ConfirmProjectBuilderRequest = z.infer<typeof ConfirmProjectBuilderRequest>;
export const ProjectPreviewRequest = z.object({ method: z.enum(["GET", "POST", "PATCH", "DELETE"]), path: z.string().max(160).regex(/^\/api\/tasks(?:\/[a-zA-Z0-9_-]+)?$/), body: z.object({ title: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional() }).strict().optional() });
export type ProjectPreviewRequest = z.infer<typeof ProjectPreviewRequest>;
export type ProjectPreviewResponse = { status: number; contentType: string; body: string };
export type ProjectBuilderRuntimeDto = { state: "empty" | "prepared" | "running" | "stopped" | "failed"; planId: string | null; files: string[]; previewUrl: string | null; error: string | null };
export type ProjectBuilderTemplateDto = { id: "task-board-v1"; name: string; description: string; features: string[]; limitations: string[] };
export type ProjectBuilderSnapshot = { projectRevision: number; briefRevision: number; rules: { id: string; version: number; revision: number; approvedAt: number | null }[]; workspace: { path: string; mode: string; state: string } | null };
export type ProjectBuilderPlanDto = { id: string; templateId: "task-board-v1"; projectName: string; features: string[]; limitations: string[]; files: string[]; brief: z.infer<typeof ProjectBriefFields>; rules: BusinessRuleDto[]; snapshot: ProjectBuilderSnapshot; createdAt: number; approvedAt: number | null; foundation?: import("./project-foundation.js").FoundationDto; gapsAcknowledged?: boolean };
export type ProjectWorkspaceAnalysisDto = { files: string[]; dependencies: string[]; hasGit: boolean; truncated: boolean };
export type ProjectBuilderDto = { revision: number; brief: ProjectBriefDto; questions: { field: keyof z.infer<typeof ProjectBriefFields>; prompt: string }[]; templates: ProjectBuilderTemplateDto[]; plan: ProjectBuilderPlanDto | null; stale: boolean; blockers: string[]; foundation: import("./project-foundation.js").FoundationDto; runtime: ProjectBuilderRuntimeDto; workspace: ProjectWorkspaceDto["workspace"] };
export type PrepareProjectAppRequest = { planId: string; templateId: "task-board-v1"; projectName: string; brief: z.infer<typeof ProjectBriefFields>; rules: BusinessRuleDto[] };
