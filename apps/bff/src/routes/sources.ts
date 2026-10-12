import { ConnectNotionTokenRequest, type ApiErrorDto, type SourcesDto, type StartNotionOAuthResultDto } from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BridgeError } from "../gateway/bridge-client.js";
import { NOTION_CALLBACK_PATH, SourcesError, type SourcesService } from "../sources/sources-service.js";

const NotionCallback = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() });

/** Origin the person opened the panel on (Vite in dev, the panel itself or a proxy in production). */
function panelOrigin(request: FastifyRequest): string {
  const host = (request.headers["x-forwarded-host"] as string | undefined) ?? request.headers.host ?? "127.0.0.1";
  const proto = (request.headers["x-forwarded-proto"] as string | undefined) ?? request.protocol;
  return `${proto}://${host}`;
}

export function registerSourceRoutes(app: FastifyInstance, deps: { sources: SourcesService }): void {
  app.get("/api/sources", async (): Promise<SourcesDto> => deps.sources.status());

  app.post("/api/sources/notion/token", async (request, reply): Promise<SourcesDto | ApiErrorDto> => {
    const { token } = ConnectNotionTokenRequest.parse(request.body);
    return withSourceErrors(reply, () => deps.sources.connectNotionToken(token));
  });

  app.post("/api/sources/notion/oauth", async (request, reply): Promise<StartNotionOAuthResultDto | ApiErrorDto> =>
    withSourceErrors(reply, () => deps.sources.startNotionOAuth(panelOrigin(request))),
  );

  // Notion sends the browser here after consent; the person lands back on the sources screen.
  app.get(NOTION_CALLBACK_PATH, async (request, reply) => {
    const q = NotionCallback.parse(request.query);
    if (q.error || !q.code || !q.state) return reply.redirect(`/sources?notion=denied`);
    try {
      await deps.sources.completeNotionOAuth(q.code, q.state);
      return reply.redirect("/sources?notion=connected");
    } catch (error) {
      request.log.warn({ err: error }, "notion sign-in failed");
      const reason = error instanceof SourcesError || error instanceof BridgeError ? error.code : "failed";
      return reply.redirect(`/sources?notion=error&reason=${encodeURIComponent(reason)}`);
    }
  });

  app.post("/api/sources/notion/disconnect", async (): Promise<SourcesDto> => deps.sources.disconnectNotion());
}

async function withSourceErrors<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | ApiErrorDto> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BridgeError) {
      reply.status(502);
      return { error: error.code, message: error.message };
    }
    if (error instanceof SourcesError) {
      reply.status(error.code === "notion_token_rejected" || error.code === "oauth_state_mismatch" ? 400 : 502);
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}
