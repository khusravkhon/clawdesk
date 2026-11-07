import { StartOpenClawUpdateRequest, type ApiErrorDto, type OpenClawUpdateDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import type { BackupService } from "../backups/backup-service.js";
import { BridgeError, type BridgeClient } from "../gateway/bridge-client.js";

// System → OpenClaw: shows the newer OpenClaw this ClawDesk has verified and moves the install to it
// when the owner asks (deploy/clawdesk-openclaw-update.mjs: backup, build, restart, checks, rollback).

const STATUS: Record<string, number> = { invalid_version: 400, not_verified: 409, not_newer: 409, update_running: 409, not_compose: 409, identity_ambiguous: 409, gateway_missing: 409 };

export function registerOpenClawUpdateRoutes(app: FastifyInstance, deps: { bridge: Pick<BridgeClient, "openclawUpdate" | "startOpenclawUpdate">; backups: Pick<BackupService, "available"> }): void {
  app.get("/api/system/openclaw", async (_request, reply): Promise<OpenClawUpdateDto | ApiErrorDto> => {
    if (!deps.backups.available) return { available: false, running: null, offer: null, status: null };
    try {
      return { available: true, ...(await deps.bridge.openclawUpdate()) };
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      // While the update restarts the Gateway the bridge is away for a while; the screen keeps asking.
      return reply.status(503).send({ error: error.code, message: error.message });
    }
  });

  app.post("/api/system/openclaw/update", async (request, reply) => {
    const { version } = StartOpenClawUpdateRequest.parse(request.body);
    if (!deps.backups.available) return reply.status(409).send({ error: "openclaw_update_unavailable", message: "OpenClaw is updated from the installed panel" });
    try {
      return await deps.bridge.startOpenclawUpdate(version);
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      return reply.status(STATUS[error.code] ?? 502).send({ error: error.code, message: error.message });
    }
  });
}
