import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRole, DataSourceKind, SpaceMode } from "@clawdesk/shared";
import { z } from "zod";

// An agent template is a folder under agents/<mode>/<id>/ with template.json
// plus SOUL.md / AGENTS.md / USER.md containing {{placeholders}}. Community
// templates arrive as pull requests adding such a folder.

const TEMPLATES_ROOT = fileURLToPath(new URL("../agents", import.meta.url));

export const WORKSPACE_FILES = ["SOUL.md", "AGENTS.md", "USER.md"] as const;
export type WorkspaceFile = (typeof WORKSPACE_FILES)[number];

const LocalizedText = z.object({ ru: z.string(), en: z.string(), tg: z.string().optional() });

export const TemplateField = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: z.enum(["text", "textarea"]),
  label: LocalizedText,
  required: z.boolean().default(true),
  default: z.string().optional(),
});

export const CronPreset = z.object({
  id: z.string(),
  label: LocalizedText,
  /** 5-field cron expression, evaluated in the Space timezone. */
  cron: z.string(),
  prompt: z.string(),
});

export const AgentTemplate = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  mode: SpaceMode,
  role: AgentRole,
  title: LocalizedText,
  description: LocalizedText,
  emoji: z.string().optional(),
  fields: z.array(TemplateField).default([]),
  skills: z.array(z.string()).default([]),
  sources: z.array(DataSourceKind).default([]),
  /** Default name of the agent's own folder inside the shared files folder (sources: folder). */
  folder: LocalizedText.optional(),
  cronPresets: z.array(CronPreset).default([]),
  canAskMain: z.boolean().default(false),
  sandbox: z.boolean().default(true),
});
export type AgentTemplate = z.infer<typeof AgentTemplate>;

export type LoadedTemplate = AgentTemplate & { files: Record<WorkspaceFile, string> };

export function listTemplates(root = TEMPLATES_ROOT): LoadedTemplate[] {
  const out: LoadedTemplate[] = [];
  for (const mode of fs.readdirSync(root)) {
    const modeDir = path.join(root, mode);
    if (!fs.statSync(modeDir).isDirectory()) continue;
    for (const id of fs.readdirSync(modeDir)) {
      if (fs.existsSync(path.join(modeDir, id, "template.json"))) out.push(loadTemplateDir(path.join(modeDir, id)));
    }
  }
  return out;
}

export function loadTemplate(mode: string, id: string, root = TEMPLATES_ROOT): LoadedTemplate {
  return loadTemplateDir(path.join(root, mode, id));
}

function loadTemplateDir(dir: string): LoadedTemplate {
  const meta = AgentTemplate.parse(JSON.parse(fs.readFileSync(path.join(dir, "template.json"), "utf8")));
  const files = Object.fromEntries(WORKSPACE_FILES.map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")])) as Record<WorkspaceFile, string>;
  return { ...meta, files };
}

/** Replaces {{key}} placeholders; throws on any placeholder without a value so half-rendered prompts never ship. */
export function renderTemplateText(text: string, values: Record<string, string>): string {
  const missing = new Set<string>();
  const rendered = text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) {
      missing.add(key);
      return "";
    }
    return value;
  });
  if (missing.size > 0) throw new Error(`template placeholders without values: ${[...missing].join(", ")}`);
  return rendered;
}

export function renderTemplateFiles(template: LoadedTemplate, values: Record<string, string>): Record<WorkspaceFile, string> {
  const withDefaults: Record<string, string> = {};
  for (const field of template.fields) {
    const value = values[field.key] ?? field.default;
    if (value === undefined && field.required) throw new Error(`template field "${field.key}" is required`);
    withDefaults[field.key] = value ?? "";
  }
  const all = { ...values, ...withDefaults };
  return Object.fromEntries(WORKSPACE_FILES.map((name) => [name, renderTemplateText(template.files[name], all)])) as Record<WorkspaceFile, string>;
}
