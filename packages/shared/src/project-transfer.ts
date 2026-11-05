import { z } from "zod";
import { BusinessRuleFields, ProjectBriefFields } from "./company.js";

// P8: a project carried to another installation (a server, another computer) as a file the owner downloads
// here and uploads there. A folder belongs to the machine its installation runs on; nothing reads another
// machine's folder. The package (gzip of JSON) holds the project's name and description, its brief, its
// business rules with every version and approval, and the folder's files with their hashes — left out like a
// first GitHub push: version control, dependencies, local databases, secrets, links, large files. Acceptance
// scenarios, tasks, check runs, executors and the GitHub link stay with this installation.

export const PROJECT_PACKAGE_LIMIT = 20 * 1024 * 1024;
export const ProjectPackage = z.object({
  format: z.literal("clawdesk-project"),
  version: z.literal(1),
  /** The same package uploaded twice makes one project. */
  packageId: z.uuid(),
  createdAt: z.number().int().positive(),
  project: z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(4000).default("") }),
  brief: ProjectBriefFields,
  rules: z.array(z.object({
    code: z.string().regex(/^BR-\d{3,}$/),
    versions: z.array(z.object({ version: z.number().int().min(1), fields: BusinessRuleFields, approvedAt: z.number().int().positive().nullable() })).min(1).max(100),
  })).max(300),
  files: z.array(z.object({ path: z.string().min(1).max(1000), size: z.number().int().min(0), sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.string() })).max(2000),
  excluded: z.array(z.object({ path: z.string().max(1000), reason: z.string().max(40) })).max(10_000).default([]),
});
export type ProjectPackage = z.infer<typeof ProjectPackage>;

/** What a package of this project would carry, before it is made. */
export type ProjectTransferPreviewDto = {
  folder: string | null;
  files: { path: string; size: number }[];
  bytes: number;
  excluded: { path: string; reason: string }[];
  rules: number;
  briefFilled: boolean;
};
export type ProjectExportDto = { fileName: string; data: string; packageId: string };
export const ImportProjectRequest = z.object({ data: z.string().min(1).max(40 * 1024 * 1024) });
export type ImportProjectRequest = z.infer<typeof ImportProjectRequest>;
/** imported — project and folder ready; folder_failed — the project exists, its files are not written yet (upload again). */
export type ProjectImportDto = { projectId: string; name: string; folder: string | null; files: number; rules: number; state: "imported" | "folder_failed"; error: string | null; repeated: boolean };
