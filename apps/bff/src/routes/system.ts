import { DownloadBackupRequest, FactoryResetRequest, type ApiErrorDto, type BackupDto, type BackupsDto, type FactoryResetResultDto } from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthService } from "../auth/auth-service.js";
import { BackupUnavailableError, type BackupService } from "../backups/backup-service.js";
import { BridgeError } from "../gateway/bridge-client.js";
import { withAuthErrors } from "./auth.js";

// System screen (14): backups and factory reset. Behind the sign-in guard like every /api route.

export function registerSystemRoutes(app: FastifyInstance, deps: { backups: BackupService; auth: AuthService }): void {
  const { backups, auth } = deps;

  app.get("/api/system/backups", async (): Promise<BackupsDto> => backups.status());

  app.post("/api/system/backups", async (_request, reply): Promise<BackupDto | ApiErrorDto> => withBackupErrors(reply, () => backups.create("manual")));

  // POST, not GET: the password that encrypts the copy must not end up in a URL or a log.
  app.post<{ Params: { name: string } }>("/api/system/backups/:name/download", async (request, reply) => {
    const { password } = DownloadBackupRequest.parse(request.body);
    return withBackupErrors(reply, async () => {
      const { stream, filename } = await backups.download(request.params.name, password);
      reply.header("content-type", "application/octet-stream").header("content-disposition", `attachment; filename="${filename}"`).header("cache-control", "no-store");
      return reply.send(stream);
    });
  });

  app.post("/api/system/reset", async (request, reply): Promise<FactoryResetResultDto | ApiErrorDto> => {
    const { password } = FactoryResetRequest.parse(request.body);
    if (!backups.available) return reply.status(409).send({ error: "backups_unavailable", message: "factory reset works in the installed panel" });
    const confirmed = await withAuthErrors(reply, () => auth.confirmPassword(password, request.ip));
    if (reply.statusCode >= 400) return confirmed as ApiErrorDto;
    return withBackupErrors(reply, () => backups.factoryReset());
  });
}

async function withBackupErrors<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | ApiErrorDto> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BackupUnavailableError) {
      reply.status(404);
      return { error: "backup_unavailable", message: error.message };
    }
    if (error instanceof BridgeError) {
      reply.status(error.code === "backup_busy" ? 409 : 502);
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}
