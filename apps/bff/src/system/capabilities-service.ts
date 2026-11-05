import type { CapabilitiesDto, CapabilityDto } from "@clawdesk/shared";
import { getConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { chainFromSetting } from "../ai-setup/model-chain.js";
import { REQUESTS_PLUGIN } from "../company/work-requests-config.js";

// P0 (see @clawdesk/shared capabilities). Every item is read from where it is enforced or used: the Gateway
// connection and its config, the bridge's probes of the container's tools, the Telegram owner binding, the
// panel's own sandbox switch. A part that cannot be reached reads as "unknown", never as working.

type Config = {
  agents?: { defaults?: { model?: Parameters<typeof chainFromSetting>[0] }; entries?: Record<string, { model?: Parameters<typeof chainFromSetting>[0] }> };
  plugins?: { entries?: Record<string, { enabled?: boolean }> };
  skills?: { entries?: { gog?: { enabled?: boolean; env?: { GOG_ACCOUNT?: string | null } } } };
};
type Probes = { openclaw: string | null; docker: string | null; git: string | null; gog: string | null };

export class CapabilitiesService {
  constructor(private readonly deps: {
    gateway: Pick<GatewayService, "request"> & { status: { state: string } };
    bridge?: { capabilities(): Promise<Probes> };
    telegramOwner: () => string | null;
    sandboxEnabled: boolean;
    companyMode: () => boolean;
    now?: () => number;
  }) {}

  async check(): Promise<CapabilitiesDto> {
    const connected = this.deps.gateway.status.state === "connected";
    const [config, probes] = await Promise.all([
      connected ? getConfig<Config>(this.deps.gateway as GatewayService).then((result) => result.config, () => null) : Promise.resolve(null),
      this.deps.bridge ? this.deps.bridge.capabilities().catch(() => null) : Promise.resolve(null),
    ]);
    const tool = (value: string | null | undefined): Pick<CapabilityDto, "state" | "value"> => probes ? (value ? { state: "ok", value } : { state: "missing", value: null }) : { state: "unknown", value: null };
    const fromConfig = (read: (config: Config) => Pick<CapabilityDto, "state" | "value">): Pick<CapabilityDto, "state" | "value"> => config ? read(config) : { state: "unknown", value: null };
    const items: CapabilityDto[] = [
      { id: "gateway", state: connected ? "ok" : "missing", value: this.deps.gateway.status.state },
      { id: "openclaw", ...tool(probes?.openclaw) },
      { id: "company_mode", state: this.deps.companyMode() ? "ok" : "off", value: null },
      { id: "model", ...fromConfig((c) => { const chain = chainFromSetting(c.agents?.entries?.main?.model ?? c.agents?.defaults?.model); return chain.length ? { state: "ok", value: chain[0]! } : { state: "missing", value: null }; }) },
      { id: "sandbox", state: this.deps.sandboxEnabled ? "ok" : "off", value: null },
      { id: "docker", ...tool(probes?.docker) },
      { id: "requests_plugin", ...fromConfig((c) => { const entry = c.plugins?.entries?.[REQUESTS_PLUGIN]; return !entry ? { state: "missing", value: null } : entry.enabled === false ? { state: "off", value: null } : { state: "ok", value: null }; }) },
      { id: "telegram", ...(this.deps.telegramOwner() ? { state: "ok" as const, value: null } : { state: "missing" as const, value: null }) },
      { id: "google", ...(probes && !probes.gog ? { state: "missing" as const, value: null } : fromConfig((c) => { const gog = c.skills?.entries?.gog; return gog?.enabled !== false && gog?.env?.GOG_ACCOUNT ? { state: probes ? "ok" : "unknown", value: gog.env.GOG_ACCOUNT } : { state: "off", value: null }; })) },
      { id: "git", ...tool(probes?.git) },
    ];
    return { checkedAt: this.deps.now?.() ?? Date.now(), items };
  }
}
