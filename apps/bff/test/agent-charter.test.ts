import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentCharterFields, charterExpands } from "@clawdesk/shared";
import Fastify from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCharterService, DEFAULT_CHARTER, blockOf, charterBlock, withBlock } from "../src/company/agent-charter-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { agents, resourceGrants, teams, workItems } from "../src/db/schema.js";
import { registerAgentCharterRoutes } from "../src/routes/agent-charter.js";
import { WorkItemsService } from "../src/company/work-items-service.js";

// Stage 4: an agent's charter. The fake Gateway keeps AGENTS.md per agent, as agents.files.get/set would.

describe("agent charters", () => {
  let root: string, db: Db, close: () => void, service: AgentCharterService, files: Map<string, string>, offline: boolean;
  const fields = (patch: Partial<AgentCharterFields>) => AgentCharterFields.parse({ ...DEFAULT_CHARTER, ...patch });
  const gateway = {
    request: async <T>(method: string, params: unknown): Promise<T> => {
      if (offline) throw new Error("offline");
      const { agentId, content } = params as { agentId: string; content?: string };
      if (method === "agents.files.get") return { file: { content: files.get(agentId) ?? "" } } as T;
      if (method === "agents.files.set") { files.set(agentId, content!); return {} as T; }
      throw new Error("unexpected " + method);
    },
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-charter-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    db.insert(teams).values({ id: "shop", name: "Shop", leadAgentId: "dev" }).run();
    db.insert(agents).values([{ id: "main", role: "main", displayName: "Main" }, { id: "dev", role: "team_member", teamId: "shop", displayName: "Dev", canAskMain: true }]).run();
    db.insert(resourceGrants).values({ id: randomUUID(), agentId: "dev", resource: "folder:specs", access: "read", grantedBy: "owner", createdAt: 1 }).run();
    files = new Map([["dev", "# Правила\n\nРаботай аккуратно."]]);
    offline = false;
    service = new AgentCharterService({ db, gateway, logger: pino({ level: "silent" }) });
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("starts from safe defaults without touching the file, then writes each saved version into AGENTS.md", async () => {
    let charter = await service.get("dev");
    expect(charter).toMatchObject({ version: 0, source: "default", file: "ok", history: [] });
    expect(charter.fields.forbidden).toContain("без одобрения владельца");
    expect(charter.powers).toEqual({ sandbox: true, canAskMain: true, folder: null, grants: [{ resource: "folder:specs", access: "read" }], team: "Shop", lead: true, manager: false });
    expect(files.get("dev")).toBe("# Правила\n\nРаботай аккуратно.");

    // Tightening needs no confirmation.
    charter = await service.save("dev", { requestId: randomUUID(), baseVersion: 0, fields: fields({ responsibleFor: "Код магазина", forbidden: DEFAULT_CHARTER.forbidden + "\nНе трогать платёжный модуль." }), note: "" });
    expect(charter).toMatchObject({ version: 1, source: "owner", file: "ok" });
    expect(files.get("dev")).toContain("Работай аккуратно.");
    expect(files.get("dev")).toContain("**За что отвечаешь:**\nКод магазина");
    expect(files.get("dev")).toContain("Не трогать платёжный модуль.");
    expect(blockOf(files.get("dev")!)).toBe(charterBlock(1, charter.fields));
  });

  it("asks for an explicit word before widening, refuses stale edits and repeats a request once", async () => {
    const v1 = fields({ forbidden: "Публиковать без одобрения.\nПисать клиентам." });
    await service.save("dev", { requestId: randomUUID(), baseVersion: 0, fields: v1, note: "", confirmExpansion: true });
    const looser = { ...v1, forbidden: "Публиковать без одобрения." };
    await expect(service.save("dev", { requestId: randomUUID(), baseVersion: 1, fields: looser, note: "" })).rejects.toThrow("expansion_confirmation_required");
    await expect(service.save("dev", { requestId: randomUUID(), baseVersion: 1, fields: { ...v1, mayDo: "Отправлять письма." }, note: "" })).rejects.toThrow("expansion_confirmation_required");
    await expect(service.save("dev", { requestId: randomUUID(), baseVersion: 0, fields: v1, note: "" })).rejects.toThrow("version_conflict");
    const request = { requestId: randomUUID(), baseVersion: 1, fields: looser, note: "разрешили писать клиентам", confirmExpansion: true };
    expect((await service.save("dev", request)).version).toBe(2);
    expect((await service.save("dev", request)).version).toBe(2);
    expect(charterExpands(DEFAULT_CHARTER, DEFAULT_CHARTER)).toBe(false);
  });

  it("restores an earlier version as a new one and keeps the whole history", async () => {
    const strict = fields({ forbidden: "Ничего не публиковать." });
    await service.save("dev", { requestId: randomUUID(), baseVersion: 0, fields: strict, note: "", confirmExpansion: true });
    await service.save("dev", { requestId: randomUUID(), baseVersion: 1, fields: { ...strict, forbidden: "Ничего не публиковать.\nНе удалять файлы." }, note: "" });
    // Going back to v1 drops a prohibition: widening, so it needs the word too.
    await expect(service.restore("dev", { requestId: randomUUID(), baseVersion: 2, version: 1 })).rejects.toThrow("expansion_confirmation_required");
    const restored = await service.restore("dev", { requestId: randomUUID(), baseVersion: 2, version: 1, confirmExpansion: true });
    expect(restored).toMatchObject({ version: 3, source: "restore", fields: { forbidden: "Ничего не публиковать." } });
    expect(restored.history.map((item) => [item.version, item.source, item.note])).toEqual([[1, "owner", ""], [2, "owner", ""], [3, "restore", "версия 1"]]);
    expect(files.get("dev")).toContain("версия 3");
    await expect(service.restore("dev", { requestId: randomUUID(), baseVersion: 3, version: 9 })).rejects.toThrow("version_missing");
  });

  it("notices an agent that rewrote its block and puts the charter back", async () => {
    await service.save("dev", { requestId: randomUUID(), baseVersion: 0, fields: fields({ forbidden: "Не публиковать." }), note: "", confirmExpansion: true });
    files.set("dev", files.get("dev")!.replace("Не публиковать.", "Можно всё."));
    expect((await service.get("dev")).file).toBe("changed");
    files.set("dev", "# Правила\n");
    expect((await service.get("dev")).file).toBe("missing");
    expect(await service.sweep()).toBe(1);
    expect(files.get("dev")).toContain("Не публиковать.");
    expect(files.get("dev")!.startsWith("# Правила")).toBe(true);
    expect((await service.get("dev")).file).toBe("ok");
    expect(await service.sweep()).toBe(0);
    // The Gateway is away: the record still changes, the file follows later.
    offline = true;
    expect(await service.save("dev", { requestId: randomUUID(), baseVersion: 1, fields: fields({ forbidden: "Не публиковать.\nНе удалять." }), note: "" })).toMatchObject({ version: 2, file: "unavailable" });
    offline = false;
    expect(await service.sweep()).toBe(1);
    expect(files.get("dev")).toContain("Не удалять.");
  });

  it("replaces only its own block in AGENTS.md", () => {
    const block = charterBlock(2, fields({ mustDo: "Отвечать" }));
    const text = withBlock("A\n\n" + charterBlock(1, DEFAULT_CHARTER) + "\n\nB", block);
    expect(text).toBe("A\n\n" + block + "\n\nB");
    expect(withBlock("", block)).toBe(block + "\n");
  });

  it("a company task keeps the charter version its executor had when it started", async () => {
    await service.save("dev", { requestId: randomUUID(), baseVersion: 0, fields: fields({ mustDo: "v1" }), note: "" });
    const items = new WorkItemsService({ db, companyMode: () => true, send: async () => undefined });
    const item = items.create({ requestId: randomUUID(), title: "Задача", description: "Сделать", criteria: "Готово", executorAgentId: "dev", deadlineAt: null, start: true });
    expect(item.charterVersion).toBe(1);
    await service.save("dev", { requestId: randomUUID(), baseVersion: 1, fields: fields({ mustDo: "v2" }), note: "" });
    expect(db.select().from(workItems).get()?.charterVersion).toBe(1);
  });

  it("serves the charter over HTTP with clear errors", async () => {
    const app = Fastify();
    registerAgentCharterRoutes(app, service);
    expect((await app.inject({ method: "GET", url: "/api/agents/dev/charter" })).json()).toMatchObject({ version: 0 });
    expect((await app.inject({ method: "GET", url: "/api/agents/nobody/charter" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/agents/dev/charter", payload: { requestId: "x" } })).statusCode).toBe(400);
    const saved = await app.inject({ method: "PUT", url: "/api/agents/dev/charter", payload: { requestId: randomUUID(), baseVersion: 0, fields: DEFAULT_CHARTER } });
    expect(saved.json()).toMatchObject({ version: 1 });
    const stale = await app.inject({ method: "PUT", url: "/api/agents/dev/charter", payload: { requestId: randomUUID(), baseVersion: 0, fields: DEFAULT_CHARTER } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "version_conflict" });
    await app.close();
  });
});
