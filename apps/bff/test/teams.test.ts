import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreateSpaceRequest, CreateTeamRequest, parseTopicLink } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { agents, agentSourceGrants, channelBindings, companyProjects, schedules, teams as teamsTable } from "../src/db/schema.js";
import type { BridgeClient } from "../src/gateway/bridge-client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { registerTeamRoutes } from "../src/routes/teams.js";
import { SpaceService } from "../src/space/space-service.js";
import { type TeamError, TeamService } from "../src/teams/team-service.js";
import type { TelegramService } from "../src/telegram/telegram-service.js";

const TOKEN = "github_pat_" + "A".repeat(40);
const STATE = "/var/lib/clawdesk/openclaw";

describe("project teams (screen 11)", () => {
  let dir: string;
  let close: () => void;
  let db: ReturnType<typeof openDb>["db"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-teams-"));
    ({ db, close } = openDb(path.join(dir, "panel.sqlite")));
  });
  afterEach(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(opts: { github?: number; push?: boolean; failOn?: string; mode?: "company" | "personal" } = {}) {
    const gatewayConfig = { current: {} as Record<string, unknown> };
    const space = new SpaceService({ db, logger: pino({ level: "silent" }) });
    space.create(CreateSpaceRequest.parse({ mode: opts.mode ?? "company", name: "Acme", locale: "ru", timezone: "UTC" }));
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let n = 0;
    const gateway = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "agents.list") return { agents: [{ id: "main", model: { primary: "google/gemini-flash-latest" } }] };
        if (method === "agents.create") {
          if (opts.failOn && String(params.name).endsWith(opts.failOn)) throw new Error("boom");
          return { agentId: params.name };
        }
        if (method === "config.get") return { hash: "h", config: gatewayConfig.current };
        if (method === "cron.add") return { id: `job-${++n}` };
        if (method === "cron.list") return { jobs: [] };
        if (method === "agents.delete") return {};
        return { ok: true };
      },
    } as unknown as GatewayService;
    const bridgeCalls: string[] = [];
    const bridge = {
      teamClone: async (teamId: string) => {
        bridgeCalls.push(`clone:${teamId}`);
        return { defaultBranch: "main", branch: `agent/${teamId}` };
      },
      teamMember: async (teamId: string, agentId: string, role: string) => {
        bridgeCalls.push(`member:${teamId}:${agentId}:${role}`);
        return { path: `${STATE}/workspace/${agentId}/repo`, moved: role === "developer" };
      },
      ensureAgentFolder: async (agentId: string, name: string, options: { dir?: string; readOnly?: boolean }) => {
        bridgeCalls.push(`docs:${agentId}:${name}:${options.dir}:${options.readOnly ? "ro" : "rw"}`);
        return { hostPath: `/var/lib/clawdesk/files/${name}`, gatewayPath: `${STATE}/workspace/${agentId}/docs` };
      },
      ensureFolder: async (name: string) => ({ hostPath: `/var/lib/clawdesk/files/${name}`, gatewayPath: `${STATE}/workspace/files/${name}` }),
      teamRemove: async (teamId: string) => {
        bridgeCalls.push(`remove:${teamId}`);
        return { ok: true };
      },
    } as unknown as BridgeClient;
    const linked: unknown[] = [];
    const telegram = { linkGroup: async (chatId: string, topics: unknown) => linked.push({ chatId, topics }), unlinkGroup: async () => undefined } as unknown as TelegramService;
    const fetchImpl = (async () => new Response(JSON.stringify({ permissions: { push: opts.push ?? true } }), { status: opts.github ?? 200 })) as typeof fetch;
    const service = new TeamService({ gateway, db, logger: pino({ level: "silent" }), bridge, space, telegram, sandboxEnabled: true, fetchImpl });
    return { service, calls, bridgeCalls, linked, gatewayConfig };
  }

  const request = (roles = ["pm", "developer", "reviewer"]) =>
    CreateTeamRequest.parse({ name: "Shop App", repoUrl: "https://github.com/acme/shop.git", token: TOKEN, brief: "Online shop", roles, timezone: "Asia/Dushanbe" });

  const patchFor = (calls: { method: string; params: Record<string, unknown> }[], agentId: string) =>
    calls
      .filter((c) => c.method === "config.patch")
      .map((c) => JSON.parse(c.params.raw as string))
      .find((p) => p.agents?.entries?.[agentId])?.agents.entries[agentId];

  it("creates PM, developer and reviewer on the team's repository, each with only what its role needs", async () => {
    const { service, calls, bridgeCalls } = setup();
    const team = await service.create(request());
    expect(team.id).toBe("shop-app");
    expect(team.members.map((m) => [m.role, m.agentId])).toEqual([
      ["pm", "shop-app-pm"],
      ["developer", "shop-app-developer"],
      ["reviewer", "shop-app-reviewer"],
    ]);
    // No sandbox binds (OpenClaw 2026.8 refuses sources outside the workspace and targets in /workspace):
    // each member gets its copy and the docs folder in its own workspace, docs writable for the PM only.
    expect(bridgeCalls).toEqual([
      "clone:shop-app",
      "member:shop-app:shop-app-pm:pm", "docs:shop-app-pm:Shop App:docs:rw",
      "member:shop-app:shop-app-developer:developer", "docs:shop-app-developer:Shop App:docs:ro",
      "member:shop-app:shop-app-reviewer:reviewer", "docs:shop-app-reviewer:Shop App:docs:ro",
    ]);
    for (const id of ["shop-app-pm", "shop-app-developer", "shop-app-reviewer"]) expect(patchFor(calls, id).sandbox.docker).toBeUndefined();
    const devAgentsMd = calls.find((c) => c.method === "agents.files.set" && c.params.agentId === "shop-app-developer" && c.params.name === "AGENTS.md")!.params.content as string;
    expect(devAgentsMd).toContain("ветка `agent/shop-app`");
    expect(devAgentsMd).not.toContain("{{");
    // The PM's daily status comes from its template; the token never reaches an agent.
    expect(db.select().from(schedules).where(eq(schedules.agentId, "shop-app-pm")).all()).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    expect(db.select().from(agentSourceGrants).all()).toHaveLength(6);
  });

  it("undoes everything when a role fails half way", async () => {
    const { service, calls, bridgeCalls } = setup({ failOn: "-developer" });
    await expect(service.create(request())).rejects.toThrow();
    expect(calls.filter((c) => c.method === "agents.delete").map((c) => c.params.agentId)).toContain("shop-app-pm");
    expect(bridgeCalls).toEqual(["clone:shop-app", "member:shop-app:shop-app-pm:pm", "docs:shop-app-pm:Shop App:docs:rw", "remove:shop-app"]);
    expect(db.select().from(teamsTable).all()).toEqual([]);
    expect(db.select().from(agents).all()).toEqual([]);
  });

  it("checks the token with GitHub before cloning anything", async () => {
    for (const [opts, code] of [
      [{ github: 401 }, "token_rejected"],
      [{ github: 404 }, "repo_not_found"],
      [{ push: false }, "no_push_permission"],
      [{ mode: "personal" as const }, "wrong_mode"],
    ] as const) {
      // A fresh database per case (the Space is chosen once).
      close();
      fs.rmSync(path.join(dir, "panel.sqlite"), { force: true });
      fs.rmSync(path.join(dir, "panel.sqlite-wal"), { force: true });
      fs.rmSync(path.join(dir, "panel.sqlite-shm"), { force: true });
      ({ db, close } = openDb(path.join(dir, "panel.sqlite")));
      const { service, bridgeCalls } = setup(opts);
      const error = await service.create(request()).then(() => null, (e: unknown) => e);
      expect((error as TeamError).code, code).toBe(code);
      expect(bridgeCalls).toEqual([]);
    }
  });

  it("assigns Telegram topics from their links and sends scheduled reports there", async () => {
    const { service, calls, linked } = setup();
    await service.create(request(["pm", "developer"]));
    const linking = service.linkTelegram("shop-app", [
      { role: "pm", link: "https://t.me/c/2234567890/12" },
      { role: "developer", link: "https://t.me/c/2234567890/14/301" },
    ]);
    await expect(service.remove("shop-app")).rejects.toMatchObject({ code: "team_busy" });
    const team = await linking;
    expect(linked).toEqual([{ chatId: "-1002234567890", topics: [{ topicId: "12", agentId: "shop-app-pm" }, { topicId: "14", agentId: "shop-app-developer" }] }]);
    expect(team.telegramChatId).toBe("-1002234567890");
    expect(team.members.find((m) => m.role === "pm")!.topicId).toBe("12");
    const update = calls.find((c) => c.method === "cron.update")!;
    expect(update.params.patch).toEqual({ delivery: { mode: "announce", channel: "telegram", to: "-1002234567890", threadId: "12", bestEffort: true } });
    await expect(service.linkTelegram("shop-app", [{ role: "pm", link: "https://t.me/c/1/2" }, { role: "developer", link: "https://t.me/c/22345678/3" }])).rejects.toThrow();
  });

  it("returns 409 before removing project executor teams or Telegram-linked teams", async () => {
    const { service, calls, bridgeCalls } = setup();
    const app = Fastify();
    registerTeamRoutes(app, { teams: service });
    try {
      db.insert(companyProjects).values({ id: "project", name: "Project", requestId: "project-request", requestPayload: "{}" }).run();
      db.insert(teamsTable).values([
        { id: "executors", name: "Executors", projectId: "project" },
        { id: "manual", name: "Manual team", projectId: "project", requestId: "manual-request" },
      ]).run();
      db.insert(agents).values({ id: "project-qa", displayName: "QA", role: "team_member", templateId: "project-qa", teamId: "executors" }).run();
      await service.create(request(["pm"]));
      await service.linkTelegram("shop-app", [{ role: "pm", link: "https://t.me/c/2234567890/12" }]);
      calls.length = 0;
      bridgeCalls.length = 0;

      const remove = (id: string) => app.inject({ method: "DELETE", url: `/api/teams/${id}` });
      for (const [id, error] of [["executors", "project_executors"], ["shop-app", "telegram_group_linked"]] as const) {
        const response = await remove(id);
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error });
      }
      db.update(teamsTable).set({ projectId: null }).where(eq(teamsTable.id, "executors")).run();
      expect((await remove("executors")).statusCode).toBe(409);
      expect(calls).toEqual([]);
      expect(bridgeCalls).toEqual([]);
      expect(db.select().from(teamsTable).all()).toHaveLength(3);
      expect(db.select().from(agents).where(eq(agents.id, "project-qa")).get()?.teamId).toBe("executors");
      expect(db.select().from(channelBindings).all()).toHaveLength(1);

      expect((await remove("manual")).statusCode).toBe(200);
      expect(bridgeCalls).toEqual(["remove:manual"]);
      expect(db.select().from(teamsTable).where(eq(teamsTable.id, "manual")).get()).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("moves members of an older team off the binds OpenClaw now refuses, keeping their other binds", async () => {
    const { service, calls, bridgeCalls, gatewayConfig } = setup();
    await service.create(request(["pm", "developer"]));
    bridgeCalls.length = 0;
    calls.length = 0;
    gatewayConfig.current = { agents: { entries: {
      "shop-app-pm": { sandbox: { docker: { binds: [`${STATE}/teams/shop-app/repo:/workspace/repo:ro`, "/var/lib/clawdesk/files/Shop App:/workspace/docs:rw", "/srv/extra:/extra:ro"] } } },
      "shop-app-developer": { sandbox: { docker: { binds: [`${STATE}/teams/shop-app/dev:/workspace/repo:rw`, "/var/lib/clawdesk/files/Shop App:/workspace/docs:ro"] } } },
    } } };
    await service.repairWorkspaces();
    expect(bridgeCalls).toEqual(["member:shop-app:shop-app-pm:pm", "docs:shop-app-pm:Shop App:docs:rw", "member:shop-app:shop-app-developer:developer", "docs:shop-app-developer:Shop App:docs:ro"]);
    expect(patchFor(calls, "shop-app-pm").sandbox.docker.binds).toEqual(["/srv/extra:/extra:ro"]);
    expect(patchFor(calls, "shop-app-developer").sandbox.docker.binds).toEqual([]);
    // Members already moved are left alone.
    gatewayConfig.current = { agents: { entries: { "shop-app-pm": { sandbox: { docker: { binds: ["/srv/extra:/extra:ro"] } } }, "shop-app-developer": {} } } };
    bridgeCalls.length = 0;
    await service.repairWorkspaces();
    expect(bridgeCalls).toEqual([]);
  });

  it("reads topic links the way Telegram copies them", () => {
    expect(parseTopicLink("https://t.me/c/2234567890/12")).toEqual({ chatId: "-1002234567890", topicId: "12" });
    expect(parseTopicLink("t.me/c/2234567890/12/345")).toEqual({ chatId: "-1002234567890", topicId: "12" });
    expect(parseTopicLink("https://t.me/somegroup/12")).toBeNull();
  });
});
