import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { BusinessRuleFields, CreateProjectRequest, ProjectBriefFields, type ProjectWorkspaceDto } from "@clawdesk/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanyService } from "../src/company/company-service.js";
import { folderName } from "../src/company/project-transfer-service.js";
import { openDb } from "../src/db/client.js";
import { companyProjects } from "../src/db/schema.js";
import { BridgeError } from "../src/gateway/bridge-client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import type { SpaceService } from "../src/space/space-service.js";
import { registerCompanyRoutes } from "../src/routes/company.js";

// P8: one installation exports a project, another imports it. Each has its own database and a fake bridge
// whose folders are in memory: names taken, files written, a write that fails once.

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const file = (filePath: string, text: string) => { const data = Buffer.from(text); return { path: filePath, size: data.length, sha256: sha(data), data: data.toString("base64") }; };
const rule = (title: string, statement: string) => BusinessRuleFields.parse({ title, statement, source: "Владелец", role: "Менеджер", expectedResult: "Ответ", allowedExample: "Да", deniedExample: "Нет" });

function installation(root: string, name: string) {
  const { db, close } = openDb(path.join(root, `${name}.sqlite`));
  const folders = new Map<string, string>(), written = new Map<string, { path: string; data: string }[]>(), taken = new Set<string>();
  let failWrite = 0;
  const bridge = {
    projectWorkspace: async (id: string): Promise<ProjectWorkspaceDto> => ({ rootPath: "/projects", workspace: folders.has(id) ? { name: folders.get(id)!, path: `/projects/${folders.get(id)}`, mode: "new", state: "ready" } : null, available: [], truncated: false }),
    prepareProjectWorkspace: async (id: string, request: { name: string }) => {
      if (taken.has(request.name)) throw new BridgeError("workspace_exists", "exists");
      taken.add(request.name); folders.set(id, request.name);
      return bridge.projectWorkspace(id);
    },
    projectTransferRead: async () => ({ files: [file("server.mjs", "console.log(1)"), file("docs/spec.md", "# ТЗ")], excluded: [{ path: ".env", reason: "secret_or_local" }], mode: "new" }),
    projectTransferWrite: async (id: string, files: { path: string; data: string }[]) => {
      if (failWrite-- > 0) throw new BridgeError("transfer_unavailable", "down");
      if (written.has(id)) throw new BridgeError("transfer_target_not_empty", "full");
      written.set(id, files); return { written: files.length, bytes: 1 };
    },
  };
  const company = new CompanyService({ db, bridge, space: { mode: () => "company" } as SpaceService, gateway: {} as GatewayService });
  return { db, close, company, folders, written, taken, failNext: (times = 1) => { failWrite = times; } };
}

describe("project transfer", () => {
  let root: string, here: ReturnType<typeof installation>, there: ReturnType<typeof installation>, projectId: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-transfer-"));
    here = installation(root, "here"); there = installation(root, "there");
    projectId = here.company.createProject(CreateProjectRequest.parse({ requestId: randomUUID(), name: "Заказы: пекарня!", description: "Учёт заказов" })).id;
    here.folders.set(projectId, "Заказы пекарня");
    here.company.saveProjectBrief(projectId, { requestId: randomUUID(), revision: 0, step: 2, fields: ProjectBriefFields.parse({ goal: "Учёт заказов", audience: "Пекарь" }) });
    const first = here.company.rules.create(projectId, { requestId: randomUUID(), fields: rule("Заказ меняет владелец", "Только владелец") });
    const approved = here.company.rules.approve(projectId, first.id, { requestId: randomUUID(), revision: first.revision, version: 1, confirm: true });
    here.company.rules.update(projectId, first.id, { requestId: randomUUID(), revision: approved.revision, fields: rule("Заказ меняет владелец или менеджер", "Владелец или менеджер") });
    here.company.rules.create(projectId, { requestId: randomUUID(), fields: rule("Скидка", "До 10%") });
  });
  afterEach(() => { here.close(); there.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("carries the project, its brief, every rule version and approval, and the folder's files", async () => {
    const preview = await here.company.transfer.preview(projectId);
    expect(preview).toMatchObject({ folder: "Заказы пекарня", rules: 2, briefFilled: true, excluded: [{ path: ".env", reason: "secret_or_local" }] });
    expect(preview.files.map((item) => item.path)).toEqual(["server.mjs", "docs/spec.md"]);
    const exported = await here.company.transfer.export(projectId);
    expect(exported.fileName).toMatch(/^Заказы пекарня \d{4}-\d{2}-\d{2}\.clawdesk-project$/);
    const pack = JSON.parse(gunzipSync(Buffer.from(exported.data, "base64")).toString("utf8"));
    expect(pack).toMatchObject({ format: "clawdesk-project", version: 1, project: { name: "Заказы: пекарня!" } });

    const result = await there.company.transfer.import(exported.data);
    expect(result).toMatchObject({ name: "Заказы: пекарня!", folder: "Заказы пекарня", files: 2, rules: 2, state: "imported", error: null, repeated: false });
    expect(there.company.projectBrief(result.projectId).fields).toMatchObject({ goal: "Учёт заказов", audience: "Пекарь" });
    const rules = there.company.rules.list(result.projectId).rules;
    expect(rules.map((item) => [item.code, item.version, item.approvedAt !== null, item.fields.title])).toEqual([["BR-001", 2, false, "Заказ меняет владелец или менеджер"], ["BR-002", 1, false, "Скидка"]]);
    const history = there.company.rules.history(result.projectId, rules[0]!.id).versions;
    expect(history.sort((a, b) => a.version - b.version).map((item) => [item.version, item.approvedAt !== null])).toEqual([[1, true], [2, false]]);
    expect(there.written.get(result.projectId)!.map((item) => item.path)).toEqual(["server.mjs", "docs/spec.md"]);

    // The same file again: the same project, nothing doubled.
    const again = await there.company.transfer.import(exported.data);
    expect(again).toMatchObject({ projectId: result.projectId, repeated: true, state: "imported" });
    expect(there.db.select().from(companyProjects).all()).toHaveLength(1);
    expect(there.company.rules.list(result.projectId).rules).toHaveLength(2);
  });

  it("takes a free folder name, and a failed write is finished by uploading the same file again", async () => {
    const exported = await here.company.transfer.export(projectId);
    there.taken.add("Заказы пекарня");
    there.failNext();
    const failed = await there.company.transfer.import(exported.data);
    expect(failed).toMatchObject({ state: "folder_failed", folder: "Заказы пекарня 2", error: "transfer_unavailable" });
    const finished = await there.company.transfer.import(exported.data);
    expect(finished).toMatchObject({ projectId: failed.projectId, state: "imported", folder: "Заказы пекарня 2", repeated: true });
    expect(there.db.select().from(companyProjects).all()).toHaveLength(1);
  });

  it("refuses a damaged, tampered or foreign file before creating anything", async () => {
    const exported = await here.company.transfer.export(projectId);
    const pack = JSON.parse(gunzipSync(Buffer.from(exported.data, "base64")).toString("utf8"));
    const repack = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value))).toString("base64");
    await expect(there.company.transfer.import(Buffer.from("not a package").toString("base64"))).rejects.toThrow("invalid_package");
    await expect(there.company.transfer.import(repack({ ...pack, format: "other" }))).rejects.toThrow("invalid_package");
    await expect(there.company.transfer.import(repack({ ...pack, files: [{ ...pack.files[0], data: Buffer.from("changed").toString("base64") }] }))).rejects.toThrow("invalid_package");
    await expect(there.company.transfer.import(repack({ ...pack, rules: [pack.rules[0], pack.rules[0]] }))).rejects.toThrow("invalid_package");
    expect(there.db.select().from(companyProjects).all()).toEqual([]);
  });

  it("makes folder names the folders accept", () => {
    expect(folderName("Заказы: пекарня!")).toBe("Заказы пекарня");
    expect(folderName("***")).toBe("Project");
    expect(folderName("a".repeat(80))).toHaveLength(52);
  });

  it("serves preview, export and import over HTTP", async () => {
    const app = Fastify();
    registerCompanyRoutes(app, here.company);
    expect((await app.inject({ method: "GET", url: `/api/company/projects/${projectId}/transfer` })).json()).toMatchObject({ rules: 2 });
    const exported = (await app.inject({ method: "POST", url: `/api/company/projects/${projectId}/transfer/export` })).json();
    expect(exported.fileName).toContain(".clawdesk-project");
    const other = Fastify();
    registerCompanyRoutes(other, there.company);
    expect((await other.inject({ method: "POST", url: "/api/company/projects/import", payload: { data: exported.data } })).json()).toMatchObject({ state: "imported" });
    expect((await other.inject({ method: "POST", url: "/api/company/projects/import", payload: { data: "AAAA" } })).statusCode).toBe(409);
    await app.close(); await other.close();
  });
});
