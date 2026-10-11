import crypto from "node:crypto";
import type { ApproveTelegramResultDto, TelegramPairingRequestDto, TelegramStatusDto } from "@clawdesk/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { channelBindings, schedules, settings } from "../db/schema.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";

// Telegram screen: one bot per install. The token is checked with Telegram's
// getMe, stored write-only in the Gateway secret store, and referenced from
// config; DMs use pairing so only the approved owner reaches the main agent.

const TOKEN_SECRET = "CLAWDESK_TELEGRAM_BOT_TOKEN";
const BOT_SETTING = "telegram.bot";
const OWNER_LABEL_SETTING = "telegram.ownerLabel";

type BotInfo = { id: number; username: string; name: string };
type TelegramConfig = { enabled?: boolean; botToken?: unknown };
type RouteBinding = { type?: string; agentId: string; match?: { channel?: string; accountId?: string; peer?: unknown } };
type PairingList = {
  requests: { requestId: string; channel: string; accountId: string; senderId: string; senderLabel: string; createdAt: string; expiresAt: string }[];
};

export class TelegramError extends Error {
  constructor(
    readonly code: "invalid_token" | "telegram_unreachable" | "not_connected" | "no_owner",
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

  async sendTest(text: string): Promise<void> {
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

  async #restart(): Promise<void> {
    const generation = this.gateway.generation;
    await this.gateway.request("gateway.restart.request", { reason: "clawdesk: telegram plugin enabled" }).catch(() => undefined);
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
