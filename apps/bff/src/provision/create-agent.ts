import type { CreateAgentRequest, CreateAgentResultDto } from "@clawdesk/shared";
import { loadTemplate, renderTemplateFiles, WORKSPACE_FILES, type LoadedTemplate } from "@clawdesk/templates";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agents, schedules } from "../db/schema.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { runSaga } from "./saga.js";

// "Create a junior agent" = one chain of Gateway RPCs plus our metadata rows.
// Any failing step undoes the earlier ones (agents.delete also drops the
// agent's config entry and workspace files).

/** Tools a junior must not have when it may not contact other agents. */
const CROSS_AGENT_TOOLS = ["agent_to_agent", "sessions_send", "sessions_spawn", "conversations_send", "conversations_turn"];

type AgentsList = { agents: { id: string; model?: { primary?: string } }[] };
type AgentToAgent = { enabled?: boolean; allow?: string[] };

export type CreateAgentDeps = { gateway: GatewayService; db: Db; logger: Logger; sandboxEnabled: boolean };

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
  const template = loadJuniorTemplate(req);
  let files: ReturnType<typeof renderTemplateFiles>;
  try {
    files = renderTemplateFiles(template, req.values);
  } catch (error) {
    throw new CreateAgentError("invalid_values", (error as Error).message);
  }
  const displayName = (req.values.agentName ?? "").trim() || template.title.ru;
  const purpose = (req.values.goal ?? req.values.purpose ?? req.values.channel ?? "").trim() || null;

  const list = await gateway.request<AgentsList>("agents.list", {});
  const agentId = uniqueSlug(slugBase(template, displayName), new Set(list.agents.map((a) => a.id)));
  const mainModel = list.agents.find((a) => a.id === "main")?.model?.primary ?? null;
  const model = req.ai === "inherit" ? mainModel : null;
  const sandboxApplied = deps.sandboxEnabled && template.sandbox;
  const cronJobIds: string[] = [];

  await runSaga(
    {},
    [
      {
        name: "agents.create",
        // OpenClaw ids are ASCII; the Cyrillic display name is set right after.
        run: async () => {
          const res = await gateway.request<{ agentId: string }>("agents.create", { name: agentId, ...(template.emoji ? { emoji: template.emoji } : {}) });
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
          if (model) entry.model = model;
          if (!req.canAskMain) entry.tools = { deny: CROSS_AGENT_TOOLS };
          if (sandboxApplied) entry.sandbox = { mode: "all", scope: "agent", workspaceAccess: "rw" };
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
              // Delivery to Telegram arrives with the Telegram screen; results stay in the agent's sessions until then.
              delivery: { mode: "none" },
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
                role: "specialist",
                parentId: "main",
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
            for (const [i, schedule] of req.schedules.entries()) {
              tx.insert(schedules)
                .values({
                  id: cronJobIds[i]!,
                  agentId,
                  cron: schedule.cron,
                  tz: req.timezone,
                  prompt: schedule.prompt,
                  deliverTo: null,
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

  logger.info({ agentId, templateId: template.id, ai: req.ai, schedules: cronJobIds.length, sandboxApplied }, "junior agent created");
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
  await deps.gateway.request("agents.delete", { agentId, deleteFiles: true });
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

function loadJuniorTemplate(req: CreateAgentRequest): LoadedTemplate {
  let template: LoadedTemplate;
  try {
    template = loadTemplate(req.mode, req.templateId);
  } catch {
    throw new CreateAgentError("invalid_template", `template ${req.mode}/${req.templateId} not found`);
  }
  if (template.role === "main") throw new CreateAgentError("invalid_template", "the main-agent template cannot create a junior agent");
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
