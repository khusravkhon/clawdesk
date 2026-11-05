import { CreateWorkItemRequest, WorkItemActionRequest } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { WorkItemError, type WorkItemsService } from "../company/work-items-service.js";

const Params = z.object({ id: z.uuid() });

/** Stage 6, part 2: company tasks — the owner sets, starts, accepts or returns them. */
export function registerWorkItemRoutes(app: FastifyInstance, deps: { workItems?: WorkItemsService }): void {
  const service = deps.workItems;
  if (!service) return;
  app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.status(400).send({ error: "invalid_request", message: "request validation failed" });
      if (!(error instanceof WorkItemError)) throw error;
      const status = error.code === "item_missing" || error.code === "company_only" || error.code === "executor_missing" ? 404 : 409;
      return reply.status(status).send({ error: error.code, message: error.code });
    });
    scope.get("/api/company/work-items", () => service.list());
    scope.post("/api/company/work-items", async (request, reply) => reply.status(201).send(service.create(CreateWorkItemRequest.parse(request.body))));
    scope.post("/api/company/work-items/:id/act", (request) => service.act(Params.parse(request.params).id, WorkItemActionRequest.parse(request.body)));
  });
}
