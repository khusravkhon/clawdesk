import { StorageCleanupDto, StorageCleanupRequest, StoragePreviewDto, StoragePreviewRequest, StorageQuotaRequest, StorageStatusDto } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { BridgeError, type BridgeClient } from "../gateway/bridge-client.js";
import type { SpaceService } from "../space/space-service.js";

const CODES = new Set(["storage_unavailable", "storage_busy", "storage_quota_exceeded", "preview_expired", "invalid_quota", "invalid_category"]);
export function registerStorageRoutes(app: FastifyInstance, deps: { bridge: BridgeClient; space: SpaceService }): void {
  app.register(async (scope) => {
    scope.addHook("preHandler", async (_request, reply) => {
      if (deps.space.mode() !== "personal") return reply.status(404).send({ error: "not_found", message: "not_found" });
    });
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.status(400).send({ error: "invalid_request", message: "invalid_request" });
      if (!(error instanceof BridgeError)) throw error;
      const code = CODES.has(error.code) ? error.code : "storage_unavailable";
      return reply.status(code === "storage_unavailable" ? 503 : 409).send({ error: code, message: code });
    });
    scope.get("/api/system/storage", async () => StorageStatusDto.parse(await deps.bridge.storageStatus()));
    scope.post("/api/system/storage/quota", async (request) => {
      const body = StorageQuotaRequest.parse(request.body);
      return StorageStatusDto.parse(await deps.bridge.storageQuota(body.videoQuotaBytes));
    });
    scope.post("/api/system/storage/preview", async (request) => {
      const body = StoragePreviewRequest.parse(request.body);
      return StoragePreviewDto.parse(await deps.bridge.storagePreview(body.category));
    });
    scope.post("/api/system/storage/cleanup", async (request) => {
      const body = StorageCleanupRequest.parse(request.body);
      return StorageCleanupDto.parse(await deps.bridge.storageCleanup(body.token));
    });
  });
}
