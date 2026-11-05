import { z } from "zod";

// P7: a project's folder on GitHub. Create a new repository (private by default) with a first push of
// exactly the confirmed plan; later changes go to a new branch and a pull request. No force push ever.

export type ProjectGitHubRepoDto = { id: number; owner: string; name: string; url: string; private: boolean; defaultBranch: string };
export type ProjectPullRequestDto = { requestId: string; url: string; number: number; branch: string; at: number };
export type ProjectGitHubDto = {
  tokenSaved: boolean;
  repo: ProjectGitHubRepoDto | null;
  /** created → committed → pushed; a step short of "pushed" is where a retry continues. */
  step: "created" | "committed" | "pushed" | null;
  pullRequests: ProjectPullRequestDto[];
  /** The folder already has git (connecting an existing repository is a later step). */
  git: boolean;
  local: { branch: string | null; changes: number } | null;
  mode: "new" | "existing";
};
export type ProjectGitHubExclusion = { path: string; reason: "link" | "generated" | "secret_or_local" | "too_large" | "looks_like_secret" };
export type ProjectGitHubPlanDto = { files: { path: string; size: number }[]; excluded: ProjectGitHubExclusion[]; addGitignore: boolean; planHash: string };
export type ProjectGitHubChangesDto = { changes: { path: string; change: "added" | "modified" | "removed" }[]; changesHash: string };

const Token = z.string().trim().regex(/^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/);
export const CreateProjectRepoRequest = z.object({
  requestId: z.uuid(),
  /** Needed the first time; afterwards the saved one is used. */
  token: Token.optional(),
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  name: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/),
  visibility: z.enum(["private", "public"]).default("private"),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
});
export type CreateProjectRepoRequest = z.infer<typeof CreateProjectRepoRequest>;
export const ProjectPullRequestRequest = z.object({
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(10_000).default(""),
  changesHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
});
export type ProjectPullRequestRequest = z.infer<typeof ProjectPullRequestRequest>;
