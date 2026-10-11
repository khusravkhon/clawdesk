import { SpaceMode, type TemplateDto } from "@clawdesk/shared";
import { listTemplates } from "@clawdesk/templates";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const Query = z.object({ mode: SpaceMode.optional(), role: z.enum(["main", "specialist", "team_member"]).optional() });

export function registerTemplateRoutes(app: FastifyInstance): void {
  // Templates ship with the panel image, so they are read once.
  const all: TemplateDto[] = listTemplates().map((t) => ({
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
  }));
  // Custom goes last; the rest keep a stable alphabetical order.
  all.sort((a, b) => Number(a.id === "custom") - Number(b.id === "custom") || a.id.localeCompare(b.id));

  app.get("/api/templates", async (request): Promise<TemplateDto[]> => {
    const { mode, role } = Query.parse(request.query);
    return all.filter((t) => (!mode || t.mode === mode) && (!role || t.role === role));
  });
}
