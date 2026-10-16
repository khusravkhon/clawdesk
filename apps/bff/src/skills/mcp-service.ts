import type { AddMcpServerRequest, McpServerDto, McpServersDto, StartMcpLoginResultDto } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { mcpGrants, mcpServers } from "../db/schema.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { liveAgentIds } from "../provision/agent-communication.js";
import { mcpAccessPatch, mcpAccessReplacePaths, type McpAccessConfig } from "./mcp-access.js";

// MCP servers by address (the owner chose: no local commands). OpenClaw keeps them in
// mcp.servers for every agent; who may use which one lives in mcp_grants and is enforced as tool
// denies (mcp-access.ts). OAuth sign-in has no RPC: the bridge runs `openclaw mcp login`, the
// provider sends the browser back to this panel, and the code goes back through the bridge —
// the same way Notion is signed in on the data sources screen.

export const MCP_CALLBACK_PATH = "/api/mcp/callback";
const PENDING_MS = 15 * 60_000;
const MAIN = "main";
// Public servers often need ~2 s for the first answer; OpenClaw's own limit is shorter.
const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;

type ServerConfig = { url?: string; auth?: string; headers?: Record<string, unknown>; oauth?: { redirectUrl?: string } };
type Config = McpAccessConfig & { mcp?: { servers?: Record<string, ServerConfig> } };

export class McpError extends Error {
  constructor(
    readonly code: "not_found" | "exists" | "not_managed" | "token_required" | "not_oauth" | "oauth_unavailable" | "oauth_state_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export class McpService {
  readonly #pending = new Map<string, { server: string; expiresAt: number }>();

  constructor(private readonly deps: { gateway: GatewayService; db: Db; bridge: BridgeClient; logger: Logger }) {}

  async list(): Promise<McpServersDto> {
    const { config } = await getConfig<Config>(this.deps.gateway);
    this.#adopt(config);
    const rows = this.deps.db.select().from(mcpServers).all();
    const servers = await Promise.all(rows.map((row) => this.#dto(row, config.mcp?.servers?.[row.name])));
    return { servers };
  }

  async add(req: AddMcpServerRequest, origin: string): Promise<McpServersDto> {
    const { config } = await getConfig<Config>(this.deps.gateway);
    if (config.mcp?.servers?.[req.name] || this.#row(req.name)) throw new McpError("exists", `an MCP server named "${req.name}" already exists`);
    if (req.auth === "token" && !req.token) throw new McpError("token_required", "this server needs a token");
    const entry: Record<string, unknown> = {
      url: req.url,
      transport: /\/sse\/?$/.test(new URL(req.url).pathname) ? "sse" : "streamable-http",
      connectionTimeoutMs: CONNECT_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    };
    if (req.auth === "oauth") Object.assign(entry, { auth: "oauth", oauth: { redirectUrl: new URL(MCP_CALLBACK_PATH, origin).href } });
    // OpenClaw marks headers as sensitive: config reads return them redacted.
    if (req.auth === "token") entry.headers = { Authorization: `Bearer ${req.token}` };
    // Denies first: the server must never be visible to agents that were not chosen, even briefly.
    this.deps.db.insert(mcpServers).values({ name: req.name, url: req.url, auth: req.auth, managed: true }).run();
    this.#setGrants(req.name, req.agentIds);
    await this.syncAccess({ ...config, mcp: { servers: { ...config.mcp?.servers, [req.name]: entry } } });
    try {
      await patchConfig(this.deps.gateway, { mcp: { servers: { [req.name]: entry } } }, { note: "clawdesk: MCP server added" });
    } catch (error) {
      this.deps.db.delete(mcpServers).where(eq(mcpServers.name, req.name)).run();
      await this.syncAccess().catch(() => undefined);
      throw error;
    }
    this.deps.logger.info({ server: req.name, auth: req.auth, agents: req.agentIds }, "MCP server added");
    return this.list();
  }

  async remove(name: string): Promise<McpServersDto> {
    const row = this.#require(name);
    if (!row.managed) throw new McpError("not_managed", "this server is managed on the data sources screen");
    if (row.auth === "oauth") await this.deps.bridge.mcpLogout(name).catch((error: Error) => this.deps.logger.warn({ err: error, server: name }, "MCP sign-out failed"));
    await patchConfig(this.deps.gateway, { mcp: { servers: { [name]: null } } }, { note: "clawdesk: MCP server removed" });
    this.deps.db.delete(mcpServers).where(eq(mcpServers.name, name)).run();
    await this.syncAccess();
    this.deps.logger.info({ server: name }, "MCP server removed");
    return this.list();
  }

  async setAgents(name: string, agentIds: string[]): Promise<McpServersDto> {
    this.#require(name);
    this.#setGrants(name, agentIds);
    await this.syncAccess();
    return this.list();
  }

  /** Starts OAuth sign-in; the provider sends the browser back to MCP_CALLBACK_PATH on `origin`. */
  async loginStart(name: string, origin: string): Promise<StartMcpLoginResultDto> {
    const row = this.#require(name);
    if (row.auth !== "oauth") throw new McpError("not_oauth", "this server does not use sign-in");
    if (!(await this.deps.bridge.available())) throw new McpError("oauth_unavailable", "sign-in needs the ClawDesk bridge in the Gateway image");
    const redirectUrl = new URL(MCP_CALLBACK_PATH, origin).href;
    // The panel may be opened on another address than when the server was added (server vs. local).
    await patchConfig(
      this.deps.gateway,
      (config) => ((config as Config).mcp?.servers?.[name]?.oauth?.redirectUrl === redirectUrl ? null : { mcp: { servers: { [name]: { oauth: { redirectUrl } } } } }),
      { note: "clawdesk: MCP sign-in address" },
    );
    const started = await this.deps.bridge.mcpLoginStart(name);
    if (started.authorized) return { authorizationUrl: null, signedIn: true };
    const state = started.authorizationUrl ? new URL(started.authorizationUrl).searchParams.get("state") : null;
    if (!started.authorizationUrl || !state) throw new McpError("oauth_unavailable", "OpenClaw did not return a sign-in link");
    this.#sweep();
    this.#pending.set(state, { server: name, expiresAt: Date.now() + PENDING_MS });
    return { authorizationUrl: started.authorizationUrl, signedIn: false };
  }

  /** The provider's redirect: only a sign-in this panel started (same state) is accepted. */
  async loginComplete(code: string, state: string): Promise<string> {
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending || Date.now() > pending.expiresAt) throw new McpError("oauth_state_mismatch", "this sign-in was not started here or has expired; start it again");
    await this.deps.bridge.mcpLoginComplete(pending.server, code);
    this.deps.logger.info({ server: pending.server }, "MCP server signed in");
    return pending.server;
  }

  /**
   * Writes every agent's MCP denies from the grants. Run after any change here, after agents
   * are created, and on start (servers added elsewhere, e.g. Notion, become main-only).
   */
  async syncAccess(known?: Config): Promise<void> {
    const config = known ?? (await getConfig<Config>(this.deps.gateway)).config;
    this.#adopt(config);
    const agentIds = await liveAgentIds(this.deps.gateway);
    const grants = new Map<string, Set<string>>();
    for (const grant of this.deps.db.select().from(mcpGrants).all()) {
      grants.set(grant.server, (grants.get(grant.server) ?? new Set()).add(grant.agentId));
    }
    await patchConfig(this.deps.gateway, (current) => mcpAccessPatch({ ...(current as Config), ...(known ? { mcp: known.mcp } : {}) }, agentIds, grants), {
      replacePaths: mcpAccessReplacePaths,
      note: "clawdesk: MCP access per agent",
    });
  }

  // --- internals ---

  /** Servers in OpenClaw's config the panel has not seen yet stay with the main agent only. */
  #adopt(config: Config): void {
    const names = Object.keys(config.mcp?.servers ?? {});
    for (const name of names) {
      if (this.#row(name)) continue;
      const entry = config.mcp!.servers![name]!;
      this.deps.db.insert(mcpServers).values({ name, url: entry.url ?? null, auth: entry.auth === "oauth" ? "oauth" : entry.headers ? "token" : "none", managed: false }).run();
      this.#setGrants(name, [MAIN]);
    }
    for (const row of this.deps.db.select().from(mcpServers).all()) {
      if (!row.managed && !names.includes(row.name)) this.deps.db.delete(mcpServers).where(eq(mcpServers.name, row.name)).run();
    }
  }

  async #dto(row: typeof mcpServers.$inferSelect, entry: ServerConfig | undefined): Promise<McpServerDto> {
    let signedIn: boolean | null = null;
    if (row.auth === "oauth" && entry) signedIn = await this.deps.bridge.mcpStatus(row.name).then((s) => s.hasTokens).catch(() => null);
    const agents = this.deps.db.select().from(mcpGrants).where(eq(mcpGrants.server, row.name)).all().map((g) => g.agentId);
    return { name: row.name, url: row.url, auth: row.auth, signedIn, managed: row.managed, agents };
  }

  #setGrants(name: string, agentIds: string[]): void {
    this.deps.db.transaction((tx) => {
      tx.delete(mcpGrants).where(eq(mcpGrants.server, name)).run();
      for (const agentId of new Set(agentIds)) tx.insert(mcpGrants).values({ server: name, agentId }).run();
    });
  }

  #row(name: string) {
    return this.deps.db.select().from(mcpServers).where(eq(mcpServers.name, name)).get();
  }

  #require(name: string) {
    const row = this.#row(name);
    if (!row) throw new McpError("not_found", "no such MCP server");
    return row;
  }

  #sweep(): void {
    const now = Date.now();
    for (const [state, pending] of this.#pending) if (now > pending.expiresAt) this.#pending.delete(state);
  }
}
