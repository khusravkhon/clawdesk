import crypto from "node:crypto";
import { parseTopicLink, topicLink, type AgentTopicsDto, type ApproveTelegramResultDto, type TelegramPairingRequestDto, type TelegramStatusDto } from "@clawdesk/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agents, channelBindings, schedules, settings, teams } from "../db/schema.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";

// Telegram screen: one bot per install. The token is checked with Telegram's
// getMe, stored write-only in the Gateway secret store, and referenced from
// config; DMs use pairing so only the approved owner reaches the main agent.

const TOKEN_SECRET = "CLAWDESK_TELEGRAM_BOT_TOKEN";
const BOT_SETTING = "telegram.bot";
const OWNER_LABEL_SETTING = "telegram.ownerLabel";
/** The owner's group whose topics are personal agents' chats. */
const AGENTS_GROUP_SETTING = "telegram.agentsGroup";

type BotInfo = { id: number; username: string; name: string };
type TelegramConfig = { enabled?: boolean; botToken?: unknown; execApprovals?: { enabled?: boolean | string; approvers?: string[] } };
type RouteBinding = { type?: string; agentId: string; match?: { channel?: string; accountId?: string; peer?: unknown } };
type PairingList = {
  requests: { requestId: string; channel: string; accountId: string; senderId: string; senderLabel: string; createdAt: string; expiresAt: string }[];
};

export class TelegramError extends Error {
  constructor(
    readonly code: "invalid_token" | "telegram_unreachable" | "not_connected" | "no_owner" | "topic_links",
    message: string,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export class TelegramService {
  constructor(
    private readonly gateway: GatewayService,
    private readonly db: Db,
    private readonly logger: Logger,
    /** Injected for tests; Telegram Bot API base. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async status(): Promise<TelegramStatusDto> {
    const { config } = await getConfig<{ channels?: { telegram?: TelegramConfig } }>(this.gateway);
    const tg = config.channels?.telegram;
    const connected = !!tg?.botToken && tg.enabled !== false;
    let running = false;
    let lastError: string | null = null;
    if (connected) {
      const res = await this.gateway
        .request<{ channelAccounts?: Record<string, { running?: boolean; connected?: boolean; lastError?: string | null }[]> }>("channels.status", { channel: "telegram" })
        .catch(() => ({ channelAccounts: undefined }));
      const accounts = res.channelAccounts?.telegram ?? [];
      running = accounts.some((a) => a.running || a.connected);
      lastError = accounts.find((a) => a.lastError)?.lastError ?? null;
    }
    const owner = this.#owner();
    return {
      connected,
      running,
      bot: connected ? this.#bot() : null,
      owner: owner ? { id: owner.peerId!, label: this.#getSetting<string>(OWNER_LABEL_SETTING) } : null,
      approvals: connected && tg?.execApprovals?.enabled === true,
      lastError,
    };
  }

  /** Validates the token, stores it as a protected secret and turns the channel on (DMs need pairing). */
  async connect(token: string): Promise<TelegramStatusDto> {
    const bot = await this.#getMe(token);

    // Bundled but off by default; enabling may ask for a capability review and a restart.
    const enabled = await this.#enablePlugin();

    await this.gateway.request("secrets.store.set", { name: TOKEN_SECRET, value: token, kind: "secret", allowedHosts: ["api.telegram.org"] });

    const { config } = await getConfig<{ bindings?: RouteBinding[] }>(this.gateway);
    const bindings = config.bindings ?? [];
    // With explicit agent ownership every channel needs a route; Telegram DMs belong to the main agent.
    const hasRoute = bindings.some((b) => (b.type ?? "route") === "route" && b.match?.channel === "telegram" && !b.match.peer);
    const generation = this.gateway.generation;
    await this.#patchMaybeRestarting(
      {
        channels: {
          telegram: {
            enabled: true,
            botToken: { source: "store", provider: "default", id: TOKEN_SECRET },
            dmPolicy: "pairing",
            groupPolicy: "disabled",
          },
        },
        ...(hasRoute ? {} : { bindings: [...bindings, { agentId: "main", match: { channel: "telegram" } }] }),
      },
      generation,
    );
    if (enabled.restartRequired && this.gateway.generation === generation) await this.#restart();

    this.#setBot(bot);
    this.logger.info({ bot: bot.username }, "telegram bot connected");
    return this.status();
  }

  async disconnect(): Promise<void> {
    const generation = this.gateway.generation;
    await this.#patchMaybeRestarting({ channels: { telegram: { enabled: false } } }, generation);
    this.db.delete(channelBindings).where(eq(channelBindings.channel, "telegram")).run();
    this.logger.info("telegram disconnected");
  }

  async pairingRequests(): Promise<TelegramPairingRequestDto[]> {
    const res = await this.gateway.request<PairingList>("channels.pairing.list", { channel: "telegram" });
    return res.requests
      .filter((r) => r.channel === "telegram")
      .map(({ requestId, accountId, senderId, senderLabel, createdAt, expiresAt }) => ({ requestId, accountId, senderId, senderLabel, createdAt, expiresAt }));
  }

  /** Approves the owner, remembers their chat, and routes existing panel schedules to it. */
  async approve(requestId: string, accountId: string): Promise<ApproveTelegramResultDto> {
    const label = (await this.pairingRequests()).find((r) => r.requestId === requestId)?.senderLabel ?? null;
    const res = await this.gateway.request<{ senderId: string }>("channels.pairing.approve", {
      channel: "telegram",
      accountId,
      requestId,
      notify: true,
      bootstrapCommandOwner: true,
    });
    this.db.delete(channelBindings).where(and(eq(channelBindings.channel, "telegram"), eq(channelBindings.peerKind, "direct"))).run();
    this.db
      .insert(channelBindings)
      .values({ id: crypto.randomUUID(), agentId: "main", channel: "telegram", accountId, peerKind: "direct", peerId: res.senderId, topicId: null })
      .run();
    if (label) this.#putSetting(OWNER_LABEL_SETTING, label);
    const schedulesRouted = await this.routeSchedules(res.senderId);
    // Dangerous commands then reach the owner as Allow / Deny buttons, not only the panel's approvals screen.
    await this.setApprovals(true).catch((error: Error) => this.logger.warn({ err: error }, "could not turn on Telegram approvals"));
    this.logger.info({ schedulesRouted }, "telegram owner approved");
    return { ownerId: res.senderId, schedulesRouted };
  }

  /** Points panel schedules that are not delivered anywhere yet at the owner's chat. */
  async routeSchedules(ownerId: string): Promise<number> {
    const rows = this.db.select().from(schedules).where(isNull(schedules.deliverTo)).all();
    let routed = 0;
    for (const row of rows) {
      if (!row.openclawCronId) continue;
      await this.gateway.request("cron.update", { id: row.openclawCronId, patch: { delivery: telegramDelivery(ownerId) } });
      this.db.update(schedules).set({ deliverTo: `telegram:${ownerId}` }).where(eq(schedules.id, row.id)).run();
      routed++;
    }
    return routed;
  }

  /**
   * Approval requests (exec commands of any agent) as Allow / Deny buttons in the owner's private chat:
   * OpenClaw's native Telegram approvals, with the owner as the only approver. Applying it restarts the Gateway.
   */
  async setApprovals(enabled: boolean): Promise<TelegramStatusDto> {
    const owner = this.#owner();
    if (enabled && !owner?.peerId) throw new TelegramError("no_owner", "approve yourself in the bot first");
    const generation = this.gateway.generation;
    const execApprovals = enabled ? { enabled: true, approvers: [owner!.peerId!], target: "dm" } : { enabled: false };
    await this.#patchMaybeRestarting({ channels: { telegram: { execApprovals } } }, generation);
    if (this.gateway.generation === generation) await this.#restart("clawdesk: telegram approvals");
    this.logger.info({ enabled }, "telegram approvals changed");
    return this.status();
  }

  /**
   * A Telegram group with topics (a team's, or the owner's group for personal agents): each listed topic is
   * answered by one agent, every other topic is ignored ("*" disabled), and only the owner can talk there
   * (groupPolicy allowlist). `dropTopics`: topics linked before that no longer have an agent. Restarts the Gateway.
   */
  async linkGroup(chatId: string, topics: { topicId: string; agentId: string }[], dropTopics: string[] = []): Promise<void> {
    const owner = this.#owner();
    if (!owner?.peerId) throw new TelegramError("no_owner", "approve yourself in the bot first");
    const { config } = await getConfig<{ channels?: { telegram?: { groupAllowFrom?: string[] } } }>(this.gateway);
    const allowFrom = [...new Set([...(config.channels?.telegram?.groupAllowFrom ?? []), owner.peerId])];
    const generation = this.gateway.generation;
    await this.#patchMaybeRestarting(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: allowFrom,
            groups: {
              [chatId]: {
                enabled: true,
                requireMention: false,
                topics: {
                  // Topics without an agent stay silent (no fallback to the main agent).
                  "*": { enabled: false },
                  ...Object.fromEntries(dropTopics.map((id) => [id, null])),
                  ...Object.fromEntries(topics.map((t) => [t.topicId, { enabled: true, agentId: t.agentId, requireMention: false }])),
                },
              },
            },
          },
        },
      },
      generation,
    );
    if (this.gateway.generation === generation) await this.#restart("clawdesk: telegram group topics");
    this.logger.info({ chatId, topics: topics.length }, "telegram group linked");
  }

  // --- The owner's group for personal agents: a topic per agent (the main agent too) ---

  /** Topics of agents that are not in a team (teams keep their own group). */
  agentTopics(): AgentTopicsDto {
    const chatId = this.#getSetting<string>(AGENTS_GROUP_SETTING);
    if (!chatId) return { chatId: null, topics: [] };
    const rows = this.db
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.channel, "telegram"), eq(channelBindings.peerKind, "group"), eq(channelBindings.peerId, chatId)))
      .all()
      .filter((r) => r.topicId);
    return { chatId, topics: rows.map((r) => ({ agentId: r.agentId, topicId: r.topicId!, link: topicLink(chatId, r.topicId!) })) };
  }

  /**
   * Links topics of one group to agents (a topic per agent). Agents that lose their topic, and the agents'
   * scheduled reports, go back to the owner's private chat. Restarts the Gateway.
   */
  async linkAgentTopics(links: { agentId: string; link: string }[]): Promise<AgentTopicsDto> {
    const parsed = links.map((l) => ({ agentId: l.agentId, ...parseTopicLink(l.link)! }));
    const chatIds = new Set(parsed.map((p) => p.chatId));
    if (chatIds.size !== 1) throw new TelegramError("topic_links", "all topics must be in the same group");
    const chatId = [...chatIds][0]!;
    if (new Set(parsed.map((p) => p.topicId)).size !== parsed.length) throw new TelegramError("topic_links", "one topic per agent");
    if (new Set(parsed.map((p) => p.agentId)).size !== parsed.length) throw new TelegramError("topic_links", "one topic per agent");
    if (this.db.select().from(teams).where(eq(teams.telegramGroupId, chatId)).get()) throw new TelegramError("topic_links", "this group belongs to a project team");
    const known = new Map(this.db.select({ id: agents.id, role: agents.role }).from(agents).all().map((a) => [a.id, a.role]));
    for (const p of parsed) {
      const role = p.agentId === "main" ? "main" : known.get(p.agentId);
      if (!role) throw new TelegramError("topic_links", `unknown agent ${p.agentId}`);
      if (role === "team_member") throw new TelegramError("topic_links", "team agents are linked on the team's screen");
    }

    const before = this.agentTopics();
    if (before.chatId && before.chatId !== chatId) await this.unlinkGroup(before.chatId);
    const dropTopics = before.chatId === chatId ? before.topics.map((t) => t.topicId).filter((id) => !parsed.some((p) => p.topicId === id)) : [];
    await this.linkGroup(chatId, parsed, dropTopics);

    if (before.chatId) this.db.delete(channelBindings).where(and(eq(channelBindings.peerKind, "group"), eq(channelBindings.peerId, before.chatId))).run();
    for (const p of parsed) {
      this.db.insert(channelBindings).values({ id: crypto.randomUUID(), agentId: p.agentId, channel: "telegram", accountId: null, peerKind: "group", peerId: chatId, topicId: p.topicId }).run();
    }
    this.#putSetting(AGENTS_GROUP_SETTING, chatId);
    await this.#routeAgentSchedules(chatId, parsed, before.topics.map((t) => t.agentId));
    this.logger.info({ chatId, topics: parsed.length }, "agent topics linked");
    return this.agentTopics();
  }

  /** Agents leave the group: their chat is the bot's private chat again (through the main agent). */
  async unlinkAgentTopics(): Promise<AgentTopicsDto> {
    const before = this.agentTopics();
    if (!before.chatId) return before;
    await this.unlinkGroup(before.chatId);
    this.db.delete(channelBindings).where(and(eq(channelBindings.peerKind, "group"), eq(channelBindings.peerId, before.chatId))).run();
    this.db.delete(settings).where(eq(settings.key, AGENTS_GROUP_SETTING)).run();
    await this.#routeAgentSchedules(before.chatId, [], before.topics.map((t) => t.agentId));
    return this.agentTopics();
  }

  /**
   * After an agent is deleted: its topic goes silent. `before` is read before the deletion, because the
   * agent's binding rows go with it.
   */
  async forgetAgentTopic(before: AgentTopicsDto, agentId: string): Promise<void> {
    const gone = before.topics.find((t) => t.agentId === agentId);
    if (!before.chatId || !gone) return;
    const remaining = before.topics.filter((t) => t.agentId !== agentId);
    if (remaining.length) {
      await this.linkGroup(before.chatId, remaining, [gone.topicId]);
    } else {
      await this.unlinkGroup(before.chatId);
      this.db.delete(settings).where(eq(settings.key, AGENTS_GROUP_SETTING)).run();
    }
  }

  /** Scheduled reports of agents with a topic go to it; those that lost theirs go to the owner's chat. */
  async #routeAgentSchedules(chatId: string, topics: { agentId: string; topicId: string }[], previous: string[]): Promise<void> {
    const owner = this.#owner();
    const affected = new Set([...topics.map((t) => t.agentId), ...previous]);
    for (const row of this.db.select().from(schedules).all()) {
      if (!row.openclawCronId || !affected.has(row.agentId)) continue;
      const topic = topics.find((t) => t.agentId === row.agentId);
      // Only schedules already delivered to Telegram (the owner's chat or a topic) move; the rest stay in the panel.
      if (!row.deliverTo?.startsWith("telegram:")) continue;
      const delivery = topic
        ? { mode: "announce" as const, channel: "telegram", to: chatId, threadId: topic.topicId, bestEffort: true }
        : owner?.peerId
          ? telegramDelivery(owner.peerId)
          : null;
      if (!delivery) continue;
      await this.gateway.request("cron.update", { id: row.openclawCronId, patch: { delivery } });
      const deliverTo = topic ? `telegram:${chatId}:${topic.topicId}` : `telegram:${owner!.peerId}`;
      this.db.update(schedules).set({ deliverTo }).where(eq(schedules.id, row.id)).run();
    }
  }

  /** Removes a team's group (its agents are gone or the team is unlinked). */
  async unlinkGroup(chatId: string): Promise<void> {
    const generation = this.gateway.generation;
    await this.#patchMaybeRestarting({ channels: { telegram: { groups: { [chatId]: null } } } }, generation);
    if (this.gateway.generation === generation) await this.#restart("clawdesk: team telegram group removed");
  }

  /** The owner approved themselves in the bot, so the panel can write to them. */
  hasOwner(): boolean {
    return !!this.#owner()?.peerId;
  }

  async sendToOwner(text: string): Promise<void> {
    const owner = this.#owner();
    if (!owner?.peerId) throw new TelegramError("no_owner", "approve yourself in the bot first");
    await this.gateway.request("send", { channel: "telegram", to: owner.peerId, message: text, idempotencyKey: crypto.randomUUID() });
  }

  /** Delivery target for cron jobs, or null when no owner is approved yet. */
  ownerDelivery(): ReturnType<typeof telegramDelivery> | null {
    const owner = this.#owner();
    return owner?.peerId ? telegramDelivery(owner.peerId) : null;
  }

  async #getMe(token: string): Promise<BotInfo> {
    let body: { ok?: boolean; result?: { id: number; username?: string; first_name?: string }; description?: string };
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(15_000) });
      body = (await res.json()) as typeof body;
    } catch {
      throw new TelegramError("telegram_unreachable", "Telegram did not answer; check the server's internet access");
    }
    if (!body.ok || !body.result?.username) throw new TelegramError("invalid_token", "Telegram rejected this token");
    return { id: body.result.id, username: body.result.username, name: body.result.first_name ?? body.result.username };
  }

  async #enablePlugin(): Promise<{ restartRequired: boolean }> {
    try {
      return await this.gateway.request<{ restartRequired: boolean }>("plugins.setEnabled", { pluginId: "telegram", enabled: true });
    } catch (error) {
      const reviewToken = (error as { details?: { reviewToken?: unknown } }).details?.reviewToken;
      if (typeof reviewToken !== "string") throw error;
      // Bundled OpenClaw channel plugin, enabled because the person connects a bot in the panel.
      return this.gateway.request<{ restartRequired: boolean }>("plugins.setEnabled", { pluginId: "telegram", enabled: true, acknowledgeCapabilities: { reviewToken } });
    }
  }

  /** Channel changes may need a Gateway restart; config.patch then answers UNAVAILABLE or the socket drops. */
  async #patchMaybeRestarting(patch: Record<string, unknown>, generation: number): Promise<void> {
    try {
      await patchConfig(this.gateway, patch, { note: "clawdesk: telegram" });
    } catch (error) {
      const code = (error as { gatewayCode?: string }).gatewayCode;
      if (code !== "UNAVAILABLE" && this.gateway.status.state === "connected") throw error;
      this.logger.info("gateway restarting to apply telegram config");
      await this.gateway.waitForReconnect(generation);
    }
  }

  async #restart(reason = "clawdesk: telegram plugin enabled"): Promise<void> {
    const generation = this.gateway.generation;
    await this.gateway.request("gateway.restart.request", { reason }).catch(() => undefined);
    await this.gateway.waitForReconnect(generation);
  }

  #owner() {
    return this.db
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.channel, "telegram"), eq(channelBindings.peerKind, "direct")))
      .get();
  }

  #bot(): BotInfo | null {
    return this.#getSetting<BotInfo>(BOT_SETTING);
  }

  #setBot(bot: BotInfo): void {
    this.#putSetting(BOT_SETTING, bot);
  }

  #getSetting<T>(key: string): T | null {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return (row?.value as T | undefined) ?? null;
  }

  #putSetting(key: string, value: unknown): void {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
      .run();
  }
}

export function telegramDelivery(ownerId: string) {
  return { mode: "announce" as const, channel: "telegram", to: ownerId, bestEffort: true };
}
