import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REMIND_BEFORE_MS, REQUEST_TTL_MS, WorkRequestsService } from "../src/company/work-requests-service.js";
import { openDb, type Db } from "../src/db/client.js";
import { agents, channelBindings, teams } from "../src/db/schema.js";

// Stage 8: a request that reaches the owner goes to the owner's Telegram with one-time buttons; a press
// comes back through the spool with the presser's numeric ID (the plugin's interactive handler).

describe("company requests in the owner's Telegram", () => {
  let root: string, db: Db, close: () => void, service: WorkRequestsService;
  let clock = 1_000;
  let spool: Record<string, unknown>[], toOwner: { text: string; buttons: { label: string; data: string }[]; key: string }[], granted: string[], owner: string | null, n: number;
  const add = (entry: Record<string, unknown>) => { const id = (++n).toString(16).padStart(32, "0"); spool.push({ id, ...entry }); return id; };
  const press = (data: string, senderId = "4242") => add({ type: "owner_button", agentId: "telegram", token: data.slice("cdreq:".length), senderId, accountId: "default" });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-requests-tg-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    spool = []; toOwner = []; granted = []; owner = "4242"; n = 0; clock = 1_000;
    db.insert(agents).values({ id: "analyst", role: "specialist", displayName: "Аналитик" }).run();
    service = new WorkRequestsService({
      db, companyMode: () => true, now: () => clock, liveAgents: async () => new Set(["main", "analyst"]),
      bridge: { requestsSpool: async () => ({ entries: [...spool], rejected: [] }), requestsAck: async (ids) => { spool = spool.filter((item) => !ids.includes(item.id as string)); } },
      send: async () => undefined,
      telegram: { ownerUserId: () => owner, sendToOwnerWithButtons: async (text, buttons, key) => { toOwner.push({ text, buttons, key }); } },
      grant: async (request) => { granted.push(`${request.agentId}:${request.resource}`); return { resource: request.resource, access: request.access, path: "/workspace/folders/Finance" }; },
    });
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  async function toTheOwner(kind: "access" | "question") {
    add({ type: "up", agentId: "analyst", kind, subject: "Финансы", details: "Нужен отчёт", ...(kind === "access" ? { resource: "folder:Finance", access: "read" } : {}) });
    await service.tick();
    add({ type: "reply", agentId: "main", requestId: "REQ-001", action: "escalate", text: "решать владельцу" });
    await service.tick();
  }

  it("asks the owner in Telegram and acts only on the owner's own press, once", async () => {
    await toTheOwner("access");
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]!.text).toContain("REQ-001 · нужен доступ: folder:Finance, только чтение");
    expect(toOwner[0]!.text).toContain("Прошло: Главный агент → вы");
    expect(toOwner[0]!.buttons.map((button) => button.label)).toEqual(["Выдать доступ", "Отказать"]);
    const [grant, deny] = toOwner[0]!.buttons;
    expect(grant!.data).toMatch(/^cdreq:[A-Za-z0-9_-]{22}$/);
    expect(new TextEncoder().encode(grant!.data).length).toBeLessThanOrEqual(64);

    // Someone else in the chat (or a forwarded button) cannot grant.
    press(grant!.data, "999");
    await service.tick();
    expect(granted).toEqual([]);
    expect(service.list().requests[0]!.status).toBe("open");

    press(grant!.data);
    await service.tick();
    expect(granted).toEqual(["analyst:folder:Finance"]);
    expect(service.list().requests[0]).toMatchObject({ status: "answered", answer: { by: "owner" } });
    expect(toOwner.at(-1)!.text).toContain("REQ-001 («Финансы»): Доступ выдан и проверен");
    expect(toOwner.at(-1)!.buttons).toEqual([]);
    // The same button again, or the other one: nothing happens, the owner is told it is decided.
    press(grant!.data);
    press(deny!.data);
    await service.tick();
    expect(granted).toHaveLength(1);
    expect(toOwner.slice(-2).map((message) => message.text)).toEqual(["REQ-001: уже решено (answered), кнопка больше не действует.", "REQ-001: уже решено (answered), кнопка больше не действует."]);
    expect(new Set(toOwner.map((message) => message.key)).size).toBe(toOwner.length);
  });

  it("a team that chose its topic gets the owner's message there, mentioned and without details", async () => {
    const toTopic: { chatId: string; topicId: string; text: string; buttons: { label: string; data: string }[] }[] = [];
    const telegram = { ownerUserId: () => owner, sendToOwnerWithButtons: async (text: string, buttons: { label: string; data: string }[], key: string) => { toOwner.push({ text, buttons, key }); }, sendToTopicWithButtons: async (chatId: string, topicId: string, text: string, buttons: { label: string; data: string }[]) => { toTopic.push({ chatId, topicId, text, buttons }); } };
    service = new WorkRequestsService({
      db, companyMode: () => true, now: () => clock, liveAgents: async () => new Set(["main", "analyst"]),
      bridge: { requestsSpool: async () => ({ entries: [...spool], rejected: [] }), requestsAck: async (ids) => { spool = spool.filter((item) => !ids.includes(item.id as string)); } },
      send: async () => undefined, telegram, grant: async (request) => ({ resource: request.resource, access: request.access, path: null }),
    });
    db.insert(teams).values({ id: "shop", name: "Shop", telegramGroupId: "-1001", ownerRequests: "topic" }).run();
    db.update(agents).set({ teamId: "shop" }).run();
    db.insert(channelBindings).values({ id: randomUUID(), agentId: "analyst", channel: "telegram", peerKind: "group", peerId: "-1001", topicId: "77" }).run();
    await toTheOwner("access");
    expect(toOwner).toEqual([]);
    expect(toTopic).toHaveLength(1);
    expect(toTopic[0]).toMatchObject({ chatId: "-1001", topicId: "77" });
    expect(toTopic[0]!.text).toContain("[Владелец](tg://user?id=4242), REQ-001 · нужен доступ");
    expect(toTopic[0]!.text).not.toContain("Нужен отчёт");
    expect(toTopic[0]!.buttons.map((button) => button.label)).toEqual(["Выдать доступ", "Отказать"]);
    // A press by another member of the group does nothing.
    press(toTopic[0]!.buttons[0]!.data, "999");
    await service.tick();
    expect(service.list().requests[0]!.status).toBe("open");
    // Without a topic for the agent the owner's own chat is used.
    db.delete(channelBindings).run();
    add({ type: "up", agentId: "analyst", kind: "question", subject: "Другое", details: "Что-то" });
    await service.tick();
    add({ type: "reply", agentId: "main", requestId: "REQ-002", action: "escalate", text: "владельцу" });
    await service.tick();
    expect(toOwner.at(-1)!.text).toContain("REQ-002");
  });

  it("a question decided in the panel closes in Telegram too; without an owner the delivery fails, the request stays", async () => {
    await toTheOwner("question");
    expect(toOwner[0]!.buttons.map((button) => button.label)).toEqual(["Отказать", "Закрыть без ответа"]);
    const request = service.list().requests[0]!;
    service.ownerAct(request.id, { requestId: randomUUID(), revision: request.revision, action: "answer", text: "Отчёт в папке Finance" });
    await service.tick();
    expect(toOwner.at(-1)!.text).toBe("REQ-001 («Финансы»): ответил Владелец: Отчёт в папке Finance");
    press(toOwner[0]!.buttons[0]!.data);
    await service.tick();
    expect(service.list().requests[0]!.status).toBe("answered");

    owner = null;
    add({ type: "up", agentId: "analyst", kind: "question", subject: "Второй", details: "x" });
    await service.tick();
    add({ type: "reply", agentId: "main", requestId: "REQ-002", action: "escalate", text: "к владельцу" });
    await service.tick();
    const second = service.list().requests[0]!;
    expect(second).toMatchObject({ code: "REQ-002", status: "open", level: 1 });
    expect(second.events.find((event) => event.channel === "telegram")!.delivery).toBe("failed");
  });

  it("a deny press closes the request with a reason the requester sees", async () => {
    await toTheOwner("access");
    press(toOwner[0]!.buttons[1]!.data);
    await service.tick();
    expect(service.list().requests[0]).toMatchObject({ status: "denied", answer: { text: "Отказано владельцем в Telegram." } });
    expect(granted).toEqual([]);
  });

  it("the owner answers with /req text from Telegram; a stranger's command does nothing", async () => {
    await toTheOwner("question");
    expect(toOwner[0]!.text).toContain("/req REQ-001 ответ <текст>");
    add({ type: "owner_text", agentId: "telegram", senderId: "999", requestId: "REQ-001", action: "answer", text: "чужой ответ" });
    await service.tick();
    expect(service.list().requests[0]!.status).toBe("open");
    add({ type: "owner_text", agentId: "telegram", senderId: "4242", requestId: "REQ-001", action: "clarify", text: "За какой месяц?" });
    await service.tick();
    expect(service.list().requests[0]!.status).toBe("clarify");
    expect(toOwner.at(-1)!.text).toBe("REQ-001: вопрос отправлен автору.");
    add({ type: "owner_text", agentId: "telegram", senderId: "4242", requestId: "REQ-001", action: "answer", text: "Отчёт в папке Sales" });
    await service.tick();
    expect(service.list().requests[0]).toMatchObject({ status: "answered", answer: { by: "owner", text: "Отчёт в папке Sales" } });
    expect(toOwner.at(-1)!.text).toBe("REQ-001 («Финансы»): ответил Владелец: Отчёт в папке Sales");
    add({ type: "owner_text", agentId: "telegram", senderId: "4242", requestId: "REQ-001", action: "deny", text: "поздно" });
    await service.tick();
    expect(toOwner.at(-1)!.text).toBe("REQ-001: уже решено (answered); ответ не нужен.");
  });

  it("reminds the owner once shortly before the deadline", async () => {
    await toTheOwner("question");
    const before = toOwner.length;
    clock = 1_000 + REQUEST_TTL_MS - REMIND_BEFORE_MS - 1;
    await service.tick();
    expect(toOwner).toHaveLength(before);
    clock += 2;
    await service.tick();
    await service.tick();
    expect(toOwner.slice(before).map((message) => message.text.slice(0, 26))).toEqual(["Напоминание: REQ-001 («Фин"]);
    clock = 1_000 + REQUEST_TTL_MS + 1;
    await service.tick();
    expect(toOwner.at(-1)!.text).toContain("срок истёк без ответа");
  });
});
