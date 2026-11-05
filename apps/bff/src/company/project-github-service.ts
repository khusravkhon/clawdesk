import type { CreateProjectRepoRequest, ProjectGitHubChangesDto, ProjectGitHubDto, ProjectGitHubPlanDto, ProjectPullRequestDto, ProjectPullRequestRequest } from "@clawdesk/shared";
import type { BridgeClient } from "../gateway/bridge-client.js";

// P7: a project's folder on GitHub. The bridge does the work (clawdesk-project-github.mjs): the token stays in
// the Gateway's state, the first push is exactly the confirmed plan, later changes go to a pull request.
// Here: the project must exist and be writable (not archived, company mode) before anything is sent.

export class ProjectGitHubError extends Error {
  constructor(readonly code: "gateway_unavailable") { super(code); }
}
export type ProjectGitHubBridge = Pick<BridgeClient, "projectGitHub" | "projectGitHubPlan" | "projectGitHubChanges" | "createProjectRepo" | "projectPullRequest" | "disconnectProjectGitHub">;

export class ProjectGitHubService {
  constructor(private readonly deps: { checkProject: (id: string, writing: boolean) => unknown; bridge?: ProjectGitHubBridge }) {}

  #bridge(): ProjectGitHubBridge {
    if (!this.deps.bridge) throw new ProjectGitHubError("gateway_unavailable");
    return this.deps.bridge;
  }

  status(projectId: string): Promise<ProjectGitHubDto> {
    this.deps.checkProject(projectId, false);
    return this.#bridge().projectGitHub(projectId);
  }

  plan(projectId: string): Promise<ProjectGitHubPlanDto> {
    this.deps.checkProject(projectId, false);
    return this.#bridge().projectGitHubPlan(projectId);
  }

  changes(projectId: string): Promise<ProjectGitHubChangesDto> {
    this.deps.checkProject(projectId, false);
    return this.#bridge().projectGitHubChanges(projectId);
  }

  create(projectId: string, request: CreateProjectRepoRequest): Promise<ProjectGitHubDto> {
    this.deps.checkProject(projectId, true);
    return this.#bridge().createProjectRepo(projectId, { ...(request.token ? { token: request.token } : {}), owner: request.owner, name: request.name, visibility: request.visibility, planHash: request.planHash, requestId: request.requestId });
  }

  pullRequest(projectId: string, request: ProjectPullRequestRequest): Promise<ProjectPullRequestDto> {
    this.deps.checkProject(projectId, true);
    return this.#bridge().projectPullRequest(projectId, { title: request.title, body: request.body, changesHash: request.changesHash, requestId: request.requestId });
  }

  disconnect(projectId: string): Promise<{ ok: true }> {
    this.deps.checkProject(projectId, true);
    return this.#bridge().disconnectProjectGitHub(projectId);
  }
}
