import crypto from "node:crypto";
import { parseTopicLink, topicLink, TELEGRAM_AUDIO_PROVIDERS, type TelegramAudioProvider, type AgentTopicsDto, type ApproveTelegramResultDto, type TelegramBotDto, type TelegramPairingRequestDto, type TelegramStatusDto } from "@clawdesk/shared";
import { and, eq, isNull, or } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agents, channelBindings, schedules, settings, teams } from "../db/schema.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { BridgeError, type BridgeClient } from "../gateway/bridge-client.js";
import { cloudAudioPatch, telegramMediaPatch, type MediaConfig } from "./media-config.js";
import { telegramReplacePaths } from "./config-replace-paths.js";

// Telegram screen: named bots routed to agents. The token is checked with Telegram's
// getMe, stored write-only in the Gateway secret store, and referenced from
// config; DMs use pairing so only the approved owner reaches the selected agent.

const TOKEN_SECRET = "CLAWDESK_TELEGRAM_BOT_TOKEN";
const BOT_SETTING = "telegram.bot";
const OWNER_LABEL_SETTING = "telegram.ownerLabel";
/** The owner's group whose topics are personal agents' chats. */
const AGENTS_GROUP_SETTING = "telegram.agentsGroup";

type BotInfo = { id: number; username: string; name: string };
type TelegramConfig = { enabled?: boolean; botToken?: unknown; accounts?: Record<string, TelegramConfig>; execApprovals?: { enabled?: boolean | string; approvers?: string[] }; [key: string]: unknown };
type TelegramRoot = { channels?: { telegram?: TelegramConfig }; bindings?: RouteBinding[]; commands?: { ownerAllowFrom?: string[] } };
type RouteBinding = { type?: string; agentId: string; match?: { channel?: string; accountId?: string; peer?: unknown } };
type PairingList = {
  requests: { requestId: string; channel: string; accountId: string; senderId: string; senderLabel: string; createdAt: string; expiresAt: string }[];
};

export class TelegramError extends Error {
  constructor(
    readonly code: "invalid_token" | "telegram_unreachable" | "not_connected" | "no_owner" | "topic_links" | "unknown_agent" | "unknown_account" | "duplicate_bot" | "no_audio_key" | "audio_setup_failed" | "audio_key_rejected" | "audio_key_provider_mismatch" | "audio_unreachable" | "audio_rate_limit" | "audio_model_unavailable" | "audio_setup_busy",
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
    private readonly bridge?: Pick<BridgeClient, "telegramApproved"> & Partial<Pick<BridgeClient, "telegramAudioStatus" | "telegramAudioKey">>,
    private readonly ensureAudioProvider?: (provider: TelegramAudioProvider) => Promise<void>,
  ) {}

  async ensureMedia(): Promise<void> {
    const { config } = await getConfig<TelegramRoot & MediaConfig>(this.gateway);
    if (!config.channels?.telegram || config.channels.telegram.enabled === false) return;
    const patch = telegramMediaPatch(config);
    if (patch) await this.#patchMaybeRestarting(patch, this.gateway.generation);
  }

  async voiceStatus() {
    const { config } = await getConfig<MediaConfig>(this.gateway);
    const state = await this.bridge?.telegramAudioStatus?.();
    const entries = Object.entries(TELEGRAM_AUDIO_PROVIDERS) as [TelegramAudioProvider, typeof TELEGRAM_AUDIO_PROVIDERS[TelegramAudioProvider]][];
    const selected = config.tools?.media?.models?.find((model) => entries.some(([, item]) => item.profile === model.profile));
    const provider = entries.find(([, item]) => item.profile === selected?.profile)?.[0] ?? "openai";
    const configuredProviders = entries.filter(([id]) => state?.providers?.[id] ?? (id === "openai" && state?.configured)).map(([id]) => id);
    const configured = configuredProviders.includes(provider);
    return { configured, configuredProviders, provider, enabled: configured && config.tools?.media?.audio?.enabled === true && !!selected, model: typeof selected?.model === "string" ? selected.model : TELEGRAM_AUDIO_PROVIDERS[provider].models[0], maxAudioMb: 20 };
  }

  async saveVoiceKey(apiKey: string, provider: TelegramAudioProvider = "openai", model: string = TELEGRAM_AUDIO_PROVIDERS[provider].models[0]) {
    if (!this.bridge?.telegramAudioKey) throw new TelegramError("not_connected", "the audio setup bridge is unavailable");
    try {
      await this.ensureAudioProvider?.(provider);
      await this.bridge.telegramAudioKey(apiKey, provider, model);
    }
    catch (error) {
      if (error instanceof BridgeError) throw new TelegramError(error.code.startsWith("audio_") ? error.code as TelegramError["code"] : "audio_setup_failed", "could not configure the selected speech recognition provider");
      throw new TelegramError("audio_setup_failed", "could not prepare the selected audio provider");
    }
    const { config } = await getConfig<MediaConfig>(this.gateway);
    await this.#patchMaybeRestarting(cloudAudioPatch(config, true, provider, model), this.gateway.generation);
    return this.voiceStatus();
  }

  async setVoice(enabled: boolean, provider?: TelegramAudioProvider, model?: string) {
    const selected = await this.voiceStatus();
    const nextProvider = provider ?? selected.provider;
    const nextModel = model ?? (nextProvider === selected.provider ? selected.model : TELEGRAM_AUDIO_PROVIDERS[nextProvider].models[0]);
    if (!(TELEGRAM_AUDIO_PROVIDERS[nextProvider].models as readonly string[]).includes(nextModel)) throw new TelegramError("audio_model_unavailable", "unsupported transcription model");
    if (enabled && !selected.configuredProviders.includes(nextProvider)) throw new TelegramError("no_audio_key", "add a separate API key for the selected speech recognition provider first");
    if (enabled) await this.ensureAudioProvider?.(nextProvider);
    const { config } = await getConfig<MediaConfig>(this.gateway);
    await this.#patchMaybeRestarting(cloudAudioPatch(config, enabled, nextProvider, nextModel), this.gateway.generation);
    return this.voiceStatus();
  }

  async status(accountId = "default"): Promise<TelegramStatusDto> {
    const { config } = await getConfig<TelegramRoot>(this.gateway);
    const root = config.channels?.telegram;
    const tg = accountId === "default" ? (root?.accounts?.default ?? root) : root?.accounts?.[accountId];
    const token = tg?.botToken ?? (accountId === "default" ? root?.botToken : undefined);
    const connected = !!token && tg?.enabled !== false && root?.enabled !== false;
    let running = false;
    let lastError: string | null = null;
    if (connected) {
      const res = await this.gateway
        .request<{ channelAccounts?: Record<string, { running?: boolean; connected?: boolean; lastError?: string | null }[]> }>("channels.status", { channel: "telegram" })
        .catch(() => ({ channelAccounts: undefined }));
      const accounts = (res.channelAccounts?.telegram ?? []).filter((a) => (a as { accountId?: string }).accountId === accountId);
      running = accounts.some((a) => a.running || a.connected);
      lastError = accounts.find((a) => a.lastError)?.lastError ?? null;
    }
    let owner = this.#owner(accountId);
    if (connected && !owner && this.bridge) {
      const approved = await this.bridge.telegramApproved(accountId).catch(() => ({ senderIds: [] }));
      const candidates = approved.senderIds.filter((id) => config.commands?.ownerAllowFrom?.includes(`telegram:${id}`));
      if (candidates.length === 1) {
        await this.#ensureMainMetadata();
        if (!this.#owner(accountId)) this.db.insert(channelBindings).values({ id: crypto.randomUUID(), agentId: "main", channel: "telegram", accountId, peerKind: "direct", peerId: candidates[0]!, topicId: null }).run();
      }
      owner = this.#owner(accountId);
    }
    return {
      connected,
      running,
      bot: connected ? this.#bot(accountId) : null,
      owner: owner ? { id: owner.peerId!, label: this.#getSetting<string>(this.#key(OWNER_LABEL_SETTING, accountId)) } : null,
      approvals: connected && tg?.execApprovals?.enabled === true,
      lastError,
    };
  }

  /** Validates the token, stores it as a protected secret and turns the channel on (DMs need pairing). */
  async connect(token: string, agentId = "main", accountId = "default"): Promise<TelegramStatusDto> {
    this.#assertAgent(agentId);
    const bot = await this.#getMe(token);
    const existing = await this.accounts();
    if (existing.some((a) => a.accountId !== accountId && a.bot?.id === bot.id)) throw new TelegramError("duplicate_bot", "this bot is already connected");

    // Bundled but off by default; enabling may ask for a capability review and a restart.
    const enabled = await this.#enablePlugin();

    // Secret names must be uppercase and bounded; hash the exact ID to avoid normalization collisions.
    const secret = accountId === "default" ? TOKEN_SECRET : `${TOKEN_SECRET}_${crypto.createHash("sha256").update(accountId).digest("hex").toUpperCase()}`;
    await this.gateway.request("secrets.store.set", { name: secret, value: token, kind: "secret", allowedHosts: ["api.telegram.org"] });

    const { config } = await getConfig<TelegramRoot>(this.gateway);
    const bindings = config.bindings ?? [];
    // With explicit agent ownership every bot needs its own account route.
    const migrated = this.#migrateDefault(config.channels?.telegram);
    const generation = this.gateway.generation;
    await this.#patchMaybeRestarting(
      {
        channels: {
          telegram: accountId === "default" && !config.channels?.telegram?.accounts ? {
            enabled: true,
            botToken: { source: "store", provider: "default", id: secret },
            dmPolicy: "pairing",
            groupPolicy: "disabled",
          } : {
            enabled: true,
            ...migrated,
            accounts: {
              ...(migrated.accounts as object ?? {}),
              [accountId]: { enabled: true, botToken: { source: "store", provider: "default", id: secret }, dmPolicy: "pairing", groupPolicy: "disabled", groups: { "*": { enabled: false } } },
            },
          },
        },
        bindings: [...this.#withoutBotRoute(bindings, accountId), { agentId, match: { channel: "telegram", accountId } }],
      },
      generation,
    );
    if (enabled.restartRequired && this.gateway.generation === generation) await this.#restart();

    this.#putSetting(this.#key(BOT_SETTING, accountId), bot);
    await this.ensureMedia();
    this.logger.info({ bot: bot.username }, "telegram bot connected");
    return this.status(accountId);
  }

  async accounts(): Promise<TelegramBotDto[]> {
    const { config } = await getConfig<TelegramRoot>(this.gateway);
    const tg = config.channels?.telegram;
    const ids = new Set(Object.keys(tg?.accounts ?? {}));
    if (tg?.botToken) ids.add("default");
    return Promise.all([...ids].sort().map(async (accountId) => ({ ...(await this.status(accountId)), bot: this.#bot(accountId), accountId, agentId: this.#agent(config, accountId) })));
  }

  /** Read-only daily health: no owner recovery, and no failed status request disguised as a stopped bot. */
  async connectionStatus(): Promise<{ accountId: string; running: boolean }[]> {
    const { config } = await getConfig<TelegramRoot>(this.gateway);
    const tg = config.channels?.telegram;
    const ids = new Set(Object.keys(tg?.accounts ?? {}));
    if (tg?.botToken) ids.add("default");
    if (!ids.size) return [];
    const res = await this.gateway.request<{ channelAccounts?: { telegram?: { accountId?: string; running?: boolean; connected?: boolean }[] } }>("channels.status", { channel: "telegram" });
    return [...ids].sort().map((accountId) => {
      const account = res.channelAccounts?.telegram?.find((a) => a.accountId === accountId);
      if (!account || (typeof account.running !== "boolean" && typeof account.connected !== "boolean")) throw new Error("telegram_status_unknown");
      return { accountId, running: account.running === true || account.connected === true };
    });
  }

  async addBot(token: string, agentId: string): Promise<TelegramBotDto> {
    const accountId = (await this.accounts()).length ? `bot-${crypto.randomUUID().slice(0, 12)}` : "default";
    await this.connect(token, agentId, accountId);
    return (await this.accounts()).find((a) => a.accountId === accountId)!;
  }

  async assignAgent(accountId: string, agentId: string): Promise<TelegramBotDto> {
    this.#assertAgent(agentId);
    if (!(await this.accounts()).some((a) => a.accountId === accountId)) throw new TelegramError("unknown_account", "unknown Telegram bot");
    const { config } = await getConfig<TelegramRoot>(this.gateway);
    await this.#patchMaybeRestarting({ bindings: [...this.#withoutBotRoute(config.bindings ?? [], accountId), { agentId, match: { channel: "telegram", accountId } }] }, this.gateway.generation);
    return (await this.accounts()).find((a) => a.accountId === accountId)!;
  }

  async disconnect(accountId = "default"): Promise<void> {
    const generation = this.gateway.generation;
    const { config } = await getConfig<TelegramRoot>(this.gateway);
    await this.#patchMaybeRestarting({ channels: { telegram: this.#accountPatch(config, accountId, { enabled: false, groups: null }) }, bindings: this.#withoutBotRoute(config.bindings ?? [], accountId) }, generation);
    this.db.delete(channelBindings).where(and(eq(channelBindings.channel, "telegram"), this.#accountWhere(accountId))).run();
    this.db.delete(settings).where(eq(settings.key, this.#key(AGENTS_GROUP_SETTING, accountId))).run();
    this.logger.info("telegram disconnected");
  }

  async pairingRequests(accountId = "default"): Promise<TelegramPairingRequestDto[]> {
    const res = await this.gateway.request<PairingList>("channels.pairing.list", { channel: "telegram" });
    return res.requests
      .filter((r) => r.channel === "telegram" && r.accountId === accountId)
      .map(({ requestId, accountId, senderId, senderLabel, createdAt, expiresAt }) => ({ requestId, accountId, senderId, senderLabel, createdAt, expiresAt }));
  }

  /** Approves the owner, remembers their chat, and routes existing panel schedules to it. */
  async approve(requestId: string, accountId: string): Promise<ApproveTelegramResultDto> {
    const request = (await this.pairingRequests(accountId)).find((r) => r.requestId === requestId);
    if (!request) throw new TelegramError("no_owner", "this pairing request has expired; message the bot again");
    const label = request.senderLabel;
    await this.#ensureMainMetadata();
    const res = await this.gateway.request<{ senderId: string }>("channels.pairing.approve", {
      channel: "telegram",
      accountId,
      requestId,
      notify: true,
      bootstrapCommandOwner: true,
    });
    this.db.delete(channelBindings).where(and(eq(channelBindings.channel, "telegram"), this.#accountWhere(accountId), eq(channelBindings.peerKind, "direct"))).run();
    this.db
      .insert(channelBindings)
      .values({ id: crypto.randomUUID(), agentId: "main", channel: "telegram", accountId, peerKind: "direct", peerId: res.senderId, topicId: null })
      .run();
    if (label) this.#putSetting(this.#key(OWNER_LABEL_SETTING, accountId), label);
    const schedulesRouted = accountId === "default" ? await this.routeSchedules(res.senderId) : 0;
    // Dangerous commands then reach the owner as Allow / Deny buttons, not only the panel's approvals screen.
    await this.setApprovals(true, accountId).catch((error: Error) => this.logger.warn({ err: error }, "could not turn on Telegram approvals"));
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
  async setApprovals(enabled: boolean, accountId = "default"): Promise<TelegramStatusDto> {
    const owner = this.#owner(accountId);
    if (enabled && !owner?.peerId) throw new TelegramError("no_owner", "approve yourself in the bot first");
    const generation = this.gateway.generation;
    const execApprovals = enabled ? { enabled: true, approvers: [owner!.peerId!], target: "dm" } : { enabled: false };
    const { config } = await getConfig<TelegramRoot>(this.gateway);
    await this.#patchMaybeRestarting({ channels: { telegram: this.#accountPatch(config, accountId, { execApprovals }) } }, generation);
    if (this.gateway.generation === generation) await this.#restart("clawdesk: telegram approvals");
    this.logger.info({ enabled }, "telegram approvals changed");
    return this.status(accountId);
  }

  /**
   * A Telegram group with topics (a team's, or the owner's group for personal agents): each listed topic is
   * answered by one agent, every other topic is ignored ("*" disabled), and only the owner can talk there
   * (groupPolicy allowlist). `dropTopics`: topics linked before that no longer have an agent. Restarts the Gateway.
   */
  async linkGroup(chatId: string, topics: { topicId: string; agentId: string }[], dropTopics: string[] = [], accountId = "default"): Promise<void> {
    const owner = this.#owner(accountId);
    if (!owner?.peerId) throw new TelegramError("no_owner", "approve yourself in the bot first");
    const { config } = await getConfig<TelegramRoot>(this.gateway);
    const allowFrom = [owner.peerId];
    const generation = this.gateway.generation;
    await this.#patchMaybeRestarting(
      {
        channels: {
          telegram: this.#accountPatch(config, accountId, {
            groupPolicy: "allowlist",
            groupAllowFrom: allowFrom,
            groups: {
              "*": { enabled: false },
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
          }),
        },
      },
      generation,
    );
    if (this.gateway.generation === generation) await this.#restart("clawdesk: telegram group topics");
    this.logger.info({ chatId, topics: topics.length }, "telegram group linked");
  }

  // --- The owner's group for personal agents: a topic per agent (the main agent too) ---

  /** Topics of agents that are not in a team (teams keep their own group). */
  agentTopics(accountId = "default"): AgentTopicsDto {
    const chatId = this.#getSetting<string>(this.#key(AGENTS_GROUP_SETTING, accountId));
    if (!chatId) return { chatId: null, topics: [] };
    const rows = this.db
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.channel, "telegram"), this.#accountWhere(accountId), eq(channelBindings.peerKind, "group"), eq(channelBindings.peerId, chatId)))
      .all()
      .filter((r) => r.topicId);
    return { chatId, topics: rows.map((r) => ({ agentId: r.agentId, topicId: r.topicId!, link: topicLink(chatId, r.topicId!) })) };
  }

  /**
   * Links topics of one group to agents (a topic per agent). Agents that lose their topic, and the agents'
   * scheduled reports, go back to the owner's private chat. Restarts the Gateway.
   */
  async linkAgentTopics(links: { agentId: string; link: string }[], accountId = "default"): Promise<AgentTopicsDto> {
    if (links.some((l) => !parseTopicLink(l.link))) throw new TelegramError("topic_links", "invalid Telegram topic link");
    const parsed = links.map((l) => ({ agentId: l.agentId, ...parseTopicLink(l.link)! }));
    const chatIds = new Set(parsed.map((p) => p.chatId));
    if (chatIds.size !== 1) throw new TelegramError("topic_links", "all topics must be in the same group");
    const chatId = [...chatIds][0]!;
    if (new Set(parsed.map((p) => p.topicId)).size !== parsed.length) throw new TelegramError("topic_links", "one topic per agent");
    if (new Set(parsed.map((p) => p.agentId)).size !== parsed.length) throw new TelegramError("topic_links", "one topic per agent");
    if (this.db.select().from(teams).where(eq(teams.telegramGroupId, chatId)).get()) throw new TelegramError("topic_links", "this group belongs to a project team");
    const occupied = this.db.select().from(channelBindings).where(and(eq(channelBindings.channel, "telegram"), eq(channelBindings.peerKind, "group"), eq(channelBindings.peerId, chatId))).all();
    if (occupied.some((r) => (r.accountId ?? "default") !== accountId && parsed.some((p) => p.topicId === r.topicId))) {
      throw new TelegramError("topic_links", "this topic is already assigned to another bot; unlink it there first");
    }
    const known = new Map(this.db.select({ id: agents.id, role: agents.role }).from(agents).all().map((a) => [a.id, a.role]));
    for (const p of parsed) {
      const role = p.agentId === "main" ? "main" : known.get(p.agentId);
      if (!role) throw new TelegramError("topic_links", `unknown agent ${p.agentId}`);
      if (role === "team_member") throw new TelegramError("topic_links", "team agents are linked on the team's screen");
    }

    const before = this.agentTopics(accountId);
    if (before.chatId && before.chatId !== chatId) await this.unlinkGroup(before.chatId, accountId);
    const dropTopics = before.chatId === chatId ? before.topics.map((t) => t.topicId).filter((id) => !parsed.some((p) => p.topicId === id)) : [];
    await this.linkGroup(chatId, parsed, dropTopics, accountId);

    if (before.chatId) this.db.delete(channelBindings).where(and(eq(channelBindings.channel, "telegram"), this.#accountWhere(accountId), eq(channelBindings.peerKind, "group"), eq(channelBindings.peerId, before.chatId))).run();
    for (const p of parsed) {
      this.db.insert(channelBindings).values({ id: crypto.randomUUID(), agentId: p.agentId, channel: "telegram", accountId, peerKind: "group", peerId: chatId, topicId: p.topicId }).run();
    }
    this.#putSetting(this.#key(AGENTS_GROUP_SETTING, accountId), chatId);
    if (accountId === "default") await this.#routeAgentSchedules(chatId, parsed, before.topics.map((t) => t.agentId));
    this.logger.info({ chatId, topics: parsed.length }, "agent topics linked");
    return this.agentTopics(accountId);
  }

  /** Agents leave the group: their chat is the bot's private chat again (through the main agent). */
  async unlinkAgentTopics(accountId = "default"): Promise<AgentTopicsDto> {
    const before = this.agentTopics(accountId);
    if (!before.chatId) return before;
    await this.unlinkGroup(before.chatId, accountId);
    this.db.delete(channelBindings).where(and(eq(channelBindings.channel, "telegram"), this.#accountWhere(accountId), eq(channelBindings.peerKind, "group"), eq(channelBindings.peerId, before.chatId))).run();
    this.db.delete(settings).where(eq(settings.key, this.#key(AGENTS_GROUP_SETTING, accountId))).run();
    if (accountId === "default") await this.#routeAgentSchedules(before.chatId, [], before.topics.map((t) => t.agentId));
    return this.agentTopics(accountId);
  }

  /**
   * After an agent is deleted: its topic goes silent. `before` is read before the deletion, because the
   * agent's binding rows go with it.
   */
  async forgetAgentTopic(before: AgentTopicsDto, agentId: string, accountId = "default"): Promise<void> {
    const gone = before.topics.find((t) => t.agentId === agentId);
    if (!before.chatId || !gone) return;
    const remaining = before.topics.filter((t) => t.agentId !== agentId);
    if (remaining.length) {
      await this.linkGroup(before.chatId, remaining, [gone.topicId], accountId);
    } else {
      await this.unlinkGroup(before.chatId, accountId);
      this.db.delete(settings).where(eq(settings.key, this.#key(AGENTS_GROUP_SETTING, accountId))).run();
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
  async unlinkGroup(chatId: string, accountId = "default"): Promise<void> {
    const generation = this.gateway.generation;
    const { config } = await getConfig<TelegramRoot>(this.gateway);
    await this.#patchMaybeRestarting({ channels: { telegram: this.#accountPatch(config, accountId, { groups: { [chatId]: null } }) } }, generation);
    if (this.gateway.generation === generation) await this.#restart("clawdesk: team telegram group removed");
  }

  /** The owner approved themselves in the bot, so the panel can write to them. */
  hasOwner(): boolean {
    return !!this.#owner()?.peerId;
  }

  async sendToOwner(text: string, accountId = "default"): Promise<void> {
    const owner = this.#owner(accountId);
    if (!owner?.peerId) throw new TelegramError("no_owner", "approve yourself in the bot first");
    await this.gateway.request("send", { channel: "telegram", accountId, to: owner.peerId, message: text, idempotencyKey: crypto.randomUUID() });
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
      await patchConfig(this.gateway, patch, { note: "clawdesk: telegram", replacePaths: (current) => telegramReplacePaths(current, patch) });
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

  #owner(accountId = "default") {
    return this.db
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.channel, "telegram"), this.#accountWhere(accountId), eq(channelBindings.peerKind, "direct")))
      .get();
  }

  #bot(accountId = "default"): BotInfo | null {
    return this.#getSetting<BotInfo>(this.#key(BOT_SETTING, accountId));
  }

  #key(base: string, accountId: string): string {
    return accountId === "default" ? base : `${base}.${accountId}`;
  }

  #accountWhere(accountId: string) {
    return accountId === "default" ? or(eq(channelBindings.accountId, "default"), isNull(channelBindings.accountId))! : eq(channelBindings.accountId, accountId);
  }

  #assertAgent(agentId: string): void {
    if (agentId === "main") return;
    if (!this.db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).get()) throw new TelegramError("unknown_agent", "unknown agent");
  }

  async #ensureMainMetadata(): Promise<void> {
    if (this.db.select({ id: agents.id }).from(agents).where(eq(agents.id, "main")).get()) return;
    // The built-in main agent can exist only in OpenClaw; owner bindings still need a panel FK.
    const result = await this.gateway.request<{ agents?: { id: string; name?: string; identity?: { name?: string; emoji?: string } }[] }>("agents.list", {});
    const main = result.agents?.find((a) => a.id === "main");
    this.db.insert(agents).values({ id: "main", role: "main", displayName: main?.identity?.name ?? main?.name ?? "main", avatar: main?.identity?.emoji, status: "ready", sandbox: false }).onConflictDoNothing().run();
  }

  #agent(config: TelegramRoot, accountId: string): string {
    const routes = config.bindings ?? [];
    return routes.find((b) => (b.type ?? "route") === "route" && b.match?.channel === "telegram" && b.match.accountId === accountId && !b.match.peer)?.agentId
      ?? (accountId === "default" ? routes.find((b) => b.match?.channel === "telegram" && !b.match.accountId && !b.match.peer)?.agentId : undefined) ?? "main";
  }

  #withoutBotRoute(bindings: RouteBinding[], accountId: string): RouteBinding[] {
    return bindings.filter((b) => !((b.type ?? "route") === "route" && b.match?.channel === "telegram" && !b.match.peer && (b.match.accountId === accountId || (accountId === "default" && !b.match.accountId))))
      .map((b) => b.match?.channel === "telegram" && !b.match.accountId ? { ...b, match: { ...b.match, accountId: "default" } } : b);
  }

  #migrateDefault(tg: TelegramConfig | undefined): Record<string, unknown> {
    if (!tg?.botToken || tg.accounts?.default) return {};
    // Keep the root token at its original path: default inherits it, while redacted refs cannot move.
    const fields = ["dmPolicy", "groupPolicy", "groups", "allowFrom", "groupAllowFrom", "execApprovals"];
    const legacy = Object.fromEntries(fields.filter((key) => tg[key] !== undefined).map((key) => [key, tg[key]]));
    return { groups: null, allowFrom: null, groupAllowFrom: null, execApprovals: null, groupPolicy: "disabled", accounts: { default: { ...legacy, enabled: tg.enabled !== false } } };
  }

  #accountPatch(config: TelegramRoot, accountId: string, patch: Record<string, unknown>): Record<string, unknown> {
    return accountId === "default" && !config.channels?.telegram?.accounts?.default ? patch : { accounts: { [accountId]: patch } };
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
