import fs from "node:fs/promises";
import path from "node:path";
import type { FolderSourceDto, NotionSourceDto, SourcesDto, StartNotionOAuthResultDto } from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import { dataSources } from "../db/schema.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";

// Data sources for the main agent (screen 5).
//
// Notion, way 1 — integration secret: checked against the Notion API, stored write-only in the
// Gateway secret store and handed to OpenClaw's bundled `notion` skill (skills.entries.notion.apiKey).
// Notion, way 2 — sign-in on Notion's own page: OpenClaw's MCP client for https://mcp.notion.com/mcp
// (mcp.servers.notion, auth "oauth"). There is no RPC for MCP sign-in, so the ClawDesk bridge in the
// Gateway container runs `openclaw mcp login`; Notion sends the browser back to the panel with the code.
//
// Folder: the person's folder is mounted into the main agent's workspace as files/ (deploy/docker-compose.yml);
// the panel only lists it.

const NOTION_TOKEN_SECRET = "clawdesk.notion.token";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const FOLDER_AGENT_PATH = "files/";
const FOLDER_LIST_LIMIT = 50;
const NOTION_MCP = "notion";
const NOTION_MCP_URL = "https://mcp.notion.com/mcp";
export const NOTION_CALLBACK_PATH = "/api/sources/notion/callback";
const OAUTH_PENDING_MS = 10 * 60_000;

export class SourcesError extends Error {
  constructor(
    readonly code: "notion_token_rejected" | "notion_unreachable" | "oauth_unavailable" | "oauth_state_mismatch",
    message: string,
  ) {
    super(message);
  }
}

type NotionMe = { name?: string | null; bot?: { workspace_name?: string | null } };
type SkillEntry = { enabled?: boolean; apiKey?: unknown };
type SourcesConfig = { skills?: { entries?: Record<string, SkillEntry> }; mcp?: { servers?: Record<string, unknown> } };

export type SourcesDeps = {
  gateway: GatewayService;
  db: Db;
  logger: Logger;
  files: { dir: string | undefined; hostPath: string | undefined };
  /** Injected for tests; Notion API calls. */
  fetchImpl?: typeof fetch;
  /** ClawDesk bridge in the Gateway container; absent or unreachable disables Notion sign-in. */
  bridge?: BridgeClient;
};

export class SourcesService {
  readonly #fetch: typeof fetch;
  /** OAuth state of the sign-in started from this panel; the callback must bring it back. */
  #pending: { state: string; expiresAt: number } | null = null;

  constructor(private readonly deps: SourcesDeps) {
    this.#fetch = deps.fetchImpl ?? fetch;
  }

  async status(): Promise<SourcesDto> {
    const [notion, folder] = await Promise.all([this.#notion(), this.#folder()]);
    return { notion, folder };
  }

  /** Checks the secret with Notion first; nothing is stored when Notion refuses it. */
  async connectNotionToken(token: string): Promise<SourcesDto> {
    const me = await this.#notionMe(token);
    await this.deps.gateway.request("secrets.store.set", { name: NOTION_TOKEN_SECRET, value: token, kind: "secret", allowedHosts: ["api.notion.com"] });
    await patchConfig(
      this.deps.gateway,
      { skills: { entries: { notion: { enabled: true, apiKey: { source: "store", provider: "default", id: NOTION_TOKEN_SECRET } } } } },
      { note: "clawdesk: notion source" },
    );
    const label = me.bot?.workspace_name ?? null;
    this.#saveRow("notion", "skill:notion", JSON.stringify({ workspace: label, integration: me.name ?? null }), "connected");
    this.deps.logger.info({ workspace: label }, "notion connected with an integration secret");
    return this.status();
  }

  /**
   * Starts sign-in on Notion's page. The MCP server entry points Notion back at this panel
   * (`redirectBase` is the origin the person opened the panel on).
   */
  async startNotionOAuth(redirectBase: string): Promise<StartNotionOAuthResultDto> {
    const bridge = this.deps.bridge;
    if (!bridge || !(await bridge.available())) throw new SourcesError("oauth_unavailable", "sign-in through Notion needs the ClawDesk bridge in the Gateway image");
    const redirectUrl = new URL(NOTION_CALLBACK_PATH, redirectBase).href;
    await patchConfig(
      this.deps.gateway,
      { mcp: { servers: { [NOTION_MCP]: { url: NOTION_MCP_URL, transport: "streamable-http", auth: "oauth", oauth: { redirectUrl } } } } },
      { note: "clawdesk: notion sign-in" },
    );
    const started = await bridge.mcpLoginStart(NOTION_MCP);
    if (started.authorized) {
      this.#saveRow("notion", `mcp:${NOTION_MCP}`, JSON.stringify({ method: "oauth" }), "connected");
      return { authorizationUrl: null, connected: true };
    }
    const state = started.authorizationUrl ? new URL(started.authorizationUrl).searchParams.get("state") : null;
    if (!started.authorizationUrl || !state) throw new SourcesError("oauth_unavailable", "OpenClaw did not return a Notion sign-in link");
    this.#pending = { state, expiresAt: Date.now() + OAUTH_PENDING_MS };
    return { authorizationUrl: started.authorizationUrl, connected: false };
  }

  /** Notion's redirect: only the sign-in this panel started (same state) is accepted. */
  async completeNotionOAuth(code: string, state: string): Promise<void> {
    const pending = this.#pending;
    if (!pending || pending.state !== state || Date.now() > pending.expiresAt) {
      throw new SourcesError("oauth_state_mismatch", "this Notion sign-in was not started here or has expired; start it again");
    }
    this.#pending = null;
    await this.deps.bridge!.mcpLoginComplete(NOTION_MCP, code);
    this.#saveRow("notion", `mcp:${NOTION_MCP}`, JSON.stringify({ method: "oauth" }), "connected");
    this.deps.logger.info("notion connected through sign-in");
  }

  /** Removes both ways of access: the integration secret and the MCP sign-in. */
  async disconnectNotion(): Promise<SourcesDto> {
    const { config } = await getConfig<SourcesConfig>(this.deps.gateway);
    const patch: Record<string, unknown> = {};
    // null removes a key in a JSON merge patch.
    if (config.skills?.entries?.notion?.apiKey) patch.skills = { entries: { notion: { apiKey: null } } };
    if (config.mcp?.servers?.[NOTION_MCP]) {
      await this.deps.bridge?.mcpLogout(NOTION_MCP).catch((error: Error) => this.deps.logger.warn({ err: error }, "notion sign-out failed"));
      patch.mcp = { servers: { [NOTION_MCP]: null } };
    }
    if (Object.keys(patch).length) await patchConfig(this.deps.gateway, patch, { note: "clawdesk: notion source removed" });
    await this.deps.gateway.request("secrets.store.delete", { name: NOTION_TOKEN_SECRET }).catch((error: Error) => {
      this.deps.logger.debug({ err: error }, "notion secret was not stored");
    });
    this.deps.db.delete(dataSources).where(eq(dataSources.id, "notion")).run();
    this.#pending = null;
    this.deps.logger.info("notion disconnected");
    return this.status();
  }

  async #notionMe(token: string): Promise<NotionMe> {
    let res: Response;
    try {
      res = await this.#fetch(`${NOTION_API}/users/me`, {
        headers: { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new SourcesError("notion_unreachable", `Notion did not answer: ${(error as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new SourcesError("notion_token_rejected", "Notion rejected this integration secret");
    if (!res.ok) throw new SourcesError("notion_unreachable", `Notion answered ${res.status}`);
    return (await res.json()) as NotionMe;
  }

  async #notion(): Promise<NotionSourceDto> {
    const row = this.deps.db.select().from(dataSources).where(eq(dataSources.id, "notion")).get();
    const meta = row?.scope ? (JSON.parse(row.scope) as { workspace?: string | null; integration?: string | null }) : {};
    const oauthAvailable = (await this.deps.bridge?.available()) ?? false;
    let viaToken = false;
    let viaOAuth = false;
    let error: string | null = null;
    try {
      const { config } = await getConfig<SourcesConfig>(this.deps.gateway);
      const entry = config.skills?.entries?.notion;
      viaToken = !!entry?.apiKey && entry.enabled !== false;
      if (config.mcp?.servers?.[NOTION_MCP] && oauthAvailable) viaOAuth = (await this.deps.bridge!.mcpStatus(NOTION_MCP)).hasTokens;
    } catch (e) {
      error = (e as Error).message;
    }
    const connected = viaToken || viaOAuth;
    return {
      connected,
      method: viaOAuth ? "oauth" : viaToken ? "token" : null,
      workspace: viaToken ? (meta.workspace ?? null) : null,
      integration: viaToken ? (meta.integration ?? null) : null,
      oauthAvailable,
      error,
    };
  }

  async #folder(): Promise<FolderSourceDto> {
    const { dir, hostPath } = this.deps.files;
    const empty: FolderSourceDto = { available: false, hostPath: hostPath ?? null, agentPath: FOLDER_AGENT_PATH, files: [], total: 0 };
    if (!dir) return empty;
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => !n.startsWith("."));
    } catch {
      return empty;
    }
    const entries = await Promise.all(
      names.map(async (name) => {
        const st = await fs.stat(path.join(dir, name)).catch(() => null);
        return st ? { name, size: st.isDirectory() ? 0 : st.size, modifiedAt: st.mtimeMs, isDir: st.isDirectory() } : null;
      }),
    );
    const files = entries.filter((e) => e !== null).sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { available: true, hostPath: hostPath ?? dir, agentPath: FOLDER_AGENT_PATH, files: files.slice(0, FOLDER_LIST_LIMIT), total: files.length };
  }

  #saveRow(id: string, connectorRef: string, scope: string, status: "pending" | "connected" | "error"): void {
    this.deps.db
      .insert(dataSources)
      .values({ id, kind: "notion", connectorRef, scope, status })
      .onConflictDoUpdate({ target: dataSources.id, set: { connectorRef, scope, status } })
      .run();
  }
}
