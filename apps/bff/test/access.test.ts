import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { FolderSyncStatusesDto } from "@clawdesk/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessService } from "../src/company/access-service.js";
import { WorkRequestsService } from "../src/company/work-requests-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { agents, mcpGrants, mcpServers, resourceGrants, teams } from "../src/db/schema.js";
import { registerWorkRequestRoutes } from "../src/routes/work-requests.js";

// Stage 5: access is read from, and checked at, where it is enforced. The fake bridge is the folder
// registry; the fake config holds the MCP denies that McpService would write from the grants.

describe("company access", () => {
  let root: string, db: Db, close: () => void, access: AccessService, requests: WorkRequestsService;
  let folders: FolderSyncStatusesDto["folders"], shared: string[], denies: Record<string, string[]>, spool: Record<string, unknown>[], sent: { agentId: string; message: string }[], breakFolders: boolean;
  const status = (agentId: string, folder: string, extra: Partial<FolderSyncStatusesDto["folders"][number]> = {}) => ({ agentId, folder, state: "ready" as const, lastAttempt: 1, lastSuccess: 1, conflicts: 0, skipped: 0, issues: [], dir: null, readOnly: false, ...extra });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-access-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    folders = []; shared = ["Finance", "Marketing"]; spool = []; sent = []; breakFolders = false;
    db.insert(teams).values([{ id: "shop", name: "Shop", repoUrl: "https://github.com/a/shop" }]).run();
    db.insert(agents).values([
      { id: "analyst", role: "specialist", displayName: "Аналитик", sandbox: true },
      { id: "dev", role: "team_member", teamId: "shop", templateId: "developer", displayName: "Разработчик", sandbox: true },
    ]).run();
    db.insert(mcpServers).values({ name: "notion", url: "https://mcp.notion.com", auth: "oauth", managed: true }).run();
    db.insert(mcpGrants).values({ server: "notion", agentId: "main" }).run();
    denies = { analyst: ["notion__*"], dev: ["notion__*"], main: [] };
    const bridge = {
      folderSyncStatus: async () => ({ folders: [...folders] }),
      sharedFolders: async () => ({ folders: [...shared] }),
      ensureAgentFolder: async (agentId: string, name: string, options: { readOnly?: boolean } = {}) => { if (!breakFolders) folders.push(status(agentId, name, { readOnly: options.readOnly === true })); return { hostPath: "h", gatewayPath: "g" }; },
      removeAgentFolder: async (agentId: string, name: string, options: { dir?: string } = {}) => { folders = folders.filter((item) => !(item.agentId === agentId && item.folder === name && (item.dir ?? undefined) === options.dir)); return { removed: true }; },
    };
    access = new AccessService({
      db, companyMode: () => true, bridge, now: () => 5,
      setMcpAgents: async (server, ids) => { db.delete(mcpGrants).run(); for (const id of ids) db.insert(mcpGrants).values({ server, agentId: id }).run(); for (const id of Object.keys(denies)) denies[id] = ids.includes(id) ? [] : [`${server}__*`]; },
      config: async () => ({ agents: { entries: Object.fromEntries(Object.entries(denies).map(([id, deny]) => [id, { tools: { deny } }])) } }),
    });
    requests = new WorkRequestsService({
      db, companyMode: () => true, liveAgents: async () => new Set(["main", "analyst", "dev"]),
      bridge: { requestsSpool: async () => ({ entries: [...spool], rejected: [] }), requestsAck: async (ids) => { spool = spool.filter((item) => !ids.includes(item.id as string)); } },
      send: async (agentId, message) => { sent.push({ agentId, message }); },
    });
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("shows what each agent reaches, grants a folder read-only and revokes it, checking both", async () => {
    folders = [status("dev", "Shop", { dir: "docs", readOnly: true })];
    let list = await access.list();
    expect(list.folders).toEqual(["Finance", "Marketing"]);
    expect(list.servers).toEqual(["notion"]);
    expect(list.agents.find((agent) => agent.agentId === "dev")!.resources).toEqual([
      { kind: "team-docs", name: "Shop", access: "read", path: "/workspace/docs", state: "ready", revocable: true },
      { kind: "team-repo", name: "Shop", access: "write", path: "/workspace/repo", state: "granted", revocable: false },
    ]);
    expect(list.agents.find((agent) => agent.agentId === "main")!.resources).toEqual([{ kind: "mcp", name: "notion", access: "write", path: null, state: "granted", revocable: true }]);

    expect(await access.grant({ agentId: "analyst", resource: "folder:Finance", access: "read" }, "owner")).toEqual({ resource: "folder:Finance", access: "read", path: "/workspace/folders/Finance" });
    list = await access.list();
    expect(list.agents.find((agent) => agent.agentId === "analyst")!.resources).toEqual([{ kind: "folder", name: "Finance", access: "read", path: "/workspace/folders/Finance", state: "ready", revocable: true }]);
    await access.revoke({ agentId: "analyst", resource: "folder:Finance" }, "owner");
    expect((await access.list()).agents.find((agent) => agent.agentId === "analyst")!.resources).toEqual([]);
    await access.revoke({ agentId: "dev", resource: "team-docs:Shop" }, "owner");
    expect(folders).toEqual([]);
    expect(db.select().from(resourceGrants).all().map((grant) => [grant.agentId, grant.resource, grant.grantedBy, grant.revokedBy])).toEqual([["analyst", "folder:Finance", "owner", "owner"], ["dev", "team-docs:Shop", "—", "owner"]]);
  });

  it("refuses what does not exist and reports a grant that did not take effect", async () => {
    await expect(access.grant({ agentId: "analyst", resource: "folder:Secret", access: "read" }, "owner")).rejects.toThrow("resource_missing");
    await expect(access.grant({ agentId: "ghost", resource: "folder:Finance", access: "read" }, "owner")).rejects.toThrow("agent_missing");
    await expect(access.grant({ agentId: "main", resource: "folder:Finance", access: "read" }, "owner")).rejects.toThrow("main_folders");
    await expect(access.grant({ agentId: "analyst", resource: "mcp:figma", access: "write" }, "owner")).rejects.toThrow("resource_missing");
    breakFolders = true;
    await expect(access.grant({ agentId: "analyst", resource: "folder:Finance", access: "write" }, "owner")).rejects.toThrow("not_applied");
    expect(db.select().from(resourceGrants).all()).toEqual([]);
  });

  it("grants and revokes an MCP server, checked against the denies in the config", async () => {
    await access.grant({ agentId: "analyst", resource: "mcp:notion", access: "write" }, "owner");
    expect(denies.analyst).toEqual([]);
    expect(db.select().from(mcpGrants).all().map((grant) => grant.agentId).sort()).toEqual(["analyst", "main"]);
    await access.revoke({ agentId: "analyst", resource: "mcp:notion" }, "owner");
    expect(denies.analyst).toEqual(["notion__*"]);
    await expect(access.revoke({ agentId: "analyst", resource: "mcp:notion" }, "owner")).rejects.toThrow("resource_missing");
  });

  it("an access request travels up, agents cannot grant it, the owner's grant is applied and checked", async () => {
    spool.push({ id: "a".repeat(32), type: "up", agentId: "analyst", kind: "access", subject: "Отчёт за квартал", details: "Нужны данные финансов", resource: "folder:Finance", access: "read" });
    spool.push({ id: "b".repeat(32), type: "up", agentId: "analyst", kind: "access", subject: "Без ресурса", details: "x" });
    await requests.tick();
    let request = requests.list().requests[0]!;
    expect(request).toMatchObject({ code: "REQ-001", kind: "access", resource: "folder:Finance", access: "read", route: [{ kind: "main" }, { kind: "owner" }] });
    expect(sent.find((item) => item.agentId === "main")!.message).toContain("нужен доступ: folder:Finance, чтение");
    expect(sent.some((item) => item.agentId === "analyst" && item.message.includes("для доступа укажи resource"))).toBe(true);
    spool.push({ id: "c".repeat(32), type: "reply", agentId: "main", requestId: "REQ-001", action: "answer", text: "вот содержимое папки" });
    await requests.tick();
    expect(requests.list().requests[0]!.status).toBe("open");
    expect(sent.some((item) => item.agentId === "main" && item.message.includes("его выдаёт только владелец"))).toBe(true);
    spool.push({ id: "d".repeat(32), type: "reply", agentId: "main", requestId: "REQ-001", action: "escalate", text: "решать владельцу" });
    await requests.tick();
    request = requests.list().requests[0]!;
    expect(request.level).toBe(1);

    const app = Fastify(); registerWorkRequestRoutes(app, { requests, access });
    const grant = { requestId: randomUUID(), revision: request.revision, action: "grant" };
    const done = await app.inject({ method: "POST", url: `/api/company/requests/${request.id}/act`, payload: grant });
    expect(done.json()).toMatchObject({ status: "answered", answer: { by: "owner", text: "Доступ выдан и проверен: folder:Finance (только чтение), в песочнице: /workspace/folders/Finance." } });
    expect((await app.inject({ method: "POST", url: `/api/company/requests/${request.id}/act`, payload: grant })).json()).toMatchObject({ status: "answered" });
    expect(folders.filter((item) => item.agentId === "analyst")).toHaveLength(1);
    expect(db.select().from(resourceGrants).all().map((row) => row.grantedBy)).toEqual(["REQ-001"]);
    await requests.tick();
    expect(sent.at(-1)).toMatchObject({ agentId: "analyst" });
    expect(sent.at(-1)!.message).toContain("Он у тебя в /workspace/folders/Finance");
    expect((await app.inject({ url: "/api/company/access" })).json().agents.find((agent: { agentId: string }) => agent.agentId === "analyst").resources[0]).toMatchObject({ kind: "folder", name: "Finance" });
    expect((await app.inject({ method: "POST", url: "/api/company/access/revoke", payload: { agentId: "analyst", resource: "folder:Finance" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/company/access/grant", payload: { agentId: "analyst", resource: "folder:../etc", access: "read" } })).statusCode).toBe(400);
    // A question cannot be granted.
    spool.push({ id: "e".repeat(32), type: "up", agentId: "dev", kind: "question", subject: "Вопрос", details: "x" });
    await requests.tick();
    const question = requests.list().requests[0]!;
    expect((await app.inject({ method: "POST", url: `/api/company/requests/${question.id}/act`, payload: { requestId: randomUUID(), revision: question.revision, action: "grant" } })).json()).toMatchObject({ error: "not_access" });
    await app.close();
  });

  it("migrates requests from 0020 keeping them and their history", async () => {
    spool.push({ id: "f".repeat(32), type: "up", agentId: "analyst", kind: "question", subject: "Старое", details: "x" });
    await requests.tick();
    const before = requests.list().requests;
    close();
    const sqlite = new Database(path.join(root, "panel.sqlite"));
    sqlite.exec([
      "DROP TABLE agent_charter_versions", "ALTER TABLE teams DROP COLUMN lead_agent_id",
      "DROP TABLE work_item_events", "DROP TABLE work_items", "DROP TABLE work_request_buttons", "DROP TABLE resource_grants",
      "ALTER TABLE project_check_runs DROP COLUMN isolation", "ALTER TABLE project_tasks DROP COLUMN review_requested_at", "ALTER TABLE project_tasks DROP COLUMN reviewer",
      "CREATE TABLE old_requests AS SELECT id, number, from_agent_id, kind, subject, subject_key, details, task_ref, status, route, level, hops, revision, answer_text, answered_by, deadline_at, created_at, updated_at, spool_id FROM work_requests",
      "CREATE TABLE old_events AS SELECT id, request_id, kind, actor, text, notify_agent_id, notify_text, delivered_at, attempts, created_at, request_key FROM work_request_events WHERE kind NOT IN ('notified', 'granted')",
      "DROP TABLE work_request_events", "DROP TABLE work_requests",
      ...fs.readFileSync(path.resolve(import.meta.dirname, "../drizzle/0020_work_requests.sql"), "utf8").split("--> statement-breakpoint").filter((part) => !part.includes("work_request_spool")),
      "INSERT INTO work_requests SELECT * FROM old_requests", "INSERT INTO work_request_events SELECT * FROM old_events", "DROP TABLE old_requests", "DROP TABLE old_events",
      "DELETE FROM __drizzle_migrations WHERE created_at >= 1792351000000",
    ].join(";\n"));
    sqlite.close();
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    requests = new WorkRequestsService({ db, companyMode: () => true });
    expect(requests.list().requests).toEqual(before.map((request) => ({ ...request, resource: null, access: null })));
  });
});
