import { randomUUID } from "node:crypto";
import type { AgentAccessDto, AgentResourceDto, CompanyAccessDto, GrantResourceRequest, RefreshResourceRequest, ResourceAccess, RevokeResourceRequest } from "@clawdesk/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, agentSourceGrants, dataSources, googleDocCopies, mcpGrants, mcpServers, resourceGrants, teams } from "../db/schema.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import { serverGlob } from "../skills/mcp-access.js";

// Stage 5: what each company agent can actually reach, and the owner's grants and revocations.
// The state shown is read from where access is enforced, not from a list of intentions: folders from the
// bridge's synchronization registry (a folder is in an agent's workspace only while it is registered),
// MCP servers from the grants that become tool denies in OpenClaw's config. A grant or revocation is
// applied, then checked at that same place; only a checked result is reported as done.
// Team repositories and project work copies come with team membership and are changed there.
// Stage 7: a Google Doc is given as a prepared read-only copy (bridge: GoogleDocCopies) exported with the
// owner's connection; the agent gets neither the connection nor any other document. A refresh replaces the
// copy and tells the agent when the document's version changed, so its inputs never change silently.

export class AccessError extends Error {
  constructor(readonly code: "company_only" | "agent_missing" | "resource_missing" | "not_revocable" | "not_applied" | "main_folders" | "google_not_connected" | "gdoc_not_found" | "gdoc_no_access" | "gdoc_too_large" | "read_only_resource" | "google_unavailable") { super(code); }
}

type Bridge = Pick<BridgeClient, "folderSyncStatus" | "ensureAgentFolder" | "removeAgentFolder" | "sharedFolders"> & Partial<Pick<BridgeClient, "googleDocCopy" | "googleDocRemove" | "googleDocList">>;
type ToolConfig = { agents?: { entries?: Record<string, { tools?: { deny?: string[] } }> }; skills?: { entries?: { gog?: { enabled?: boolean; env?: { GOG_ACCOUNT?: string | null } } } } };
const GOOGLE_ERRORS = new Set(["google_not_connected", "gdoc_not_found", "gdoc_no_access", "gdoc_too_large", "google_unavailable"]);
const FOLDER = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;

export class AccessService {
  constructor(private readonly deps: {
    db: Db;
    companyMode: () => boolean;
    bridge: Bridge;
    /** Changes who may use an MCP server (McpService.setAgents: grants, then denies in the config). */
    setMcpAgents: (server: string, agentIds: string[]) => Promise<unknown>;
    /** OpenClaw's current config, to check the denies really changed (and the owner's Google account). */
    config: () => Promise<ToolConfig>;
    /** Stage 7: tells an agent its document copy changed. */
    notify?: (agentId: string, text: string, idempotencyKey: string) => Promise<void>;
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
    const docs = db.select().from(googleDocCopies).all();
    const teamRows = new Map(db.select().from(teams).all().map((team) => [team.id, team]));
    const row = (agentId: string, name: string, role: AgentAccessDto["role"], sandboxed: boolean, teamId: string | null, templateId: string | null): AgentAccessDto => {
      const resources: AgentResourceDto[] = [];
      for (const folder of sync.folders.filter((item) => item.agentId === agentId)) {
        const docs = folder.dir === "docs";
        resources.push({ kind: docs ? "team-docs" : "folder", name: folder.folder, access: folder.readOnly ? "read" : "write", path: sandboxed ? (docs ? "/workspace/docs" : `/workspace/folders/${folder.folder}`) : null, state: folder.state, revocable: true });
      }
      for (const grant of grants.filter((item) => item.agentId === agentId)) resources.push({ kind: "mcp", name: grant.server, access: "write", path: null, state: "granted", revocable: true });
      for (const copy of docs.filter((item) => item.agentId === agentId)) resources.push({ kind: "gdoc", name: copy.docId, title: copy.title, version: copy.revision, copiedAt: copy.copiedAt, access: "read", path: sandboxed ? `/workspace/google/${copy.docId}.md` : `google/${copy.docId}.md`, state: "ready", revocable: true });
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
    } else if (kind === "gdoc") {
      if (request.access !== "read") throw new AccessError("read_only_resource");
      await this.#copyDoc(agent.id, name);
    } else {
      if (!this.deps.db.select().from(mcpServers).where(eq(mcpServers.name, name)).get()) throw new AccessError("resource_missing");
      const current = this.deps.db.select().from(mcpGrants).where(eq(mcpGrants.server, name)).all().map((grant) => grant.agentId);
      await this.deps.setMcpAgents(name, [...new Set([...current, agent.id])]);
      if (await this.#denied(agent.id, name)) throw new AccessError("not_applied");
    }
    this.deps.db.insert(resourceGrants).values({ id: randomUUID(), agentId: agent.id, resource: request.resource, access: request.access, grantedBy: by, createdAt: this.#now() }).run();
    return { resource: request.resource, access: request.access, path: kind === "folder" && agent.sandbox ? `/workspace/folders/${name}` : kind === "gdoc" ? (agent.sandbox ? `/workspace/google/${name}.md` : `google/${name}.md`) : null };
  }

  /** Exports the document into the agent's copy and checks the copy is there with exactly that content. */
  async #copyDoc(agentId: string, docId: string): Promise<{ changed: boolean; title: string; revision: string | null }> {
    const { bridge, db } = this.deps;
    if (!bridge.googleDocCopy || !bridge.googleDocList) throw new AccessError("google_unavailable");
    const config = await this.deps.config();
    const account = config.skills?.entries?.gog?.enabled !== false ? config.skills?.entries?.gog?.env?.GOG_ACCOUNT : null;
    if (!account) throw new AccessError("google_not_connected");
    let copy;
    try { copy = await bridge.googleDocCopy(agentId, docId, account); }
    catch (error) {
      const code = (error as { code?: string }).code ?? "";
      throw new AccessError(GOOGLE_ERRORS.has(code) ? code as "google_not_connected" : "google_unavailable");
    }
    if (!(await bridge.googleDocList(agentId)).copies.some((item) => item.docId === docId && item.sha === copy.sha)) throw new AccessError("not_applied");
    const before = db.select().from(googleDocCopies).where(and(eq(googleDocCopies.agentId, agentId), eq(googleDocCopies.docId, docId))).get();
    const row = { agentId, docId, title: copy.title, revision: copy.revision, sha: copy.sha, copiedAt: copy.copiedAt };
    db.insert(googleDocCopies).values(row).onConflictDoUpdate({ target: [googleDocCopies.agentId, googleDocCopies.docId], set: { title: row.title, revision: row.revision, sha: row.sha, copiedAt: row.copiedAt } }).run();
    return { changed: !!before && before.sha !== copy.sha, title: copy.title, revision: copy.revision };
  }

  /**
   * Stage 7: exports a granted document again. When its content changed the agent hears about it — the inputs
   * of its work changed, and that is not left for it to notice.
   */
  async refresh(request: RefreshResourceRequest): Promise<{ changed: boolean }> {
    if (!this.deps.companyMode()) throw new AccessError("company_only");
    const agent = this.#agent(request.agentId);
    const docId = request.resource.slice("gdoc:".length);
    if (!this.deps.db.select().from(googleDocCopies).where(and(eq(googleDocCopies.agentId, agent.id), eq(googleDocCopies.docId, docId))).get()) throw new AccessError("resource_missing");
    const result = await this.#copyDoc(agent.id, docId);
    if (result.changed) await this.deps.notify?.(agent.id, `Документ «${result.title}» обновился (версия ${result.revision ?? "неизвестна"}). Копия ${agent.sandbox ? `/workspace/google/${docId}.md` : `google/${docId}.md`} заменена — входные условия твоей работы изменились, перечитай её. Если это меняет задачу, подай обращение.`, `clawdesk-gdoc-${agent.id}-${docId}-${Date.now()}`).catch(() => undefined);
    return { changed: result.changed };
  }

  /** Takes access away and checks it is gone: the folder copy deleted from the workspace, the server's tools denied. */
  async revoke(request: RevokeResourceRequest, by: string): Promise<void> {
    if (!this.deps.companyMode()) throw new AccessError("company_only");
    const agent = this.#agent(request.agentId);
    const [kind, name] = split(request.resource);
    const { db } = this.deps;
    if (kind === "gdoc") {
      if (!this.deps.bridge.googleDocRemove || !this.deps.bridge.googleDocList) throw new AccessError("google_unavailable");
      await this.deps.bridge.googleDocRemove(agent.id, name);
      if ((await this.deps.bridge.googleDocList(agent.id)).copies.some((item) => item.docId === name)) throw new AccessError("not_applied");
      db.delete(googleDocCopies).where(and(eq(googleDocCopies.agentId, agent.id), eq(googleDocCopies.docId, name))).run();
    } else if (kind === "folder" || kind === "team-docs") {
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
    // The copy is gone; what the agent wrote down or remembers from it is not. It is told plainly (§7.3).
    if (kind !== "mcp") await this.deps.notify?.(agent.id, revokedMessage(kind, name), `clawdesk-revoked-${agent.id}-${ref}-${this.#now()}`).catch(() => undefined);
  }
}

/** What a revoked agent is told: the source is gone, and nothing taken from it may be used or passed on. */
export function revokedMessage(kind: "folder" | "team-docs" | "gdoc", name: string): string {
  const what = kind === "gdoc" ? `Google-документу ${name}` : kind === "team-docs" ? "документам команды" : `папке «${name}»`;
  return `Владелец отозвал твой доступ к ${what}; копия удалена из твоей рабочей папки. Больше не используй и не пересказывай сведения из неё — ни в ответах, ни в обращениях, ни другим агентам. Удали из своих заметок и памяти (MEMORY.md, memory/) всё, что ты из неё выписал. Если для работы она всё ещё нужна, подай обращение о доступе.`;
}

function split(resource: string): ["folder" | "mcp" | "team-docs" | "gdoc", string] {
  const index = resource.indexOf(":");
  return [resource.slice(0, index) as "folder" | "mcp" | "team-docs" | "gdoc", resource.slice(index + 1)];
}
