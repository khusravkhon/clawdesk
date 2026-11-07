import fs from "node:fs/promises";
import path from "node:path";
import type {
  FigmaSourceDto,
  FolderSourceDto,
  GitHubSourceDto,
  GoogleService,
  GoogleSourceDto,
  NotionSourceDto,
  PollGitHubSignInResultDto,
  SourcesDto,
  StartGitHubSignInResultDto,
  StartGoogleLoginResultDto,
  StartNotionOAuthResultDto,
} from "@clawdesk/shared";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import type { BridgeClient, GoogleLogin } from "../gateway/bridge-client.js";
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
export const GOOGLE_CALLBACK_PATH = "/api/sources/google/callback";
const FIGMA_TOKEN_SECRET = "clawdesk.figma.token";
/** ClawDesk's own skills in the Gateway image (deploy/skills). */
const CLAWDESK_SKILLS = "/usr/local/share/clawdesk/skills";

/** Google sends a Desktop-app sign-in back only to loopback; elsewhere the person pastes the address. */
export function googleRedirectFor(panelOrigin: string): string | undefined {
  const url = new URL(panelOrigin);
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1") ? new URL(GOOGLE_CALLBACK_PATH, url).href : undefined;
}

export class SourcesError extends Error {
  constructor(
    readonly code: "notion_token_rejected" | "notion_unreachable" | "oauth_unavailable" | "oauth_state_mismatch" | "google_unavailable" | "figma_token_rejected" | "figma_unreachable",
    message: string,
  ) {
    super(message);
  }
}

type NotionMe = { name?: string | null; bot?: { workspace_name?: string | null } };
type SkillEntry = { enabled?: boolean; apiKey?: unknown };
type SourcesConfig = { skills?: { entries?: Record<string, SkillEntry>; load?: { extraDirs?: string[] } }; mcp?: { servers?: Record<string, unknown> } };
type GitHubStatus = { selected?: { configured?: boolean; identity?: { credentialState?: string; account?: { login?: string } | null } | null } };

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
  /** Google sign-ins started here, by OAuth state. */
  readonly #googlePending = new Map<string, GoogleLogin & { expiresAt: number }>();

  constructor(private readonly deps: SourcesDeps) {
    this.#fetch = deps.fetchImpl ?? fetch;
  }

  async status(): Promise<SourcesDto> {
    const [notion, folder, google, github, figma] = await Promise.all([this.#notion(), this.#folder(), this.#google(), this.#github(), this.#figma()]);
    return { notion, folder, google, github, figma };
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

  // --- Google: the person's own OAuth client, signed in through gog for OpenClaw's gog skill.

  async uploadGoogleClient(json: string): Promise<SourcesDto> {
    await this.#bridgeFor("google").googleCredentials(json);
    this.deps.logger.info("google oauth client stored");
    return this.status();
  }

  async startGoogleLogin(email: string, services: GoogleService[], readonly: boolean, panelOrigin: string): Promise<StartGoogleLoginResultDto> {
    const redirectUri = googleRedirectFor(panelOrigin);
    const login: GoogleLogin = { email, services, readonly, ...(redirectUri ? { redirectUri } : {}) };
    const { authorizationUrl } = await this.#bridgeFor("google").googleLoginStart(login);
    const state = new URL(authorizationUrl).searchParams.get("state");
    if (!state) throw new SourcesError("google_unavailable", "gog did not return a Google sign-in link");
    this.#dropExpired();
    this.#googlePending.set(state, { ...login, expiresAt: Date.now() + OAUTH_PENDING_MS });
    return { authorizationUrl, returnsToPanel: !!redirectUri };
  }

  /** `returnedUrl`: where Google sent the browser (the panel callback, or a pasted localhost address). */
  async completeGoogleLogin(returnedUrl: string): Promise<SourcesDto> {
    this.#dropExpired();
    const state = new URL(returnedUrl).searchParams.get("state") ?? "";
    const login = this.#googlePending.get(state);
    if (!login) throw new SourcesError("oauth_state_mismatch", "this Google sign-in was not started here or has expired; start it again");
    this.#googlePending.delete(state);
    const { expiresAt: _e, ...args } = login;
    await this.#bridgeFor("google").googleLoginComplete({ ...args, authUrl: returnedUrl });
    // The bundled skill uses this account by default; the agent sees Gmail/Drive/Docs through it.
    await patchConfig(this.deps.gateway, { skills: { entries: { gog: { enabled: true, env: { GOG_ACCOUNT: login.email } } } } }, { note: "clawdesk: google source" });
    this.deps.logger.info({ services: login.services, readonly: login.readonly }, "google account connected");
    return this.status();
  }

  async removeGoogle(email: string): Promise<SourcesDto> {
    await this.#bridgeFor("google").googleRemove(email);
    const { config } = await getConfig<{ skills?: { entries?: Record<string, { env?: Record<string, string> }> } }>(this.deps.gateway);
    if (config.skills?.entries?.gog?.env?.GOG_ACCOUNT === email) {
      await patchConfig(this.deps.gateway, { skills: { entries: { gog: { enabled: false, env: { GOG_ACCOUNT: null } } } } }, { note: "clawdesk: google source removed" });
    }
    return this.status();
  }

  // --- GitHub: OpenClaw's own GitHub sign-in (device code) for the main agent only; teams have their own token.

  async startGitHubSignIn(): Promise<StartGitHubSignInResultDto> {
    const res = await this.deps.gateway.request<{ requestId: string; userCode: string; verificationUri: string; expiresInMs: number; pollAfterMs: number }>(
      "tools.github.authorize.start",
      { scope: "agent", agentId: "main" },
    );
    return { requestId: res.requestId, userCode: res.userCode, verificationUri: res.verificationUri, expiresAt: Date.now() + res.expiresInMs, pollAfterMs: res.pollAfterMs };
  }

  async pollGitHubSignIn(requestId: string): Promise<PollGitHubSignInResultDto> {
    const res = await this.deps.gateway.request<{ status: string; retryAfterMs?: number; reason?: string }>("tools.github.authorize.poll", { requestId });
    const retryAfterMs = res.retryAfterMs ?? 5000;
    // GitHub asks to poll slower (slow_down) or the request did not get through (network_error): the sign-in goes
    // on. Stopping here left an approved app without its token (seen live on 2026.8.35).
    if (res.status === "pending" || res.status === "slow_down" || res.status === "network_error") return { status: "pending", retryAfterMs, reason: null };
    if (res.status === "success") {
      this.deps.logger.info("github connected for the main agent");
      return { status: "success", retryAfterMs, reason: null };
    }
    if (res.status === "access_denied" || res.status === "expired") return { status: res.status, retryAfterMs, reason: null };
    // incorrect_device_code, failed (identity_changed | setup_failed) or something new: say which.
    const reason = res.status === "failed" ? (res.reason ?? "failed") : res.status;
    this.deps.logger.warn({ status: res.status, reason: res.reason }, "github sign-in failed");
    return { status: "failed", retryAfterMs, reason };
  }

  async disconnectGitHub(): Promise<SourcesDto> {
    // Back to inheriting: no GitHub identity of its own for the main agent.
    await this.deps.gateway.request("tools.github.configure", { scope: "agent", agentId: "main", mode: "inherit" });
    return this.status();
  }

  async #github(): Promise<GitHubSourceDto> {
    try {
      const st = await this.deps.gateway.request<GitHubStatus>("tools.github.status", { agentId: "main", selectedScope: "agent" });
      const identity = st.selected?.configured ? st.selected.identity : null;
      return { connected: identity?.credentialState === "available", account: identity?.account?.login ?? null, error: null };
    } catch (e) {
      return { connected: false, account: null, error: (e as Error).message };
    }
  }

  // --- Figma: a personal access token for ClawDesk's read-only figma skill.

  async connectFigmaToken(token: string): Promise<SourcesDto> {
    let res: Response;
    try {
      res = await this.#fetch("https://api.figma.com/v1/me", { headers: { "x-figma-token": token }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new SourcesError("figma_unreachable", `Figma did not answer: ${(error as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new SourcesError("figma_token_rejected", "Figma rejected this token");
    if (!res.ok) throw new SourcesError("figma_unreachable", `Figma answered ${res.status}`);
    const me = (await res.json()) as { handle?: string; email?: string };
    await this.deps.gateway.request("secrets.store.set", { name: FIGMA_TOKEN_SECRET, value: token, kind: "secret", allowedHosts: ["api.figma.com"] });
    const { config } = await getConfig<SourcesConfig>(this.deps.gateway);
    const dirs = [...new Set([...(config.skills?.load?.extraDirs ?? []), CLAWDESK_SKILLS])];
    await patchConfig(
      this.deps.gateway,
      { skills: { load: { extraDirs: dirs }, entries: { figma: { enabled: true, apiKey: { source: "store", provider: "default", id: FIGMA_TOKEN_SECRET } } } } },
      { note: "clawdesk: figma source" },
    );
    this.#saveRow("figma", "skill:figma", JSON.stringify({ handle: me.handle ?? me.email ?? null }), "connected", "figma");
    this.deps.logger.info("figma connected");
    return this.status();
  }

  async disconnectFigma(): Promise<SourcesDto> {
    await patchConfig(this.deps.gateway, { skills: { entries: { figma: { enabled: false, apiKey: null } } } }, { note: "clawdesk: figma source removed" });
    await this.deps.gateway.request("secrets.store.delete", { name: FIGMA_TOKEN_SECRET }).catch(() => undefined);
    this.deps.db.delete(dataSources).where(eq(dataSources.id, "figma")).run();
    return this.status();
  }

  async #figma(): Promise<FigmaSourceDto> {
    const row = this.deps.db.select().from(dataSources).where(eq(dataSources.id, "figma")).get();
    try {
      const { config } = await getConfig<SourcesConfig>(this.deps.gateway);
      const entry = config.skills?.entries?.figma;
      const connected = !!entry?.apiKey && entry.enabled !== false;
      return { connected, handle: connected && row?.scope ? ((JSON.parse(row.scope) as { handle?: string | null }).handle ?? null) : null, error: null };
    } catch (e) {
      return { connected: false, handle: null, error: (e as Error).message };
    }
  }

  #bridgeFor(what: "google"): BridgeClient {
    if (!this.deps.bridge) throw new SourcesError(`${what}_unavailable`, "the ClawDesk bridge is not configured");
    return this.deps.bridge;
  }

  #dropExpired(): void {
    const now = Date.now();
    for (const [state, p] of this.#googlePending) if (p.expiresAt < now) this.#googlePending.delete(state);
  }

  async #google(): Promise<GoogleSourceDto> {
    const empty: GoogleSourceDto = { available: false, clientConfigured: false, clientId: null, accounts: [], error: null };
    const bridge = this.deps.bridge;
    if (!bridge || !(await bridge.available())) return empty;
    try {
      const st = await bridge.googleStatus();
      if (!st.installed) return empty;
      return {
        available: true,
        clientConfigured: st.clients.length > 0,
        clientId: st.clients.find((c) => c.default)?.client_id ?? st.clients[0]?.client_id ?? null,
        accounts: st.accounts.filter((a) => a.email).map((a) => ({ email: a.email!, services: a.services ?? [] })),
        error: null,
      };
    } catch (e) {
      return { ...empty, available: true, error: (e as Error).message };
    }
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
    let sync: FolderSourceDto["sync"] = null;
    try { sync = await this.deps.bridge?.folderSyncStatus() ?? null; } catch { /* Older bridges may not expose synchronization status yet. */ }
    const empty: FolderSourceDto = { available: false, hostPath: hostPath ?? null, agentPath: FOLDER_AGENT_PATH, files: [], total: 0, sync };
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
    return { available: true, hostPath: hostPath ?? dir, agentPath: FOLDER_AGENT_PATH, files: files.slice(0, FOLDER_LIST_LIMIT), total: files.length, sync };
  }

  #saveRow(id: string, connectorRef: string, scope: string, status: "pending" | "connected" | "error", kind: "notion" | "figma" = "notion"): void {
    this.deps.db
      .insert(dataSources)
      .values({ id, kind, connectorRef, scope, status })
      .onConflictDoUpdate({ target: dataSources.id, set: { connectorRef, scope, status } })
      .run();
  }
}
