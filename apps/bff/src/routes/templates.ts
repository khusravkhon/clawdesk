import { SpaceMode, type ApiErrorDto, type TemplateDto } from "@clawdesk/shared";
import { listTemplates } from "@clawdesk/templates";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { AgentProfileError, deleteUserTemplate, listUserTemplates } from "../provision/agent-profile.js";

const Query = z.object({ mode: SpaceMode.optional(), role: z.enum(["main", "specialist", "team_member"]).optional() });
const OwnParams = z.object({ templateId: z.string().regex(/^my-[a-z0-9-]{1,60}$/) });

export function registerTemplateRoutes(app: FastifyInstance, deps: { db: Db }): void {
  // Built-in templates ship with the panel image, so they are read once.
  const builtIn: TemplateDto[] = listTemplates().map((t) => ({
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
    own: false,
  }));
  // Custom goes last; the rest keep a stable alphabetical order.
  builtIn.sort((a, b) => Number(a.id === "custom") - Number(b.id === "custom") || a.id.localeCompare(b.id));

  app.get("/api/templates", async (request): Promise<TemplateDto[]> => {
    const { mode, role } = Query.parse(request.query);
    // The owner's own templates first: they are why the person came back to the builder.
    const own = (mode ? listUserTemplates(deps.db, mode) : [...listUserTemplates(deps.db, "personal"), ...listUserTemplates(deps.db, "company")]).sort((a, b) =>
      a.title.ru.localeCompare(b.title.ru),
    );
    return [...own, ...builtIn].filter((t) => (!mode || t.mode === mode) && (!role || t.role === role));
  });

  app.delete("/api/templates/:templateId", async (request, reply) => {
    const { templateId } = OwnParams.parse(request.params);
    try {
      deleteUserTemplate(deps.db, templateId);
    } catch (error) {
      if (error instanceof AgentProfileError) return reply.status(404).send({ error: error.code, message: error.message } satisfies ApiErrorDto);
      throw error;
    }
    return reply.status(204).send();
  });
}
