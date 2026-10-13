import type { AuditPageDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuditService } from "../audit/audit-service.js";

const Query = z.object({ before: z.coerce.number().int().positive().optional(), cursor: z.string().max(200).optional() });

export function registerAuditRoutes(app: FastifyInstance, deps: { audit: AuditService }): void {
  app.get("/api/system/audit", async (request): Promise<AuditPageDto> => deps.audit.page(Query.parse(request.query)));
}
