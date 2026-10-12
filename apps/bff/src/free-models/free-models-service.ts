import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FREE_MODEL_REF, type FreeModelsStatusDto, type FreeProviderDto } from "@clawdesk/shared";
import type { Logger } from "pino";
import { z } from "zod";
import type { BridgeClient } from "../gateway/bridge-client.js";
import { patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { readJsonIfExists, writeSecureJson } from "../lib/secure-file.js";

// Manages the bundled FreeLLMAPI for "free models" (junior agents, personal mode).
// The panel owns FreeLLMAPI's single dashboard account. Its password is derived from the Gateway
// token (deploy/.env), so a lost panel volume does not lock the panel out; the 0600 file is a cache.
// The panel adds the provider keys people paste, and registers
// FreeLLMAPI in OpenClaw as provider "freellmapi" with its unified key stored
// as a protected Gateway secret.

const UNIFIED_KEY_SECRET = "CLAWDESK_FREELLMAPI_KEY";
/** How OpenClaw reaches FreeLLMAPI: both live in the gateway's network namespace. */
const GATEWAY_SIDE_BASE_URL = "http://127.0.0.1:3001/v1";

/** Free keys without a card, open worldwide, with the page where the key is created. */
const RECOMMENDED: Record<string, string> = {
  google: "https://aistudio.google.com/apikey",
  groq: "https://console.groq.com/keys",
  cerebras: "https://cloud.cerebras.ai/",
  mistral: "https://console.mistral.ai/api-keys",
  openrouter: "https://openrouter.ai/keys",
  github: "https://github.com/settings/personal-access-tokens",
  nvidia: "https://build.nvidia.com/",
  zhipu: "https://z.ai/manage-apikey/apikey-list",
  cohere: "https://dashboard.cohere.com/api-keys",
  huggingface: "https://huggingface.co/settings/tokens",
};
const RECOMMENDED_ORDER = Object.keys(RECOMMENDED);

const Account = z.object({ email: z.string(), password: z.string() });
type ProvidersResponse = { providers: { platform: string; name: string; keyless: boolean; configured: boolean; keyCount: number }[] };

export class FreeModelsError extends Error {
  constructor(
    readonly code: "unavailable" | "rejected",
    message: string,
  ) {
    super(message);
    this.name = "FreeModelsError";
  }
}

export type FreeModelsOptions = {
  /** FreeLLMAPI as seen from the BFF; undefined disables the feature. */
  baseUrl: string | undefined;
  dataDir: string;
  /** Only needed when the BFF is not on FreeLLMAPI's loopback (host development). */
  setupCode: string | undefined;
  /** Gateway token: the account password is derived from it. */
  accountSecret?: string;
  /** Recovers the account when the panel has lost (or never had) its password. */
  bridge?: BridgeClient;
};

const ACCOUNT_EMAIL = "clawdesk@panel.local";

/** Same input, same password — on any reinstall of the panel with the same deploy/.env. */
export function derivedPassword(secret: string): string {
  return crypto.createHmac("sha256", secret).update("clawdesk/freellmapi/account/v1").digest("base64url");
}

export class FreeModelsService {
  #session: string | null = null;
  #registered = false;

  constructor(
    private readonly gateway: GatewayService,
    private readonly logger: Logger,
    private readonly opts: FreeModelsOptions,
  ) {}

  async status(): Promise<FreeModelsStatusDto> {
    const empty = { available: false, ready: false, modelRef: FREE_MODEL_REF, providers: [] };
    if (!this.opts.baseUrl) return { ...empty, error: "free models are not installed on this server" };
    let res: ProvidersResponse;
    try {
      res = await this.#api<ProvidersResponse>("/api/keys/providers");
    } catch (error) {
      return { ...empty, error: (error as Error).message };
    }
    const providers: FreeProviderDto[] = res.providers
      // Keyless pools log prompts for training or are very slow; not offered.
      .filter((p) => !p.keyless)
      .map((p) => ({
        platform: p.platform,
        name: p.name,
        configured: p.configured,
        keyCount: p.keyCount,
        recommended: p.platform in RECOMMENDED,
        signupUrl: RECOMMENDED[p.platform] ?? null,
      }))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const anyKey = providers.some((p) => p.configured);
    if (anyKey && !this.#registered) await this.ensureRegistered().catch((e: Error) => this.logger.warn({ err: e }, "freellmapi registration failed"));
    return { available: true, ready: anyKey && this.#registered, modelRef: FREE_MODEL_REF, providers, error: null };
  }

  async addKey(platform: string, key: string): Promise<FreeModelsStatusDto> {
    await this.#api("/api/keys", { method: "POST", body: { platform, key } });
    this.logger.info({ platform }, "free model key added");
    await this.ensureRegistered();
    return this.status();
  }

  async removeKeys(platform: string): Promise<FreeModelsStatusDto> {
    const keys = await this.#api<{ id: number; platform: string }[] | { keys: { id: number; platform: string }[] }>("/api/keys");
    const list = Array.isArray(keys) ? keys : keys.keys;
    for (const k of list.filter((k) => k.platform === platform)) await this.#api(`/api/keys/${k.id}`, { method: "DELETE" });
    return this.status();
  }

  /** Puts FreeLLMAPI's unified key into the Gateway secret store and declares the provider in OpenClaw. */
  async ensureRegistered(): Promise<void> {
    const { apiKey } = await this.#api<{ apiKey: string }>("/api/settings/api-key");
    await this.gateway.request("secrets.store.set", { name: UNIFIED_KEY_SECRET, value: apiKey, kind: "secret", allowedHosts: ["127.0.0.1"] });
    await patchConfig(
      this.gateway,
      {
        models: {
          providers: {
            freellmapi: {
              baseUrl: GATEWAY_SIDE_BASE_URL,
              api: "openai-completions",
              apiKey: { source: "store", provider: "default", id: UNIFIED_KEY_SECRET },
              models: [{ id: "auto", name: "Free models (FreeLLMAPI auto)", contextWindow: 32768, maxTokens: 4096 }],
            },
          },
        },
      },
      { note: "clawdesk: free models provider" },
    );
    this.#registered = true;
  }

  async #api<T = unknown>(pathname: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
    const token = await this.#login();
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}${pathname}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new FreeModelsError("unavailable", "the free models service is not responding");
    }
    if (res.status === 401 && !retried) {
      this.#session = null;
      return this.#api<T>(pathname, init, true);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new FreeModelsError("rejected", body.error?.message ?? `free models service answered ${res.status}`);
    return body as T;
  }

  /** Logs into FreeLLMAPI with the panel's account: creates it on first use, moves it to the derived password, recovers it. */
  async #login(): Promise<string> {
    if (this.#session) return this.#session;
    const file = path.join(this.opts.dataDir, "freellmapi", "account.json");
    const stored = readJsonIfExists(file);
    const derived = this.opts.accountSecret ? { email: ACCOUNT_EMAIL, password: derivedPassword(this.opts.accountSecret) } : null;
    const post = (route: string, body: unknown, token?: string) => this.#authPost(route, body, token);

    if (stored !== undefined) {
      const account = Account.parse(stored);
      const res = await post("login", account);
      if (res.ok && res.body.token) {
        if (derived && account.password !== derived.password) await this.#moveToDerived(res.body.token, account.password, derived, file);
        return (this.#session = res.body.token);
      }
      this.logger.warn("free models: stored account was rejected; trying the derived password");
    }

    if (derived) {
      const res = await post("login", derived);
      if (res.ok && res.body.token) {
        writeSecureJson(file, derived);
        return (this.#session = res.body.token);
      }
    }

    const account = derived ?? { email: ACCOUNT_EMAIL, password: crypto.randomBytes(24).toString("base64url") };
    // Persist first: if setup succeeds but the write failed, a random password would be unrecoverable.
    writeSecureJson(file, account);
    const setup = await post("setup", { ...account, ...(this.opts.setupCode ? { setupCode: this.opts.setupCode } : {}) });
    if (setup.ok && setup.body.token) {
      this.logger.info("free models service account created");
      return (this.#session = setup.body.token);
    }

    // The account exists but its password is gone (e.g. a lost panel volume): reset it.
    if (derived && this.opts.bridge && /already/i.test(setup.body.error?.message ?? "")) {
      await this.opts.bridge.freellmapiReset(derived.password);
      const res = await post("login", derived);
      if (res.ok && res.body.token) {
        this.logger.info("free models service account recovered");
        return (this.#session = res.body.token);
      }
    }
    if (!derived) fs.rmSync(file, { force: true });
    throw new FreeModelsError("rejected", setup.body.error?.message ?? "could not sign in to the free models service");
  }

  /** Accounts made before the derived password: switch once, keep the file in step. */
  async #moveToDerived(token: string, current: string, derived: { email: string; password: string }, file: string): Promise<void> {
    const res = await this.#authPost("change-password", { currentPassword: current, newPassword: derived.password }, token);
    if (res.ok) {
      writeSecureJson(file, derived);
      this.logger.info("free models account moved to the derived password");
    } else {
      this.logger.warn({ status: res.status }, "free models: could not move the account to the derived password");
    }
  }

  async #authPost(route: string, body: unknown, token?: string) {
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/auth/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as { token?: string; error?: { message?: string } } };
    } catch {
      throw new FreeModelsError("unavailable", "the free models service is not responding");
    }
  }
}

function rank(p: FreeProviderDto): number {
  const i = RECOMMENDED_ORDER.indexOf(p.platform);
  return i === -1 ? 1000 : i;
}
