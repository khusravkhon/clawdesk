import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import { patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { communicationReplacePaths, liveAgentIds, sandboxPluginGate } from "../provision/agent-communication.js";

// Which agents get the request tools (clawdesk-requests plugin): in company mode the main agent and every
// company agent the Gateway runs; in personal mode nobody. The plugin's own allowlist is the gate (its tool
// factory refuses anyone else); each agent also lists the tools in its own tool policy, since plugin tools
// are optional and OpenClaw offers them only to agents that allow them. Sandboxed sessions have a second
// gate, tools.sandbox.tools: it must name the plugin, or the tools stay invisible inside the sandbox.

export const REQUESTS_PLUGIN = "clawdesk-requests";
export const REQUESTS_PATH = "/usr/local/share/clawdesk/plugins/clawdesk-requests";
export const REQUEST_TOOLS = ["clawdesk_request_up", "clawdesk_request_reply", "clawdesk_task_report", "clawdesk_task_review"];
/** The main agent's own: proposing to give the owner's file to an agent (the owner confirms). */
export const MAIN_TOOLS = ["clawdesk_share_file"];
const ALL_TOOLS = [...REQUEST_TOOLS, ...MAIN_TOOLS];

type Policy = { allow?: string[]; alsoAllow?: string[]; deny?: string[] };
type Config = {
  tools?: { sandbox?: { tools?: Policy } };
  agents?: { entries?: Record<string, { tools?: Policy }> };
  plugins?: { load?: { paths?: string[] }; allow?: string[]; entries?: Record<string, { enabled?: boolean; config?: { allowedAgentIds?: string[] } }> };
};

/** The tools added to (or, for an agent that loses them, removed from) an agent's own policy. */
function policyWith(policy: Policy | undefined, granted: boolean, agentId: string): Policy | null {
  const key = policy?.allow?.length ? "allow" : "alsoAllow";
  const current = policy?.[key] ?? [];
  const tools = granted ? (agentId === "main" ? ALL_TOOLS : REQUEST_TOOLS) : [];
  const next = [...new Set([...current.filter((tool) => !ALL_TOOLS.includes(tool) || tools.includes(tool)), ...tools])];
  return JSON.stringify(next) === JSON.stringify(current) ? null : { [key]: next };
}

/**
 * In company mode agents are only added: removing a deleted agent would change plugin config (a Gateway
 * restart) right after agents.delete, which can leave OpenClaw unable to start; a stale ID is harmless,
 * since the tool factory also requires the agent to exist. Personal mode clears the list.
 */
export function requestsPluginPatch(config: Config, granted: string[], companyMode = true): Record<string, unknown> | null {
  const current = config.plugins?.entries?.[REQUESTS_PLUGIN];
  const allowedAgentIds = companyMode ? [...new Set([...(current?.config?.allowedAgentIds ?? []), ...granted])].sort() : [];
  if (!allowedAgentIds.length && !current) return null;
  const entries: Record<string, { tools: Policy }> = {};
  for (const [agentId, entry] of Object.entries(config.agents?.entries ?? {})) {
    const tools = policyWith(entry.tools, allowedAgentIds.includes(agentId), agentId);
    if (tools) entries[agentId] = { tools };
  }
  const paths = [...new Set([...(config.plugins?.load?.paths ?? []), REQUESTS_PATH])];
  const allow = config.plugins?.allow ? [...new Set([...config.plugins.allow, REQUESTS_PLUGIN])] : undefined;
  const pluginSame = current?.enabled === true && JSON.stringify(current.config?.allowedAgentIds) === JSON.stringify(allowedAgentIds)
    && JSON.stringify(config.plugins?.load?.paths) === JSON.stringify(paths) && (!allow || JSON.stringify(config.plugins?.allow) === JSON.stringify(allow));
  const gate = allowedAgentIds.length ? sandboxPluginGate(config.tools?.sandbox?.tools, REQUESTS_PLUGIN) : null;
  if (pluginSame && !Object.keys(entries).length && !gate) return null;
  return {
    ...(gate ? { tools: { sandbox: { tools: gate } } } : {}),
    ...(pluginSame ? {} : { plugins: { load: { paths }, ...(allow ? { allow } : {}), entries: { [REQUESTS_PLUGIN]: { enabled: true, config: { allowedAgentIds } } } } }),
    ...(Object.keys(entries).length ? { agents: { entries } } : {}),
  };
}

/** Company agents with the request tools: main plus specialists and team members the Gateway runs. */
export async function syncRequestTools(deps: { gateway: GatewayService; db: Db; companyMode: boolean }): Promise<boolean> {
  const live = await liveAgentIds(deps.gateway);
  const ids = deps.companyMode
    ? ["main", ...deps.db.select({ id: agents.id }).from(agents).where(inArray(agents.role, ["specialist", "team_member"])).all().map(({ id }) => id)].filter((id) => live.has(id))
    : [];
  return patchConfig(deps.gateway, (config) => requestsPluginPatch(config as Config, ids, deps.companyMode), { replacePaths: communicationReplacePaths, note: "clawdesk: company request tools" }).then(Boolean);
}
