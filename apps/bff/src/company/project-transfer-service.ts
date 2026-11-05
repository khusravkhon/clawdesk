import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { ProjectPackage, PROJECT_PACKAGE_LIMIT, type BusinessRuleDto, type BusinessRuleVersionDto, type ProjectBriefDto, type ProjectExportDto, type ProjectImportDto, type ProjectTransferPreviewDto, type ProjectWorkspaceDto, type SaveProjectBriefRequest } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { projectImports } from "../db/schema.js";

// P8 (see @clawdesk/shared project-transfer). Export reads the folder through the bridge and adds the
// project's description and rules. Import checks the whole package before touching anything, creates the
// project and its rules with request IDs derived from the package (so a repeat changes nothing), then a new
// folder and its files. A failed folder step leaves the project; uploading the same file again finishes it.

export class ProjectTransferError extends Error {
  constructor(readonly code: "invalid_package" | "package_too_large" | "gateway_unavailable" | "folder_unavailable") { super(code); }
}

export type TransferBridge = {
  projectTransferRead(projectId: string): Promise<{ files: ProjectPackage["files"]; excluded: ProjectPackage["excluded"]; mode: string }>;
  projectTransferWrite(projectId: string, files: ProjectPackage["files"]): Promise<{ written: number; bytes: number }>;
  projectWorkspace(projectId: string): Promise<ProjectWorkspaceDto>;
  prepareProjectWorkspace(projectId: string, request: { requestId: string; mode: "new"; name: string }): Promise<ProjectWorkspaceDto>;
};
type Ports = {
  db: Db;
  project: (id: string) => { id: string; name: string; description: string };
  brief: (id: string) => ProjectBriefDto;
  saveBrief: (id: string, request: SaveProjectBriefRequest) => ProjectBriefDto;
  rules: { list(id: string): { rules: BusinessRuleDto[] }; history(id: string, ruleId: string): { versions: BusinessRuleVersionDto[] }; create(id: string, request: { requestId: string; fields: BusinessRuleDto["fields"] }): BusinessRuleDto; update(id: string, ruleId: string, request: { requestId: string; revision: number; fields: BusinessRuleDto["fields"] }): BusinessRuleDto; approve(id: string, ruleId: string, request: { requestId: string; revision: number; version: number; confirm: true }): BusinessRuleDto };
  createProject: (request: { requestId: string; name: string; description: string; departmentId: null; status: "draft" }) => { id: string };
  bridge?: TransferBridge;
  now?: () => number;
};

/** A request ID that is the same every time for the same package and step. */
const stableId = (...parts: string[]) => {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
/** A folder name the folders accept (letters, digits, space, "_", "-"; up to 60). */
export const folderName = (name: string) => (name.normalize("NFC").replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim().replace(/^[ _-]+/, "") || "Project").slice(0, 52).trim();

export class ProjectTransferService {
  constructor(private readonly deps: Ports) {}

  #bridge() { if (!this.deps.bridge) throw new ProjectTransferError("gateway_unavailable"); return this.deps.bridge; }

  async preview(projectId: string): Promise<ProjectTransferPreviewDto> {
    this.deps.project(projectId);
    const bridge = this.#bridge();
    const [read, workspace] = await Promise.all([bridge.projectTransferRead(projectId), bridge.projectWorkspace(projectId)]);
    const brief = this.deps.brief(projectId);
    return {
      folder: workspace.workspace?.name ?? null, files: read.files.map((file) => ({ path: file.path, size: file.size })), bytes: read.files.reduce((sum, file) => sum + file.size, 0),
      excluded: read.excluded, rules: this.deps.rules.list(projectId).rules.length, briefFilled: Object.values(brief.fields).some((value) => value.trim()),
    };
  }

  async export(projectId: string): Promise<ProjectExportDto> {
    const project = this.deps.project(projectId);
    const read = await this.#bridge().projectTransferRead(projectId);
    const rules = this.deps.rules.list(projectId).rules.map((rule) => ({
      code: rule.code,
      versions: this.deps.rules.history(projectId, rule.id).versions.sort((a, b) => a.version - b.version).map((version) => ({ version: version.version, fields: version.fields, approvedAt: version.approvedAt })),
    }));
    const pack: ProjectPackage = { format: "clawdesk-project", version: 1, packageId: randomUUID(), createdAt: this.deps.now?.() ?? Date.now(), project: { name: project.name, description: project.description }, brief: this.deps.brief(projectId).fields, rules, files: read.files, excluded: read.excluded };
    const data = gzipSync(Buffer.from(JSON.stringify(pack)));
    const day = new Date(pack.createdAt).toISOString().slice(0, 10);
    return { fileName: `${folderName(project.name)} ${day}.clawdesk-project`, data: data.toString("base64"), packageId: pack.packageId };
  }

  /** The package as checked data: size, format, paths and hashes, codes in order; nothing is created before. */
  static parse(base64: string): ProjectPackage {
    let json: unknown;
    try {
      const raw = gunzipSync(Buffer.from(base64, "base64"), { maxOutputLength: PROJECT_PACKAGE_LIMIT * 2 });
      json = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      throw new ProjectTransferError((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "package_too_large" : "invalid_package");
    }
    const parsed = ProjectPackage.safeParse(json);
    if (!parsed.success) throw new ProjectTransferError("invalid_package");
    const pack = parsed.data;
    let total = 0;
    for (const file of pack.files) {
      const data = Buffer.from(file.data, "base64");
      total += data.length;
      if (data.length !== file.size || createHash("sha256").update(data).digest("hex") !== file.sha256) throw new ProjectTransferError("invalid_package");
    }
    if (total > PROJECT_PACKAGE_LIMIT) throw new ProjectTransferError("package_too_large");
    if (new Set(pack.rules.map((rule) => rule.code)).size !== pack.rules.length) throw new ProjectTransferError("invalid_package");
    return pack;
  }

  async import(base64: string): Promise<ProjectImportDto> {
    const pack = ProjectTransferService.parse(base64);
    const bridge = this.#bridge();
    const { db } = this.deps;
    const before = db.select().from(projectImports).where(eq(projectImports.packageId, pack.packageId)).get();
    if (before?.state === "imported") return this.#dto(before.projectId, pack, (await bridge.projectWorkspace(before.projectId).catch(() => null))?.workspace?.name ?? null, "imported", null, true);
    // The project, its brief and its rules: every step keyed on the package, so a repeat is a no-op.
    const { id } = this.deps.createProject({ requestId: stableId(pack.packageId, "project"), name: pack.project.name, description: pack.project.description, departmentId: null, status: "draft" });
    if (!before) db.insert(projectImports).values({ packageId: pack.packageId, projectId: id, state: "folder_failed", createdAt: this.deps.now?.() ?? Date.now() }).run();
    const brief = this.deps.brief(id);
    if (brief.updatedAt === null) this.deps.saveBrief(id, { requestId: stableId(pack.packageId, "brief"), revision: brief.revision, step: 3, fields: pack.brief });
    const existing = new Map(this.deps.rules.list(id).rules.map((rule) => [rule.code, rule]));
    for (const rule of [...pack.rules].sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }))) {
      let current = existing.get(rule.code);
      for (const version of [...rule.versions].sort((a, b) => a.version - b.version)) {
        if (current && current.version >= version.version) {
          if (version.approvedAt && current.version === version.version && current.approvedAt === null) current = this.deps.rules.approve(id, current.id, { requestId: stableId(pack.packageId, rule.code, String(version.version), "approve"), revision: current.revision, version: current.version, confirm: true });
          continue;
        }
        current = current
          ? this.deps.rules.update(id, current.id, { requestId: stableId(pack.packageId, rule.code, String(version.version)), revision: current.revision, fields: version.fields })
          : this.deps.rules.create(id, { requestId: stableId(pack.packageId, rule.code, String(version.version)), fields: version.fields });
        // The owner approved this version on the other installation; the approval travels with it.
        if (version.approvedAt) current = this.deps.rules.approve(id, current.id, { requestId: stableId(pack.packageId, rule.code, String(version.version), "approve"), revision: current.revision, version: current.version, confirm: true });
      }
    }
    // A new folder: the project's name, or "<name> 2…5" when it is taken.
    let folder = (await bridge.projectWorkspace(id).catch(() => null))?.workspace?.name ?? null;
    let error: string | null = null;
    for (let attempt = 1; !folder && attempt <= 5; attempt++) {
      const name = attempt === 1 ? folderName(pack.project.name) : `${folderName(pack.project.name)} ${attempt}`;
      try { folder = (await bridge.prepareProjectWorkspace(id, { requestId: stableId(pack.packageId, "folder", String(attempt)), mode: "new", name })).workspace?.name ?? null; }
      catch (failure) {
        const code = (failure as { code?: string }).code ?? "folder_unavailable";
        error = code;
        if (code !== "workspace_exists" && code !== "workspace_in_use") break;
      }
    }
    if (folder) {
      try { await bridge.projectTransferWrite(id, pack.files); error = null; }
      catch (failure) {
        const code = (failure as { code?: string }).code ?? "folder_unavailable";
        // Written already by an earlier attempt that lost its answer: the folder is the package's.
        error = code === "transfer_target_not_empty" && before ? null : code;
      }
    }
    const state = folder && !error ? "imported" : "folder_failed";
    db.update(projectImports).set({ state }).where(eq(projectImports.packageId, pack.packageId)).run();
    return this.#dto(id, pack, folder, state, error, !!before);
  }

  #dto(projectId: string, pack: ProjectPackage, folder: string | null, state: ProjectImportDto["state"], error: string | null, repeated: boolean): ProjectImportDto {
    return { projectId, name: pack.project.name, folder, files: pack.files.length, rules: pack.rules.length, state, error, repeated };
  }
}
