import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkRequestsService, REQUEST_TTL_MS } from "../src/company/work-requests-service.js";
import { requestsPluginPatch } from "../src/company/work-requests-config.js";
import { openDb, type Db } from "../src/db/client.js";
import { agents, companyAgentAssignments, departmentManagers, departments, teams } from "../src/db/schema.js";
import { registerWorkRequestRoutes } from "../src/routes/work-requests.js";

// Stage 6: requests up the company structure. The fake bridge is the plugin's spool; `send` records the
// messages agents would get in their chats.

describe("company requests", () => {
  let root: string, db: Db, close: () => void, service: WorkRequestsService, clock: number;
  let spool: Record<string, unknown>[], acked: string[], sent: { agentId: string; message: string; key: string }[], live: Set<string>, failSend: boolean, company: boolean;
  let n = 0;
  const entry = (agentId: string, fields: Record<string, unknown>) => { const id = (++n).toString(16).padStart(32, "0"); spool.push({ id, agentId, sessionKey: `agent:${agentId}:main`, at: clock, ...fields }); return id; };
  const up = (agentId: string, subject = "Где ТЗ?", kind = "question") => entry(agentId, { type: "up", kind, subject, details: "Нужна ссылка на ТЗ" });
  const reply = (agentId: string, requestId: string, action: string, text = "ответ") => entry(agentId, { type: "reply", requestId, action, text });
  const tick = async () => { await service.tick(); };
  const messagesTo = (agentId: string) => sent.filter((item) => item.agentId === agentId).map((item) => item.message);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-requests-"));
    ({ db, close } = openDb(path.join(root, "panel.sqlite")));
    clock = 1_000_000; spool = []; acked = []; sent = []; failSend = false; company = true;
    live = new Set(["main", "it-head", "dev", "solo"]);
    db.insert(departments).values({ id: "it", requestId: randomUUID(), requestPayload: "{}", name: "IT" }).run();
    db.insert(teams).values({ id: "shop", name: "Shop", departmentId: "it" }).run();
    db.insert(agents).values([
      { id: "it-head", role: "specialist", displayName: "Руководитель IT" },
      { id: "dev", role: "team_member", teamId: "shop", templateId: "developer", displayName: "Разработчик" },
      { id: "solo", role: "specialist", displayName: "Аналитик" },
    ]).run();
    db.insert(departmentManagers).values({ departmentId: "it", agentId: "it-head" }).run();
    db.insert(companyAgentAssignments).values({ agentId: "it-head", departmentId: "it" }).run();
    service = new WorkRequestsService({
      db, companyMode: () => company, now: () => clock, liveAgents: async () => live,
      bridge: { requestsSpool: async () => ({ entries: [...spool], rejected: [] }), requestsAck: async (ids) => { acked.push(...ids); spool = spool.filter((item) => !ids.includes(item.id as string)); } },
      send: async (agentId, message, key) => { if (failSend) throw new Error("offline"); sent.push({ agentId, message, key }); },
    });
  });
  afterEach(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });

  it("routes a developer's request through its department manager, main agent, then the owner, who answers", async () => {
    expect(service.route("dev").map((level) => level.kind)).toEqual(["manager", "main", "owner"]);
    expect(service.route("it-head").map((level) => level.agentId)).toEqual(["main", null]);
    expect(service.route("solo").map((level) => level.kind)).toEqual(["main", "owner"]);
    expect(service.route("main").map((level) => level.kind)).toEqual(["owner"]);

    const filed = up("dev");
    await tick();
    expect(acked).toEqual([filed]);
    let request = service.list().requests[0]!;
    expect(request).toMatchObject({ code: "REQ-001", status: "open", level: 0, from: { agentId: "dev", name: "Разработчик" }, route: [{ kind: "manager", name: "Руководитель IT" }, { kind: "main" }, { kind: "owner", name: "Владелец" }] });
    expect(messagesTo("it-head")[0]).toContain("Обращение REQ-001 от Разработчик");
    expect(messagesTo("it-head")[0]).toContain("escalate — передать выше (Главный агент)");
    expect(messagesTo("dev")[0]).toContain("REQ-001 принято и передано: Руководитель IT");

    // Someone else cannot answer; the manager passes it up, the main agent too.
    reply("solo", "REQ-001", "answer");
    reply("it-head", "REQ-001", "escalate", "не знаю, где ТЗ");
    await tick();
    expect(messagesTo("solo")[0]).toContain("Ты не можешь отвечать по REQ-001");
    reply("main", "REQ-001", "escalate", "ТЗ у владельца");
    await tick();
    request = service.list().requests[0]!;
    expect(request).toMatchObject({ status: "open", level: 2 });
    expect(messagesTo("main")[0]).toContain("Обращение REQ-001");

    request = service.ownerAct(request.id, { requestId: randomUUID(), revision: request.revision, action: "answer", text: "ТЗ в папке docs/spec.md" });
    expect(request).toMatchObject({ status: "answered", answer: { by: "owner", text: "ТЗ в папке docs/spec.md" } });
    await tick();
    expect(messagesTo("dev").at(-1)).toContain("Ответ на REQ-001");
    // The owner was told in Telegram when it reached them, so the outcome goes there too.
    expect(request.events.map((event) => event.kind)).toEqual(["created", "routed", "escalated", "routed", "escalated", "routed", "answered", "notified"]);
    // A late reply from the main agent changes nothing.
    reply("main", "REQ-001", "answer");
    await tick();
    expect(messagesTo("main").at(-1)).toContain("REQ-001 уже закрыто");
  });

  it("puts the team lead first, skips it for its own request and when it is also the manager", async () => {
    db.insert(agents).values([{ id: "lead", role: "team_member", teamId: "shop", templateId: "pm", displayName: "Тимлид" }]).run();
    db.update(teams).set({ leadAgentId: "lead" }).run();
    expect(service.route("dev").map((level) => [level.kind, level.agentId])).toEqual([["lead", "lead"], ["manager", "it-head"], ["main", "main"], ["owner", null]]);
    expect(service.route("lead").map((level) => level.kind)).toEqual(["manager", "main", "owner"]);
    db.update(teams).set({ leadAgentId: "it-head" }).run();
    expect(service.route("dev").map((level) => level.kind)).toEqual(["manager", "main", "owner"]);
    // A lead that no longer exists counts as none.
    db.update(teams).set({ leadAgentId: "gone" }).run();
    expect(service.route("dev").map((level) => level.kind)).toEqual(["manager", "main", "owner"]);
    // A request goes to the lead first, and the lead's escalation reaches the manager.
    db.update(teams).set({ leadAgentId: "lead" }).run();
    live.add("lead");
    up("dev", "Какой API?");
    await tick();
    expect(messagesTo("lead").at(-1)).toContain("Какой API?");
  });

  it("skips a level that is not running, asks for clarification and accepts only the requester's reply", async () => {
    live.delete("it-head");
    up("dev", "Какой формат даты?");
    await tick();
    let request = service.list().requests[0]!;
    expect(request).toMatchObject({ level: 1 });
    expect(request.events.map((event) => [event.kind, event.text])).toContainEqual(["skipped", "Руководитель IT (it-head) недоступен"]);
    reply("main", "REQ-001", "clarify", "Для какого экрана?");
    await tick();
    expect(service.list().requests[0]!.status).toBe("clarify");
    expect(messagesTo("dev").at(-1)).toContain("уточняет по REQ-001");
    reply("main", "REQ-001", "reply", "сам себе");
    reply("dev", "REQ-001", "reply", "Для списка задач");
    await tick();
    expect(messagesTo("main").some((message) => message.includes("может дать только автор обращения"))).toBe(true);
    expect(messagesTo("main").some((message) => message.includes("ответил на уточнение:\nДля списка задач"))).toBe(true);
    expect(service.list().requests[0]!.status).toBe("open");
    reply("main", "REQ-001", "deny", "Решает дизайнер");
    await tick();
    request = service.list().requests[0]!;
    expect(request).toMatchObject({ status: "denied", answer: { by: "main", text: "Решает дизайнер" } });
    expect(messagesTo("dev").at(-1)).toContain("Не повторяй то же обращение");
  });

  it("files each spool entry once, keeps one active request per subject and limits transitions", async () => {
    const id = up("dev");
    await tick();
    spool.push({ ...spool[0], id }); // the same entry again (e.g. after a lost acknowledgement)
    up("dev", "  где   тз? ");
    up("dev", "Где ТЗ?", "decision");
    await tick();
    expect(service.list().requests.map((request) => [request.code, request.kind])).toEqual([["REQ-002", "decision"], ["REQ-001", "question"]]);
    expect(messagesTo("dev").some((message) => message.includes("по этой теме уже открыто REQ-001"))).toBe(true);
    for (const subject of ["a", "b", "c", "d"]) up("dev", subject);
    await tick();
    expect(service.list().requests.filter((request) => request.status === "open")).toHaveLength(5);
    expect(messagesTo("dev").at(-1)).toContain("уже 5 открытых обращений");
    // A team member of a department without a manager goes straight to main.
    db.delete(departmentManagers).run();
    expect(service.route("dev").map((level) => level.kind)).toEqual(["main", "owner"]);
  });

  it("expires overdue requests, retries failed deliveries without duplicates, and is company-only", async () => {
    up("solo");
    failSend = true;
    await tick();
    expect(sent).toEqual([]);
    expect(service.list().requests[0]!.events.find((event) => event.kind === "routed")!.delivery).toBe("pending");
    failSend = false;
    await tick();
    const keys = sent.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    await tick();
    expect(sent.map((item) => item.key)).toEqual(keys);
    clock += REQUEST_TTL_MS + 1;
    await tick();
    expect(service.list().requests[0]!.status).toBe("expired");
    expect(messagesTo("solo").at(-1)).toContain("истёк без ответа");
    company = false;
    up("solo", "new");
    await tick();
    expect(spool).toHaveLength(1);
    expect(() => service.ownerAct(service.list().requests[0]!.id, { requestId: randomUUID(), revision: 0, action: "cancel", text: "" })).toThrow("company_only");
  });

  it("owner actions are idempotent per request ID and refuse stale revisions; routes validate", async () => {
    up("solo");
    await tick();
    const [request] = service.list().requests;
    const action = { requestId: randomUUID(), revision: request!.revision, action: "clarify" as const, text: "Зачем?" };
    const first = service.ownerAct(request!.id, action);
    expect(service.ownerAct(request!.id, action)).toEqual(first);
    expect(() => service.ownerAct(request!.id, { ...action, text: "другое" })).toThrow("request_conflict");
    expect(() => service.ownerAct(request!.id, { ...action, requestId: randomUUID() })).toThrow("revision_conflict");
    const app = Fastify(); registerWorkRequestRoutes(app, { requests: service });
    expect((await app.inject({ url: "/api/company/requests" })).json().requests).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/company/requests/${request!.id}/act`, payload: { requestId: randomUUID(), revision: first.revision, action: "answer", text: "" } })).statusCode).toBe(400);
    const done = await app.inject({ method: "POST", url: `/api/company/requests/${request!.id}/act`, payload: { requestId: randomUUID(), revision: first.revision, action: "answer", text: "Вот" } });
    expect(done.json()).toMatchObject({ status: "answered" });
    expect((await app.inject({ method: "POST", url: `/api/company/requests/${randomUUID()}/act`, payload: { requestId: randomUUID(), revision: 0, action: "cancel" } })).statusCode).toBe(404);
    await app.close();
  });

  it("gives the request tools to company agents only adding to their own policies, never removing a live one", () => {
    const config = { agents: { entries: { main: {}, dev: { tools: { alsoAllow: ["clawdesk_ask_main"] } }, strict: { tools: { allow: ["read"] } } } }, plugins: { load: { paths: ["/p/ask"] }, entries: {} } };
    const patch = requestsPluginPatch(config, ["main", "dev", "strict"]) as Record<string, any>;
    expect(patch.plugins.entries["clawdesk-requests"]).toEqual({ enabled: true, config: { allowedAgentIds: ["dev", "main", "strict"] } });
    expect(patch.plugins.load.paths).toEqual(["/p/ask", "/usr/local/share/clawdesk/plugins/clawdesk-requests"]);
    expect(patch.agents.entries.dev.tools).toEqual({ alsoAllow: ["clawdesk_ask_main", "clawdesk_request_up", "clawdesk_request_reply", "clawdesk_task_report", "clawdesk_task_review"] });
    expect(patch.agents.entries.strict.tools).toEqual({ allow: ["read", "clawdesk_request_up", "clawdesk_request_reply", "clawdesk_task_report", "clawdesk_task_review"] });
    // Sandboxed sessions see plugin tools only when the sandbox gate names the plugin.
    expect(patch.tools).toEqual({ sandbox: { tools: { alsoAllow: ["clawdesk-requests"] } } });
    expect((requestsPluginPatch({ ...config, tools: { sandbox: { tools: { allow: ["read"] } } } }, ["main"]) as Record<string, any>).tools.sandbox.tools).toEqual({ allow: ["read", "clawdesk-requests"] });
    expect((requestsPluginPatch({ ...config, tools: { sandbox: { tools: { deny: ["clawdesk-requests"] } } } }, ["main"]) as Record<string, any>).tools).toBeUndefined();
    const applied = { tools: patch.tools, agents: { entries: { main: { tools: patch.agents.entries.main.tools }, dev: { tools: patch.agents.entries.dev.tools }, strict: { tools: patch.agents.entries.strict.tools } } }, plugins: { load: patch.plugins.load, entries: patch.plugins.entries } };
    expect(requestsPluginPatch(applied, ["main", "dev", "strict"])).toBeNull();
    // A deleted agent stays in the allowlist (no plugin change right after a delete); personal mode clears it.
    expect(requestsPluginPatch(applied, ["main", "dev"])).toBeNull();
    const personal = requestsPluginPatch(applied, [], false) as Record<string, any>;
    expect(personal.plugins.entries["clawdesk-requests"].config.allowedAgentIds).toEqual([]);
    expect(personal.agents.entries.dev.tools).toEqual({ alsoAllow: ["clawdesk_ask_main"] });
    expect(requestsPluginPatch({}, [], false)).toBeNull();
  });
});
