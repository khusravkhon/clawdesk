import { LibraryItemKind, SaveBudgetRequest, SaveMemoryNoteRequest, type BudgetDto, type LibrarySearchDto, type MemoryNotesDto } from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { BudgetService } from "../budget/budget-service.js";
import type { LibraryService } from "../library/library-service.js";
import { MemoryNoteError, type MemoryNoteService } from "../library/memory-note-service.js";

// The owner's library, their agents' notes and the spending limits. Everything is behind the panel
// sign-in like every /api route; agents never call these.

const AgentId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** "Today" and "this month" are the owner's, so the browser's time zone decides — as on screen 13. */
const TimeZone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  })
  .optional();
const BudgetQuery = z.object({ tz: TimeZone });
const SearchQuery = z.object({ q: z.string().trim().max(200).default(""), agentId: AgentId.optional() });
const MaterialId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const PageQuery = SearchQuery.extend({
  kind: LibraryItemKind.optional(),
  beforeAt: z.coerce.number().int().min(0).max(8_640_000_000_000_000).optional(),
  beforeId: MaterialId.optional(),
}).refine(({ beforeAt, beforeId }) => (beforeAt === undefined) === (beforeId === undefined), "a cursor requires both fields");
const NoteParams = z.object({ agentId: AgentId, id: z.string().uuid() });

export function registerLibraryRoutes(app: FastifyInstance, deps: { library: LibraryService; notes: MemoryNoteService; budget: BudgetService }): void {
  const zone = (tz: string | undefined) => tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  app.get("/api/library", async (request) => {
    const { agentId, kind, q, beforeAt, beforeId } = PageQuery.parse(request.query);
    return deps.library.page({ agentId, kind, query: q, cursor: beforeAt !== undefined && beforeId ? { at: beforeAt, id: beforeId } : undefined });
  });

  // A search only reads the materials of the agent asked about; without one it is the owner's own view.
  app.get("/api/library/search", async (request): Promise<LibrarySearchDto> => {
    const { q, agentId } = SearchQuery.parse(request.query);
    return deps.library.search(q, agentId);
  });

  app.get("/api/library/:id", async (request, reply) => {
    const { id } = z.object({ id: MaterialId }).parse(request.params);
    const material = deps.library.material(id);
    return material ?? reply.status(404).send({ error: "not_found", message: "no such material" });
  });

  app.delete<{ Params: { id: string } }>("/api/library/:id", async (request, reply) => {
    const { id } = z.object({ id: MaterialId }).parse(request.params);
    deps.library.remove(id);
    return reply.status(204).send();
  });

  app.get<{ Params: { agentId: string } }>("/api/memory/:agentId/notes", async (request): Promise<MemoryNotesDto> => {
    const { agentId } = z.object({ agentId: AgentId }).parse(request.params);
    return deps.notes.list(agentId);
  });

  app.post("/api/memory/:agentId/notes/sync", async (request): Promise<MemoryNotesDto> => {
    const { agentId } = z.object({ agentId: AgentId }).parse(request.params);
    return deps.notes.sync(agentId);
  });

  app.post<{ Params: { agentId: string } }>("/api/memory/:agentId/notes", async (request, reply): Promise<MemoryNotesDto | undefined> => {
    const { agentId } = z.object({ agentId: AgentId }).parse(request.params);
    const body = SaveMemoryNoteRequest.parse(request.body);
    try {
      const notes = await deps.notes.add(agentId, body);
      reply.status(201);
      return notes;
    } catch (error) {
      return noteError(error, reply);
    }
  });

  app.patch<{ Params: { agentId: string; id: string } }>("/api/memory/:agentId/notes/:id", async (request, reply): Promise<MemoryNotesDto | undefined> => {
    const { agentId, id } = NoteParams.parse(request.params);
    const body = SaveMemoryNoteRequest.parse(request.body);
    try {
      return await deps.notes.update(agentId, id, body);
    } catch (error) {
      return noteError(error, reply);
    }
  });

  app.delete<{ Params: { agentId: string; id: string } }>("/api/memory/:agentId/notes/:id", async (request, reply): Promise<MemoryNotesDto | undefined> => {
    const { agentId, id } = NoteParams.parse(request.params);
    try {
      return await deps.notes.remove(agentId, id);
    } catch (error) {
      return noteError(error, reply);
    }
  });

  app.get("/api/budget", async (request): Promise<BudgetDto> => {
    const { tz } = BudgetQuery.parse(request.query);
    return deps.budget.status(zone(tz));
  });
  app.get("/api/budget/limits", async () => deps.budget.limits());

  app.put("/api/budget", async (request): Promise<BudgetDto> => {
    const { tz } = BudgetQuery.parse(request.query);
    const body = SaveBudgetRequest.parse(request.body);
    return deps.budget.save(body, zone(tz));
  });
}

/** A note error is the owner's to fix: a note that is gone, or one note too many. */
function noteError(error: unknown, reply: FastifyReply): undefined {
  if (!(error instanceof MemoryNoteError)) throw error;
  const status = error.code === "not_found" ? 404 : 409;
  void reply.status(status).send({ error: "note_rejected", message: error.code, details: { code: error.code } });
  return undefined;
}
