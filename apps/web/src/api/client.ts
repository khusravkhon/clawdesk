import type {
  ActivateApiKeyRequest,
  ActivateResultDto,
  AgentListDto,
  AiCatalogDto,
  AiStatusDto,
  ApprovalDecision,
  ApprovalsDto,
  AssistantDto,
  AssistantProfile,
  AuthStateDto,
  AuditPageDto,
  UsageDto,
  CreateSpaceRequest,
  CreateTeamRequest,
  PullRequestDto,
  TeamDto,
  TeamRepoStatusDto,
  TeamsDto,
  LinkTeamTelegramRequest,
  SpaceDto,
  BackupDto,
  BackupsDto,
  FactoryResetResultDto,
  MemoryProvider,
  ExecMode,
  ChatHistoryDto,
  ApiErrorDto,
  ApproveTelegramResultDto,
  CreateAgentRequest,
  CreateAgentResultDto,
  CreateScheduleRequest,
  DashboardDto,
  DashboardRange,
  FreeModelsStatusDto,
  HealthDto,
  ScheduleListDto,
  ScheduleRunDto,
  UpdateScheduleRequest,
  InstallProviderResultDto,
  SignInAnswerRequest,
  SignInStateDto,
  SourcesDto,
  StartGitHubSignInResultDto,
  PollGitHubSignInResultDto,
  StartGoogleLoginResultDto,
  StartNotionOAuthResultDto,
  StartSignInRequest,
  AgentTopicsDto,
  LinkAgentTopicsRequest,
  AgentProfileDto,
  SaveAgentProfileRequest,
  SaveAsTemplateRequest,
  ModelChainDto,
  SaveModelChainRequest,
  TelegramPairingRequestDto,
  TelegramStatusDto,
  TelegramBotDto,
  TelegramVoiceDto,
  TemplateDto,
} from "@clawdesk/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorDto,
  ) {
    super(body.message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { accept: "application/json", ...init?.headers } });
  const body = (await res.json().catch(() => ({ error: "bad_response", message: res.statusText }))) as unknown;
  // Session ended (signed out elsewhere, password changed, 30 days unused): back to the sign-in screen.
  if (res.status === 401 && (body as ApiErrorDto).error === "unauthorized" && !location.pathname.startsWith("/login")) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
  if (!res.ok) throw new ApiError(res.status, body as ApiErrorDto);
  return body as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** The person's own time zone; the panel server may run in UTC. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const q = (agentId: string) => `agentId=${encodeURIComponent(agentId)}`;

export const api = {
  auth: {
    state: () => request<AuthStateDto>("/api/auth/state"),
    setup: (code: string, password: string) => post<AuthStateDto>("/api/auth/setup", { code, password }),
    login: (password: string) => post<AuthStateDto>("/api/auth/login", { password }),
    logout: () => post<{ ok: true }>("/api/auth/logout"),
    telegramSend: (locale: string) => post<{ ok: true }>("/api/auth/telegram/send", { locale }),
    telegramReset: (code: string, password: string) => post<AuthStateDto>("/api/auth/telegram/reset", { code, password }),
  },
  teams: {
    list: () => request<TeamsDto>("/api/teams"),
    create: (body: CreateTeamRequest) => post<TeamDto>("/api/teams", body),
    repo: (id: string) => request<TeamRepoStatusDto>(`/api/teams/${encodeURIComponent(id)}/repo`),
    fetch: (id: string) => post<TeamRepoStatusDto>(`/api/teams/${encodeURIComponent(id)}/fetch`),
    push: (id: string) => post<PullRequestDto>(`/api/teams/${encodeURIComponent(id)}/push`),
    linkTelegram: (id: string, topics: LinkTeamTelegramRequest["topics"]) => post<TeamDto>(`/api/teams/${encodeURIComponent(id)}/telegram`, { topics }),
    remove: (id: string) => request<{ ok: true }>(`/api/teams/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  space: {
    get: () => request<{ space: SpaceDto | null }>("/api/space"),
    create: (body: CreateSpaceRequest) => post<SpaceDto>("/api/space", body),
  },
  system: {
    backups: () => request<BackupsDto>("/api/system/backups"),
    createBackup: () => post<BackupDto>("/api/system/backups"),
    /** The encrypted copy as a file; the password never goes into a URL. */
    downloadBackup: async (name: string, password: string): Promise<Blob> => {
      const res = await fetch(`/api/system/backups/${encodeURIComponent(name)}/download`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({ error: "bad_response", message: res.statusText }))) as ApiErrorDto);
      return res.blob();
    },
    reset: (password: string) => post<FactoryResetResultDto>("/api/system/reset", { password, confirm: true }),
    audit: (q: { before?: number; cursor?: string }) =>
      request<AuditPageDto>(`/api/system/audit?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()}`),
  },
  usage: (range: DashboardRange) => request<UsageDto>(`/api/usage?range=${range}&tz=${encodeURIComponent(browserTimeZone())}`),
  health: () => request<HealthDto>("/api/health"),
  dashboard: (range: DashboardRange) => request<DashboardDto>(`/api/dashboard?range=${range}&tz=${encodeURIComponent(browserTimeZone())}`),
  agents: () => request<AgentListDto>("/api/agents"),
  createAgent: (body: CreateAgentRequest) => post<CreateAgentResultDto>("/api/agents", body),
  deleteAgent: (agentId: string) => request<void>(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }),
  agentProfile: (agentId: string) => request<AgentProfileDto>(`/api/agents/${encodeURIComponent(agentId)}/profile`),
  saveAgentProfile: (agentId: string, body: SaveAgentProfileRequest) =>
    request<AgentProfileDto>(`/api/agents/${encodeURIComponent(agentId)}/profile`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  saveAsTemplate: (agentId: string, body: SaveAsTemplateRequest) => post<TemplateDto>(`/api/agents/${encodeURIComponent(agentId)}/template`, body),
  deleteTemplate: (templateId: string) => request<void>(`/api/templates/${encodeURIComponent(templateId)}`, { method: "DELETE" }),
  telegram: {
    voice: () => request<TelegramVoiceDto>("/api/telegram/voice"),
    saveVoiceKey: (apiKey: string, provider = "openai", model?: string) => request<TelegramVoiceDto>("/api/telegram/voice/key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey, provider, model }) }),
    setVoice: (enabled: boolean, provider?: string, model?: string) => request<TelegramVoiceDto>("/api/telegram/voice", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, provider, model }) }),
    status: (accountId = "default") => request<TelegramStatusDto>(`/api/telegram?accountId=${encodeURIComponent(accountId)}`),
    accounts: () => request<TelegramBotDto[]>("/api/telegram/accounts"),
    addBot: (token: string, agentId: string) => post<TelegramBotDto>("/api/telegram/accounts", { token, agentId }),
    assignAgent: (accountId: string, agentId: string) => request<TelegramBotDto>(`/api/telegram/accounts/${encodeURIComponent(accountId)}/agent`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId }) }),
    connect: (token: string, agentId = "main", accountId = "default") => post<TelegramStatusDto>(`/api/telegram/connect?accountId=${encodeURIComponent(accountId)}`, { token, agentId }),
    disconnect: (accountId = "default") => post<void>(`/api/telegram/disconnect?accountId=${encodeURIComponent(accountId)}`),
    pairing: (accountId = "default") => request<TelegramPairingRequestDto[]>(`/api/telegram/pairing?accountId=${encodeURIComponent(accountId)}`),
    approve: (requestId: string, accountId: string) => post<ApproveTelegramResultDto>("/api/telegram/pairing/approve", { requestId, accountId }),
    test: (text: string, accountId = "default") => post<void>(`/api/telegram/test?accountId=${encodeURIComponent(accountId)}`, { text }),
    approvals: (enabled: boolean, accountId = "default") => post<TelegramStatusDto>(`/api/telegram/approvals?accountId=${encodeURIComponent(accountId)}`, { enabled }),
    topics: (accountId = "default") => request<AgentTopicsDto>(`/api/telegram/topics?accountId=${encodeURIComponent(accountId)}`),
    saveTopics: (body: LinkAgentTopicsRequest, accountId = "default") =>
      request<AgentTopicsDto>(`/api/telegram/topics?accountId=${encodeURIComponent(accountId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    removeTopics: (accountId = "default") => request<AgentTopicsDto>(`/api/telegram/topics?accountId=${encodeURIComponent(accountId)}`, { method: "DELETE" }),
  },
  freeModels: {
    status: () => request<FreeModelsStatusDto>("/api/free-models"),
    addKey: (platform: string, key: string) => post<FreeModelsStatusDto>("/api/free-models/keys", { platform, key }),
    removeKeys: (platform: string) => request<FreeModelsStatusDto>(`/api/free-models/keys/${encodeURIComponent(platform)}`, { method: "DELETE" }),
  },
  assistant: {
    get: () => request<AssistantDto>("/api/assistant"),
    save: (profile: AssistantProfile) =>
      request<AssistantDto>("/api/assistant", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(profile) }),
    setMemory: (provider: MemoryProvider) => post<AssistantDto>("/api/assistant/memory", { provider }),
  },
  schedules: {
    list: () => request<ScheduleListDto>("/api/schedules"),
    create: (body: CreateScheduleRequest) => post<ScheduleListDto>("/api/schedules", body),
    update: (id: string, body: UpdateScheduleRequest) =>
      request<ScheduleListDto>(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    remove: (id: string) => request<ScheduleListDto>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),
    run: (id: string) => post<{ ok: true }>(`/api/schedules/${encodeURIComponent(id)}/run`),
    runs: (id: string) => request<ScheduleRunDto[]>(`/api/schedules/${encodeURIComponent(id)}/runs`),
  },
  approvals: {
    list: () => request<ApprovalsDto>("/api/approvals"),
    resolve: (id: string, kind: "exec" | "plugin", decision: ApprovalDecision) => post<void>(`/api/approvals/${encodeURIComponent(id)}/resolve`, { kind, decision }),
    setMode: (mode: ExecMode) => post<ApprovalsDto>("/api/approvals/mode", { mode }),
    removeAllowed: (pattern: string) => post<ApprovalsDto>("/api/approvals/allowed/remove", { pattern }),
    eventsUrl: "/api/approvals/events",
  },
  chat: {
    history: (agentId: string) => request<ChatHistoryDto>(`/api/chat/${encodeURIComponent(agentId)}/history`),
    send: (agentId: string, text: string) => post<{ runId: string | null }>(`/api/chat/${encodeURIComponent(agentId)}/send`, { text }),
    abort: (agentId: string) => post<void>(`/api/chat/${encodeURIComponent(agentId)}/abort`),
    eventsUrl: (agentId: string) => `/api/chat/${encodeURIComponent(agentId)}/events`,
  },
  sources: {
    status: () => request<SourcesDto>("/api/sources"),
    notionToken: (token: string) => post<SourcesDto>("/api/sources/notion/token", { token }),
    notionOAuth: () => post<StartNotionOAuthResultDto>("/api/sources/notion/oauth"),
    notionDisconnect: () => post<SourcesDto>("/api/sources/notion/disconnect"),
    googleClient: (json: string) => post<SourcesDto>("/api/sources/google/client", { json }),
    googleLogin: (email: string, services: string[], readonly: boolean) => post<StartGoogleLoginResultDto>("/api/sources/google/login", { email, services, readonly }),
    googleComplete: (redirectUrl: string) => post<SourcesDto>("/api/sources/google/complete", { redirectUrl }),
    googleRemove: (email: string) => post<SourcesDto>("/api/sources/google/remove", { email }),
    githubStart: () => post<StartGitHubSignInResultDto>("/api/sources/github/start"),
    githubPoll: (requestId: string) => post<PollGitHubSignInResultDto>("/api/sources/github/poll", { requestId }),
    githubDisconnect: () => post<SourcesDto>("/api/sources/github/disconnect"),
    figmaToken: (token: string) => post<SourcesDto>("/api/sources/figma/token", { token }),
    figmaDisconnect: () => post<SourcesDto>("/api/sources/figma/disconnect"),
  },
  templates: (mode: string) => request<TemplateDto[]>(`/api/templates?mode=${encodeURIComponent(mode)}&role=specialist`),
  ai: {
    status: (agentId: string) => request<AiStatusDto>(`/api/ai/status?${q(agentId)}`),
    catalog: (agentId: string) => request<AiCatalogDto>(`/api/ai/catalog?${q(agentId)}`),
    install: (pluginId: string) => post<InstallProviderResultDto>(`/api/ai/providers/${encodeURIComponent(pluginId)}/install`),
    activate: (body: ActivateApiKeyRequest) => post<ActivateResultDto>("/api/ai/activate", body),
    models: (agentId: string) => request<ModelChainDto>(`/api/ai/models?${q(agentId)}`),
    saveModels: (body: SaveModelChainRequest) =>
      request<ModelChainDto>("/api/ai/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signIn: {
      start: (body: StartSignInRequest) => post<SignInStateDto>("/api/ai/signin", body),
      get: (sessionId: string) => request<SignInStateDto>(`/api/ai/signin/${encodeURIComponent(sessionId)}`),
      answer: (sessionId: string, body: SignInAnswerRequest) => post<SignInStateDto>(`/api/ai/signin/${encodeURIComponent(sessionId)}/answer`, body),
      cancel: (sessionId: string) => request<void>(`/api/ai/signin/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
    },
  },
};
