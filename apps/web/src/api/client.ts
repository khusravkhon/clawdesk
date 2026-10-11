import type { AgentListDto, ApiErrorDto, HealthDto } from "@clawdesk/shared";

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

export const api = {
  health: () => request<HealthDto>("/api/health"),
  agents: () => request<AgentListDto>("/api/agents"),
};
