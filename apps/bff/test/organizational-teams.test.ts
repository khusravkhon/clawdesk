import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CreateOrganizationalTeamRequest } from "@clawdesk/shared";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrganizationalTeams } from "../src/company/organizational-teams.js";
import { openDb, type Db } from "../src/db/client.js";
import { agents, departments, teams } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { WorkRequestsService } from "../src/company/work-requests-service.js";

// Stage 3: a team without a repository, its members made from company specialist templates. The fake
// Gateway answers the calls createJuniorAgent makes; `failOn` breaks the n-th agent to check the undo.

describe("teams without a repository", () => {
  let root: string, db: Db, close: () => void, calls: { method: string; params: Record<string, unknown> }[], failOn: number | null, created: number;
  const gateway = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "agents.list") return { agents: [{ id: "main" }, ...db.select().from(agents).all().map((row) => ({ id: row.id }))] };
      if (method === "agents.create") { created++; if (failOn === created) throw new Error("gateway refused"); return { agentId: params.name }; }
      if (method === "config.get") return { hash: "h", config: { agents: { entries: { main: { model: { primary: "openai-codex/gpt-5.5" } } } } } };
      return { ok: true };
    },
  } as unknown as GatewayService;
  const service = () => new OrganizationalTeams({ db, gateway, logger: pino({ level: "silent" }), sandboxEnabled: true });
  const request = (patch: Partial<CreateOrganizationalTeamRequest> = {}) => CreateOrganizationalTeamRequest.parse({ requestId: randomUUID(), name: "Маркетинг", departmentId: "mkt", context: "Продвигаем пекарню в соцсетях", members: [{ templateId: "team-lead", name: "Лейла" }, { templateId: "marketing" }, { templateId: "analyst" }], lead: 0, timezone: "Asia/Dushanbe", ...patch });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-org-teams-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    calls = []; failOn = null; created = 0;
    db.insert(departments).values({ id: "mkt", requestId: randomUUID(), requestPayload: "{}", name: "Маркетинг", description: "Продвижение" }).run();
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("makes the team, its members from specialist templates, and its lead; a repeat returns the same team", async () => {
    const body = request();
    const { id } = await service().create(body);
    const team = db.select().from(teams).get()!;
    expect(team).toMatchObject({ id, name: "Маркетинг", repoUrl: null, departmentId: "mkt", projectId: null });
    const members = db.select().from(agents).all();
    expect(members.map((row) => [row.templateId, row.role, row.teamId])).toEqual([["team-lead", "team_member", id], ["marketing", "team_member", id], ["analyst", "team_member", id]]);
    expect(members[0]!.displayName).toBe("Лейла");
    expect(team.leadAgentId).toBe(members[0]!.id);
    // Members are sandboxed and on the main agent's model.
    const patches = calls.filter((call) => call.method === "config.patch").map((call) => JSON.parse(call.params.raw as string));
    expect(patches.some((patch) => Object.values(patch.agents?.entries ?? {}).some((entry) => (entry as { sandbox?: { mode?: string } }).sandbox?.mode === "all"))).toBe(true);
    expect(await service().create(body)).toEqual({ id });
    expect(db.select().from(teams).all()).toHaveLength(1);
    await expect(service().create({ ...body, name: "Другое" })).rejects.toThrow("request_conflict");
    // A member's request goes to the team lead first.
    const requests = new WorkRequestsService({ db, companyMode: () => true, liveAgents: async () => new Set(members.map((row) => row.id).concat("main")), bridge: { requestsSpool: async () => ({ entries: [], rejected: [] }), requestsAck: async () => undefined } });
    expect(requests.route(members[1]!.id).map((level) => level.agentId)).toEqual([members[0]!.id, "main", null]);
  });

  it("undoes everything when one member cannot be made", async () => {
    failOn = 2;
    await expect(service().create(request())).rejects.toThrow();
    expect(db.select().from(teams).all()).toEqual([]);
    expect(db.select().from(agents).all()).toEqual([]);
    expect(calls.filter((call) => call.method === "agents.delete")).toHaveLength(1);
  });

  it("refuses templates that are not company specialists and unknown places", async () => {
    expect(CreateOrganizationalTeamRequest.safeParse({ ...request(), members: [{ templateId: "department-head" }] }).success).toBe(false);
    expect(CreateOrganizationalTeamRequest.safeParse({ ...request(), members: [{ templateId: "developer" }] }).success).toBe(false);
    await expect(service().create(request({ departmentId: "nope" }))).rejects.toThrow("department_missing");
    await expect(service().create(request({ projectId: "nope" }))).rejects.toThrow("project_missing");
    await expect(new OrganizationalTeams({ db, sandboxEnabled: true }).create(request())).rejects.toThrow("gateway_unavailable");
  });
});
