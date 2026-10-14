import { FREE_MODEL_REF, MAX_BACKUP_MODELS, type ModelOptionDto } from "@clawdesk/shared";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";

// An agent's model chain: chain[0] is its main model, the rest are the backups
// OpenClaw tries in order when the main one fails with a limit, billing, auth or
// overload error (agents.entries.<id>.model { primary, fallbacks }). An agent's own
// primary without its own fallbacks is strict in OpenClaw, so the list is always
// written explicitly. See docs/model-fallback.md.

type ModelSetting = string | { primary?: string; fallbacks?: string[] } | undefined;
type AgentsConfig = { agents?: { defaults?: { model?: ModelSetting }; entries?: Record<string, { model?: ModelSetting }> } };
export type CatalogModel = { id: string; name?: string; provider: string; available?: boolean };

/** FreeLLMAPI is for junior agents in personal mode only, never for the main agent. */
const MAIN_FORBIDDEN_PROVIDERS = new Set(["freellmapi"]);

export class ModelChainError extends Error {
  constructor(
    readonly code: "chain_full" | "invalid_chain",
    message: string,
  ) {
    super(message);
    this.name = "ModelChainError";
  }
}

export function chainFromSetting(setting: ModelSetting): string[] {
  if (!setting) return [];
  if (typeof setting === "string") return [setting];
  return dedupe([setting.primary, ...(setting.fallbacks ?? [])].filter((ref): ref is string => !!ref));
}

/** Drops a pinned auth profile: "deepseek/deepseek-v4-flash@deepseek:default" → "deepseek/deepseek-v4-flash". */
export function baseRef(ref: string): string {
  const at = ref.indexOf("@");
  return at === -1 ? ref : ref.slice(0, at);
}

/** `before` stays as it was; `added` becomes the last backup (unless the chain already has it). */
export function withBackup(before: string[], added: string): string[] {
  if (before.some((ref) => baseRef(ref) === baseRef(added))) return before;
  return [...before, added];
}

export function assertRoomForBackup(chain: string[]): void {
  if (chain.length >= 1 + MAX_BACKUP_MODELS) throw new ModelChainError("chain_full", `at most ${MAX_BACKUP_MODELS} backup models`);
}

export function toOptions(refs: string[], catalog: CatalogModel[]): ModelOptionDto[] {
  const byRef = new Map(catalog.map((m) => [`${m.provider}/${m.id}`, m]));
  return refs.map((ref) => {
    const model = byRef.get(baseRef(ref));
    const provider = model?.provider ?? baseRef(ref).split("/")[0] ?? "";
    return { ref, label: model?.name ?? baseRef(ref).slice(provider.length + 1), provider, ready: model?.available ?? false };
  });
}

/** Models of providers the agent can already use that are not in its chain yet. */
export function choicesFor(agentId: string, chain: string[], catalog: CatalogModel[]): ModelOptionDto[] {
  const inChain = new Set(chain.map(baseRef));
  const refs = catalog
    .filter((m) => m.available && !inChain.has(`${m.provider}/${m.id}`) && allowed(agentId, m.provider))
    .map((m) => `${m.provider}/${m.id}`);
  return toOptions(refs, catalog);
}

/** Null when the chain can be saved; otherwise what is wrong with it. */
export function validateChain(agentId: string, chain: string[], catalog: CatalogModel[], current: string[]): string | null {
  if (!chain.length) return "the main model is required";
  if (chain.length > 1 + MAX_BACKUP_MODELS) return `at most ${MAX_BACKUP_MODELS} backup models`;
  if (new Set(chain.map(baseRef)).size !== chain.length) return "a model is listed twice";
  const known = new Set([...catalog.map((m) => `${m.provider}/${m.id}`), ...current.map(baseRef)]);
  for (const ref of chain) {
    if (!known.has(baseRef(ref))) return `unknown model: ${ref}`;
    if (!allowed(agentId, baseRef(ref).split("/")[0] ?? "")) return `${ref} cannot be used by the main agent`;
  }
  return null;
}

function allowed(agentId: string, provider: string): boolean {
  return agentId !== "main" || !MAIN_FORBIDDEN_PROVIDERS.has(provider);
}

function dedupe(refs: string[]): string[] {
  const seen = new Set<string>();
  return refs.filter((ref) => !seen.has(baseRef(ref)) && seen.add(baseRef(ref)));
}

// --- Gateway I/O ---

export async function readChain(gateway: GatewayService, agentId: string): Promise<string[]> {
  const { config } = await getConfig<AgentsConfig>(gateway);
  return chainFromSetting(config.agents?.entries?.[agentId]?.model ?? config.agents?.defaults?.model);
}

export async function writeChain(gateway: GatewayService, agentId: string, chain: string[], note: string): Promise<void> {
  const [primary, ...fallbacks] = chain;
  await patchConfig(gateway, { agents: { entries: { [agentId]: { model: { primary, fallbacks } } } } }, { replacePaths: [`agents.entries.${agentId}.model.fallbacks`], note });
}

export async function readCatalog(gateway: GatewayService): Promise<CatalogModel[]> {
  const res = await gateway.request<{ models?: CatalogModel[] }>("models.list", { view: "all" });
  return res.models ?? [];
}

/**
 * Junior agents created with "same AI as the main agent". The panel DB keeps the main
 * model they copied ("own" access keeps null, free models keep the free ref).
 */
export function followerIds(db: Db): string[] {
  return db
    .select({ id: agents.id, model: agents.model })
    .from(agents)
    .where(inArray(agents.role, ["specialist", "team_member"]))
    .all()
    .filter((a) => a.model !== null && a.model !== FREE_MODEL_REF)
    .map((a) => a.id);
}

/**
 * Juniors with the main agent's AI use its whole chain: when the main model runs out,
 * they switch to the same backups. Only agents whose chain differs are written.
 * Returns the ids that were updated.
 */
export async function syncFollowers(gateway: GatewayService, db: Db): Promise<string[]> {
  const ids = followerIds(db);
  if (!ids.length) return [];
  const { config } = await getConfig<AgentsConfig>(gateway);
  const main = chainFromSetting(config.agents?.entries?.main?.model ?? config.agents?.defaults?.model);
  if (!main.length) return [];
  const entries = config.agents?.entries ?? {};
  // Agents removed outside the panel are skipped: patching them would recreate a config entry.
  const stale = ids.filter((id) => id in entries && JSON.stringify(chainFromSetting(entries[id]!.model)) !== JSON.stringify(main));
  if (!stale.length) return [];
  const [primary, ...fallbacks] = main;
  await patchConfig(
    gateway,
    { agents: { entries: Object.fromEntries(stale.map((id) => [id, { model: { primary, fallbacks } }])) } },
    { replacePaths: stale.map((id) => `agents.entries.${id}.model.fallbacks`), note: "clawdesk: juniors follow the main agent's models" },
  );
  db.update(agents).set({ model: primary }).where(inArray(agents.id, stale)).run();
  return stale;
}

/**
 * Connecting a key or a subscription makes the new model the agent's main one
 * (OpenClaw's setup has no "add as backup"). Afterwards: put the chain from before
 * back and keep the new model as its last backup. Returns the new model's ref.
 */
export async function keepAsBackup(gateway: GatewayService, agentId: string, before: string[]): Promise<string | null> {
  const added = (await readChain(gateway, agentId))[0] ?? null;
  if (!added || !before.length) return added;
  await writeChain(gateway, agentId, withBackup(before, added), "clawdesk: backup model");
  return added;
}
