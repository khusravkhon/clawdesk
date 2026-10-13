import { LoginRequest, SetOwnerPasswordRequest, TelegramResetConfirmRequest, TelegramResetRequest, type ApiErrorDto, type AuthStateDto } from "@clawdesk/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthError, type AuthService, type IssuedSession } from "../auth/auth-service.js";

// Panel sign-in routes and the guard in front of every other /api route.
// Cookie: httpOnly (scripts cannot read it), SameSite=Lax (other sites cannot send it with their
// POSTs, yet it still comes with the Notion/Google return trips), Secure behind HTTPS.
// Changing requests also have to come from the panel's own origin.

const COOKIE = "clawdesk_session";
/** Reachable without a session. */
const PUBLIC_ROUTES = new Set(["/api/health"]);
const PUBLIC_PREFIX = "/api/auth/";

export function registerAuthRoutes(app: FastifyInstance, deps: { auth: AuthService }): void {
  const { auth } = deps;

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/")) return;
    if (!SAFE_METHODS.has(request.method) && !sameOrigin(request)) {
      return reply.status(403).send({ error: "cross_origin", message: "request from another site" } satisfies ApiErrorDto);
    }
    // The matched route, not the raw path: "/api/auth/../agents" must not count as public.
    const route = request.routeOptions.url ?? path;
    if (PUBLIC_ROUTES.has(route) || route.startsWith(PUBLIC_PREFIX)) return;
    const session = auth.check(readCookie(request));
    if (!session) {
      // A page the browser opens directly (OAuth return trips) goes to the sign-in screen.
      if (request.method === "GET" && request.headers.accept?.includes("text/html")) return reply.redirect(`/login?next=${encodeURIComponent(request.url)}`);
      return reply.status(401).send({ error: "unauthorized", message: "sign in to the panel" } satisfies ApiErrorDto);
    }
    if (session.renewed) setCookie(reply, request, session.renewed);
  });

  app.get("/api/auth/state", async (request): Promise<AuthStateDto> => auth.state(readCookie(request)));

  app.post("/api/auth/setup", async (request, reply) => {
    const { code, password } = SetOwnerPasswordRequest.parse(request.body);
    return withAuthErrors(reply, async () => {
      setCookie(reply, request, await auth.setOwnerPassword(code, password, request.ip, request.headers["user-agent"]));
      return { state: "ok", telegramReset: auth.state(undefined).telegramReset } satisfies AuthStateDto;
    });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const { password } = LoginRequest.parse(request.body);
    return withAuthErrors(reply, async () => {
      setCookie(reply, request, await auth.login(password, request.ip, request.headers["user-agent"]));
      return { state: "ok", telegramReset: auth.state(undefined).telegramReset } satisfies AuthStateDto;
    });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    auth.logout(readCookie(request));
    clearCookie(reply, request);
    return { ok: true };
  });

  app.post("/api/auth/telegram/send", async (request, reply) => {
    const { locale } = TelegramResetRequest.parse(request.body ?? {});
    return withAuthErrors(reply, async () => {
      await auth.sendTelegramCode(locale, request.ip);
      return { ok: true };
    });
  });

  app.post("/api/auth/telegram/reset", async (request, reply) => {
    const { code, password } = TelegramResetConfirmRequest.parse(request.body);
    return withAuthErrors(reply, async () => {
      setCookie(reply, request, await auth.resetWithTelegramCode(code, password, request.ip, request.headers["user-agent"]));
      return { state: "ok", telegramReset: true } satisfies AuthStateDto;
    });
  });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const STATUS: Record<AuthError["code"], number> = {
  invalid_code: 400,
  wrong_password: 401,
  no_owner: 409,
  too_many_attempts: 429,
  too_soon: 429,
  telegram_unavailable: 503,
};

export async function withAuthErrors<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | ApiErrorDto> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    const retryAfterSec = Math.ceil(error.retryAfterMs / 1000);
    if (retryAfterSec > 0) reply.header("retry-after", String(retryAfterSec));
    reply.status(STATUS[error.code]);
    return { error: error.code, message: error.message, ...(retryAfterSec > 0 ? { details: { retryAfterSec } } : {}) };
  }
}

/** Browsers send Origin with every cross-site POST; it must name the host the panel was opened on. */
function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = (request.headers["x-forwarded-host"] as string | undefined) ?? request.headers.host;
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readCookie(request: FastifyRequest): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function isHttps(request: FastifyRequest): boolean {
  return request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
}

function setCookie(reply: FastifyReply, request: FastifyRequest, session: IssuedSession): void {
  reply.header("set-cookie", `${COOKIE}=${session.token}; Path=/; Max-Age=${session.maxAgeSec}; HttpOnly; SameSite=Lax${isHttps(request) ? "; Secure" : ""}`);
}

function clearCookie(reply: FastifyReply, request: FastifyRequest): void {
  reply.header("set-cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isHttps(request) ? "; Secure" : ""}`);
}
