import { FolderSyncStatusesDto, type OpenClawUpdateDto, type PullRequestDto, type TeamRepoStatusDto } from "@clawdesk/shared";

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

/** Claude Code's login in the Gateway (Claude plan sign-in). */
export type ClaudeLoginStatus = { installed: boolean; loggedIn: boolean; method?: string | null; subscription: string | null; email?: string | null };

/**
 * What the video worker reports back. Either subtitles, or the audio track when the video has
 * none, or an error code — never a free-form message, and never both a result and an error.
 */
export type BridgeVideoResult = {
  source?: "subtitles" | "speech" | "frames" | "file";
  title?: string | null;
  durationSec?: number | null;
  language?: string | null;
  /** WebVTT or SRT as the site served it; the panel turns it into a transcript. */
  subtitles?: string;
  audio?: { mimeType: string; fileName: string; content: string; durationMs?: number | null };
  /** Sampled frames, each with the second of the video it was taken at. */
  frames?: { atSec: number; mimeType: string; fileName: string; content: string }[];
  /** The kept original: its path inside the panel's video directory, and its size. */
  file?: { name: string; bytes: number };
  error?: string;
};

export type BridgeBackup = { name: string; kind: "daily" | "manual" | "before-reset" | "before-update"; createdAt: string; size: number };

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

  storageStatus(): Promise<import("@clawdesk/shared").StorageStatusDto> {
    return this.#call("GET", "/storage/status", undefined, 30_000);
  }
  storageQuota(videoQuotaBytes: number | null): Promise<import("@clawdesk/shared").StorageStatusDto> {
    return this.#call("POST", "/storage/quota", { videoQuotaBytes }, 30_000);
  }
  storagePreview(category: import("@clawdesk/shared").StorageCategory): Promise<import("@clawdesk/shared").StoragePreviewDto> {
    return this.#call("POST", "/storage/preview", { category }, 30_000);
  }
  storageCleanup(token: string): Promise<import("@clawdesk/shared").StorageCleanupDto> {
    return this.#call("POST", "/storage/cleanup", { token, confirm: true }, 30_000);
  }

  /** Starts the pinned worker for one video; the call ends when the worker does. */
  studyVideo(request: { jobId: string; url: string; maxDurationSec: number; maxAudioBytes: number; maxSeconds: number }): Promise<BridgeVideoResult> {
    return this.#call("POST", "/video/study", request, (request.maxSeconds + 30) * 1000);
  }

  /** Frames only: no subtitles and no audio are touched by this call. */
  framesOfVideo(request: { jobId: string; url: string; maxDurationSec: number; maxFrames: number; maxFrameBytes: number; maxSeconds: number }): Promise<BridgeVideoResult> {
    return this.#call("POST", "/video/frames", request, (request.maxSeconds + 30) * 1000);
  }

  /** The original file, written into the panel's video directory by the worker. */
  downloadVideo(request: { jobId: string; url: string; maxDurationSec: number; maxFileBytes: number; maxSeconds: number }): Promise<BridgeVideoResult> {
    return this.#call("POST", "/video/download", request, (request.maxSeconds + 60) * 1000);
  }

  /** How far a running download got, as a percentage, or null when the worker said nothing yet. */
  videoProgress(jobId: string): Promise<{ percent: number | null }> {
    return this.#call("GET", "/video/progress?jobId=" + encodeURIComponent(jobId), undefined, 10_000);
  }

  cancelVideo(jobId: string): Promise<{ stopped: boolean }> {
    return this.#call("POST", "/video/cancel", { jobId }, 30_000);
  }

  mcpStatus(server: string): Promise<McpAuthStatus> {
    return this.#call("GET", `/mcp/status?server=${encodeURIComponent(server)}`);
  }

  telegramApproved(accountId: string): Promise<{ senderIds: string[] }> {
    return this.#call("GET", `/telegram/approved?accountId=${encodeURIComponent(accountId)}`);
  }

  telegramAudioStatus(): Promise<{ configured: boolean; providers?: { openai: boolean; groq: boolean } }> {
    return this.#call("GET", "/telegram/audio");
  }

  telegramAudioKey(apiKey: string, provider = "openai", model?: string): Promise<{ configured: boolean }> {
    return this.#call("POST", "/telegram/audio", { apiKey, provider, model }, 120_000);
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

  claudeStatus(): Promise<ClaudeLoginStatus> {
    return this.#call("GET", "/claude/status", undefined, 40_000);
  }

  /** Starts Claude Code's own sign-in; it then waits in the Gateway for the code from the page. */
  claudeLoginStart(): Promise<{ authorizationUrl: string }> {
    return this.#call("POST", "/claude/login/start", {}, 60_000);
  }

  claudeLoginComplete(code: string): Promise<ClaudeLoginStatus> {
    return this.#call("POST", "/claude/login/complete", { code }, 150_000);
  }

  /** Removes one agent's skills/<slug> folder (OpenClaw has no RPC for it). */
  skillsRemove(dir: string): Promise<{ removed: boolean }> {
    return this.#call("POST", "/skills/remove", { dir }, 60_000);
  }

  claudeLogout(): Promise<{ ok: true }> {
    return this.#call("POST", "/claude/logout", {}, 40_000);
  }

  localMemoryStatus(): Promise<import("@clawdesk/shared").LocalMemoryStatusDto> {
    return this.#call("GET", "/memory/status", undefined, 5_000);
  }

  localMemorySearch(agentId: string, query: string): Promise<import("@clawdesk/shared").LocalMemorySearchDto> {
    return this.#call("POST", "/memory/search", { agentId, query }, 130_000);
  }

  localMemoryAction(action: "setup" | "reindex" | "check", consent: boolean): Promise<import("@clawdesk/shared").LocalMemoryStatusDto> {
    return this.#call("POST", "/memory/action", { action, consent }, 5_000);
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

  projectWorkspace(projectId: string): Promise<import("@clawdesk/shared").ProjectWorkspaceDto> {
    return this.#call("GET", `/projects/workspace?projectId=${encodeURIComponent(projectId)}`);
  }

  builderStatus(projectId: string): Promise<import("@clawdesk/shared").ProjectBuilderRuntimeDto> {
    return this.#call("GET", `/projects/builder?projectId=${encodeURIComponent(projectId)}`);
  }

  prepareProjectApp(projectId: string, request: { planId: string; templateId: string; projectName: string; brief: import("@clawdesk/shared").ProjectBriefFields; rules: import("@clawdesk/shared").BusinessRuleDto[] }): Promise<import("@clawdesk/shared").ProjectBuilderRuntimeDto> {
    return this.#call("POST", "/projects/builder/prepare", { projectId, ...request });
  }

  startProjectPreview(projectId: string, request: { planId: string }): Promise<import("@clawdesk/shared").ProjectBuilderRuntimeDto> {
    return this.#call("POST", "/projects/builder/start", { projectId, ...request });
  }

  /** The project's own checks in a throwaway container (on given files, e.g. a work copy); up to two minutes. */
  runProjectChecks(projectId: string, files?: Record<string, string>): Promise<import("@clawdesk/shared").ProjectChecksRunResult> {
    return this.#call("POST", "/projects/builder/checks", { projectId, ...(files ? { files } : {}) }, 180_000);
  }

  /** The app's current flat files (P6.2 baseline and review). */
  projectAppFiles(projectId: string): Promise<{ files: Record<string, string> }> {
    return this.#call("GET", `/projects/builder/files?projectId=${encodeURIComponent(projectId)}`);
  }

  /** Writes accepted work into app/ if it still matches `baseline` (name → sha256). */
  applyProjectWork(projectId: string, files: Record<string, string>, baseline: Record<string, string>): Promise<{ files: string[]; applied: true }> {
    return this.#call("POST", "/projects/builder/apply", { projectId, files, baseline });
  }

  /** An executor's work copy: its path (created if missing), refilled for a stage, or read back. */
  /** The executor agent's work copy: the folder "project" in its own workspace (/workspace/project in its sandbox). */
  ensureProjectWork(agentId: string): Promise<{ path: string }> {
    return this.#call("POST", "/projects/work/ensure", { agentId });
  }

  prepareProjectWork(agentId: string, files: Record<string, string>): Promise<{ path: string; files: string[] }> {
    return this.#call("POST", "/projects/work/prepare", { agentId, files });
  }

  snapshotProjectWork(agentId: string): Promise<{ files: Record<string, string>; ignored: string[]; hashes: Record<string, string> }> {
    return this.#call("POST", "/projects/work/snapshot", { agentId });
  }

  stopProjectPreview(projectId: string): Promise<import("@clawdesk/shared").ProjectBuilderRuntimeDto> {
    return this.#call("POST", "/projects/builder/stop", { projectId });
  }

  projectPreviewRequest(projectId: string, request: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown }): Promise<{ status: number; contentType: string; body: string }> {
    return this.#call("POST", "/projects/builder/request", { projectId, ...request });
  }

  analyzeProjectWorkspace(projectId: string): Promise<{ files: string[]; dependencies: string[]; hasGit: boolean; truncated: boolean }> {
    return this.#call("GET", `/projects/builder/analyze?projectId=${encodeURIComponent(projectId)}`);
  }

  prepareProjectWorkspace(projectId: string, request: import("@clawdesk/shared").PrepareProjectWorkspaceRequest): Promise<import("@clawdesk/shared").ProjectWorkspaceDto> {
    return this.#call("POST", "/projects/workspace", { projectId, ...request });
  }

  /** Makes (or finds) a junior agent's folder in the shared files folder. */
  ensureFolder(name: string): Promise<{ hostPath: string; gatewayPath: string }> {
    return this.#call("POST", "/files/folder", { name });
  }

  /**
   * Exchanges files with the junior's managed workspace, without a host bind in its sandbox. `dir` puts the
   * copy at a fixed workspace folder (a team's "docs"); `readOnly` only mirrors the shared folder into it.
   */
  ensureAgentFolder(agentId: string, name: string, options: { dir?: "docs"; readOnly?: boolean } = {}): Promise<{ hostPath: string; gatewayPath: string }> {
    return this.#call("POST", "/files/agent-folder", { agentId, name, ...options }, 120_000);
  }

  /** Stops synchronizing a folder for an agent and deletes the agent's copy (stage 5 revocation). */
  removeAgentFolder(agentId: string, name: string, options: { dir?: "docs" } = {}): Promise<{ removed: boolean }> {
    return this.#call("POST", "/files/agent-folder/remove", { agentId, name, ...options }, 60_000);
  }

  /** Folder names in the shared files folder. */
  sharedFolders(): Promise<{ folders: string[] }> {
    return this.#call("GET", "/files/folders");
  }

  /** P9: a load check of the project's app (app and load client in separate containers). */
  projectLoad(projectId: string, request: { concurrency: number; durationMs: number }): Promise<{ conditions: import("@clawdesk/shared").LoadConditionsDto; result: import("@clawdesk/shared").LoadResultDto | null; error: string | null }> {
    return this.#call("POST", "/projects/builder/load", { projectId, ...request }, request.durationMs + 120_000);
  }

  /** P0: versions of OpenClaw and of the tools the container has (null when missing). */
  capabilities(): Promise<{ openclaw: string | null; docker: string | null; git: string | null; gog: string | null }> {
    return this.#call("GET", "/capabilities", undefined, 20_000);
  }

  /** P8: a project's files for a transfer package (base64 with hashes), and a package's files into a new folder. */
  projectTransferRead(projectId: string): Promise<{ files: { path: string; size: number; sha256: string; data: string }[]; excluded: { path: string; reason: string }[]; mode: string }> {
    return this.#call("POST", "/projects/transfer/read", { projectId }, 120_000);
  }
  projectTransferWrite(projectId: string, files: { path: string; size: number; sha256: string; data: string }[]): Promise<{ written: number; bytes: number }> {
    return this.#call("POST", "/projects/transfer/write", { projectId, files }, 180_000);
  }

  /** Stage 7: one Google Doc as a read-only copy in the agent's workspace (google/<id>.md), exported with the owner's account. */
  googleDocCopy(agentId: string, docId: string, account: string): Promise<{ docId: string; title: string; revision: string | null; copiedAt: number; sha: string; path: string }> {
    return this.#call("POST", "/google/doc/copy", { agentId, docId, account }, 120_000);
  }
  googleDocRemove(agentId: string, docId: string): Promise<{ removed: true }> {
    return this.#call("POST", "/google/doc/remove", { agentId, docId });
  }
  googleDocList(agentId: string): Promise<{ copies: { docId: string; sha: string }[] }> {
    return this.#call("POST", "/google/doc/list", { agentId });
  }

  /** The owner's files in the shared folder (deploy/clawdesk-owner-files.mjs). */
  ownerFiles(): Promise<{ files: { path: string; size: number; modifiedAt: number }[] }> {
    return this.#call("GET", "/owner-files/list", undefined, 30_000);
  }
  /** A file sent to the bot or the chat (media://inbound/<id>) saved into «Входящие»; returns its path there. */
  ownerFileStore(inbound: string, name?: string): Promise<{ path: string; size: number; sha: string }> {
    return this.#call("POST", "/owner-files/store", { inbound, ...(name ? { name } : {}) }, 60_000);
  }
  ownerFileUpload(name: string, base64: string): Promise<{ path: string; size: number; sha: string }> {
    return this.#call("POST", "/owner-files/upload", { name, base64 }, 120_000);
  }
  /** One file as a read-only copy in the agent's inbox (/workspace/inbox/…). */
  ownerFileCopy(agentId: string, file: string): Promise<{ path: string; size: number; sha: string; copiedAt: number }> {
    return this.#call("POST", "/owner-files/copy", { agentId, file }, 60_000);
  }
  ownerFileRemove(agentId: string, file: string): Promise<{ removed: true }> {
    return this.#call("POST", "/owner-files/remove", { agentId, file });
  }
  ownerFileCopies(agentId: string): Promise<{ copies: { file: string; sha: string }[] }> {
    return this.#call("POST", "/owner-files/copies", { agentId });
  }

  async folderSyncStatus(): Promise<FolderSyncStatusesDto> {
    return FolderSyncStatusesDto.parse(await this.#call("GET", "/files/sync-status", undefined, 5_000));
  }

  /** Clones a team's repository for the panel; the token stays aside. Members get copies with teamMember. */
  teamClone(teamId: string, repoUrl: string, token: string): Promise<{ defaultBranch: string; branch: string }> {
    return this.#call("POST", "/teams/clone", { teamId, repoUrl, token }, 10 * 60_000);
  }

  /** A member's copy at <its workspace>/repo (/workspace/repo in its sandbox): the developer's branch, or a read copy. */
  teamMember(teamId: string, agentId: string, role: "pm" | "developer" | "reviewer"): Promise<{ path: string; moved: boolean }> {
    return this.#call("POST", "/teams/member", { teamId, agentId, role }, 10 * 60_000);
  }

  teamStatus(teamId: string, developer?: string): Promise<TeamRepoStatusDto> {
    return this.#call("GET", `/teams/status?teamId=${encodeURIComponent(teamId)}${developer ? `&developer=${encodeURIComponent(developer)}` : ""}`);
  }

  /** New commits from GitHub; read copies of PM and reviewer are refreshed. */
  teamFetch(teamId: string, members: { agentId: string; role: "pm" | "developer" | "reviewer" }[]): Promise<TeamRepoStatusDto> {
    return this.#call("POST", "/teams/fetch", { teamId, members }, 5 * 60_000);
  }

  /** Pushes the developer's branch (read into the panel's clone) and opens (or finds) its pull request. */
  teamPush(teamId: string, repoUrl: string, developer: string | undefined, title: string, body: string): Promise<PullRequestDto> {
    return this.#call("POST", "/teams/push", { teamId, repoUrl, developer, title, body }, 5 * 60_000);
  }

  /** P7: the project's GitHub connection (the token is never returned). */
  projectGitHub(projectId: string): Promise<import("@clawdesk/shared").ProjectGitHubDto> {
    return this.#call("GET", `/projects/github/status?projectId=${encodeURIComponent(projectId)}`, undefined, 60_000);
  }

  projectGitHubPlan(projectId: string): Promise<import("@clawdesk/shared").ProjectGitHubPlanDto> {
    return this.#call("GET", `/projects/github/plan?projectId=${encodeURIComponent(projectId)}`, undefined, 60_000);
  }

  projectGitHubChanges(projectId: string): Promise<import("@clawdesk/shared").ProjectGitHubChangesDto> {
    return this.#call("GET", `/projects/github/changes?projectId=${encodeURIComponent(projectId)}`, undefined, 60_000);
  }

  /** Creates (or continues with this project's) repository and pushes exactly the confirmed plan. */
  createProjectRepo(projectId: string, body: { token?: string; owner: string; name: string; visibility: "private" | "public"; planHash: string; requestId: string }): Promise<import("@clawdesk/shared").ProjectGitHubDto> {
    return this.#call("POST", "/projects/github/create", { projectId, ...body }, 10 * 60_000);
  }

  connectProjectRepo(projectId: string, body: { token?: string; requestId: string }): Promise<import("@clawdesk/shared").ProjectGitHubDto> {
    return this.#call("POST", "/projects/github/connect", { projectId, ...body }, 60_000);
  }

  importProjectRepo(projectId: string, body: { token?: string; url: string; folder: string; requestId: string }): Promise<import("@clawdesk/shared").ProjectGitHubDto> {
    return this.#call("POST", "/projects/github/import", { projectId, ...body }, 15 * 60_000);
  }

  projectPullRequest(projectId: string, body: { title: string; body: string; changesHash: string; requestId: string }): Promise<import("@clawdesk/shared").ProjectPullRequestDto> {
    return this.#call("POST", "/projects/github/pull-request", { projectId, ...body }, 10 * 60_000);
  }

  disconnectProjectGitHub(projectId: string): Promise<{ ok: true }> {
    return this.#call("POST", "/projects/github/disconnect", { projectId });
  }

  /** Entries the clawdesk-requests plugin filed (oldest first), and names of unreadable ones. */
  requestsSpool(): Promise<{ entries: Record<string, unknown>[]; rejected: string[] }> {
    return this.#call("GET", "/requests/spool");
  }

  /** Removes spool entries the panel has stored. */
  requestsAck(ids: string[]): Promise<{ removed: number }> {
    return this.#call("POST", "/requests/ack", { ids });
  }

  teamRemove(teamId: string): Promise<{ ok: true }> {
    return this.#call("POST", "/teams/remove", { teamId });
  }

  /** Makes a backup archive in the server's backups folder; takes minutes for large workspaces. */
  backupCreate(kind: BridgeBackup["kind"]): Promise<BridgeBackup> {
    return this.#call("POST", "/backup/create", { kind }, 20 * 60_000);
  }

  backupDelete(name: string): Promise<{ deleted: true; name: string }> {
    return this.#call("POST", "/backup/delete", { name, confirm: true }, 30_000);
  }

  /** The running OpenClaw, the verified newer one and the last update (deploy/clawdesk-openclaw-update.mjs). */
  openclawUpdate(): Promise<Omit<OpenClawUpdateDto, "available">> {
    return this.#call("GET", "/openclaw/update", undefined, 30_000);
  }

  /** Starts the backup and the update helper; the Gateway and the panel restart a few minutes later. */
  startOpenclawUpdate(version: string): Promise<{ started: true; version: string }> {
    return this.#call("POST", "/openclaw/update", { version }, 60_000);
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
