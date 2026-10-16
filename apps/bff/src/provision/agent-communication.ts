import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import { patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";

export type CommunicationConfig = {
  tools?: { agentToAgent?: { enabled?: boolean; allow?: string[] }; sessions?: { visibility?: string } };
  agents?: {
    defaults?: { sandbox?: { sessionToolsVisibility?: string } };
    entries?: Record<string, { tools?: AgentTools }>;
  };
  plugins?: { load?: { paths?: string[] }; allow?: string[]; entries?: Record<string, { enabled?: boolean; config?: { allowedAgentIds?: string[] } }> };
};

type AgentTools = { allow?: string[]; alsoAllow?: string[]; deny?: string[] };
export const ASK_MAIN_PLUGIN = "clawdesk-ask-main";
export const ASK_MAIN_TOOL = "clawdesk_ask_main";
export const ASK_MAIN_PATH = "/usr/local/share/clawdesk/plugins/clawdesk-ask-main";
export const CROSS_SESSION_TOOLS = [
  "agent_to_agent", "agents_list", "sessions_list", "sessions_history", "sessions_search",
  "sessions_send", "sessions_spawn", "sessions_yield", "session_status", "subagents",
  "conversations_list", "conversations_send", "conversations_turn",
];

export function personalAgentTools(before: AgentTools | undefined, permitted: boolean): AgentTools {
  const deny = [...new Set([...(before?.deny ?? []), ...CROSS_SESSION_TOOLS, ...(!permitted ? [ASK_MAIN_TOOL] : [])])];
  const alsoAllow = [...new Set([...(before?.alsoAllow ?? []).filter((tool) => tool !== ASK_MAIN_TOOL), ...(permitted ? [ASK_MAIN_TOOL] : [])])];
  if (before?.allow) return { deny, allow: [...new Set([...before.allow.filter((tool) => tool !== ASK_MAIN_TOOL), ...(permitted ? [ASK_MAIN_TOOL] : [])])], ...(before.alsoAllow ? { alsoAllow: before.alsoAllow.filter((tool) => tool !== ASK_MAIN_TOOL) } : {}) };
  return { deny, alsoAllow };
}

export function agentCommunicationPatch(config: CommunicationConfig, personal: { id: string; canAskMain: boolean }[], existing: ReadonlySet<string>) {
  const entries: Record<string, { tools: AgentTools }> = {};
  for (const { id, canAskMain } of personal) {
    // Existence comes from agents.list: a just-created agent may not have a config entry yet.
    if (!existing.has(id)) continue;
    const current = config.agents?.entries?.[id];
    const tools = personalAgentTools(current?.tools, canAskMain);
    if (Object.entries(tools).some(([key, value]) => JSON.stringify(current?.tools?.[key as keyof AgentTools] ?? []) !== JSON.stringify(value))) entries[id] = { tools };
  }
  const managed = new Set(personal.map(({ id }) => id));
  const live = personal.filter(({ id }) => existing.has(id)).map(({ id }) => id);
  const allow = [...new Set([...(config.tools?.agentToAgent?.allow ?? []).filter((id) => !managed.has(id) || live.includes(id)), "main", ...live])];
  const native = live.length && (!config.tools?.agentToAgent?.enabled || JSON.stringify(config.tools.agentToAgent.allow) !== JSON.stringify(allow) || config.tools.sessions?.visibility !== "all");
  if (!Object.keys(entries).length && !native) return null;
  return {
    ...(native ? { tools: { agentToAgent: { enabled: true, allow }, sessions: { visibility: "all" } } } : {}),
    // Personal juniors cannot use native cross-session tools, regardless of the global visibility gate.
    ...(Object.keys(entries).length ? { agents: { entries } } : {}),
  };
}

export function mainPluginPatch(config: CommunicationConfig, personal: { id: string; canAskMain: boolean }[], existing: ReadonlySet<string>) {
  const allowedAgentIds = personal.filter(({ id, canAskMain }) => canAskMain && existing.has(id)).map(({ id }) => id).sort();
  const current = config.plugins?.entries?.[ASK_MAIN_PLUGIN];
  if (!personal.length && !current) return null;
  const paths = [...new Set([...(config.plugins?.load?.paths ?? []), ASK_MAIN_PATH])];
  const allow = config.plugins?.allow ? [...new Set([...config.plugins.allow, ASK_MAIN_PLUGIN])] : undefined;
  if (current?.enabled === true && JSON.stringify(current.config?.allowedAgentIds) === JSON.stringify(allowedAgentIds)
    && JSON.stringify(config.plugins?.load?.paths) === JSON.stringify(paths) && (!allow || JSON.stringify(config.plugins?.allow) === JSON.stringify(allow))) return null;
  return { plugins: { load: { paths }, ...(allow ? { allow } : {}), entries: { [ASK_MAIN_PLUGIN]: { enabled: true, config: { allowedAgentIds } } } } };
}

export const communicationReplacePaths = (_config: unknown, patch: Record<string, unknown>): string[] => {
  const collect = (value: unknown, prefix: string): string[] => {
    if (Array.isArray(value)) return [prefix];
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, item]) => collect(item, prefix ? `${prefix}.${key}` : key));
  };
  return collect(patch, "");
};

export function personalAgents(db: Db): { id: string; canAskMain: boolean }[] {
  return db.select({ id: agents.id, canAskMain: agents.canAskMain }).from(agents).where(eq(agents.role, "specialist")).all();
}

/** Agents the Gateway really has now: our rows may still name an agent deleted outside the panel. */
export async function liveAgentIds(gateway: GatewayService): Promise<Set<string>> {
  const list = await gateway.request<{ agents?: { id: string }[] }>("agents.list", {});
  return new Set((list.agents ?? []).map(({ id }) => id));
}

/** Bring existing agents with the owner's permission onto the same policy as new agents. */
export async function repairAgentCommunication(deps: { gateway: GatewayService; db: Db }): Promise<void> {
  const personal = personalAgents(deps.db);
  const existing = await liveAgentIds(deps.gateway);
  await patchConfig(deps.gateway, (config) => agentCommunicationPatch(config as CommunicationConfig, personal, existing), { replacePaths: communicationReplacePaths, note: "clawdesk: isolate personal agent sessions" });
  await patchConfig(deps.gateway, (config) => mainPluginPatch(config as CommunicationConfig, personal, existing), { replacePaths: communicationReplacePaths, note: "clawdesk: configure restricted ask-main tool (availability unverified)" });
}
