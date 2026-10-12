import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthError, AuthService, SESSION_TTL_MS } from "../src/auth/auth-service.js";
import { OwnerCodeFile, sameCode } from "../src/auth/owner-code.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { openDb } from "../src/db/client.js";
import { registerAuthRoutes } from "../src/routes/auth.js";

const PASSWORD = "correct horse battery";
const UA = "vitest";

describe("panel sign-in", () => {
  let dir: string;
  let close: () => void;
  let db: ReturnType<typeof openDb>["db"];
  let now: number;
  let sent: string[];
  let telegramOwner: boolean;
  let telegramFails: boolean;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-auth-"));
    ({ db, close } = openDb(path.join(dir, "panel.sqlite")));
    now = Date.UTC(2026, 9, 12, 12);
    sent = [];
    telegramOwner = true;
    telegramFails = false;
  });
  afterEach(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const service = () =>
    new AuthService({
      db,
      dataDir: dir,
      logger: pino({ level: "silent" }),
      now: () => now,
      telegram: {
        hasOwner: () => telegramOwner,
        sendToOwner: async (text) => {
          if (telegramFails) throw new Error("gateway down");
          sent.push(text);
        },
      },
    });

  const codeIn = (text: string) => /: ([A-Z0-9]{4}-[A-Z0-9]{4})\n/.exec(text)![1]!;
  const rejects = async (p: Promise<unknown>, code: AuthError["code"]) => {
    const error = await p.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
  };

  it("hashes passwords with a salt and checks them", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword("wrong password!", a)).toBe(false);
    expect(await verifyPassword(PASSWORD, "garbage")).toBe(false);
  });

  it("compares owner codes without dashes and case", () => {
    expect(sameCode("abcd-efgh-jkmn", "ABCDEFGHJKMN")).toBe(true);
    expect(sameCode("ABCD-EFGH-JKMP", "ABCD-EFGH-JKMN")).toBe(false);
  });

  it("first run: the owner password needs the code from the server, and the code works once", async () => {
    const auth = service();
    expect(auth.state(undefined).state).toBe("setup");
    const code = auth.ownerCodeForFirstRun()!;
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(auth.ownerCodeForFirstRun()).toBe(code); // same code across restarts until used

    await rejects(auth.setOwnerPassword("AAAA-BBBB-CCCC", PASSWORD, "1.2.3.4", UA), "invalid_code");
    const session = await auth.setOwnerPassword(code.toLowerCase(), PASSWORD, "1.2.3.4", UA);
    expect(auth.state(session.token).state).toBe("ok");
    expect(auth.state(undefined).state).toBe("login");
    expect(auth.ownerCodeForFirstRun()).toBeNull();
    await rejects(auth.setOwnerPassword(code, "another password", "1.2.3.4", UA), "invalid_code");
  });

  it("a new owner code from the server replaces the password and signs everyone out", async () => {
    const auth = service();
    const first = await auth.setOwnerPassword(auth.ownerCodeForFirstRun()!, PASSWORD, "ip", UA);
    const code = new OwnerCodeFile(dir).issue(); // what `owner-code` does while the panel runs
    const second = await auth.setOwnerPassword(code, "a brand new password", "ip", UA);
    expect(auth.check(first.token)).toBeNull();
    expect(auth.check(second.token)).not.toBeNull();
    await rejects(auth.login(PASSWORD, "ip", UA), "wrong_password");
    await auth.login("a brand new password", "ip", UA);
  });

  it("signs in with the password and slows down guessing", async () => {
    const auth = service();
    await auth.setOwnerPassword(auth.ownerCodeForFirstRun()!, PASSWORD, "ip", UA);
    for (let i = 0; i < 5; i++) await rejects(auth.login("guess number " + i, "attacker", UA), "wrong_password");
    await rejects(auth.login("one more guess", "attacker", UA), "wrong_password");
    // Now the attacker waits, even with the right password; other addresses are not affected.
    await rejects(auth.login(PASSWORD, "attacker", UA), "too_many_attempts");
    const ok = await auth.login(PASSWORD, "owner-laptop", UA);
    expect(auth.check(ok.token)?.userId).toBe("owner");
    now += 31_000;
    await auth.login(PASSWORD, "attacker", UA);
  });

  it("sessions last 30 days and are renewed while used", async () => {
    const auth = service();
    const { token } = await auth.setOwnerPassword(auth.ownerCodeForFirstRun()!, PASSWORD, "ip", UA);
    expect(auth.check(token)?.renewed).toBeNull();
    now += 2 * 24 * 60 * 60_000;
    const renewed = auth.check(token)!.renewed!;
    expect(renewed.expiresAt).toBe(now + SESSION_TTL_MS);
    now += SESSION_TTL_MS - 1; // unused for a month
    expect(auth.check(token)).not.toBeNull();
    now = renewed.expiresAt + SESSION_TTL_MS; // and again, without a visit
    expect(auth.check(token)).toBeNull();
    expect(auth.check("not-a-token")).toBeNull();
  });

  it("logout ends only this browser's session", async () => {
    const auth = service();
    const a = await auth.setOwnerPassword(auth.ownerCodeForFirstRun()!, PASSWORD, "ip", UA);
    const b = await auth.login(PASSWORD, "ip", UA);
    auth.logout(a.token);
    expect(auth.check(a.token)).toBeNull();
    expect(auth.check(b.token)).not.toBeNull();
  });

  it("forgotten password: the bot sends a code, five wrong tries burn it", async () => {
    const auth = service();
    const old = await auth.setOwnerPassword(auth.ownerCodeForFirstRun()!, PASSWORD, "ip", UA);
    await auth.sendTelegramCode("ru", "ip");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("15 минут");
    const code = codeIn(sent[0]!);
    for (let i = 0; i < 5; i++) await rejects(auth.resetWithTelegramCode("ZZZZ-ZZZZ", "new password 123", `ip${i}`, UA), "invalid_code");
    await rejects(auth.resetWithTelegramCode(code, "new password 123", "ip9", UA), "invalid_code");

    now += 61_000;
    await auth.sendTelegramCode("en", "ip");
    const fresh = codeIn(sent[1]!);
    const session = await auth.resetWithTelegramCode(fresh.toLowerCase(), "new password 123", "ip", UA);
    expect(auth.check(old.token)).toBeNull();
    expect(auth.check(session.token)).not.toBeNull();
    await rejects(auth.resetWithTelegramCode(fresh, "again password 1", "ip", UA), "invalid_code"); // once
  });

  it("telegram codes expire, are not resent too often, and need an approved owner", async () => {
    const auth = service();
    await auth.setOwnerPassword(auth.ownerCodeForFirstRun()!, PASSWORD, "ip", UA);
    await auth.sendTelegramCode("tg", "ip");
    await rejects(auth.sendTelegramCode("tg", "ip"), "too_soon");
    now += 16 * 60_000;
    await rejects(auth.resetWithTelegramCode(codeIn(sent[0]!), "new password 123", "ip", UA), "invalid_code");

    telegramFails = true;
    await rejects(auth.sendTelegramCode("ru", "ip"), "telegram_unavailable");
    telegramOwner = false;
    expect(auth.state(undefined).telegramReset).toBe(false);
    await rejects(auth.sendTelegramCode("ru", "ip"), "telegram_unavailable");
  });

  describe("routes", () => {
    let app: FastifyInstance;
    let auth: AuthService;

    beforeEach(async () => {
      auth = service();
      app = Fastify();
      registerAuthRoutes(app, { auth });
      app.get("/api/health", async () => ({ ok: true }));
      app.get("/api/agents", async () => ({ agents: [] }));
      app.post("/api/agents", async () => ({ created: true }));
      app.get("/api/sources/google/callback", async () => "ok");
      await app.ready();
    });
    afterEach(() => app.close());

    const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;

    it("keeps every /api route closed until sign-in, except health and sign-in itself", async () => {
      expect((await app.inject({ url: "/api/agents" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
      const state = await app.inject({ url: "/api/auth/state" });
      expect(state.json()).toEqual({ state: "setup", telegramReset: true });

      const page = await app.inject({ url: "/api/sources/google/callback?code=x", headers: { accept: "text/html" } });
      expect(page.statusCode).toBe(302);
      expect(page.headers.location).toBe(`/login?next=${encodeURIComponent("/api/sources/google/callback?code=x")}`);
    });

    it("sets an httpOnly cookie on setup and login, and logout clears it", async () => {
      const code = auth.ownerCodeForFirstRun()!;
      const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { code, password: PASSWORD } });
      expect(setup.statusCode).toBe(200);
      expect(String(setup.headers["set-cookie"])).toMatch(/^clawdesk_session=[\w-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
      const cookie = cookieOf(setup);
      expect((await app.inject({ url: "/api/agents", headers: { cookie } })).statusCode).toBe(200);

      const wrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "nope" } });
      expect(wrong.statusCode).toBe(401);
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD }, headers: { "x-forwarded-proto": "https" } });
      expect(String(login.headers["set-cookie"])).toContain("; Secure");

      await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
      expect((await app.inject({ url: "/api/agents", headers: { cookie } })).statusCode).toBe(401);
    });

    it("rejects changes sent from another site", async () => {
      const { token } = await auth.setOwnerPassword(auth.ownerCodeForFirstRun()!, PASSWORD, "ip", UA);
      const cookie = `clawdesk_session=${token}`;
      const foreign = await app.inject({ method: "POST", url: "/api/agents", headers: { cookie, host: "panel.example", origin: "https://evil.example" } });
      expect(foreign.statusCode).toBe(403);
      const own = await app.inject({ method: "POST", url: "/api/agents", headers: { cookie, host: "panel.example", origin: "https://panel.example" } });
      expect(own.statusCode).toBe(200);
    });

    it("reports a pause after too many tries", async () => {
      await auth.setOwnerPassword(auth.ownerCodeForFirstRun()!, PASSWORD, "127.0.0.1", UA);
      for (let i = 0; i < 6; i++) await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: `guess ${i}` } });
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD } });
      expect(res.statusCode).toBe(429);
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });
  });
});
