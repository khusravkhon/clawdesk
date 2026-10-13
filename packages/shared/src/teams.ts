import { z } from "zod";

// Project teams (screen 11, company mode): one team per repository — PM, developer, reviewer.

export const TeamRole = z.enum(["pm", "developer", "reviewer"]);
export type TeamRole = z.infer<typeof TeamRole>;

export const GITHUB_REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export const CreateTeamRequest = z.object({
  name: z.string().trim().min(1).max(60),
  repoUrl: z.string().trim().regex(GITHUB_REPO_URL, "expected https://github.com/<owner>/<repo>"),
  /** Fine-grained token for this repository only: Contents and Pull requests read/write. */
  token: z
    .string()
    .trim()
    .regex(/^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/, "this does not look like a GitHub token"),
  brief: z.string().trim().max(4000).default(""),
  roles: z.array(TeamRole).min(1),
  /** IANA time zone for the PM's daily status. */
  timezone: z.string().min(1).max(64),
});
export type CreateTeamRequest = z.infer<typeof CreateTeamRequest>;

export const TeamMemberDto = z.object({
  agentId: z.string(),
  role: TeamRole,
  name: z.string(),
  emoji: z.string().nullable(),
  /** Telegram topic this agent answers in, once the team's group is linked. */
  topicId: z.string().nullable(),
});
export type TeamMemberDto = z.infer<typeof TeamMemberDto>;

export const TeamDto = z.object({
  id: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  /** The project's folder in the shared files folder (specs, notes): PM writes, others read. */
  docsFolder: z.string().nullable(),
  members: z.array(TeamMemberDto),
  telegramChatId: z.string().nullable(),
});
export type TeamDto = z.infer<typeof TeamDto>;

export const TeamsDto = z.object({ teams: z.array(TeamDto) });
export type TeamsDto = z.infer<typeof TeamsDto>;

export const TeamRepoStatusDto = z.object({
  defaultBranch: z.string(),
  /** The developer's branch (agent/<team>). */
  branch: z.string(),
  /** Commits on the developer's branch that the default branch does not have. */
  ahead: z.number(),
  uncommitted: z.boolean(),
  lastCommit: z.string().nullable(),
});
export type TeamRepoStatusDto = z.infer<typeof TeamRepoStatusDto>;

export const PullRequestDto = z.object({ url: z.string(), number: z.number(), created: z.boolean() });
export type PullRequestDto = z.infer<typeof PullRequestDto>;

/**
 * A topic's link from Telegram ("Copy link" on the topic): https://t.me/c/<chat>/<topic>[/<message>].
 * The group's API id is -100<chat>.
 */
export function parseTopicLink(link: string): { chatId: string; topicId: string } | null {
  const m = /^(?:https?:\/\/)?t\.me\/c\/(\d{5,16})\/(\d{1,10})(?:\/\d+)?\/?(?:\?.*)?$/.exec(link.trim());
  return m ? { chatId: `-100${m[1]}`, topicId: m[2]! } : null;
}

export const LinkTeamTelegramRequest = z.object({
  topics: z
    .array(z.object({ role: TeamRole, link: z.string().trim().refine((l) => parseTopicLink(l) !== null, "paste the topic's link, it starts with https://t.me/c/") }))
    .min(1),
});
export type LinkTeamTelegramRequest = z.infer<typeof LinkTeamTelegramRequest>;
