import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LinkAgentTopicsRequest, topicLink } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { agents, channelBindings, schedules } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { TelegramService } from "../src/telegram/telegram-service.js";

const GROUP = "-1001234567890";
const link = (topic: string, group = GROUP) => topicLink(group, topic);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-topics-"));
  const { db, close } = openDb(path.join(dir, "panel.sqlite"));
  const patches: Record<string, unknown>[] = [];
  const cron: { id: string; patch: unknown }[] = [];
  const gateway = {
    generation: 1,
    status: { state: "connected" },
    waitForReconnect: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "config.get") return { hash: "h", config: { channels: { telegram: { groupAllowFrom: [] } } } };
      if (method === "config.patch") patches.push(JSON.parse(params.raw as string) as Record<string, unknown>);
      if (method === "cron.update") cron.push({ id: params.id as string, patch: params.patch });
      return { ok: true };
    },
  } as unknown as GatewayService;
  const row = { parentId: "main", displayName: "x", status: "ready" as const };
  db.insert(agents)
    .values([
      { ...row, id: "main", role: "main", parentId: null },
      { ...row, id: "accountant", role: "specialist" },
      { ...row, id: "social", role: "specialist" },
      { ...row, id: "team-dev", role: "team_member" },
    ])
    .run();
  db.insert(channelBindings).values({ id: "owner", agentId: "main", channel: "telegram", accountId: "default", peerKind: "direct", peerId: "42", topicId: null }).run();
  db.insert(schedules)
    .values([
      { id: "s1", agentId: "accountant", cron: "0 21 * * *", tz: "UTC", prompt: "траты", deliverTo: "telegram:42", openclawCronId: "job-1" },
      { id: "s2", agentId: "social", cron: "0 9 * * *", tz: "UTC", prompt: "идея", deliverTo: null, openclawCronId: "job-2" },
    ])
    .run();
  const telegram = new TelegramService(gateway, db, pino({ level: "silent" }));
  const cleanup = () => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, telegram, patches, cron, cleanup };
}

const topicsOf = (patch: Record<string, unknown>) =>
  (patch as { channels: { telegram: { groups: Record<string, { topics: Record<string, unknown> }> } } }).channels.telegram.groups[GROUP]!.topics;

describe("a topic per agent in the owner's group", () => {
  it("accepts only topic links", () => {
    expect(LinkAgentTopicsRequest.safeParse({ topics: [{ agentId: "accountant", link: "https://t.me/c/1234567890/5" }] }).success).toBe(true);
    expect(LinkAgentTopicsRequest.safeParse({ topics: [{ agentId: "accountant", link: "https://t.me/mygroup" }] }).success).toBe(false);
  });

  it("routes each topic to its agent, keeps other topics silent and moves Telegram reports into the topic", async () => {
    const { db, telegram, patches, cron, cleanup } = setup();
    try {
      const res = await telegram.linkAgentTopics([
        { agentId: "accountant", link: link("5") },
        { agentId: "main", link: link("1") },
      ]);
      expect(res).toEqual({
        chatId: GROUP,
        topics: [
          { agentId: "accountant", topicId: "5", link: link("5") },
          { agentId: "main", topicId: "1", link: link("1") },
        ],
      });
      const topics = topicsOf(patches[0]!);
      expect(topics["*"]).toEqual({ enabled: false });
      expect(topics["5"]).toEqual({ enabled: true, agentId: "accountant", requireMention: false });
      // Only the owner may talk in the group.
      expect((patches[0] as { channels: { telegram: { groupPolicy: string; groupAllowFrom: string[] } } }).channels.telegram).toMatchObject({ groupPolicy: "allowlist", groupAllowFrom: ["42"] });
      // The accountant's report (already going to Telegram) now lands in its topic; social's panel-only job stays.
      expect(cron).toEqual([{ id: "job-1", patch: { delivery: { mode: "announce", channel: "telegram", to: GROUP, threadId: "5", bestEffort: true } } }]);
      expect(db.select().from(schedules).where(eq(schedules.id, "s1")).get()!.deliverTo).toBe(`telegram:${GROUP}:5`);

      // Re-linking without the accountant: its topic is dropped and its report goes back to the owner's chat.
      await telegram.linkAgentTopics([{ agentId: "main", link: link("1") }]);
      expect(topicsOf(patches[1]!)["5"]).toBeNull();
      expect(cron[1]).toEqual({ id: "job-1", patch: { delivery: { mode: "announce", channel: "telegram", to: "42", bestEffort: true } } });

      // Deleting the last agent with a topic removes the group.
      const before = telegram.agentTopics();
      await telegram.forgetAgentTopic(before, "main");
      expect((patches[2] as { channels: { telegram: { groups: Record<string, unknown> } } }).channels.telegram.groups[GROUP]).toBeNull();
      expect(telegram.agentTopics()).toEqual({ chatId: null, topics: [] });
    } finally {
      cleanup();
    }
  });

  it("refuses links from two groups, one topic for two agents, and team agents", async () => {
    const { telegram, cleanup } = setup();
    try {
      await expect(telegram.linkAgentTopics([{ agentId: "accountant", link: link("5") }, { agentId: "social", link: link("6", "-1009999999999") }])).rejects.toThrow(/same group/);
      await expect(telegram.linkAgentTopics([{ agentId: "accountant", link: link("5") }, { agentId: "social", link: link("5") }])).rejects.toThrow(/one topic per agent/);
      await expect(telegram.linkAgentTopics([{ agentId: "team-dev", link: link("7") }])).rejects.toThrow(/team/);
      await expect(telegram.linkAgentTopics([{ agentId: "ghost", link: link("8") }])).rejects.toThrow(/unknown agent/);
    } finally {
      cleanup();
    }
  });
});
