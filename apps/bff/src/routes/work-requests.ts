import { GrantResourceRequest, OwnerRequestAction, RefreshResourceRequest, RevokeResourceRequest, ShareOwnerFileRequest, UploadOwnerFileRequest } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { AccessError, type AccessService } from "../company/access-service.js";
import { WorkRequestError, type WorkRequestsService } from "../company/work-requests-service.js";

const Params = z.object({ id: z.uuid() });

/** Stages 5–6: requests up the company structure, the owner's answers and grants, and agents' access. */
export function registerWorkRequestRoutes(app: FastifyInstance, deps: { requests?: WorkRequestsService; access?: AccessService }): void {
  const { requests, access } = deps;
  if (!requests) return;
  app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.status(400).send({ error: "invalid_request", message: "request validation failed" });
      if (!(error instanceof WorkRequestError) && !(error instanceof AccessError)) throw error;
      const status = error.code === "request_missing" || error.code === "company_only" || error.code === "agent_missing" || error.code === "resource_missing" ? 404 : 409;
      return reply.status(status).send({ error: error.code, message: error.code });
    });
    scope.get("/api/company/requests", () => requests.list());
    scope.post("/api/company/requests/:id/act", (request) => {
      const id = Params.parse(request.params).id, body = OwnerRequestAction.parse(request.body);
      if (body.action !== "grant") return requests.ownerAct(id, { ...body, action: body.action });
      if (!access) throw new WorkRequestError("not_access");
      return requests.ownerGrant(id, body, (grant, by) => access.grant(grant, by));
    });
    if (!access) return;
    scope.get("/api/company/access", () => access.list());
    scope.post("/api/company/access/grant", async (request) => { await access.grant(GrantResourceRequest.parse(request.body), "owner"); return access.list(); });
    scope.post("/api/company/access/revoke", async (request) => { await access.revoke(RevokeResourceRequest.parse(request.body), "owner"); return access.list(); });
    // «Документы»: the owner's files without any connection — upload, give one to an agent with an instruction.
    scope.get("/api/company/documents", () => access.files());
    scope.post("/api/company/documents/upload", { bodyLimit: 30 * 1024 * 1024 }, async (request) => { const { name, base64 } = UploadOwnerFileRequest.parse(request.body); await access.uploadFile(name, base64); return access.files(); });
    scope.post("/api/company/documents/share", async (request) => { const { agentId, file, instruction } = ShareOwnerFileRequest.parse(request.body); const result = await access.shareFile(agentId, file, instruction); return { ...(await access.files()), path: result.path }; });
    scope.post("/api/company/access/refresh", async (request) => { const result = await access.refresh(RefreshResourceRequest.parse(request.body)); return { ...(await access.list()), changed: result.changed }; });
  });
}
