import { CreateAgentRequest, FolderName, GITHUB_REPO_URL, parseTopicLink, type CreateTeamRequest, type PullRequestDto, type TeamDto, type TeamRepoStatusDto, type TeamRole, type TeamsDto } from "@clawdesk/shared";
import { loadTemplate } from "@clawdesk/templates";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agents, agentSourceGrants, channelBindings, dataSources, schedules, teams } from "../db/schema.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import { createJuniorAgent, deleteJuniorAgent, slugBase, uniqueSlug } from "../provision/create-agent.js";
import type { SpaceService } from "../space/space-service.js";
import type { TelegramService } from "../telegram/telegram-service.js";

// Project teams (screen 11, company mode). A team = a GitHub repository + PM, developer, reviewer.
//
// The bridge keeps the panel's clone with the token aside and gives each member a copy in its own workspace
// (clawdesk-teams.mjs): the developer's branch, read copies for PM and reviewer. The sandbox sees it at
// /workspace/repo. The team's docs folder is synchronized into <workspace>/docs, writable for the PM only.
// No sandbox binds: OpenClaw 2026.8+ accepts bind sources only inside the agent's workspace and reserves
// /workspace. Sandboxes have no network and never see the token; the owner pushes the developer's branch
// and opens the pull request from the panel. Merging stays with people.

const ROLE_ORDER: TeamRole[] = ["pm", "developer", "reviewer"];
const REPO = "/workspace/repo";
const DOCS = "/workspace/docs";
/** Targets of the binds teams used before members got copies in their workspaces. */
const LEGACY_BINDS = [`:${REPO}:`, `:${DOCS}:`];

export class TeamError extends Error {
  constructor(
    readonly code: "wrong_mode" | "repo_not_found" | "token_rejected" | "no_push_permission" | "github_unreachable" | "no_team" | "telegram_links" | "no_bridge",
    message: string,
  ) {
    super(message);
  }
}

export type TeamDeps = {
  gateway: GatewayService;
  db: Db;
  logger: Logger;
  bridge: BridgeClient;
  space: SpaceService;
  telegram: TelegramService;
  sandboxEnabled: boolean;
  /** Injected for tests; GitHub API calls. */
  fetchImpl?: typeof fetch;
};

export class TeamService {
  readonly #fetch: typeof fetch;

  constructor(private readonly deps: TeamDeps) {
    this.#fetch = deps.fetchImpl ?? fetch;
  }

  list(): TeamsDto {
    const { db } = this.deps;
    // GitHub teams only: a project's executors (P6.2) are a team without a repository, managed on the project.
    const rows = db.select().from(teams).where(isNotNull(teams.repoUrl)).all();
    const members = db.select().from(agents).where(eq(agents.role, "team_member")).all();
    const topics = db.select().from(channelBindings).where(and(eq(channelBindings.channel, "telegram"), eq(channelBindings.peerKind, "group"))).all();
    const docs = db.select().from(dataSources).where(eq(dataSources.kind, "folder")).all();
    return {
      teams: rows.map((team): TeamDto => ({
        id: team.id,
        name: team.name,
        repoUrl: team.repoUrl ?? "",
        docsFolder: docs.find((d) => d.id === `team-docs:${team.id}`)?.connectorRef ?? null,
        telegramChatId: team.telegramGroupId,
        ownerRequests: team.ownerRequests,
        members: members
          .filter((m) => m.teamId === team.id)
          .map((m) => ({
            agentId: m.id,
            role: (m.templateId ?? "pm") as TeamRole,
            name: m.displayName,
            emoji: m.avatar,
            topicId: topics.find((t) => t.agentId === m.id)?.topicId ?? null,
          }))
          .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)),
      })),
    };
  }

  /** Stage 8: where requests of the team's members that reach the owner arrive. */
  setOwnerRequests(teamId: string, mode: "direct" | "topic"): void {
    const team = this.deps.db.select().from(teams).where(eq(teams.id, teamId)).get();
    if (!team) throw new TeamError("no_team", `team ${teamId} not found`);
    this.deps.db.update(teams).set({ ownerRequests: mode }).where(eq(teams.id, teamId)).run();
  }

  async create(req: CreateTeamRequest): Promise<TeamDto> {
    const { db, logger, bridge } = this.deps;
    if (this.deps.space.mode() !== "company") throw new TeamError("wrong_mode", "teams are for company projects");
    await this.#checkGitHub(req.repoUrl, req.token);

    const taken = new Set(db.select({ id: teams.id }).from(teams).all().map((t) => t.id));
    const teamId = uniqueSlug(slugBase({ id: "custom" }, req.name).slice(0, 30).replace(/-+$/, "") || "team", taken);
    const created: string[] = [];
    let cloned = false;
    db.insert(teams).values({ id: teamId, name: req.name, repoUrl: req.repoUrl.replace(/(\.git)?\/?$/, ""), telegramGroupId: null }).run();
    try {
      const docsName = FolderName.safeParse(req.name).success ? req.name : teamId;
      const repo = await bridge.teamClone(teamId, req.repoUrl, req.token);
      cloned = true;
      const docsReady = (agentId: string, role: TeamRole) => bridge.ensureAgentFolder(agentId, docsName, { dir: "docs", readOnly: role !== "pm" });
      // Specs and notes for the team: a folder in the shared files folder, named after the project.
      const docs = await bridge.ensureFolder(docsName);
      db.insert(dataSources).values({ id: `team-docs:${teamId}`, kind: "folder", connectorRef: docsName, scope: docs.hostPath, status: "connected" }).onConflictDoNothing().run();
      db.insert(dataSources).values({ id: `github:${teamId}`, kind: "github", connectorRef: req.repoUrl, scope: repo.branch, status: "connected" }).onConflictDoNothing().run();

      const sandboxed = this.deps.sandboxEnabled;
      for (const role of ROLE_ORDER.filter((r) => req.roles.includes(r))) {
        const template = loadTemplate("company", role);
        const result = await createJuniorAgent(
          {
            ...this.deps,
            team: {
              id: teamId,
              binds: [],
              values: {
                projectName: req.name,
                projectBrief: req.brief || "—",
                repoUrl: req.repoUrl,
                // Without a sandbox the agent works in its workspace, where the same folders are.
                repoPath: sandboxed ? REPO : "repo",
                docsPath: sandboxed ? DOCS : "docs",
                branch: repo.branch,
              },
            },
          },
          CreateAgentRequest.parse({
            templateId: role,
            mode: "company",
            values: {},
            canAskMain: true,
            ai: "inherit",
            schedules: template.cronPresets.map((p) => ({ presetId: p.id, label: p.label.ru, cron: p.cron, prompt: p.prompt })),
            timezone: req.timezone,
            deliverToTelegram: false,
            folder: null,
          }),
        );
        created.push(result.agentId);
        await bridge.teamMember(teamId, result.agentId, role);
        await docsReady(result.agentId, role);
        db.insert(agentSourceGrants).values({ agentId: result.agentId, sourceId: `github:${teamId}`, access: role === "developer" ? "write" : "read" }).run();
        db.insert(agentSourceGrants).values({ agentId: result.agentId, sourceId: `team-docs:${teamId}`, access: role === "pm" ? "write" : "read" }).run();
      }
      logger.info({ teamId, roles: created }, "team created");
      return this.list().teams.find((t) => t.id === teamId)!;
    } catch (error) {
      logger.warn({ err: error, teamId }, "team creation failed, undoing");
      for (const agentId of created.reverse()) await deleteJuniorAgent(this.deps, agentId).catch(() => undefined);
      if (cloned) await bridge.teamRemove(teamId).catch(() => undefined);
      db.delete(dataSources).where(inArray(dataSources.id, [`team-docs:${teamId}`, `github:${teamId}`])).run();
      db.delete(teams).where(eq(teams.id, teamId)).run();
      throw error;
    }
  }

  status(teamId: string): Promise<TeamRepoStatusDto> {
    this.#team(teamId);
    return this.deps.bridge.teamStatus(teamId, this.#members(teamId).find((m) => m.role === "developer")?.agentId);
  }

  fetchUpdates(teamId: string): Promise<TeamRepoStatusDto> {
    this.#team(teamId);
    return this.deps.bridge.teamFetch(teamId, this.#members(teamId));
  }

  #members(teamId: string): { agentId: string; role: TeamRole }[] {
    return this.deps.db.select().from(agents).where(and(eq(agents.teamId, teamId), eq(agents.role, "team_member"))).all()
      .filter((m) => ROLE_ORDER.includes(m.templateId as TeamRole)).map((m) => ({ agentId: m.id, role: m.templateId as TeamRole }));
  }

  /**
   * Teams made before members had copies in their workspaces: each member still carrying the old binds gets
   * its copy (the developer's clone is moved in with its work) and the docs folder, then loses the binds.
   * A member that fails keeps its binds and is tried again at the next start.
   */
  async repairWorkspaces(): Promise<void> {
    const { db, bridge, gateway, logger } = this.deps;
    const rows = db.select().from(teams).where(isNotNull(teams.repoUrl)).all();
    if (!rows.length) return;
    type Config = { agents?: { entries?: Record<string, { sandbox?: { docker?: { binds?: string[] } } }> } };
    const legacy = (binds: string[] | undefined) => (binds ?? []).filter((bind) => LEGACY_BINDS.some((target) => bind.includes(target)));
    for (const team of rows) {
      const docsName = db.select().from(dataSources).where(eq(dataSources.id, `team-docs:${team.id}`)).get()?.connectorRef ?? null;
      for (const member of this.#members(team.id)) {
        try {
          const { config } = await getConfig<Config>(gateway);
          if (!legacy(config.agents?.entries?.[member.agentId]?.sandbox?.docker?.binds).length) continue;
          const copy = await bridge.teamMember(team.id, member.agentId, member.role);
          if (docsName) await bridge.ensureAgentFolder(member.agentId, docsName, { dir: "docs", readOnly: member.role !== "pm" });
          await patchConfig(gateway, (snapshot) => {
            const entry = (snapshot as Config).agents?.entries?.[member.agentId];
            const binds = entry?.sandbox?.docker?.binds;
            if (!binds || !legacy(binds).length) return null;
            return { agents: { entries: { [member.agentId]: { sandbox: { docker: { binds: binds.filter((bind) => !legacy([bind]).length) } } } } } };
          }, { replacePaths: [`agents.entries.${member.agentId}.sandbox.docker.binds`], note: "clawdesk: team member copy in its workspace" });
          logger.info({ teamId: team.id, agentId: member.agentId, moved: copy.moved }, "team member moved to a copy in its workspace");
        } catch (error) {
          logger.warn({ err: error, teamId: team.id, agentId: member.agentId }, "could not move a team member off its old binds; kept as it was");
        }
      }
    }
  }

  /** The owner's decision: pushes the developer's branch and opens its pull request. */
  async pushBranch(teamId: string): Promise<PullRequestDto> {
    const team = this.#team(teamId);
    const developer = this.#members(teamId).find((m) => m.role === "developer")?.agentId;
    const status = await this.deps.bridge.teamStatus(teamId, developer);
    const pr = await this.deps.bridge.teamPush(
      teamId,
      team.repoUrl ?? "",
      developer,
      `${team.name}: ${status.lastCommit?.replace(/^\w+ /, "") ?? "changes from the team"}`,
      `Prepared by the ClawDesk team «${team.name}» (developer agent, branch \`${status.branch}\`).\n\nReview before merging — agents never merge.`,
    );
    this.deps.logger.info({ teamId, pr: pr.url }, "team branch pushed");
    return pr;
  }

  /** Each topic link (Copy link on the topic in Telegram) assigns that topic to one role of the team. */
  async linkTelegram(teamId: string, links: { role: TeamRole; link: string }[]): Promise<TeamDto> {
    const team = this.#team(teamId);
    const members = this.list().teams.find((t) => t.id === teamId)!.members;
    const parsed = links.map((l) => ({ ...l, ...parseTopicLink(l.link)! }));
    const chatIds = new Set(parsed.map((p) => p.chatId));
    if (chatIds.size !== 1) throw new TeamError("telegram_links", "all topics must be in the same group");
    const chatId = [...chatIds][0]!;
    const topics = parsed.map((p) => {
      const agentId = members.find((m) => m.role === p.role)?.agentId;
      if (!agentId) throw new TeamError("telegram_links", `the team has no ${p.role}`);
      return { topicId: p.topicId, agentId };
    });
    // Topics this team had in the same group before, now without a role.
    const dropTopics =
      team.telegramGroupId === chatId
        ? this.deps.db
            .select({ topicId: channelBindings.topicId })
            .from(channelBindings)
            .where(and(eq(channelBindings.peerKind, "group"), eq(channelBindings.peerId, chatId)))
            .all()
            .map((b) => b.topicId!)
            .filter((id) => id && !topics.some((t) => t.topicId === id))
        : [];
    await this.deps.telegram.linkGroup(chatId, topics, dropTopics);

    const { db, gateway } = this.deps;
    db.delete(channelBindings).where(and(eq(channelBindings.channel, "telegram"), eq(channelBindings.peerKind, "group"), eq(channelBindings.peerId, team.telegramGroupId ?? chatId))).run();
    for (const t of topics) {
      db.insert(channelBindings).values({ id: crypto.randomUUID(), agentId: t.agentId, channel: "telegram", accountId: null, peerKind: "group", peerId: chatId, topicId: t.topicId }).run();
      // Scheduled reports (the PM's daily status) go to the agent's topic.
      for (const s of db.select().from(schedules).where(eq(schedules.agentId, t.agentId)).all()) {
        if (!s.openclawCronId) continue;
        await gateway.request("cron.update", { id: s.openclawCronId, patch: { delivery: { mode: "announce", channel: "telegram", to: chatId, threadId: t.topicId, bestEffort: true } } });
        db.update(schedules).set({ deliverTo: `telegram:${chatId}:${t.topicId}` }).where(eq(schedules.id, s.id)).run();
      }
    }
    db.update(teams).set({ telegramGroupId: chatId }).where(eq(teams.id, teamId)).run();
    return this.list().teams.find((t) => t.id === teamId)!;
  }

  async remove(teamId: string): Promise<void> {
    const team = this.#team(teamId);
    const { db } = this.deps;
    for (const member of db.select().from(agents).where(eq(agents.teamId, teamId)).all()) await deleteJuniorAgent(this.deps, member.id);
    if (team.telegramGroupId) {
      await this.deps.telegram.unlinkGroup(team.telegramGroupId).catch((error: Error) => this.deps.logger.warn({ err: error }, "could not unlink the team's group"));
      db.delete(channelBindings).where(and(eq(channelBindings.peerKind, "group"), eq(channelBindings.peerId, team.telegramGroupId))).run();
    }
    await this.deps.bridge.teamRemove(teamId);
    db.delete(dataSources).where(inArray(dataSources.id, [`team-docs:${teamId}`, `github:${teamId}`])).run();
    db.delete(teams).where(eq(teams.id, teamId)).run();
    this.deps.logger.info({ teamId }, "team removed (its docs folder stays)");
  }

  #team(teamId: string) {
    const team = this.deps.db.select().from(teams).where(eq(teams.id, teamId)).get();
    if (!team) throw new TeamError("no_team", "no such team");
    return team;
  }

  /** The token must reach the repository and be allowed to push (the developer's branch). */
  async #checkGitHub(repoUrl: string, token: string): Promise<void> {
    const [, owner, repo] = GITHUB_REPO_URL.exec(repoUrl)!;
    let res: Response;
    try {
      res = await this.#fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new TeamError("github_unreachable", `GitHub did not answer: ${(error as Error).message}`);
    }
    if (res.status === 401) throw new TeamError("token_rejected", "GitHub rejected this token");
    if (res.status === 404 || res.status === 403) throw new TeamError("repo_not_found", "the token cannot see this repository");
    if (!res.ok) throw new TeamError("github_unreachable", `GitHub answered ${res.status}`);
    const body = (await res.json()) as { permissions?: { push?: boolean } };
    if (body.permissions && body.permissions.push === false) throw new TeamError("no_push_permission", "the token cannot write to this repository (Contents: Read and write)");
  }
}

