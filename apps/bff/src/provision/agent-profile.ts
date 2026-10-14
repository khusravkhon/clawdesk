import { CronExpr, type AgentFiles, type AgentProfileDto, type SaveAgentProfileRequest, type SaveAsTemplateRequest, type TemplateDto } from "@clawdesk/shared";
import { loadTemplate, type LoadedTemplate } from "@clawdesk/templates";
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { agents, agentSourceGrants, dataSources, schedules, userTemplates } from "../db/schema.js";
import type { GatewayService } from "../gateway/gateway-service.js";

// Editing a junior agent after creation (name, emoji, its workspace files) and saving it as one of the
// owner's own templates ("My templates"). A saved template works like a built-in one in the builder:
// the agent's name becomes {{agentName}}, its schedules become presets, its folder the suggested folder.

export type ProfileDeps = { gateway: GatewayService; db: Db; logger: Logger };

const FILE_NAMES = { soul: "SOUL.md", user: "USER.md", agents: "AGENTS.md" } as const satisfies Record<keyof AgentFiles, string>;

/** The block create-agent appends to AGENTS.md for the agent's folder; a template gets it again for its own folder. */
const FOLDER_BLOCK = "\n\n## Твоя папка (ClawDesk)";

export class AgentProfileError extends Error {
  constructor(
    readonly code: "not_found" | "not_editable" | "not_found_template",
    message: string,
  ) {
    super(message);
    this.name = "AgentProfileError";
  }
}

function editableRow(db: Db, agentId: string) {
  const row = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!row) throw new AgentProfileError("not_found", `agent ${agentId} is not managed by the panel`);
  if (row.role === "main") throw new AgentProfileError("not_editable", "the main agent is edited on the assistant screen");
  return row;
}

function agentFolder(db: Db, agentId: string): string | null {
  return (
    db
      .select({ name: dataSources.connectorRef })
      .from(agentSourceGrants)
      .innerJoin(dataSources, eq(agentSourceGrants.sourceId, dataSources.id))
      .where(and(eq(agentSourceGrants.agentId, agentId), eq(dataSources.kind, "folder")))
      .get()?.name ?? null
  );
}

export async function readProfile(deps: ProfileDeps, agentId: string): Promise<AgentProfileDto> {
  const row = editableRow(deps.db, agentId);
  const read = async (name: string) =>
    (await deps.gateway.request<{ file?: { content?: string } }>("agents.files.get", { agentId, name })).file?.content ?? "";
  const [soul, user, agentsMd] = await Promise.all([read(FILE_NAMES.soul), read(FILE_NAMES.user), read(FILE_NAMES.agents)]);
  return { id: agentId, name: row.displayName, emoji: row.avatar, role: row.role, folder: agentFolder(deps.db, agentId), files: { soul, user, agents: agentsMd } };
}

export async function saveProfile(deps: ProfileDeps, agentId: string, req: SaveAgentProfileRequest): Promise<AgentProfileDto> {
  editableRow(deps.db, agentId);
  for (const [key, name] of Object.entries(FILE_NAMES) as [keyof AgentFiles, string][]) {
    await deps.gateway.request("agents.files.set", { agentId, name, content: req.files[key] });
  }
  await deps.gateway.request("agents.update", { agentId, name: req.name, ...(req.emoji ? { emoji: req.emoji } : {}) });
  deps.db.update(agents).set({ displayName: req.name, avatar: req.emoji }).where(eq(agents.id, agentId)).run();
  deps.logger.info({ agentId }, "agent profile saved");
  return readProfile(deps, agentId);
}

/**
 * The agent's files as template text: its name becomes {{agentName}}, the folder block is dropped (the
 * builder adds one for the new agent's folder) and stray "{{" cannot turn into placeholders.
 */
export function filesToTemplate(files: AgentFiles, agentName: string): Record<string, string> {
  const name = agentName.trim();
  const convert = (text: string) => {
    const safe = text.replaceAll("{{", "{ {");
    // Short names ("Я", "Ту") would also hit ordinary words.
    return name.length >= 3 ? safe.split(name).join("{{agentName}}") : safe;
  };
  const agentsMd = files.agents.includes(FOLDER_BLOCK) ? files.agents.slice(0, files.agents.indexOf(FOLDER_BLOCK)) + "\n" : files.agents;
  return { "SOUL.md": convert(files.soul), "USER.md": convert(files.user), "AGENTS.md": convert(agentsMd) };
}

export function templateId(title: string): string {
  const latin = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `my-${latin ? `${latin}-` : ""}${crypto.randomBytes(3).toString("hex")}`;
}

export async function saveAsTemplate(deps: ProfileDeps & { mode: "personal" | "company" }, agentId: string, req: SaveAsTemplateRequest): Promise<TemplateDto> {
  const row = editableRow(deps.db, agentId);
  if (row.role !== "specialist") throw new AgentProfileError("not_editable", "team roles are created with a team, not from a template");
  const profile = await readProfile(deps, agentId);
  // Skills come from the template the agent was made from (built-in or the owner's own).
  const source = row.templateId ? findTemplate(deps.db, deps.mode, row.templateId) : null;
  const presets = deps.db
    .select()
    .from(schedules)
    .where(eq(schedules.agentId, agentId))
    .all()
    // Only schedules the builder can show and edit.
    .filter((s) => CronExpr.safeParse(s.cron).success)
    .map((s, i) => ({ id: `s${i + 1}`, label: s.prompt.replace(/\s+/g, " ").slice(0, 40), cron: s.cron, prompt: s.prompt }));
  const id = templateId(req.title);
  deps.db
    .insert(userTemplates)
    .values({
      id,
      mode: deps.mode,
      title: req.title,
      description: req.description,
      emoji: profile.emoji,
      defaultName: profile.name,
      files: filesToTemplate(profile.files, profile.name),
      folder: profile.folder,
      cronPresets: presets,
      skills: source?.skills ?? [],
      canAskMain: row.canAskMain,
    })
    .run();
  deps.logger.info({ agentId, templateId: id }, "agent saved as a template");
  return listUserTemplates(deps.db, deps.mode).find((t) => t.id === id)!;
}

export function deleteUserTemplate(db: Db, id: string): void {
  const res = db.delete(userTemplates).where(eq(userTemplates.id, id)).run();
  if (res.changes === 0) throw new AgentProfileError("not_found_template", `template ${id} not found`);
}

type UserTemplateRow = typeof userTemplates.$inferSelect;

const same = (text: string) => ({ ru: text, en: text, tg: text });
const NAME_LABEL = { ru: "Имя", en: "Name", tg: "Ном" };

function toLoaded(row: UserTemplateRow): LoadedTemplate {
  return {
    id: row.id,
    mode: row.mode,
    role: "specialist",
    title: same(row.title),
    description: same(row.description),
    emoji: row.emoji ?? undefined,
    fields: [{ key: "agentName", type: "text", label: NAME_LABEL, required: true, default: row.defaultName }],
    skills: row.skills,
    sources: row.folder ? ["folder"] : [],
    folder: row.folder ? same(row.folder) : undefined,
    cronPresets: row.cronPresets.map((p) => ({ ...p, label: same(p.label) })),
    canAskMain: row.canAskMain,
    sandbox: true,
    files: row.files as LoadedTemplate["files"],
  };
}

export function listUserTemplates(db: Db, mode: "personal" | "company"): TemplateDto[] {
  return db
    .select()
    .from(userTemplates)
    .where(eq(userTemplates.mode, mode))
    .all()
    .map(toLoaded)
    .map((t) => ({
      id: t.id,
      mode: t.mode,
      role: t.role,
      title: t.title,
      description: t.description,
      emoji: t.emoji ?? null,
      fields: t.fields.map((f) => ({ key: f.key, type: f.type, label: f.label, required: f.required, default: f.default ?? null })),
      cronPresets: t.cronPresets,
      canAskMain: t.canAskMain,
      sandbox: t.sandbox,
      folder: t.folder ?? null,
      own: true,
    }));
}

/** A built-in template, or one of the owner's ("my-…"). */
export function findTemplate(db: Db, mode: string, id: string): LoadedTemplate | null {
  if (id.startsWith("my-")) {
    const row = db.select().from(userTemplates).where(eq(userTemplates.id, id)).get();
    return row && row.mode === mode ? toLoaded(row) : null;
  }
  try {
    return loadTemplate(mode, id);
  } catch {
    return null;
  }
}
