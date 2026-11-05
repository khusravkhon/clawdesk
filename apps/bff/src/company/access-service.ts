import { randomUUID } from "node:crypto";
import type { AgentAccessDto, AgentResourceDto, CompanyAccessDto, GrantResourceRequest, ResourceAccess, RevokeResourceRequest } from "@clawdesk/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, agentSourceGrants, dataSources, mcpGrants, mcpServers, resourceGrants, teams } from "../db/schema.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import { serverGlob } from "../skills/mcp-access.js";

// Stage 5: what each company agent can actually reach, and the owner's grants and revocations.
// The state shown is read from where access is enforced, not from a list of intentions: folders from the
// bridge's synchronization registry (a folder is in an agent's workspace only while it is registered),
// MCP servers from the grants that become tool denies in OpenClaw's config. A grant or revocation is
// applied, then checked at that same place; only a checked result is reported as done.
// Team repositories and project work copies come with team membership and are changed there.

export class AccessError extends Error {
  constructor(readonly code: "company_only" | "agent_missing" | "resource_missing" | "not_revocable" | "not_applied" | "main_folders") { super(code); }
}

type Bridge = Pick<BridgeClient, "folderSyncStatus" | "ensureAgentFolder" | "removeAgentFolder" | "sharedFolders">;
type ToolConfig = { agents?: { entries?: Record<string, { tools?: { deny?: string[] } }> } };
const FOLDER = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;

export class AccessService {
  constructor(private readonly deps: {
    db: Db;
    companyMode: () => boolean;
    bridge: Bridge;
    /** Changes who may use an MCP server (McpService.setAgents: grants, then denies in the config). */
    setMcpAgents: (server: string, agentIds: string[]) => Promise<unknown>;
    /** OpenClaw's current config, to check the denies really changed. */
    config: () => Promise<ToolConfig>;
    now?: () => number;
  }) {}

  #now() { return this.deps.now?.() ?? Date.now(); }

  #agents() {
    return this.deps.db.select().from(agents).where(inArray(agents.role, ["specialist", "team_member"])).all();
  }

  async list(): Promise<CompanyAccessDto> {
    if (!this.deps.companyMode()) throw new AccessError("company_only");
    const { db } = this.deps;
    const [sync, shared] = await Promise.all([this.deps.bridge.folderSyncStatus(), this.deps.bridge.sharedFolders().catch(() => ({ folders: [] as string[] }))]);
    const grants = db.select().from(mcpGrants).all();
    const teamRows = new Map(db.select().from(teams).all().map((team) => [team.id, team]));
    const row = (agentId: string, name: string, role: AgentAccessDto["role"], sandboxed: boolean, teamId: string | null, templateId: string | null): AgentAccessDto => {
      const resources: AgentResourceDto[] = [];
      for (const folder of sync.folders.filter((item) => item.agentId === agentId)) {
        const docs = folder.dir === "docs";
        resources.push({ kind: docs ? "team-docs" : "folder", name: folder.folder, access: folder.readOnly ? "read" : "write", path: sandboxed ? (docs ? "/workspace/docs" : `/workspace/folders/${folder.folder}`) : null, state: folder.state, revocable: true });
      }
      for (const grant of grants.filter((item) => item.agentId === agentId)) resources.push({ kind: "mcp", name: grant.server, access: "write", path: null, state: "granted", revocable: true });
      const team = teamId ? teamRows.get(teamId) : undefined;
      if (team?.repoUrl) resources.push({ kind: "team-repo", name: team.name, access: templateId === "developer" ? "write" : "read", path: sandboxed ? "/workspace/repo" : null, state: "granted", revocable: false });
      else if (team?.projectId) resources.push({ kind: "project-copy", name: team.name, access: "write", path: sandboxed ? "/workspace/project" : null, state: "granted", revocable: false });
      return { agentId, name, role, sandboxed, resources };
    };
    const list = [
      row("main", "Главный агент", "main", false, null, null),
      ...this.#agents().map((agent) => row(agent.id, agent.displayName, agent.role as AgentAccessDto["role"], agent.sandbox, agent.teamId, agent.templateId)),
    ];
    const history = db.select().from(resourceGrants).orderBy(desc(resourceGrants.createdAt)).limit(100).all()
      .map((grant) => ({ id: grant.id, agentId: grant.agentId, resource: grant.resource, access: grant.access, grantedBy: grant.grantedBy, createdAt: grant.createdAt, revokedAt: grant.revokedAt }));
    const servers = db.select({ name: mcpServers.name }).from(mcpServers).all().map((server) => server.name).sort();
    return { agents: list, folders: shared.folders.filter((name) => FOLDER.test(name)), servers, history };
  }

  #agent(agentId: string) {
    if (agentId === "main") return { id: "main", sandbox: false };
    const agent = this.deps.db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent || agent.role === "main") throw new AccessError("agent_missing");
    return agent;
  }

  async #denied(agentId: string, server: string): Promise<boolean> {
    return ((await this.deps.config()).agents?.entries?.[agentId]?.tools?.deny ?? []).includes(serverGlob(server));
  }

  /**
   * Gives an agent a shared folder (synchronized into its workspace; read-only mirrors one way) or an MCP
   * server, then checks it: the folder registered for the agent, the server's tools no longer denied.
   * Returns where the agent finds it.
   */
  async grant(request: GrantResourceRequest, by: string): Promise<{ resource: string; access: ResourceAccess; path: string | null }> {
    if (!this.deps.companyMode()) throw new AccessError("company_only");
    const agent = this.#agent(request.agentId);
    const [kind, name] = split(request.resource);
    if (kind === "folder") {
      if (agent.id === "main") throw new AccessError("main_folders");
      if (!(await this.deps.bridge.sharedFolders()).folders.includes(name)) throw new AccessError("resource_missing");
      await this.deps.bridge.ensureAgentFolder(agent.id, name, { readOnly: request.access === "read" });
      const registered = (await this.deps.bridge.folderSyncStatus()).folders.find((item) => item.agentId === agent.id && item.folder === name && !item.dir);
      if (!registered || registered.readOnly !== (request.access === "read")) throw new AccessError("not_applied");
    } else {
      if (!this.deps.db.select().from(mcpServers).where(eq(mcpServers.name, name)).get()) throw new AccessError("resource_missing");
      const current = this.deps.db.select().from(mcpGrants).where(eq(mcpGrants.server, name)).all().map((grant) => grant.agentId);
      await this.deps.setMcpAgents(name, [...new Set([...current, agent.id])]);
      if (await this.#denied(agent.id, name)) throw new AccessError("not_applied");
    }
    this.deps.db.insert(resourceGrants).values({ id: randomUUID(), agentId: agent.id, resource: request.resource, access: request.access, grantedBy: by, createdAt: this.#now() }).run();
    return { resource: request.resource, access: request.access, path: kind === "folder" && agent.sandbox ? `/workspace/folders/${name}` : null };
  }

  /** Takes access away and checks it is gone: the folder copy deleted from the workspace, the server's tools denied. */
  async revoke(request: RevokeResourceRequest, by: string): Promise<void> {
    if (!this.deps.companyMode()) throw new AccessError("company_only");
    const agent = this.#agent(request.agentId);
    const [kind, name] = split(request.resource);
    const { db } = this.deps;
    if (kind === "folder" || kind === "team-docs") {
      await this.deps.bridge.removeAgentFolder(agent.id, name, kind === "team-docs" ? { dir: "docs" } : {});
      if ((await this.deps.bridge.folderSyncStatus()).folders.some((item) => item.agentId === agent.id && item.folder === name && (kind === "team-docs" ? item.dir === "docs" : !item.dir))) throw new AccessError("not_applied");
      // The agent's profile lists folders from these grant rows: drop the matching ones too.
      const sources = db.select({ id: dataSources.id }).from(dataSources).where(and(eq(dataSources.kind, "folder"), eq(dataSources.connectorRef, name))).all().map((source) => source.id)
        .filter((id) => kind === "team-docs" ? id.startsWith("team-docs:") : !id.startsWith("team-docs:"));
      if (sources.length) db.delete(agentSourceGrants).where(and(eq(agentSourceGrants.agentId, agent.id), inArray(agentSourceGrants.sourceId, sources))).run();
    } else {
      const current = db.select().from(mcpGrants).where(eq(mcpGrants.server, name)).all().map((grant) => grant.agentId);
      if (!current.includes(agent.id)) throw new AccessError("resource_missing");
      await this.deps.setMcpAgents(name, current.filter((id) => id !== agent.id));
      if (!(await this.#denied(agent.id, name))) throw new AccessError("not_applied");
    }
    const ref = kind === "team-docs" ? `team-docs:${name}` : request.resource;
    db.update(resourceGrants).set({ revokedAt: this.#now(), revokedBy: by }).where(and(eq(resourceGrants.agentId, agent.id), eq(resourceGrants.resource, ref), isNull(resourceGrants.revokedAt))).run();
    if (!db.select().from(resourceGrants).where(and(eq(resourceGrants.agentId, agent.id), eq(resourceGrants.resource, ref))).get()) {
      // Access the panel had not granted itself (a template folder, a team): record its revocation as well.
      db.insert(resourceGrants).values({ id: randomUUID(), agentId: agent.id, resource: ref, access: "read", grantedBy: "—", createdAt: this.#now(), revokedAt: this.#now(), revokedBy: by }).run();
    }
  }
}

function split(resource: string): ["folder" | "mcp" | "team-docs", string] {
  const index = resource.indexOf(":");
  return [resource.slice(0, index) as "folder" | "mcp" | "team-docs", resource.slice(index + 1)];
}
