import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessService } from "../src/company/access-service.js";
import { inboundId, WorkRequestsService } from "../src/company/work-requests-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { agents, teams } from "../src/db/schema.js";
import { registerWorkRequestRoutes } from "../src/routes/work-requests.js";

// The owner's files without a connection: «Документы» and the main agent's proposals. The fake bridge keeps the
// shared folder and each agent's inbox; a grant is checked by the copy's hash, a revocation by the copy gone.

describe("owner files", () => {
  let root: string, db: Db, close: () => void, access: AccessService, requests: WorkRequestsService;
  let shared: Map<string, string>, inbox: Map<string, Map<string, string>>, inbound: Map<string, string>, spool: Record<string, unknown>[], sent: { agentId: string; message: string }[], owner: string[], breakCopy: boolean;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-owner-files-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    shared = new Map([["Входящие/ТЗ.pdf", "тз v1"]]); inbox = new Map(); inbound = new Map([["ТЗ_доски---0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.pdf", "тз из telegram"]]);
    spool = []; sent = []; owner = []; breakCopy = false;
    db.insert(agents).values([
      { id: "analyst", role: "specialist", displayName: "Аналитик", sandbox: true },
      { id: "dev", role: "team_member", displayName: "Разработчик проекта", sandbox: true },
    ]).run();
    const box = (agentId: string) => inbox.get(agentId) ?? inbox.set(agentId, new Map()).get(agentId)!;
    const bridge = {
      folderSyncStatus: async () => ({ folders: [] }), sharedFolders: async () => ({ folders: [] }),
      ensureAgentFolder: async () => ({ hostPath: "h", gatewayPath: "g" }), removeAgentFolder: async () => ({ removed: true }),
      ownerFiles: async () => ({ files: [...shared.keys()].map((file) => ({ path: file, size: 5, modifiedAt: 1 })) }),
      ownerFileUpload: async (name: string, base64: string) => { shared.set(`Входящие/${name}`, Buffer.from(base64, "base64").toString()); return { path: `Входящие/${name}`, size: 1, sha: "x" }; },
      ownerFileStore: async (id: string) => {
        if (!inbound.has(id)) throw Object.assign(new Error("file_missing"), { code: "file_missing" });
        shared.set("Входящие/ТЗ_доски.pdf", inbound.get(id)!);
        return { path: "Входящие/ТЗ_доски.pdf", size: 1, sha: "x" };
      },
      ownerFileCopy: async (agentId: string, file: string) => {
        if (!shared.has(file)) throw Object.assign(new Error("file_missing"), { code: "file_missing" });
        if (!breakCopy) box(agentId).set(file, shared.get(file)!);
        return { path: `/workspace/inbox/${file.split("/").join(" · ")}`, size: 1, sha: shared.get(file)!, copiedAt: 1 };
      },
      ownerFileCopies: async (agentId: string) => ({ copies: [...box(agentId)].map(([file, sha]) => ({ file, sha })) }),
      ownerFileRemove: async (agentId: string, file: string) => { box(agentId).delete(file); return { removed: true as const }; },
    };
    access = new AccessService({ db, companyMode: () => true, bridge, now: () => 5, setMcpAgents: async () => undefined, config: async () => ({}), notify: async (agentId, message) => { sent.push({ agentId, message }); } });
    requests = new WorkRequestsService({
      db, companyMode: () => true, liveAgents: async () => new Set(["main", "analyst", "dev"]), files: bridge,
      grant: (request, by) => access.grant(request, by),
      bridge: { requestsSpool: async () => ({ entries: [...spool], rejected: [] }), requestsAck: async (ids) => { spool = spool.filter((item) => !ids.includes(item.id as string)); } },
      send: async (agentId, message) => { sent.push({ agentId, message }); },
      telegram: { ownerUserId: () => "42", sendToOwnerWithButtons: async (text) => { owner.push(text); } },
    });
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("«Документы»: upload, give one file to an agent with an instruction, see it, take it back", async () => {
    const app = Fastify(); registerWorkRequestRoutes(app, { requests, access });
    expect((await app.inject({ method: "POST", url: "/api/company/documents/upload", payload: { name: "План.docx", base64: Buffer.from("план").toString("base64") } })).json().files.map((file: { path: string }) => file.path)).toContain("Входящие/План.docx");
    const shared1 = await app.inject({ method: "POST", url: "/api/company/documents/share", payload: { agentId: "analyst", file: "Входящие/ТЗ.pdf", instruction: "Изучи ТЗ и выпиши сроки" } });
    expect(shared1.json()).toMatchObject({ path: "/workspace/inbox/Входящие · ТЗ.pdf", given: [{ agentId: "analyst", file: "Входящие/ТЗ.pdf", grantedBy: "owner" }] });
    expect(sent.at(-1)).toMatchObject({ agentId: "analyst" });
    expect(sent.at(-1)!.message).toContain("Владелец передал тебе файл «ТЗ.pdf»: /workspace/inbox/Входящие · ТЗ.pdf (только чтение).\nЧто сделать: Изучи ТЗ и выпиши сроки");
    const listed = (await app.inject({ url: "/api/company/access" })).json().agents.find((agent: { agentId: string }) => agent.agentId === "analyst");
    expect(listed.resources).toContainEqual(expect.objectContaining({ kind: "file", name: "Входящие/ТЗ.pdf", access: "read", path: "/workspace/inbox/Входящие · ТЗ.pdf", revocable: true }));
    // The main agent sees the shared folder itself; a copy that did not land is not reported as given.
    expect((await app.inject({ method: "POST", url: "/api/company/documents/share", payload: { agentId: "main", file: "Входящие/ТЗ.pdf", instruction: "x" } })).statusCode).toBe(409);
    breakCopy = true;
    expect((await app.inject({ method: "POST", url: "/api/company/documents/share", payload: { agentId: "dev", file: "Входящие/ТЗ.pdf", instruction: "x" } })).json()).toMatchObject({ error: "not_applied" });
    expect((await app.inject({ method: "POST", url: "/api/company/access/grant", payload: { agentId: "dev", resource: "file:../секрет", access: "read" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/company/access/revoke", payload: { agentId: "analyst", resource: "file:Входящие/ТЗ.pdf" } })).statusCode).toBe(200);
    expect(inbox.get("analyst")!.size).toBe(0);
    expect(sent.at(-1)!.message).toContain("Владелец отозвал твой доступ к файлу «ТЗ.pdf»");
    expect((await app.inject({ url: "/api/company/documents" })).json().given).toEqual([]);
    await app.close();
  });

  it("the main agent proposes a file the owner sent to the bot; the owner's button gives it with the instruction", async () => {
    spool.push({ id: "a".repeat(32), type: "share", agentId: "main", to: "Разработчик проекта", file: "media://inbound/ТЗ_доски---0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.pdf", instruction: "Изучи ТЗ и составь план работ" });
    await requests.tick();
    const request = requests.list().requests[0]!;
    expect(request).toMatchObject({ code: "REQ-001", kind: "access", from: { agentId: "dev" }, resource: "file:Входящие/ТЗ_доски.pdf", access: "read", route: [{ kind: "owner" }], status: "open" });
    expect(shared.get("Входящие/ТЗ_доски.pdf")).toBe("тз из telegram");
    expect(owner.at(-1)).toContain("Главный агент предлагает передать файл «ТЗ_доски.pdf» агенту Разработчик проекта (dev), только чтение.");
    expect(owner.at(-1)).toContain("Задание: Изучи ТЗ и составь план работ");
    expect(sent.find((item) => item.agentId === "main")!.message).toContain("REQ-001: предложение передать «ТЗ_доски.pdf» агенту Разработчик проекта отправлено владельцу");
    expect(inbox.get("dev")?.size ?? 0).toBe(0);

    const app = Fastify(); registerWorkRequestRoutes(app, { requests, access });
    expect((await app.inject({ method: "POST", url: `/api/company/requests/${request.id}/act`, payload: { requestId: randomUUID(), revision: request.revision, action: "grant" } })).json()).toMatchObject({ status: "answered" });
    expect(inbox.get("dev")!.get("Входящие/ТЗ_доски.pdf")).toBe("тз из telegram");
    await requests.tick();
    const told = sent.filter((item) => item.agentId === "dev").at(-1)!.message;
    expect(told).toContain("Владелец передал тебе файл «ТЗ_доски.pdf»: /workspace/inbox/Входящие · ТЗ_доски.pdf (только чтение).");
    expect(told).toContain("Что сделать: Изучи ТЗ и составь план работ");
    await app.close();
  });

  it("accepts the staged path OpenClaw shows the agent and a name with an emoji; same names get a list to ask about", async () => {
    expect(inboundId("media://inbound/A---0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.md")).toBe("A---0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.md");
    expect(inboundId("/var/lib/clawdesk-local/openclaw/workspace/media/inbound/openclaw-staged-2701588c-84a6-4848-a5d4-43f3db7336d2/input-ARCHITECTURE---260fa262-2ca8-4530-91b9-c69b6a9cc01a.md")).toBe("ARCHITECTURE---260fa262-2ca8-4530-91b9-c69b6a9cc01a.md");
    expect(inboundId("Входящие/ТЗ.pdf")).toBeNull();
    // Seen live: the owner sent ARCHITECTURE.md to the bot and wrote «надо передать 🛠️ Разработчик проекта».
    inbound.set("ТЗ_доски---0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.pdf", "тз");
    spool.push({ id: "a".repeat(32), type: "share", agentId: "main", to: "🛠️ Разработчик проекта", file: "/var/lib/x/workspace/media/inbound/openclaw-staged-2701588c-84a6-4848-a5d4-43f3db7336d2/input-ТЗ_доски---0f8a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.pdf", instruction: "Изучи" });
    await requests.tick();
    expect(requests.list().requests[0]).toMatchObject({ from: { agentId: "dev" }, resource: "file:Входящие/ТЗ_доски.pdf" });
    db.insert(teams).values([{ id: "shop", name: "Магазин" }, { id: "board", name: "Доска" }]).run();
    db.insert(agents).values([
      { id: "dev-shop", role: "team_member", teamId: "shop", displayName: "Разработчик проекта", sandbox: true },
      { id: "dev-board", role: "team_member", teamId: "board", displayName: "Разработчик проекта", sandbox: true },
    ]).run();
    spool.push({ id: "b".repeat(32), type: "share", agentId: "main", to: "Разработчик проекта", file: "Входящие/ТЗ.pdf", instruction: "Изучи" });
    await requests.tick();
    const told = sent.filter((item) => item.agentId === "main").at(-1)!.message;
    expect(told).toContain("это несколько агентов");
    expect(told).toContain("Разработчик проекта — dev-shop (команда «Магазин»)");
    expect(told).toContain("Разработчик проекта — dev-board (команда «Доска»)");
    expect(requests.list().requests).toHaveLength(1);
  });

  it("the waiting share tool gets the panel's answer; a message follows only when it did not take it in time", async () => {
    let clock = 1000;
    const results = new Map<string, string>();
    const quick = new WorkRequestsService({
      db, companyMode: () => true, files: { ownerFiles: async () => ({ files: [{ path: "Входящие/ТЗ.pdf" }] }), ownerFileStore: async () => ({ path: "x" }) }, now: () => clock,
      bridge: {
        requestsSpool: async () => ({ entries: [...spool], rejected: [] }), requestsAck: async (ids) => { spool = spool.filter((item) => !ids.includes(item.id as string)); },
        requestsResult: async (id, text) => { results.set(id, text); }, requestsResultTake: async (id) => ({ existed: results.delete(id) }),
      },
      send: async (agentId, message) => { sent.push({ agentId, message }); },
    });
    spool.push({ id: "a".repeat(32), type: "share", agentId: "main", to: "dev", file: "Входящие/ТЗ.pdf", instruction: "Прочитай" });
    spool.push({ id: "b".repeat(32), type: "share", agentId: "main", to: "никто", file: "Входящие/ТЗ.pdf", instruction: "Прочитай" });
    await quick.tick();
    expect(results.get("a".repeat(32))).toContain("REQ-001: предложение передать «ТЗ.pdf»");
    expect(sent.filter((item) => item.agentId === "main")).toEqual([]);
    results.delete("a".repeat(32)); // the tool took this one; the other one it did not
    clock += 30_000;
    await quick.tick();
    const toMain = sent.filter((item) => item.agentId === "main").map((item) => item.message);
    expect(toMain).toHaveLength(1);
    expect(toMain[0]).toContain("агент «никто» не найден");
  });

  it("refuses proposals from other agents, for unknown agents or files, twice, and an agent asking for a file itself", async () => {
    spool.push({ id: "b".repeat(32), type: "share", agentId: "analyst", to: "dev", file: "Входящие/ТЗ.pdf", instruction: "x" });
    spool.push({ id: "c".repeat(32), type: "share", agentId: "main", to: "никто", file: "Входящие/ТЗ.pdf", instruction: "x" });
    spool.push({ id: "d".repeat(32), type: "share", agentId: "main", to: "dev", file: "Входящие/нет.pdf", instruction: "x" });
    spool.push({ id: "e".repeat(32), type: "share", agentId: "main", to: "dev", file: "media://inbound/исчез.pdf", instruction: "x" });
    spool.push({ id: "f".repeat(32), type: "share", agentId: "main", to: "dev", file: "Входящие/ТЗ.pdf", instruction: "Прочитай" });
    spool.push({ id: "1".repeat(32), type: "share", agentId: "main", to: "dev", file: "Входящие/ТЗ.pdf", instruction: "Прочитай ещё" });
    spool.push({ id: "2".repeat(32), type: "up", agentId: "analyst", kind: "access", subject: "Нужен ТЗ", details: "x", resource: "file:Входящие/ТЗ.pdf", access: "read" });
    await requests.tick();
    expect(requests.list().requests.map((item) => `${item.code}:${item.from.agentId}:${item.resource}`)).toEqual(["REQ-001:dev:file:Входящие/ТЗ.pdf"]);
    const toMain = sent.filter((item) => item.agentId === "main").map((item) => item.message);
    expect(toMain.some((text) => text.includes("агент «никто» не найден"))).toBe(true);
    expect(toMain.some((text) => text.includes("«Входящие/нет.pdf» нет в общей папке"))).toBe(true);
    expect(toMain.some((text) => text.includes("его нет во входящих"))).toBe(true);
    expect(toMain.some((text) => text.includes("уже предложено: REQ-001"))).toBe(true);
    expect(sent.some((item) => item.agentId === "analyst" && item.message.includes("для доступа укажи resource"))).toBe(true);
  });
});
