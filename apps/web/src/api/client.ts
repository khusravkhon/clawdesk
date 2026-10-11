import type {
  ActivateApiKeyRequest,
  ActivateResultDto,
  AgentListDto,
  AiCatalogDto,
  AiStatusDto,
  ApiErrorDto,
  CreateAgentRequest,
  CreateAgentResultDto,
  HealthDto,
  TemplateDto,
  InstallProviderResultDto,
  SignInAnswerRequest,
  SignInStateDto,
  StartSignInRequest,
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
  agents: () => request<AgentListDto>("/api/agents"),
  createAgent: (body: CreateAgentRequest) => post<CreateAgentResultDto>("/api/agents", body),
  deleteAgent: (agentId: string) => request<void>(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }),
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
