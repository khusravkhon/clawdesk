import type { FastifyInstance } from "fastify";

/**
 * The panel's own Content Security Policy. Naive UI injects its styles at runtime, hence 'unsafe-inline' for
 * styles only; scripts come from the build alone. A route that sets its own policy (the project builder
 * preview) keeps it.
 */
export const PANEL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

/**
 * Protective headers on every answer, so a panel reached through an SSH tunnel or the desktop app is as
 * protected as one behind Caddy. HSTS stays with Caddy: only it knows the panel is served over HTTPS.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", PANEL_CSP);
    return payload;
  });
}
