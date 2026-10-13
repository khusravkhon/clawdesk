import {
  CompleteGoogleLoginRequest,
  ConnectFigmaRequest,
  PollGitHubSignInRequest,
  ConnectNotionTokenRequest,
  StartGoogleLoginRequest,
  UploadGoogleClientRequest,
  type ApiErrorDto,
  type SourcesDto,
  type StartGoogleLoginResultDto,
  type StartNotionOAuthResultDto,
} from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BridgeError } from "../gateway/bridge-client.js";
import { GOOGLE_CALLBACK_PATH, NOTION_CALLBACK_PATH, SourcesError, type SourcesService } from "../sources/sources-service.js";

const RemoveGoogle = z.object({ email: z.string().email() });
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

  app.post("/api/sources/google/client", async (request, reply): Promise<SourcesDto | ApiErrorDto> => {
    const { json } = UploadGoogleClientRequest.parse(request.body);
    return withSourceErrors(reply, () => deps.sources.uploadGoogleClient(json));
  });

  app.post("/api/sources/google/login", async (request, reply): Promise<StartGoogleLoginResultDto | ApiErrorDto> => {
    const { email, services, readonly } = StartGoogleLoginRequest.parse(request.body);
    return withSourceErrors(reply, () => deps.sources.startGoogleLogin(email, services, readonly, panelOrigin(request)));
  });

  // Google returns here when the panel is on localhost; the full address goes to gog as the auth URL.
  app.get(GOOGLE_CALLBACK_PATH, async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    if (q.error || !q.code) return reply.redirect("/sources?google=denied");
    try {
      await deps.sources.completeGoogleLogin(new URL(request.url, panelOrigin(request)).href);
      return reply.redirect("/sources?google=connected");
    } catch (error) {
      request.log.warn({ err: error }, "google sign-in failed");
      const reason = error instanceof SourcesError || error instanceof BridgeError ? error.code : "failed";
      return reply.redirect(`/sources?google=error&reason=${encodeURIComponent(reason)}`);
    }
  });

  app.post("/api/sources/google/complete", async (request, reply): Promise<SourcesDto | ApiErrorDto> => {
    const { redirectUrl } = CompleteGoogleLoginRequest.parse(request.body);
    return withSourceErrors(reply, () => deps.sources.completeGoogleLogin(redirectUrl));
  });

  app.post("/api/sources/google/remove", async (request, reply): Promise<SourcesDto | ApiErrorDto> => {
    const { email } = RemoveGoogle.parse(request.body);
    return withSourceErrors(reply, () => deps.sources.removeGoogle(email));
  });

  app.post("/api/sources/notion/disconnect", async (): Promise<SourcesDto> => deps.sources.disconnectNotion());

  // GitHub: the person types the code OpenClaw got from GitHub at github.com/login/device; the panel polls.
  app.post("/api/sources/github/start", async () => deps.sources.startGitHubSignIn());
  app.post("/api/sources/github/poll", async (request) => deps.sources.pollGitHubSignIn(PollGitHubSignInRequest.parse(request.body).requestId));
  app.post("/api/sources/github/disconnect", async (): Promise<SourcesDto> => deps.sources.disconnectGitHub());

  app.post("/api/sources/figma/token", async (request, reply): Promise<SourcesDto | ApiErrorDto> => {
    const { token } = ConnectFigmaRequest.parse(request.body);
    return withSourceErrors(reply, () => deps.sources.connectFigmaToken(token));
  });
  app.post("/api/sources/figma/disconnect", async (): Promise<SourcesDto> => deps.sources.disconnectFigma());
}

async function withSourceErrors<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | ApiErrorDto> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BridgeError) {
      // gog / OpenClaw refused the input (bad client JSON, wrong code): the person can fix it.
      reply.status(["invalid_client_json", "login_failed", "invalid_auth_url", "invalid_email", "invalid_services"].includes(error.code) ? 400 : 502);
      return { error: error.code, message: error.message };
    }
    if (error instanceof SourcesError) {
      reply.status(error.code === "notion_token_rejected" || error.code === "figma_token_rejected" || error.code === "oauth_state_mismatch" ? 400 : 502);
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}
