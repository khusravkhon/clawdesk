import { CreateTeamRequest, LinkTeamTelegramRequest, TeamOwnerRequestsRequest, type ApiErrorDto } from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { BridgeError } from "../gateway/bridge-client.js";
import { SagaError } from "../provision/saga.js";
import { TeamError, type TeamService } from "../teams/team-service.js";
import { TelegramError } from "../telegram/telegram-service.js";

const Params = z.object({ teamId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/) });

export function registerTeamRoutes(app: FastifyInstance, deps: { teams: TeamService; mcp?: { syncAccess(): Promise<void> } }): void {
  const { teams } = deps;
  app.get("/api/teams", async () => teams.list());
  app.post("/api/teams", async (request, reply) =>
    withTeamErrors(
      reply,
      async () => {
        const team = await teams.create(CreateTeamRequest.parse(request.body));
        // Team agents get no MCP server until the owner grants one.
        await deps.mcp?.syncAccess().catch((error: Error) => request.log.warn({ err: error }, "could not apply MCP access to the team agents"));
        return team;
      },
      201,
    ),
  );
  app.get("/api/teams/:teamId/repo", async (request, reply) => withTeamErrors(reply, () => teams.status(Params.parse(request.params).teamId)));
  app.post("/api/teams/:teamId/fetch", async (request, reply) => withTeamErrors(reply, () => teams.fetchUpdates(Params.parse(request.params).teamId)));
  app.post("/api/teams/:teamId/push", async (request, reply) => withTeamErrors(reply, () => teams.pushBranch(Params.parse(request.params).teamId)));
  app.post("/api/teams/:teamId/telegram", async (request, reply) =>
    withTeamErrors(reply, () => teams.linkTelegram(Params.parse(request.params).teamId, LinkTeamTelegramRequest.parse(request.body).topics)),
  );
  app.put("/api/teams/:teamId/owner-requests", async (request, reply) => withTeamErrors(reply, async () => {
    teams.setOwnerRequests(Params.parse(request.params).teamId, TeamOwnerRequestsRequest.parse(request.body).mode);
    return { ok: true };
  }));
  app.delete("/api/teams/:teamId", async (request, reply) =>
    withTeamErrors(reply, async () => {
      await teams.remove(Params.parse(request.params).teamId);
      return { ok: true };
    }),
  );
}

const CONFLICT = new Set(["wrong_mode", "nothing_to_push", "no_owner", "no_token"]);

async function withTeamErrors<T>(reply: FastifyReply, run: () => Promise<T>, okStatus = 200): Promise<T | ApiErrorDto> {
  try {
    const result = await run();
    reply.status(okStatus);
    return result;
  } catch (error) {
    if (error instanceof TeamError || error instanceof BridgeError || error instanceof TelegramError) {
      reply.status(error.code === "no_team" ? 404 : CONFLICT.has(error.code) ? 409 : error instanceof BridgeError ? 502 : 400);
      return { error: error.code, message: error.message };
    }
    if (error instanceof SagaError) {
      reply.status(502);
      return { error: "create_failed", message: error.message, details: { failedStep: error.failedStep } };
    }
    throw error;
  }
}
