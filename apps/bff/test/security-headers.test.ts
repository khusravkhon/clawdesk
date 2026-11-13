import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { PANEL_CSP, registerSecurityHeaders } from "../src/security-headers.js";

describe("security headers", () => {
  it("are on every answer, also without Caddy in front", async () => {
    const app = Fastify();
    registerSecurityHeaders(app);
    app.get("/api/health", async () => ({ ok: true }));
    app.get("/api/missing", async (_request, reply) => reply.status(404).send({ error: "not_found" }));
    for (const url of ["/api/health", "/api/missing"]) {
      const res = await app.inject({ url });
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(res.headers["content-security-policy"]).toBe(PANEL_CSP);
    }
    await app.close();
  });

  it("leave a route's own policy alone (the builder preview runs its inline scripts)", async () => {
    const app = Fastify();
    registerSecurityHeaders(app);
    app.get("/preview", async (_request, reply) => reply.header("Content-Security-Policy", "default-src 'none'").type("text/html").send("<p>hi</p>"));
    const res = await app.inject({ url: "/preview" });
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
  });

  it("allow scripts from the panel's own origin only", () => {
    expect(PANEL_CSP).toContain("script-src 'self';");
    expect(PANEL_CSP).not.toMatch(/script-src[^;]*unsafe/);
  });
});
