import type { ActivateApiKeyRequest, ActivateResultDto, AiCatalogDto, AiStatusDto, InstallProviderResultDto, ModelChainDto, SaveModelChainRequest } from "@clawdesk/shared";
import type { Logger } from "pino";
import { patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { buildCatalog, providerPluginId, type DetectResult, type PluginEntry } from "./catalog.js";
import { findFlashModels, storeKeyWithModelViaWizard } from "./gemini-free-tier.js";
import type { Db } from "../db/client.js";
import { assertRoomForBackup, choicesFor, keepAsBackup, ModelChainError, readCatalog, readChain, syncFollowers, toOptions, validateChain, writeChain } from "./model-chain.js";

type ActivateResult = { ok: boolean; status?: string; modelRef?: string; latencyMs?: number; error?: string };
type InstallResult = { ok: true; plugin: { id: string; version?: string }; restartRequired?: boolean };

export class AiSetupError extends Error {
  constructor(
    readonly code: "unknown_provider" | "install_failed" | "gateway_version_unknown",
    message: string,
  ) {
    super(message);
    this.name = "AiSetupError";
  }
}

/**
 * Connects AI models to agents through the Gateway's own setup API, so every
 * provider OpenClaw supports works without provider-specific code here.
 * Each agent can get its own credential (agentId is passed through).
 */
export class AiSetupService {
  /** Plugin installs restart the Gateway; never run two at once. */
  #installQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly gateway: GatewayService,
    private readonly logger: Logger,
    private readonly db: Db,
  ) {}

  /** Juniors with the main agent's AI follow its model chain; never fails the caller. */
  async syncFollowers(): Promise<void> {
    try {
      const updated = await syncFollowers(this.gateway, this.db);
      if (updated.length) this.logger.info({ agents: updated }, "juniors follow the main agent's models");
    } catch (error) {
      this.logger.warn({ err: error }, "could not copy the main agent's models to juniors");
    }
  }

  async catalog(agentId: string): Promise<AiCatalogDto> {
    const [detect, plugins] = await Promise.all([
      this.gateway.request<DetectResult>("openclaw.setup.detect", { agentId }, { timeoutMs: 60_000 }),
      this.gateway.request<{ plugins: PluginEntry[] }>("plugins.list", {}),
    ]);
    return buildCatalog(agentId, detect, plugins.plugins);
  }

  /** Cheap check for routing (first-run window): does this agent have any model credential? */
  async status(agentId: string): Promise<AiStatusDto> {
    const res = await this.gateway.request<{ providers?: { provider?: string; id?: string; status?: string }[] }>("models.authStatus", { agentId });
    // Declared providers without a usable credential report status "missing".
    const providers = (res.providers ?? []).filter((p) => p.status !== "missing").map((p) => p.provider ?? p.id ?? "unknown");
    return { agentId, connected: providers.length > 0, providers };
  }

  /** Installs an official provider plugin pinned to the running OpenClaw version, then restarts the Gateway. */
  installProvider(pluginId: string): Promise<InstallProviderResultDto> {
    const run = this.#installQueue.then(() => this.#install(pluginId));
    this.#installQueue = run.catch(() => undefined);
    return run;
  }

  async modelChain(agentId: string): Promise<ModelChainDto> {
    const [chain, catalog] = await Promise.all([readChain(this.gateway, agentId), readCatalog(this.gateway)]);
    return { agentId, chain: toOptions(chain, catalog), choices: choicesFor(agentId, chain, catalog) };
  }

  async saveModelChain(req: SaveModelChainRequest): Promise<ModelChainDto> {
    const [current, catalog] = await Promise.all([readChain(this.gateway, req.agentId), readCatalog(this.gateway)]);
    const problem = validateChain(req.agentId, req.chain, catalog, current);
    if (problem) throw new ModelChainError("invalid_chain", problem);
    await writeChain(this.gateway, req.agentId, req.chain, "clawdesk: model chain");
    this.logger.info({ agentId: req.agentId, chain: req.chain }, "model chain saved");
    if (req.agentId === "main") await this.syncFollowers();
    return this.modelChain(req.agentId);
  }

  async activateApiKey(req: ActivateApiKeyRequest): Promise<ActivateResultDto> {
    const result = await this.#activateApiKey(req);
    if (result.ok && req.agentId === "main") await this.syncFollowers();
    return result;
  }

  async #activateApiKey(req: ActivateApiKeyRequest): Promise<ActivateResultDto> {
    const before = req.asBackup ? await readChain(this.gateway, req.agentId) : null;
    if (before) assertRoomForBackup(before);
    const res = await this.gateway.request<ActivateResult>(
      "openclaw.setup.activate",
      { agentId: req.agentId, kind: "api-key", authChoice: req.authChoice, apiKey: req.apiKey },
      { timeoutMs: 90_000 },
    );
    // Only the outcome is logged; the key never is.
    this.logger.info({ agentId: req.agentId, authChoice: req.authChoice, ok: res.ok, status: res.status }, "ai activation");
    const result = {
      ok: res.ok,
      status: res.status ?? (res.ok ? "ok" : "unknown"),
      modelRef: res.modelRef ?? null,
      latencyMs: res.latencyMs ?? null,
      error: res.error ?? null,
      switchedModel: false,
    };
    if (before) {
      if (res.ok) result.modelRef = await keepAsBackup(this.gateway, req.agentId, before);
      return result;
    }
    if (!res.ok && (res.status === "rate_limit" || res.status === "billing") && req.authChoice === "gemini-api-key" && req.agentId === "main") {
      return (await this.#activateGeminiFlash(req.apiKey)) ?? result;
    }
    return result;
  }

  /** Free Google keys have no Pro quota; retry the main agent on a Flash model this key can use. */
  async #activateGeminiFlash(apiKey: string): Promise<ActivateResultDto | null> {
    const candidates = (await findFlashModels(apiKey)).slice(0, 6);
    if (!candidates.length) return null;
    type Verify = { ok: boolean; modelRef?: string; latencyMs?: number; status?: string; error?: string };
    let verify: Verify | null = null;
    let modelRef = `google/${candidates[0]}`;
    try {
      await storeKeyWithModelViaWizard(this.gateway, this.logger, { provider: "google", apiKey, modelRef });
      for (const [i, id] of candidates.entries()) {
        modelRef = `google/${id}`;
        if (i > 0) await this.gateway.request("agents.update", { agentId: "main", model: modelRef });
        verify = await this.gateway.request<Verify>("openclaw.setup.verify", { agentId: "main" }, { timeoutMs: 90_000 });
        this.logger.info({ modelRef, ok: verify.ok, status: verify.status }, "gemini flash fallback");
        // "format": the pinned OpenClaw does not know this (newer) model yet; try the next one.
        if (verify.ok) {
          await this.#setGeminiFallbacks(modelRef, candidates.slice(i + 1));
          break;
        }
        if (verify.status !== "format") break;
      }
    } catch (error) {
      this.logger.warn({ err: error }, "could not store the Gemini key with a Flash model");
    }
    if (!verify?.ok) {
      // Leave nothing half-configured behind.
      await this.gateway.request("models.authLogout", { provider: "google", agentId: "main" }).catch(() => undefined);
      await this.gateway.request("agents.update", { agentId: "main", model: null }).catch(() => undefined);
      if (!verify) return null;
    }
    return {
      ok: verify.ok,
      status: verify.ok ? "ok" : (verify.status ?? "unknown"),
      modelRef: verify.modelRef ?? modelRef,
      latencyMs: verify.latencyMs ?? null,
      error: verify.ok ? null : (verify.error ?? null),
      switchedModel: verify.ok,
    };
  }

  /**
   * Free Flash models are often "overloaded" (503) for minutes; without fallbacks the turn just fails.
   * The other Flash models of the same key take over (OpenClaw tries them in order).
   */
  async #setGeminiFallbacks(primary: string, rest: string[]): Promise<void> {
    const fallbacks = geminiFallbacks(primary, rest);
    await patchConfig(this.gateway, { agents: { entries: { main: { model: { primary, fallbacks } } } } }, { replacePaths: ["agents.entries.main.model.fallbacks"], note: "clawdesk: gemini fallbacks" }).catch(
      (error: Error) => this.logger.warn({ err: error }, "could not set Gemini fallback models"),
    );
  }

  async #install(pluginId: string): Promise<InstallProviderResultDto> {
    const plugins = await this.gateway.request<{ plugins: PluginEntry[] }>("plugins.list", {});
    const plugin = plugins.plugins.find((p) => providerPluginId(p) === pluginId);
    if (!plugin) throw new AiSetupError("unknown_provider", `"${pluginId}" is not an official OpenClaw provider plugin`);

    const version = this.gateway.hello?.server.version;
    if (!version) throw new AiSetupError("gateway_version_unknown", "gateway version is not known yet");

    // Official installs follow "latest", which may need a newer OpenClaw; pin to the running version instead.
    const spec = { source: "clawhub", packageName: plugin.packageName!, version };
    let result: InstallResult;
    try {
      result = await this.gateway.request<InstallResult>("plugins.install", spec, { timeoutMs: 300_000 });
    } catch (error) {
      const reviewToken = readReviewToken(error);
      if (!reviewToken) throw new AiSetupError("install_failed", (error as Error).message);
      // The person chose this provider in the panel; consent is limited to official provider plugins (checked above).
      result = await this.gateway.request<InstallResult>(
        "plugins.install",
        { ...spec, acknowledgeCapabilities: { reviewToken }, acknowledgeInstallPolicyWarning: true },
        { timeoutMs: 300_000 },
      );
    }
    this.logger.info({ pluginId, version: result.plugin.version, restartRequired: result.restartRequired }, "provider plugin installed");

    let restarted = false;
    if (result.restartRequired) {
      const generation = this.gateway.generation;
      await this.gateway.request("gateway.restart.request", { reason: `clawdesk: installed provider ${pluginId}` }).catch((error: Error) => {
        // The socket may close before the reply arrives; the reconnect wait below is the real check.
        this.logger.debug({ err: error }, "restart request did not answer");
      });
      await this.gateway.waitForReconnect(generation);
      restarted = true;
    }
    return { ok: true, pluginId, version: result.plugin.version ?? version, restarted };
  }
}

/** Google keeps these aliases on current free-tier Flash models, so they work whatever this key lists. */
const GEMINI_ALIASES = ["gemini-flash-latest", "gemini-flash-lite-latest"];

export function geminiFallbacks(primary: string, rest: string[]): string[] {
  return [...new Set([...rest, ...GEMINI_ALIASES].map((id) => `google/${id}`))].filter((ref) => ref !== primary);
}

function readReviewToken(error: unknown): string | null {
  const details = (error as { details?: unknown }).details;
  if (details && typeof details === "object" && "reviewToken" in details && typeof details.reviewToken === "string") {
    return details.reviewToken;
  }
  return null;
}
