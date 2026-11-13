import { GatewayClient, type DeviceIdentity, type GatewayClientRequestOptions } from "@openclaw/gateway-client";
import { readPairingConnectErrorDetails, readConnectErrorDetailCode } from "@openclaw/gateway-protocol/connect-error-details";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol/frame-guards";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import type { GatewayStatusDto } from "@clawdesk/shared";
import type { Logger } from "pino";
import { publicKeyRawBase64Url, signDevicePayload } from "./device-identity.js";
import type { DeviceTokenStore } from "./token-store.js";

/** Everything the panel does needs these; operator.admin alone would satisfy all, but we ask explicitly. */
export const PANEL_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

const ROLE = "operator";

export type GatewayServiceOptions = {
  url: string;
  sharedToken: string | undefined;
  identity: DeviceIdentity;
  tokens: DeviceTokenStore;
  clientVersion: string;
  logger: Logger;
  /** Long-running server only: re-try a paused, unapproved connection so an approval takes effect without a restart. */
  retryPairingEveryMs?: number;
};

type EventListener = (event: EventFrame) => void;

/**
 * The Gateway sends a tick every tickIntervalMs. Its client checks them only while no request is
 * pending, and the panel nearly always has one, so a frozen Gateway (open socket, no answers) stayed
 * "connected". The panel counts any event, ticks included, and gives up after two missed ticks.
 */
export function gatewayStale(now: number, lastFrameAt: number, tickIntervalMs: number): boolean {
  return now - lastFrameAt > Math.max(2 * tickIntervalMs, 20_000) + 5_000;
}

/**
 * The BFF's single connection to the OpenClaw Gateway. Owns reconnects, device
 * pairing state and event fan-out; the browser never talks to the Gateway.
 */
export class GatewayService {
  readonly #opts: GatewayServiceOptions;
  readonly #listeners = new Set<EventListener>();
  readonly #waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  #client: GatewayClient | null = null;
  #hello: HelloOk | null = null;
  /** Incremented on every hello-ok; lets callers wait for a reconnect after a Gateway restart. */
  #generation = 0;
  #retryTimer: NodeJS.Timeout | undefined;
  #watchTimer: NodeJS.Timeout | undefined;
  #lastFrameAt = 0;
  #tickIntervalMs = 30_000;
  #status: GatewayStatusDto = {
    state: "idle",
    serverVersion: null,
    protocol: null,
    scopes: [],
    hint: null,
    lastError: null,
  };

  constructor(opts: GatewayServiceOptions) {
    this.#opts = opts;
  }

  get status(): GatewayStatusDto {
    return this.#status;
  }

  get hello(): HelloOk | null {
    return this.#hello;
  }

  get deviceId(): string {
    return this.#opts.identity.deviceId;
  }

  get generation(): number {
    return this.#generation;
  }

  /** Resolves once a hello-ok newer than `sinceGeneration` arrives (i.e. after a Gateway restart). */
  async waitForReconnect(sinceGeneration: number, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#generation <= sinceGeneration) {
      if (Date.now() > deadline) throw new Error(`gateway did not reconnect within ${timeoutMs}ms (state: ${this.#status.state})`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  start(): void {
    if (this.#client) return;
    const { identity, tokens, logger } = this.#opts;
    this.#setStatus({ state: "connecting" });
    this.#client = new GatewayClient({
      url: this.#opts.url,
      token: this.#opts.sharedToken,
      clientName: "gateway-client",
      clientDisplayName: "ClawDesk panel",
      clientVersion: this.#opts.clientVersion,
      mode: "backend",
      platform: process.platform,
      role: ROLE,
      scopes: [...PANEL_OPERATOR_SCOPES],
      // Without these the Gateway has no reviewer for approvals (it denies at once: "no-route")
      // and keeps tool activity out of the agent events the chat shows.
      caps: ["approvals", "exec-approvals", "plugin-approvals", "tool-events"],
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      deviceIdentity: identity,
      hostDeps: {
        signDevicePayload,
        publicKeyRawBase64UrlFromPem: publicKeyRawBase64Url,
        loadDeviceAuthToken: ({ deviceId, role }) => tokens.load({ deviceId, role }),
        storeDeviceAuthToken: ({ deviceId, role, token, scopes }) => {
          tokens.store({ deviceId, role, token, scopes });
          logger.info({ role, scopes }, "gateway issued a device token; stored");
        },
        clearDeviceAuthToken: ({ deviceId, role }) => tokens.clear({ deviceId, role }),
        logDebug: (message) => logger.debug(this.#redact(message)),
        logError: (message) => logger.error(this.#redact(message)),
        redactForLog: (message) => this.#redact(message),
      },
      onHelloOk: (hello) => this.#onHello(hello),
      onConnectError: (error) => this.#onConnectError(error),
      onReconnectPaused: (info) => {
        logger.warn({ code: info.code, detailCode: info.detailCode }, "gateway reconnect paused");
        const state = info.detailCode === "PAIRING_REQUIRED" ? "pairing_required" : "auth_failed";
        this.#setStatus({ state, lastError: this.#redact(info.reason) });
        // The client will not retry on its own; waiting longer cannot succeed.
        this.#rejectWaiters(new Error(`gateway connection paused (${state})${this.#status.hint ? `: ${this.#status.hint}` : ""}`));
        if (state === "pairing_required" && this.#opts.retryPairingEveryMs) {
          clearTimeout(this.#retryTimer);
          this.#retryTimer = setTimeout(() => void this.#reconnectFresh(), this.#opts.retryPairingEveryMs);
        }
      },
      onClose: (code, reason) => {
        if (this.#client && this.#status.state === "connected") {
          logger.warn({ code, reason: this.#redact(reason) }, "gateway connection closed; reconnecting");
          this.#setStatus({ state: "disconnected" });
        }
      },
      onGap: (info) => logger.warn(info, "gateway event sequence gap"),
      onEvent: (event) => {
        this.#lastFrameAt = Date.now();
        for (const listener of this.#listeners) {
          try {
            listener(event);
          } catch (error) {
            logger.error({ err: error, event: event.event }, "gateway event listener failed");
          }
        }
      },
    });
    this.#client.start();
  }

  async stop(): Promise<void> {
    clearTimeout(this.#retryTimer);
    clearInterval(this.#watchTimer);
    this.#watchTimer = undefined;
    const client = this.#client;
    this.#client = null;
    // Set before closing so onClose does not report an intentional stop as a lost connection.
    this.#setStatus({ state: "idle" });
    if (client) await client.stopAndWait({ timeoutMs: 2_000 });
    this.#rejectWaiters(new Error("gateway service stopped"));
  }

  /** Replaces a paused client with a new one (keeps the pairing hint visible meanwhile). */
  async #reconnectFresh(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    this.#client = null;
    await client.stopAndWait({ timeoutMs: 2_000 }).catch(() => undefined);
    this.start();
  }

  /** Resolves once hello-ok has been received; rejects on timeout or terminal auth failure. */
  waitUntilConnected(timeoutMs = 20_000): Promise<void> {
    if (this.#status.state === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`gateway not connected after ${timeoutMs}ms (state: ${this.#status.state}${this.#status.hint ? `; ${this.#status.hint}` : ""})`));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  async request<T = Record<string, unknown>>(method: string, params: unknown = {}, opts?: GatewayClientRequestOptions): Promise<T> {
    if (!this.#client || this.#status.state !== "connected") {
      throw new GatewayUnavailableError(this.#status);
    }
    return this.#client.request<T>(method, params, opts);
  }

  onEvent(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #onHello(hello: HelloOk): void {
    this.#hello = hello;
    this.#generation++;
    this.#lastFrameAt = Date.now();
    this.#tickIntervalMs = typeof hello.policy?.tickIntervalMs === "number" && hello.policy.tickIntervalMs > 0 ? hello.policy.tickIntervalMs : 30_000;
    if (!this.#watchTimer) {
      this.#watchTimer = setInterval(() => this.#checkStale(), 5_000);
      this.#watchTimer.unref();
    }
    this.#setStatus({
      state: "connected",
      serverVersion: hello.server.version,
      protocol: hello.protocol,
      scopes: hello.auth.scopes,
      hint: null,
      lastError: null,
    });
    this.#opts.logger.info(
      { server: hello.server.version, protocol: hello.protocol, scopes: hello.auth.scopes, deviceId: this.deviceId },
      "connected to gateway",
    );
    for (const waiter of this.#waiters) waiter.resolve();
    this.#waiters.clear();
  }

  #checkStale(): void {
    if (this.#status.state !== "connected" || !gatewayStale(Date.now(), this.#lastFrameAt, this.#tickIntervalMs)) return;
    const seconds = Math.round((Date.now() - this.#lastFrameAt) / 1000);
    this.#opts.logger.warn({ seconds }, "gateway stopped answering; reconnecting");
    this.#setStatus({ state: "disconnected", lastError: `gateway stopped answering (no events for ${seconds}s)` });
    void this.#reconnectFresh();
  }

  #onConnectError(error: Error): void {
    const details = (error as { details?: unknown }).details;
    const pairing = readPairingConnectErrorDetails(details);
    if (pairing) {
      const hint = pairing.requestId
        ? `approve this panel on the gateway host: openclaw devices approve ${pairing.requestId}`
        : "approve this panel on the gateway host: openclaw devices list, then openclaw devices approve <requestId>";
      this.#setStatus({ state: "pairing_required", hint, lastError: this.#redact(error.message) });
      this.#opts.logger.warn({ reason: pairing.reason, requestId: pairing.requestId }, "gateway pairing required");
      return;
    }
    const code = readConnectErrorDetailCode(details);
    const terminal = code?.startsWith("AUTH_") === true;
    this.#setStatus({
      state: terminal ? "auth_failed" : "connecting",
      hint: terminal ? hintForAuthCode(code) : null,
      lastError: this.#redact(error.message),
    });
    this.#opts.logger.warn({ code, message: this.#redact(error.message) }, "gateway connect failed");
    if (terminal) this.#rejectWaiters(new Error(`gateway auth failed (${code})`));
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  #setStatus(patch: Partial<GatewayStatusDto>): void {
    this.#status = { ...this.#status, ...patch };
  }

  /** Strips the shared token and any stored device token from log lines. */
  #redact(message: string): string {
    let out = message;
    const secrets = [this.#opts.sharedToken, this.#opts.tokens.load({ deviceId: this.deviceId, role: ROLE })?.token];
    for (const secret of secrets) {
      if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
    }
    return out;
  }
}

export class GatewayUnavailableError extends Error {
  constructor(readonly status: GatewayStatusDto) {
    super(`gateway is not connected (state: ${status.state})`);
    this.name = "GatewayUnavailableError";
  }
}

function hintForAuthCode(code: string): string {
  switch (code) {
    case "AUTH_TOKEN_MISSING":
    case "AUTH_TOKEN_MISMATCH":
      return "set OPENCLAW_GATEWAY_TOKEN for the panel to the gateway's token";
    case "AUTH_SCOPE_MISMATCH":
      return "the panel's device token does not cover the requested scopes; re-approve the device";
    case "AUTH_RATE_LIMITED":
      return "too many failed attempts; wait and retry";
    default:
      return `gateway rejected the panel (${code})`;
  }
}
