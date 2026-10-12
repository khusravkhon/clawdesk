import { ResolveApprovalRequest, SetExecModeRequest, type ApprovalsDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApprovalsService } from "../approvals/approvals-service.js";
import type { GatewayService } from "../gateway/gateway-service.js";

const IdParams = z.object({ id: z.string().min(1).max(200) });
const RemoveAllowed = z.object({ pattern: z.string().min(1).max(2000) });
const APPROVAL_EVENTS = new Set(["exec.approval.requested", "exec.approval.resolved", "plugin.approval.requested", "plugin.approval.resolved"]);

export function registerApprovalRoutes(app: FastifyInstance, deps: { approvals: ApprovalsService; gateway: GatewayService }): void {
  app.get("/api/approvals", async (): Promise<ApprovalsDto> => deps.approvals.list());

  app.post("/api/approvals/:id/resolve", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { kind, decision } = ResolveApprovalRequest.parse(request.body);
    await deps.approvals.resolve(id, kind, decision);
    return reply.status(204).send();
  });

  app.post("/api/approvals/mode", async (request): Promise<ApprovalsDto> => {
    const { mode } = SetExecModeRequest.parse(request.body);
    await deps.approvals.setMainMode(mode);
    return deps.approvals.list();
  });

  app.post("/api/approvals/allowed/remove", async (request): Promise<ApprovalsDto> => {
    const { pattern } = RemoveAllowed.parse(request.body);
    await deps.approvals.removeAllowed(pattern);
    return deps.approvals.list();
  });

  // Tells open panels that the queue changed; they fetch the list (events may carry the full request).
  app.get("/api/approvals/events", async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": connected\n\n");
    const off = deps.gateway.onEvent((event) => {
      if (APPROVAL_EVENTS.has(event.event)) res.write(`data: ${JSON.stringify({ type: event.event.endsWith("requested") ? "requested" : "resolved" })}\n\n`);
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(ping);
      off();
    });
  });
}
