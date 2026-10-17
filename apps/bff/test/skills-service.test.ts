import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import type { BridgeClient } from "../src/gateway/bridge-client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { SkillsService } from "../src/skills/skills-service.js";

// A Gateway that keeps per-agent workspaces in memory: skills.install puts skills/<slug> there,
// the bridge's removal takes it away, skills.status reports what is there.
function fakeWorld(agents = ["main", "finance", "social"]) {
  const workspaces = new Map(agents.map((id) => [id, new Set<string>()]));
  const uploads = new Map<string, { slug: string; bytes: Buffer }>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let config: Record<string, unknown> = {};
  const ws = (agentId: string) => `/state/workspace-${agentId}`;
  const gateway = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      switch (method) {
        case "agents.list":
          return { agents: agents.map((id) => ({ id })) };
        case "skills.status": {
          const agentId = params.agentId as string;
          return { workspaceDir: ws(agentId), skills: [...workspaces.get(agentId)!].map((slug) => ({ name: slug, baseDir: `${ws(agentId)}/skills/${slug}` })).concat([{ name: "weather", baseDir: "/app/skills/weather" }]) };
        }
        case "skills.install": {
          if (params.source === "upload") {
            const upload = uploads.get(params.uploadId as string)!;
            expect(upload.slug).toBe(params.slug);
            uploads.delete(params.uploadId as string);
          }
          const slug = params.source === "clawhub" ? String(params.slug).split("/").pop()! : (params.slug as string);
          workspaces.get(params.agentId as string)!.add(slug);
          return { ok: true };
        }
        case "skills.upload.begin": {
          const uploadId = `u${uploads.size + calls.length}`;
          uploads.set(uploadId, { slug: params.slug as string, bytes: Buffer.alloc(0) });
          return { uploadId };
        }
        case "skills.upload.chunk": {
          const upload = uploads.get(params.uploadId as string)!;
          upload.bytes = Buffer.concat([upload.bytes, Buffer.from(params.dataBase64 as string, "base64")]);
          return {};
        }
        case "skills.upload.commit":
          return {};
        case "config.get":
          return { hash: "h", config };
        case "config.patch":
          config = { ...config, ...JSON.parse(params.raw as string) };
          return {};
        case "skills.search":
          return { results: [{ installRef: "@ana/budget", slug: "budget", displayName: "Budget", summary: "Tracks spend", score: 1 }, { installRef: "skills-sh:a/b/c", slug: "c", displayName: "C", trustState: "not-scanned-by-clawhub", score: 0.5 }] };
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  } as unknown as GatewayService;
  const removed: string[] = [];
  const bridge = {
    skillsRemove: async (dir: string) => {
      removed.push(dir);
      const [, agentId] = /workspace-([a-z]+)\//.exec(dir)!;
      workspaces.get(agentId!)!.delete(path.posix.basename(dir));
      return { removed: true };
    },
  } as unknown as BridgeClient;
  return { gateway, bridge, workspaces, uploads, calls, removed, config: () => config };
}

describe("SkillsService", () => {
  let dir: string;
  let db: ReturnType<typeof openDb>["db"];
  let close: () => void;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-skills-"));
    ({ db, close } = openDb(path.join(dir, "panel.sqlite")));
  });
  afterEach(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("searches ClawHub and flags skills ClawHub did not scan", async () => {
    const world = fakeWorld();
    const service = new SkillsService({ ...world, db, logger: pino({ level: "silent" }) });
    expect((await service.search("budget")).results).toEqual([
      { installRef: "@ana/budget", slug: "budget", name: "Budget", summary: "Tracks spend", notScanned: false },
      { installRef: "skills-sh:a/b/c", slug: "c", name: "C", summary: null, notScanned: true },
    ]);
  });

  it("installs a ClawHub skill for the chosen agents and reads who has it from their workspaces", async () => {
    const world = fakeWorld();
    const service = new SkillsService({ ...world, db, logger: pino({ level: "silent" }) });
    const { skills } = await service.addClawHub({ installRef: "@ana/budget", name: "Budget", summary: "Tracks spend", agentIds: ["main", "finance"] });
    expect(skills).toMatchObject([{ kind: "clawhub", slug: "budget", agents: ["main", "finance"], editable: false }]);
    expect(world.calls.filter((c) => c.method === "skills.install").map((c) => c.params)).toEqual([
      expect.objectContaining({ agentId: "main", source: "clawhub", slug: "@ana/budget" }),
      expect.objectContaining({ agentId: "finance", source: "clawhub", slug: "@ana/budget" }),
    ]);
  });

  it("a written skill goes to OpenClaw as a zip with SKILL.md, and uploads are switched on once", async () => {
    const world = fakeWorld();
    const service = new SkillsService({ ...world, db, logger: pino({ level: "silent" }) });
    let archive: Buffer | null = null;
    const request = world.gateway.request.bind(world.gateway);
    (world.gateway as unknown as { request: typeof request }).request = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "skills.install" && params.source === "upload") archive = world.uploads.get(params.uploadId as string)!.bytes;
      return request(method, params);
    };
    const { skills } = await service.createOwn({ name: "Отчёт за неделю", description: "Сводка трат по пятницам", instructions: "Собери траты и пришли итог.", agentIds: ["finance"] });
    expect(skills).toMatchObject([{ kind: "own", slug: "otchyot-za-nedelyu", agents: ["finance"], editable: true }]);
    const md = strFromU8(unzipSync(archive!)["SKILL.md"]!);
    expect(md).toContain("name: otchyot-za-nedelyu");
    expect(md).toContain("Собери траты и пришли итог.");
    const patches = world.calls.filter((c) => c.method === "config.patch").map((c) => JSON.parse(c.params.raw as string));
    expect(patches[0]).toEqual({ skills: { install: { allowUploadedArchives: true } } });
    // Then OpenClaw is asked to reload its skill lists.
    expect(patches.at(-1)).toEqual({ skills: { entries: { "otchyot-za-nedelyu": { config: { clawdeskRevision: expect.any(Number) } } } } });
    expect(service.content(skills[0]!.id)).toEqual({ name: "Отчёт за неделю", description: "Сводка трат по пятницам", instructions: "Собери траты и пришли итог." });
  });

  it("checkboxes install for new agents and remove the folder from the others", async () => {
    const world = fakeWorld();
    const service = new SkillsService({ ...world, db, logger: pino({ level: "silent" }) });
    const { skills } = await service.addClawHub({ installRef: "@ana/budget", name: "Budget", agentIds: ["main", "finance"] });
    const after = await service.setAgents(skills[0]!.id, ["finance", "social"]);
    expect(after.skills[0]!.agents).toEqual(["finance", "social"]);
    expect(world.removed).toEqual(["/state/workspace-main/skills/budget"]);
  });

  it("removing a skill takes it from every agent; editing rewrites it where it stays", async () => {
    const world = fakeWorld();
    const service = new SkillsService({ ...world, db, logger: pino({ level: "silent" }) });
    const { skills } = await service.createOwn({ name: "Notes", description: "d", instructions: "v1", agentIds: ["main", "social"] });
    const id = skills[0]!.id;
    await service.updateOwn(id, { name: "Notes", description: "d", instructions: "v2", agentIds: ["main"] });
    expect(world.removed).toEqual(["/state/workspace-social/skills/notes"]);
    expect(service.content(id).instructions).toBe("v2");
    expect((await service.remove(id)).skills).toEqual([]);
    expect(JSON.parse(world.calls.filter((c) => c.method === "config.patch").at(-1)!.params.raw as string)).toEqual({ skills: { entries: { notes: null } } });
    expect([...world.workspaces.get("main")!]).toEqual([]);
  });

  it("refuses a second skill with the same folder name from ClawHub", async () => {
    const world = fakeWorld();
    const service = new SkillsService({ ...world, db, logger: pino({ level: "silent" }) });
    await service.addClawHub({ installRef: "@ana/budget", name: "Budget", agentIds: [] });
    await expect(service.addClawHub({ installRef: "@bob/budget", name: "Budget", agentIds: [] })).rejects.toMatchObject({ code: "exists" });
  });
});
