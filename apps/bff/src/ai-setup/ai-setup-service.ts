import type { ActivateApiKeyRequest, ActivateResultDto, AiCatalogDto, AiStatusDto, InstallProviderResultDto } from "@clawdesk/shared";
import type { Logger } from "pino";
import type { GatewayService } from "../gateway/gateway-service.js";
import { buildCatalog, providerPluginId, type DetectResult, type PluginEntry } from "./catalog.js";
import { findFlashModel, storeKeyWithModelViaWizard } from "./gemini-free-tier.js";

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
  ) {}

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

  async activateApiKey(req: ActivateApiKeyRequest): Promise<ActivateResultDto> {
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
    if (!res.ok && (res.status === "rate_limit" || res.status === "billing") && req.authChoice === "gemini-api-key" && req.agentId === "main") {
      return (await this.#activateGeminiFlash(req.apiKey)) ?? result;
    }
    return result;
  }

  /** Free Google keys have no Pro quota; retry the main agent on a Flash model this key can use. */
  async #activateGeminiFlash(apiKey: string): Promise<ActivateResultDto | null> {
    const flash = await findFlashModel(apiKey);
    if (!flash) return null;
    const modelRef = `google/${flash}`;
    try {
      await storeKeyWithModelViaWizard(this.gateway, this.logger, { provider: "google", apiKey, modelRef });
    } catch (error) {
      this.logger.warn({ err: error }, "could not store the Gemini key with a Flash model");
      return null;
    }
    const verify = await this.gateway.request<{ ok: boolean; modelRef?: string; latencyMs?: number; status?: string; error?: string }>(
      "openclaw.setup.verify",
      { agentId: "main" },
      { timeoutMs: 90_000 },
    );
    this.logger.info({ modelRef, ok: verify.ok, status: verify.status }, "gemini flash fallback");
    if (!verify.ok) {
      // Leave nothing half-configured behind.
      await this.gateway.request("models.authLogout", { provider: "google", agentId: "main" }).catch(() => undefined);
      await this.gateway.request("agents.update", { agentId: "main", model: null }).catch(() => undefined);
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

function readReviewToken(error: unknown): string | null {
  const details = (error as { details?: unknown }).details;
  if (details && typeof details === "object" && "reviewToken" in details && typeof details.reviewToken === "string") {
    return details.reviewToken;
  }
  return null;
}
