import { FREE_MODEL_REF, type CreateAgentRequest, type CreateAgentResultDto } from "@clawdesk/shared";
import { loadTemplate, renderTemplateFiles, WORKSPACE_FILES, type LoadedTemplate } from "@clawdesk/templates";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agents, agentSourceGrants, dataSources, schedules } from "../db/schema.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { readChain } from "../ai-setup/model-chain.js";
import { runSaga } from "./saga.js";

// "Create a junior agent" = one chain of Gateway RPCs plus our metadata rows.
// Any failing step undoes the earlier ones (agents.delete also drops the
// agent's config entry and workspace files).

/** Tools a junior must not have when it may not contact other agents. */
const CROSS_AGENT_TOOLS = ["agent_to_agent", "sessions_send", "sessions_spawn", "conversations_send", "conversations_turn"];

type AgentsList = { agents: { id: string; model?: { primary?: string } }[] };
type AgentToAgent = { enabled?: boolean; allow?: string[] };

export type CreateAgentDeps = {
  gateway: GatewayService;
  db: Db;
  logger: Logger;
  sandboxEnabled: boolean;
  /** Owner chat delivery when Telegram is connected and approved; null otherwise. */
  telegramDelivery?: { mode: "announce"; channel: string; to: string; bestEffort: boolean } | null;
  /** Makes the agent's folder in the shared files folder (the ClawDesk bridge). */
  folders?: { ensureFolder(name: string): Promise<{ hostPath: string; gatewayPath: string }> };
  /** A project team member (screen 11): its team, the project values its template needs, extra sandbox binds. */
  team?: { id: string; values: Record<string, string>; binds: string[] };
};

/** Where a sandboxed junior sees its folder: inside its workspace, where OpenClaw's file tools work. */
export const SANDBOX_FOLDERS = "/workspace/folders";

export class CreateAgentError extends Error {
  constructor(
    readonly code: "invalid_template" | "invalid_values",
    message: string,
  ) {
    super(message);
    this.name = "CreateAgentError";
  }
}

export async function createJuniorAgent(deps: CreateAgentDeps, req: CreateAgentRequest): Promise<CreateAgentResultDto> {
  const { gateway, db, logger } = deps;
  const template = loadJuniorTemplate(req, !!deps.team);
  let files: ReturnType<typeof renderTemplateFiles>;
  try {
    files = renderTemplateFiles(template, { ...req.values, ...deps.team?.values });
  } catch (error) {
    throw new CreateAgentError("invalid_values", (error as Error).message);
  }
  const displayName = (req.values.agentName ?? "").trim() || template.title.ru;
  const purpose = (req.values.goal ?? req.values.purpose ?? req.values.channel ?? "").trim() || null;

  const list = await gateway.request<AgentsList>("agents.list", {});
  const taken = new Set(list.agents.map((a) => a.id));
  const base = deps.team ? `${deps.team.id}-${template.id}` : slugBase(template, displayName);
  let agentId = uniqueSlug(base, taken);
  // Free models only for personal-mode juniors; company teams and the main agent never get them.
  if (req.ai === "free" && template.mode !== "personal") throw new CreateAgentError("invalid_values", "free models are only available for personal assistants");
  // "Same as main" takes the main agent's whole chain, backups included (kept in sync by syncFollowers).
  const mainChain = req.ai === "inherit" ? await readChain(gateway, "main") : [];
  const model = req.ai === "inherit" ? (mainChain[0] ?? null) : req.ai === "free" ? FREE_MODEL_REF : null;
  const modelSetting = req.ai === "inherit" && mainChain.length ? { primary: mainChain[0], fallbacks: mainChain.slice(1) } : model;
  const sandboxApplied = deps.sandboxEnabled && template.sandbox;
  const cronJobIds: string[] = [];
  const delivery = req.deliverToTelegram && deps.telegramDelivery ? deps.telegramDelivery : null;
  let folder: { name: string; hostPath: string; agentPath: string } | null = null;
  if (req.folder && !deps.folders) throw new CreateAgentError("invalid_values", "folders need the ClawDesk bridge");

  await runSaga(
    {},
    [
      {
        // Kept on rollback: the folder may already hold the person's files.
        name: "folder",
        run: async () => {
          if (!req.folder) return;
          const made = await deps.folders!.ensureFolder(req.folder);
          folder = { name: req.folder, hostPath: made.hostPath, agentPath: sandboxApplied ? `${SANDBOX_FOLDERS}/${req.folder}` : made.gatewayPath };
          files["AGENTS.md"] = `${files["AGENTS.md"].trimEnd()}\n\n${dataAccessBlock(folder.agentPath, req.folder, req.canAskMain)}\n`;
        },
      },
      {
        name: "agents.create",
        // OpenClaw ids are ASCII; the Cyrillic display name is set right after.
        run: async () => {
          let res: { agentId: string } | undefined;
          // A just-deleted agent keeps its id while OpenClaw finishes cleanup; take the next free one.
          for (let attempt = 0; !res; attempt++) {
            try {
              res = await gateway.request<{ agentId: string }>("agents.create", { name: agentId, ...(template.emoji ? { emoji: template.emoji } : {}) });
            } catch (error) {
              if (attempt >= 4 || !/deletion cleanup is still pending/i.test((error as Error).message)) throw error;
              taken.add(agentId);
              agentId = uniqueSlug(base, taken);
            }
          }
          if (res.agentId !== agentId) throw new Error(`gateway assigned id "${res.agentId}" instead of "${agentId}"`);
          await gateway.request("agents.update", { agentId, name: displayName });
        },
        undo: async () => {
          await gateway.request("agents.delete", { agentId, deleteFiles: true });
        },
      },
      {
        name: "agents.files.set",
        run: async () => {
          for (const name of WORKSPACE_FILES) await gateway.request("agents.files.set", { agentId, name, content: files[name] });
        },
      },
      {
        name: "config.patch",
        run: async () => {
          const entry: Record<string, unknown> = {};
          if (template.skills.length) entry.skills = template.skills;
          if (modelSetting) entry.model = modelSetting;
          if (!req.canAskMain) entry.tools = { deny: CROSS_AGENT_TOOLS };
          if (sandboxApplied) {
            // Only this folder of the person's files; the rest of the shared folder stays outside the sandbox.
            const binds = [...(folder ? [`${folder.hostPath}:${folder.agentPath}:rw`] : []), ...(deps.team?.binds ?? [])];
            entry.sandbox = { mode: "all", scope: "agent", workspaceAccess: "rw", ...(binds.length ? { docker: { binds } } : {}) };
          }
          const patch: Record<string, unknown> = { agents: { entries: { [agentId]: entry } } };
          if (req.canAskMain) {
            // Targets reachable over agent_to_agent: the main agent (and this junior, so main can reply/delegate).
            const { config } = await getConfig<{ tools?: { agentToAgent?: AgentToAgent } }>(gateway);
            const allow = [...new Set([...(config.tools?.agentToAgent?.allow ?? []), "main", agentId])];
            patch.tools = { agentToAgent: { enabled: true, allow } };
          }
          await patchConfig(gateway, patch, { note: `clawdesk: create agent ${agentId}` });
        },
      },
      {
        name: "cron.add",
        run: async () => {
          for (const [i, schedule] of req.schedules.entries()) {
            const job = await gateway.request<{ id: string }>("cron.add", {
              name: `${agentId}:${schedule.presetId ?? `custom-${i + 1}`}`,
              displayName: schedule.label,
              agentId,
              enabled: true,
              schedule: { kind: "cron", expr: schedule.cron, tz: req.timezone },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: schedule.prompt },
              // Without Telegram the results stay in the agent's own sessions.
              delivery: delivery ?? { mode: "none" },
            });
            cronJobIds.push(job.id);
          }
        },
        undo: async () => {
          for (const id of cronJobIds) await gateway.request("cron.remove", { id }).catch(() => undefined);
        },
      },
      {
        name: "db.insert",
        run: async () => {
          db.transaction((tx) => {
            tx.insert(agents)
              .values({
                id: agentId,
                role: deps.team ? "team_member" : "specialist",
                parentId: "main",
                teamId: deps.team?.id ?? null,
                templateId: template.id,
                displayName,
                avatar: template.emoji ?? null,
                purpose,
                model,
                canAskMain: req.canAskMain,
                sandbox: sandboxApplied,
                status: "ready",
              })
              .run();
            if (folder) {
              const sourceId = `folder:${folder.name}`;
              tx.insert(dataSources).values({ id: sourceId, kind: "folder", connectorRef: folder.name, scope: folder.hostPath, status: "connected" }).onConflictDoNothing().run();
              tx.insert(agentSourceGrants).values({ agentId, sourceId, access: "write" }).run();
            }
            for (const [i, schedule] of req.schedules.entries()) {
              tx.insert(schedules)
                .values({
                  id: cronJobIds[i]!,
                  agentId,
                  cron: schedule.cron,
                  tz: req.timezone,
                  prompt: schedule.prompt,
                  deliverTo: delivery ? `telegram:${delivery.to}` : null,
                  openclawCronId: cronJobIds[i]!,
                  enabled: true,
                })
                .run();
            }
          });
        },
        undo: async () => {
          db.delete(agents).where(eq(agents.id, agentId)).run();
        },
      },
    ],
    logger,
  );

  logger.info({ agentId, templateId: template.id, ai: req.ai, schedules: cronJobIds.length, sandboxApplied, folder: req.folder }, "junior agent created");
  return { agentId, displayName, model, cronJobIds, sandboxApplied };
}

/** Removes a junior agent: its cron jobs, the OpenClaw agent (config + files) and our rows. */
export async function deleteJuniorAgent(deps: Pick<CreateAgentDeps, "gateway" | "db" | "logger">, agentId: string): Promise<void> {
  if (agentId === "main") throw new CreateAgentError("invalid_values", "the main agent cannot be deleted");
  // Only jobs the panel created: OpenClaw also keeps system-owned monitor jobs per agent
  // (e.g. skill-collection-review-<id>) that cron clients may not remove; agents.delete handles those.
  const ours = new Set(deps.db.select({ id: schedules.openclawCronId }).from(schedules).where(eq(schedules.agentId, agentId)).all().map((r) => r.id));
  const jobs = await deps.gateway.request<{ jobs?: { id: string; name?: string; agentId?: string }[] }>("cron.list", { agentId, includeDisabled: true });
  for (const job of jobs.jobs ?? []) {
    if (job.agentId === agentId && (ours.has(job.id) || job.name?.startsWith(`${agentId}:`))) {
      await deps.gateway.request("cron.remove", { id: job.id });
    }
  }
  const deleted = await deps.gateway.request<{ failed?: { path: string; reason: string }[]; purgeFailed?: boolean }>("agents.delete", { agentId, deleteFiles: true });
  if (deleted.failed?.length || deleted.purgeFailed) {
    // Leftover files keep the id fenced and can stop the next Gateway start (docs/stage-0.md, "удаление агента + рестарт").
    deps.logger.warn({ agentId, failed: deleted.failed, purgeFailed: deleted.purgeFailed }, "OpenClaw could not remove all files of the deleted agent");
  }
  const { config } = await getConfig<{ tools?: { agentToAgent?: AgentToAgent } }>(deps.gateway);
  const allow = config.tools?.agentToAgent?.allow ?? [];
  if (allow.includes(agentId)) {
    // Shrinking an array must be confirmed with replacePaths, otherwise the Gateway refuses the write.
    await patchConfig(
      deps.gateway,
      { tools: { agentToAgent: { allow: allow.filter((id) => id !== agentId) } } },
      { replacePaths: ["tools.agentToAgent.allow"], note: `clawdesk: delete agent ${agentId}` },
    );
  }
  deps.db.delete(agents).where(eq(agents.id, agentId)).run();
  deps.logger.info({ agentId }, "junior agent deleted");
}

/** Appended to the junior's AGENTS.md: where its data is and how to get the rest (architecture rules 1–2). */
export function dataAccessBlock(agentPath: string, folderName: string, canAskMain: boolean): string {
  return [
    "## Твоя папка (ClawDesk)",
    "",
    `Твоя папка: \`${agentPath}\`. Это папка «${folderName}» в общей папке владельца ClawDesk: туда он кладёт файлы для тебя,`,
    "туда же сохраняй свои результаты (планы, списки, заметки). Других папок владельца у тебя нет.",
    "",
    canAskMain
      ? "Почту, Notion, Google и файлы других агентов ты не видишь — спрашивай главного ассистента конкретный факт или путь."
      : "Почту, Notion, Google и файлы других агентов ты не видишь и спросить главного не можешь: работай с тем, что есть.",
  ].join("\n");
}

function loadJuniorTemplate(req: CreateAgentRequest, forTeam: boolean): LoadedTemplate {
  let template: LoadedTemplate;
  try {
    template = loadTemplate(req.mode, req.templateId);
  } catch {
    throw new CreateAgentError("invalid_template", `template ${req.mode}/${req.templateId} not found`);
  }
  if (template.role === "main") throw new CreateAgentError("invalid_template", "the main-agent template cannot create a junior agent");
  // Team roles only through a team (they need its repository and project values), and the other way round.
  if ((template.role === "team_member") !== forTeam) throw new CreateAgentError("invalid_template", forTeam ? "not a team role" : "team roles are created with a team");
  return template;
}

export function slugBase(template: Pick<LoadedTemplate, "id">, displayName: string): string {
  if (template.id !== "custom") return template.id;
  const latin = displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return latin || "agent";
}

export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base) && base !== "main") return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
