import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { topicLink } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { agents, channelBindings, settings } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { TelegramService } from "../src/telegram/telegram-service.js";
import { listAgents } from "../src/routes/agents.js";
import { BridgeError } from "../src/gateway/bridge-client.js";

function arrayPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return [path];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => arrayPaths(child, path ? `${path}.${key}` : key));
}

function merge(target: Record<string, any>, patch: Record<string, any>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (key === "id" && value === "__OPENCLAW_REDACTED__") {
      if (typeof target[key] !== "string") throw new Error("SecretRef contains a redacted id placeholder with no matching original value");
    }
    else if (typeof value === "object" && !Array.isArray(value)) merge(target[key] ??= {}, value);
    else target[key] = value;
  }
}

function redactTokens(config: Record<string, any>) {
  const copy = structuredClone(config);
  const telegram = copy.channels?.telegram;
  for (const account of [telegram, ...Object.values(telegram?.accounts ?? {})] as Record<string, any>[]) {
    if (account?.botToken && typeof account.botToken === "object") account.botToken.id = "__OPENCLAW_REDACTED__";
  }
  return copy;
}

describe("Telegram bot accounts", () => {
  let dir: string;
  let db: ReturnType<typeof openDb>["db"];
  let close: () => void;
  let config: Record<string, any>;
  let calls: { method: string; params: Record<string, any> }[];
  let approved: string[];
  let audioConfigured: boolean;
  let audioProviders: { openai: boolean; groq: boolean };
  let audioKeyError: Error | null;
  let telegram: TelegramService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-tg-accounts-"));
    ({ db, close } = openDb(path.join(dir, "panel.sqlite")));
    db.insert(agents).values([{ id: "main", role: "main", displayName: "Main" }, { id: "junior", role: "specialist", displayName: "Junior" }]).run();
    config = {
      channels: { telegram: { enabled: true, botToken: { source: "store", id: "existing" }, dmPolicy: "pairing", groupPolicy: "disabled" } },
      bindings: [{ agentId: "main", match: { channel: "telegram" } }],
      commands: { ownerAllowFrom: ["telegram:42"] },
    };
    db.insert(settings).values({ key: "telegram.bot", value: { id: 1, username: "first_bot", name: "First" } }).run();
    approved = [];
    audioConfigured = false;
    audioProviders = { openai: false, groq: false };
    audioKeyError = null;
    calls = [];
    const gateway = {
      generation: 1, status: { state: "connected" }, waitForReconnect: async () => undefined,
      request: async (method: string, params: Record<string, any>) => {
        calls.push({ method, params });
        if (method === "secrets.store.set" && !/^(?:[A-Z][A-Z0-9_]{0,127}|github-setup-[a-f0-9]{32})$/.test(params.name)) throw new Error("invalid secret name");
        if (method === "config.get") return { hash: "h", config: redactTokens(config) };
        if (method === "config.patch") {
          const next = structuredClone(config);
          merge(next, JSON.parse(params.raw));
          for (const path of arrayPaths(config)) {
            const read = (value: Record<string, any>) => path.split(".").reduce((node, key) => node?.[key], value);
            const before = read(config) as unknown[];
            const after = read(next) as unknown[] | undefined;
            if ((!Array.isArray(after) || before.some((entry) => !after.some((other) => JSON.stringify(entry) === JSON.stringify(other)))) && !params.replacePaths?.includes(path)) {
              throw new Error(`config.patch would remove entries from array path(s): ${path}`);
            }
          }
          config = next;
        }
        if (method === "plugins.setEnabled") return { restartRequired: false };
        if (method === "agents.list") return { agents: [{ id: "main", identity: { name: "Original name", emoji: "M" } }] };
        if (method === "channels.status") return { channelAccounts: { telegram: [{ accountId: "default", running: true }, { accountId: "second", running: false, lastError: "network failure" }] } };
        if (method === "channels.pairing.list") return { requests: ["default", "second"].map((accountId) => ({ channel: "telegram", accountId, requestId: `${accountId}-r`, senderId: "42", senderLabel: "Owner", createdAt: "", expiresAt: "" })) };
        if (method === "channels.pairing.approve") return { senderId: "42" };
        if (method === "gateway.restart.request") gateway.generation++;
        return { ok: true };
      },
    };
    const fetchBot = (async (url: string) => new Response(JSON.stringify({ ok: true, result: { id: url.includes("duplicate") ? 1 : url.includes("third") ? 3 : 2, username: "second_bot", first_name: "Second" } }))) as typeof fetch;
    telegram = new TelegramService(gateway as unknown as GatewayService, db, pino({ level: "silent" }), fetchBot, {
      telegramApproved: async () => ({ senderIds: approved }),
      telegramAudioStatus: async () => ({ configured: audioConfigured, providers: audioProviders }),
      telegramAudioKey: async (_key, provider = "openai") => {
        if (audioKeyError) throw audioKeyError;
        audioProviders[provider as "openai" | "groq"] = true;
        audioConfigured = true; return { configured: true };
      },
    });
  });

  afterEach(() => { close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function owner(accountId = "default") {
    db.insert(channelBindings).values({ id: `owner-${accountId}`, agentId: "main", channel: "telegram", accountId, peerKind: "direct", peerId: "42" }).run();
  }

  it("requires a separate audio key before enabling cloud transcription", async () => {
    expect(await telegram.voiceStatus()).toMatchObject({ configured: false, enabled: false });
    await expect(telegram.setVoice(true)).rejects.toThrow(/separate API key/);
    expect(calls.some((call) => call.method === "config.patch")).toBe(false);
  });

  it("enables audio only after storing its key and does not change the text model", async () => {
    config.agents = { entries: { main: { model: "openai/text-model@openai:oauth" } } };
    expect(await telegram.saveVoiceKey("sk-test012345678901234567890")).toMatchObject({ configured: true, enabled: true });
    expect(config.agents.entries.main.model).toBe("openai/text-model@openai:oauth");
    expect(config.tools.media.models[0]).toMatchObject({ profile: "openai:clawdesk-audio" });
    expect(await telegram.setVoice(false)).toMatchObject({ configured: true, enabled: false });
  });

  it("saves Groq, preserves its model across disable/enable, and can switch back using a saved OpenAI key", async () => {
    config.agents = { entries: { main: { model: "openai/text@oauth" } } };
    await telegram.saveVoiceKey("sk-test012345678901234567890");
    const saved = await telegram.saveVoiceKey("gsk_test012345678901234567890", "groq", "whisper-large-v3");
    expect(saved).toMatchObject({ provider: "groq", model: "whisper-large-v3", enabled: true, configured: true, configuredProviders: ["openai", "groq"] });
    expect(config.tools.media.models).toHaveLength(1);
    await telegram.setVoice(false);
    expect(await telegram.setVoice(true)).toMatchObject({ provider: "groq", model: "whisper-large-v3", enabled: true });
    expect(await telegram.setVoice(true, "openai", "whisper-1")).toMatchObject({ provider: "openai", model: "whisper-1", enabled: true });
    expect(config.agents.entries.main.model).toBe("openai/text@oauth");
  });

  it("does not activate a provider with a rejected or missing key", async () => {
    audioKeyError = new BridgeError("audio_key_rejected", "safe provider rejection");
    await expect(telegram.saveVoiceKey("gsk_test012345678901234567890", "groq")).rejects.toMatchObject({ code: "audio_key_rejected" });
    expect(calls.some((call) => call.method === "config.patch")).toBe(false);
    await expect(telegram.setVoice(true, "groq")).rejects.toMatchObject({ code: "no_audio_key" });
  });

  it("recovers only an approved, explicit command owner and does not duplicate concurrent reads", async () => {
    approved = ["42", "99"];
    const statuses = await Promise.all([telegram.status(), telegram.status()]);
    expect(statuses.every((s) => s.owner?.id === "42")).toBe(true);
    expect(db.select().from(channelBindings).all()).toHaveLength(1);
    expect(calls.some((c) => c.method === "channels.pairing.approve")).toBe(false);
  });

  it("never promotes an unapproved person or an ambiguous set of owners", async () => {
    approved = ["99"];
    expect((await telegram.status()).owner).toBeNull();
    approved = ["42", "99"];
    config.commands.ownerAllowFrom.push("telegram:99");
    expect((await telegram.status()).owner).toBeNull();
  });

  it("recovers the owner when the built-in main agent has no panel metadata", async () => {
    db.delete(agents).where(eq(agents.id, "main")).run();
    approved = ["42"];
    expect((await telegram.status()).owner?.id).toBe("42");
    expect(db.select().from(agents).where(eq(agents.id, "main")).get()).toMatchObject({ displayName: "Original name", role: "main", sandbox: false });
    expect((await telegram.status()).owner?.id).toBe("42");
    const listed = await listAgents({ db, sandboxEnabled: true, gateway: { request: async () => ({ defaultId: "main", agents: [{ id: "main", identity: { name: "Updated name" } }] }) } as unknown as GatewayService });
    expect(listed.agents[0]?.name).toBe("Updated name");
  });

  it("approves a new owner without a pre-existing main metadata row", async () => {
    db.delete(agents).where(eq(agents.id, "main")).run();
    await telegram.approve("default-r", "default");
    expect((await telegram.status()).owner?.id).toBe("42");
  });

  it("adds a separate bot, migrates the legacy bot and keeps secrets out of responses", async () => {
    owner();
    const second = await telegram.addBot("new-token", "junior");
    expect(second.accountId).not.toBe("default");
    expect(second.agentId).toBe("junior");
    expect(second.owner).toBeNull();
    expect(config.channels.telegram.botToken.id).toBe("existing");
    expect(config.channels.telegram.accounts.default.botToken).toBeUndefined();
    expect((await telegram.status()).connected).toBe(true);
    expect(calls.filter((call) => call.method === "config.patch").every((call) => !call.params.raw.includes("__OPENCLAW_REDACTED__"))).toBe(true);
    expect(config.channels.telegram.accounts[second.accountId].dmPolicy).toBe("pairing");
    expect(config.bindings).toEqual([
      { agentId: "main", match: { channel: "telegram", accountId: "default" } },
      { agentId: "junior", match: { channel: "telegram", accountId: second.accountId } },
    ]);
    expect(JSON.stringify(await telegram.accounts())).not.toContain("new-token");
    expect((await telegram.status()).owner?.id).toBe("42");
  });

  it("rejects duplicate bots and nonexistent agents before modifying config", async () => {
    await expect(telegram.addBot("duplicate", "junior")).rejects.toThrow(/already connected/);
    await expect(telegram.addBot("new-token", "missing")).rejects.toThrow(/unknown agent/);
    expect(calls.filter((c) => c.method === "config.patch")).toHaveLength(0);
  });

  it("explicitly moves all legacy permission arrays without changing owners or other channels", async () => {
    owner();
    const permissions = {
      allowFrom: ["42"], groupAllowFrom: ["42", "99"],
      execApprovals: { enabled: true, approvers: ["42"], target: "dm" },
      groups: { "-1001234567890": { allowFrom: ["42"], topics: { "1": { skills: ["memory"], allowFrom: ["42"] } } } },
    };
    Object.assign(config.channels.telegram, structuredClone(permissions));
    config.channels.other = { allowFrom: ["unrelated"] };
    const second = await telegram.addBot("new-token", "junior");
    expect(config.channels.telegram.accounts.default).toMatchObject(permissions);
    expect(config.channels.telegram.botToken.id).toBe("existing");
    expect(config.channels.telegram.groupAllowFrom).toBeUndefined();
    expect(config.channels.telegram.execApprovals).toBeUndefined();
    expect(config.channels.other).toEqual({ allowFrom: ["unrelated"] });
    const patch = calls.find((call) => call.method === "config.patch" && JSON.parse(call.params.raw).channels?.telegram?.accounts);
    expect(patch?.params.replacePaths).toEqual(expect.arrayContaining([
      "channels.telegram.allowFrom", "channels.telegram.groupAllowFrom", "channels.telegram.execApprovals.approvers",
      "channels.telegram.groups.-1001234567890.allowFrom", "channels.telegram.groups.-1001234567890.topics.1.skills",
      "channels.telegram.groups.-1001234567890.topics.1.allowFrom",
    ]));
    expect(patch?.params.replacePaths).not.toContain("channels.other.allowFrom");
    expect((await telegram.status()).owner?.id).toBe("42");
    expect(second.agentId).toBe("junior");
    owner(second.accountId);
    await telegram.setApprovals(true, second.accountId);
    await telegram.linkGroup("-1009876543210", [{ agentId: "junior", topicId: "1" }], [], second.accountId);
    config.channels.telegram.accounts[second.accountId].groups["-1009876543210"].allowFrom = ["42"];
    await telegram.unlinkGroup("-1009876543210", second.accountId);
    await telegram.disconnect(second.accountId);
    expect((await telegram.status()).connected).toBe(true);
    expect(config.channels.telegram.accounts.default).toMatchObject(permissions);
  });

  it("preserves the inherited default token and other bots when adding a third bot or disconnecting default", async () => {
    owner();
    await telegram.connect("new-token", "junior", "second");
    const secondToken = structuredClone(config.channels.telegram.accounts.second.botToken);
    await telegram.connect("third-token", "main", "third");
    expect(config.channels.telegram.botToken.id).toBe("existing");
    expect(config.channels.telegram.accounts.second.botToken).toEqual(secondToken);
    expect((await telegram.accounts()).filter((bot) => bot.connected)).toHaveLength(3);
    await telegram.disconnect();
    expect((await telegram.status()).connected).toBe(false);
    expect((await telegram.status("second")).connected).toBe(true);
    expect((await telegram.status("third")).connected).toBe(true);
    expect(config.channels.telegram.botToken.id).toBe("existing");
  });

  it("uses valid, stable and distinct secret names for named accounts while preserving the default key", async () => {
    const accountId = `bot-${"a".repeat(60)}`;
    const otherAccountId = accountId.replace("-", "_");
    await telegram.connect("new-token", "junior", accountId);
    await telegram.connect("third-token", "junior", otherAccountId);
    await telegram.connect("new-token", "junior", accountId);
    await telegram.connect("duplicate", "main", "default");
    const names = calls.filter((call) => call.method === "secrets.store.set").map((call) => call.params.name);
    expect(names).toHaveLength(4);
    expect(names.every((name) => /^[A-Z][A-Z0-9_]{0,127}$/.test(name))).toBe(true);
    expect(names[0]).toBe(names[2]);
    expect(names[0]).not.toBe(names[1]);
    expect(names[3]).toBe("CLAWDESK_TELEGRAM_BOT_TOKEN");
    expect(config.channels.telegram.accounts[accountId].botToken.id).toBe(names[0]);
    expect(config.channels.telegram.accounts[otherAccountId].botToken.id).toBe(names[1]);
  });

  it("changes only the selected bot route and sends using that bot", async () => {
    owner(); owner("second");
    await telegram.connect("new-token", "junior", "second");
    await telegram.assignAgent("second", "main");
    expect(config.bindings).toEqual([
      { agentId: "main", match: { channel: "telegram", accountId: "default" } },
      { agentId: "main", match: { channel: "telegram", accountId: "second" } },
    ]);
    await telegram.sendToOwner("test", "second");
    expect(calls.find((c) => c.method === "send")?.params).toMatchObject({ accountId: "second", to: "42", message: "test" });
    expect((await telegram.status("second")).lastError).toBe("network failure");
    expect((await telegram.status()).running).toBe(true);
  });

  it("sends buttons through message.action: OpenClaw 2026.8.35 refuses them in send", async () => {
    owner();
    await telegram.sendToOwnerWithButtons("REQ-001 · передать файл", [{ label: "Выдать доступ", data: "cdreq:aaaaaaaaaaaaaaaaaaaa", style: "success" }], "key-1");
    const call = calls.filter((c) => c.method === "message.action").at(-1)!;
    expect(call.params).toEqual({ channel: "telegram", action: "send", accountId: "default", idempotencyKey: "key-1", params: { to: "42", message: "REQ-001 · передать файл", presentation: { blocks: [{ type: "buttons", buttons: [{ label: "Выдать доступ", action: { type: "callback", value: "cdreq:aaaaaaaaaaaaaaaaaaaa" }, style: "success" }] }] } } });
    expect(calls.some((c) => c.method === "send" && "presentation" in (c.params as object))).toBe(false);
    await telegram.sendToTopicWithButtons("-100", "7", "в тему", [{ label: "Отказать", data: "cdreq:bbbbbbbbbbbbbbbbbbbb" }], "key-2");
    expect(calls.filter((c) => c.method === "message.action").at(-1)!.params).toMatchObject({ params: { to: "-100", threadId: "7", message: "в тему" } });
  });

  it("filters pairing by account and refuses a request from another bot", async () => {
    expect((await telegram.pairingRequests("second")).map((r) => r.requestId)).toEqual(["second-r"]);
    await expect(telegram.approve("default-r", "second")).rejects.toThrow(/expired/);
    expect(calls.some((c) => c.method === "channels.pairing.approve")).toBe(false);
  });

  it("isolates group topics per bot and prevents duplicate replies across bots", async () => {
    owner(); owner("second");
    await telegram.connect("new-token", "junior", "second");
    const group = "-1001234567890";
    await telegram.linkAgentTopics([{ agentId: "main", link: topicLink(group, "1") }]);
    await telegram.linkAgentTopics([{ agentId: "junior", link: topicLink(group, "2") }], "second");
    expect(telegram.agentTopics().topics[0]?.topicId).toBe("1");
    expect(telegram.agentTopics("second").topics[0]?.topicId).toBe("2");
    expect(config.channels.telegram.accounts.default.groups[group].topics["2"]).toBeUndefined();
    expect(config.channels.telegram.accounts.second.groups[group].topics["1"]).toBeUndefined();
    await expect(telegram.linkAgentTopics([{ agentId: "junior", link: topicLink(group, "1") }], "second")).rejects.toThrow(/another bot/);
    await telegram.disconnect("second");
    expect(config.channels.telegram.accounts.default.enabled).toBe(true);
    expect(telegram.agentTopics().topics).toHaveLength(1);
    expect(telegram.agentTopics("second").topics).toHaveLength(0);
    expect((await telegram.status()).owner?.id).toBe("42");
  });
});
