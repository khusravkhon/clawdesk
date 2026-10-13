// Client for the ClawDesk bridge in the Gateway container (deploy/clawdesk-bridge.mjs):
// OpenClaw CLI steps that have no RPC, such as signing in to an OAuth MCP server.

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type McpAuthStatus = { configured: boolean; hasTokens: boolean; state: string | null };

export type BridgeBackup = { name: string; kind: "daily" | "manual" | "before-reset"; createdAt: string; size: number };

export type GoogleLogin = { email: string; services: string[]; readonly: boolean; redirectUri?: string };
export type GoogleBridgeStatus = {
  installed: boolean;
  clients: { client: string; default?: boolean; client_id?: string }[];
  accounts: { email?: string; services?: string[]; scopes?: string[]; client?: string }[];
};

export class BridgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async available(): Promise<boolean> {
    if (!this.token) return false;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  mcpStatus(server: string): Promise<McpAuthStatus> {
    return this.#call("GET", `/mcp/status?server=${encodeURIComponent(server)}`);
  }

  mcpLoginStart(server: string): Promise<{ authorizationUrl?: string; authorized?: boolean }> {
    return this.#call("POST", "/mcp/login/start", { server });
  }

  mcpLoginComplete(server: string, code: string): Promise<{ ok: true }> {
    return this.#call("POST", "/mcp/login/complete", { server, code }, 120_000);
  }

  mcpLogout(server: string): Promise<{ ok: true }> {
    return this.#call("POST", "/mcp/logout", { server });
  }

  googleStatus(): Promise<GoogleBridgeStatus> {
    return this.#call("GET", "/google/status");
  }

  googleCredentials(json: string): Promise<{ ok: true; clientId: string; kind: "installed" | "web" }> {
    return this.#call("POST", "/google/credentials", { json });
  }

  googleLoginStart(login: GoogleLogin): Promise<{ authorizationUrl: string }> {
    return this.#call("POST", "/google/login/start", login);
  }

  googleLoginComplete(login: GoogleLogin & { authUrl: string }): Promise<{ ok: true }> {
    return this.#call("POST", "/google/login/complete", login, 120_000);
  }

  googleRemove(email: string): Promise<{ ok: true }> {
    return this.#call("POST", "/google/remove", { email });
  }

  /** Recovers FreeLLMAPI's single account (one-time code from its log) and sets this password. */
  freellmapiReset(newPassword: string): Promise<{ ok: true }> {
    return this.#call("POST", "/freellmapi/reset", { newPassword }, 60_000);
  }

  /** Makes a backup archive in the server's backups folder; takes minutes for large workspaces. */
  backupCreate(kind: BridgeBackup["kind"]): Promise<BridgeBackup> {
    return this.#call("POST", "/backup/create", { kind }, 20 * 60_000);
  }

  /** Starts the factory reset; the Gateway and the panel stop shortly after this returns. */
  factoryReset(ownerCode: string): Promise<{ started: true }> {
    return this.#call("POST", "/reset", { ownerCode }, 60_000);
  }

  async #call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 90_000): Promise<T> {
    if (!this.token) throw new BridgeError("bridge_unavailable", "the Gateway token is not configured");
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BridgeError("bridge_unavailable", `ClawDesk bridge did not answer: ${(error as Error).message}`);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new BridgeError(data.error ?? "bridge_error", data.message ?? `bridge answered ${res.status}`);
    return data as T;
  }
}
