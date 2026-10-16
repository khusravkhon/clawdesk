import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agents, agentSourceGrants, dataSources } from "../db/schema.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { SANDBOX_FOLDERS } from "./create-agent.js";

/** Register existing personal folders, then remove only their superseded host mounts. */
export async function repairAgentFolders(deps: { gateway: GatewayService; db: Db; bridge: Pick<BridgeClient, "ensureAgentFolder">; logger: Logger }): Promise<void> {
  const folders = deps.db.select({ agentId: agents.id, role: agents.role, name: dataSources.connectorRef })
    .from(agents).innerJoin(agentSourceGrants, eq(agentSourceGrants.agentId, agents.id))
    .innerJoin(dataSources, eq(dataSources.id, agentSourceGrants.sourceId)).where(eq(dataSources.kind, "folder")).all();
  for (const folder of folders) {
    if (folder.role !== "specialist") continue;
    try {
      const { config } = await getConfig<{ agents?: { entries?: Record<string, { sandbox?: { docker?: { binds?: string[] } } }> } }>(deps.gateway);
      if (!config.agents?.entries?.[folder.agentId]) continue;
      await deps.bridge.ensureAgentFolder(folder.agentId, folder.name);
      const changed = await patchConfig(deps.gateway, (snapshot) => {
        const current = snapshot as typeof config;
        const entry = current.agents?.entries?.[folder.agentId];
        if (!entry) return null;
        const binds = entry.sandbox?.docker?.binds ?? [];
        const kept = binds.filter((bind) => {
          const parts = bind.split(":");
          return parts[parts.length - 2] !== `${SANDBOX_FOLDERS}/${folder.name}`;
        });
        return kept.length === binds.length ? null : { agents: { entries: { [folder.agentId]: { sandbox: { docker: { binds: kept } } } } } };
      }, {
          replacePaths: [`agents.entries.${folder.agentId}.sandbox.docker.binds`], note: "clawdesk: managed agent folder",
      });
      if (changed) {
        deps.logger.info({ agentId: folder.agentId }, "replaced host folder bind with managed workspace exchange");
      }
    } catch (error) {
      deps.logger.warn({ err: error, agentId: folder.agentId }, "could not prepare managed agent folder; original data retained");
    }
  }
}
