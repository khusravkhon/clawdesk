import { OwnerRequestAction } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { WorkRequestError, type WorkRequestsService } from "../company/work-requests-service.js";

const Params = z.object({ id: z.uuid() });

/** Stage 6: the owner's view of requests up the company structure and the owner's answers. */
export function registerWorkRequestRoutes(app: FastifyInstance, deps: { requests?: WorkRequestsService }): void {
  const service = deps.requests;
  if (!service) return;
  app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.status(400).send({ error: "invalid_request", message: "request validation failed" });
      if (!(error instanceof WorkRequestError)) throw error;
      const status = error.code === "request_missing" ? 404 : error.code === "company_only" ? 404 : 409;
      return reply.status(status).send({ error: error.code, message: error.code });
    });
    scope.get("/api/company/requests", () => service.list());
    scope.post("/api/company/requests/:id/act", (request) => service.ownerAct(Params.parse(request.params).id, OwnerRequestAction.parse(request.body)));
  });
}
