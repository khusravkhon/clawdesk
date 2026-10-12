import type {
  ActivateApiKeyRequest,
  ActivateResultDto,
  AgentListDto,
  AiCatalogDto,
  AiStatusDto,
  ApprovalDecision,
  ApprovalsDto,
  ExecMode,
  ChatHistoryDto,
  ApiErrorDto,
  ApproveTelegramResultDto,
  CreateAgentRequest,
  CreateAgentResultDto,
  DashboardDto,
  DashboardRange,
  FreeModelsStatusDto,
  HealthDto,
  InstallProviderResultDto,
  SignInAnswerRequest,
  SignInStateDto,
  SourcesDto,
  StartNotionOAuthResultDto,
  StartSignInRequest,
  TelegramPairingRequestDto,
  TelegramStatusDto,
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

const q = (agentId: string) => `agentId=${encodeURIComponent(agentId)}`;

export const api = {
  health: () => request<HealthDto>("/api/health"),
  dashboard: (range: DashboardRange) => request<DashboardDto>(`/api/dashboard?range=${range}`),
  agents: () => request<AgentListDto>("/api/agents"),
  createAgent: (body: CreateAgentRequest) => post<CreateAgentResultDto>("/api/agents", body),
  deleteAgent: (agentId: string) => request<void>(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }),
  telegram: {
    status: () => request<TelegramStatusDto>("/api/telegram"),
    connect: (token: string) => post<TelegramStatusDto>("/api/telegram/connect", { token }),
    disconnect: () => post<void>("/api/telegram/disconnect"),
    pairing: () => request<TelegramPairingRequestDto[]>("/api/telegram/pairing"),
    approve: (requestId: string, accountId: string) => post<ApproveTelegramResultDto>("/api/telegram/pairing/approve", { requestId, accountId }),
    test: (text: string) => post<void>("/api/telegram/test", { text }),
  },
  freeModels: {
    status: () => request<FreeModelsStatusDto>("/api/free-models"),
    addKey: (platform: string, key: string) => post<FreeModelsStatusDto>("/api/free-models/keys", { platform, key }),
    removeKeys: (platform: string) => request<FreeModelsStatusDto>(`/api/free-models/keys/${encodeURIComponent(platform)}`, { method: "DELETE" }),
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
  },
  templates: (mode: string) => request<TemplateDto[]>(`/api/templates?mode=${encodeURIComponent(mode)}&role=specialist`),
  ai: {
    status: (agentId: string) => request<AiStatusDto>(`/api/ai/status?${q(agentId)}`),
    catalog: (agentId: string) => request<AiCatalogDto>(`/api/ai/catalog?${q(agentId)}`),
    install: (pluginId: string) => post<InstallProviderResultDto>(`/api/ai/providers/${encodeURIComponent(pluginId)}/install`),
    activate: (body: ActivateApiKeyRequest) => post<ActivateResultDto>("/api/ai/activate", body),
    signIn: {
      start: (body: StartSignInRequest) => post<SignInStateDto>("/api/ai/signin", body),
      get: (sessionId: string) => request<SignInStateDto>(`/api/ai/signin/${encodeURIComponent(sessionId)}`),
      answer: (sessionId: string, body: SignInAnswerRequest) => post<SignInStateDto>(`/api/ai/signin/${encodeURIComponent(sessionId)}/answer`, body),
      cancel: (sessionId: string) => request<void>(`/api/ai/signin/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
    },
  },
};
