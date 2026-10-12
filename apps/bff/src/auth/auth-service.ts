import { createHash, randomBytes } from "node:crypto";
import type { AuthStateDto } from "@clawdesk/shared";
import { and, eq, lt } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { panelSessions, panelUsers } from "../db/schema.js";
import { OwnerCodeFile, randomCode, sameCode } from "./owner-code.js";
import { hashPassword, verifyPassword } from "./password.js";

// Panel sign-in: one owner, password only (screen 1).
// - First password: needs the owner code the server printed (OwnerCodeFile).
// - Forgotten password: a short code from the Telegram bot, or a new owner code from the server.
// - Sessions: random token in an httpOnly cookie, only its SHA-256 in the database, 30 days, renewed while used.

const OWNER_ID = "owner";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** Renew a session at most once a day, not on every request. */
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60_000;
const TELEGRAM_CODE_TTL_MS = 15 * 60_000;
const TELEGRAM_CODE_ATTEMPTS = 5;
const TELEGRAM_RESEND_MS = 60_000;
const TELEGRAM_MAX_PER_HOUR = 5;

export type AuthErrorCode = "invalid_code" | "wrong_password" | "too_many_attempts" | "no_owner" | "telegram_unavailable" | "too_soon";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

/** `maxAgeSec`: cookie lifetime, counted on the same clock as `expiresAt`. */
export type IssuedSession = { token: string; expiresAt: number; maxAgeSec: number };
export type SessionCheck = { userId: string; renewed: IssuedSession | null };

/** The bit of the Telegram service the reset needs. */
export type OwnerMessenger = { hasOwner(): boolean; sendToOwner(text: string): Promise<void> };

export type AuthDeps = {
  db: Db;
  dataDir: string;
  logger: Logger;
  telegram?: OwnerMessenger;
  now?: () => number;
};

/** Failed attempts per key (client address): 5 free, then a pause that doubles up to 15 minutes. */
export class AttemptLimiter {
  readonly #entries = new Map<string, { failures: number; blockedUntil: number }>();

  constructor(
    private readonly now: () => number,
    private readonly free = 5,
    private readonly baseMs = 30_000,
    private readonly maxMs = 15 * 60_000,
  ) {}

  retryAfter(key: string): number {
    const entry = this.#entries.get(key);
    return entry ? Math.max(0, entry.blockedUntil - this.now()) : 0;
  }

  fail(key: string): void {
    if (this.#entries.size > 10_000) this.#entries.clear();
    const entry = this.#entries.get(key) ?? { failures: 0, blockedUntil: 0 };
    entry.failures++;
    if (entry.failures > this.free) entry.blockedUntil = this.now() + Math.min(this.maxMs, this.baseMs * 2 ** (entry.failures - this.free - 1));
    this.#entries.set(key, entry);
  }

  succeed(key: string): void {
    this.#entries.delete(key);
  }
}

const TELEGRAM_TEXT: Record<"ru" | "en" | "tg", (code: string) => string> = {
  ru: (code) => `Код для нового пароля ClawDesk: ${code}\nДействует 15 минут. Если вы не просили сменить пароль, ничего не делайте — пароль останется прежним.`,
  en: (code) => `ClawDesk new password code: ${code}\nValid for 15 minutes. If you did not ask to change the password, ignore this message — it stays the same.`,
  tg: (code) => `Рамз барои пароли нави ClawDesk: ${code}\n15 дақиқа эътибор дорад. Агар шумо иваз кардани паролро нахоста бошед, ҳеҷ кор накунед — парол ҳамон мемонад.`,
};

export class AuthService {
  readonly #now: () => number;
  readonly #ownerCode: OwnerCodeFile;
  readonly #limiter: AttemptLimiter;
  #telegramCode: { code: string; expiresAt: number; attempts: number } | null = null;
  #telegramSent: number[] = [];

  constructor(private readonly deps: AuthDeps) {
    this.#now = deps.now ?? Date.now;
    this.#ownerCode = new OwnerCodeFile(deps.dataDir);
    this.#limiter = new AttemptLimiter(this.#now);
  }

  hasOwner(): boolean {
    return !!this.#owner()?.passwordHash;
  }

  /** First run: makes sure an owner code exists and returns it (for the log); null once the owner is set. */
  ownerCodeForFirstRun(): string | null {
    return this.hasOwner() ? null : this.#ownerCode.existingOrNew();
  }

  state(token: string | undefined): AuthStateDto {
    const telegramReset = this.deps.telegram?.hasOwner() ?? false;
    if (!this.hasOwner()) return { state: "setup", telegramReset };
    return { state: token && this.#findSession(token) ? "ok" : "login", telegramReset };
  }

  /** Sets (or replaces) the owner's password with the owner code from the server. Signs out every other browser. */
  async setOwnerPassword(code: string, password: string, client: string, userAgent: string | undefined): Promise<IssuedSession> {
    this.#throttle(client);
    if (!this.#ownerCode.matches(code)) {
      this.#limiter.fail(client);
      throw new AuthError("invalid_code", "this owner code is wrong or was already used");
    }
    this.#limiter.succeed(client);
    const first = !this.hasOwner();
    await this.#savePassword(password);
    this.#ownerCode.consume();
    this.deps.logger.info({ first }, first ? "panel owner created" : "panel owner password replaced with an owner code");
    return this.#issueSession(userAgent);
  }

  async login(password: string, client: string, userAgent: string | undefined): Promise<IssuedSession> {
    this.#throttle(client);
    const owner = this.#owner();
    if (!owner?.passwordHash) throw new AuthError("no_owner", "the panel has no owner yet; open the link with the owner code");
    if (!(await verifyPassword(password, owner.passwordHash))) {
      this.#limiter.fail(client);
      this.deps.logger.warn({ client }, "panel sign-in with a wrong password");
      throw new AuthError("wrong_password", "wrong password");
    }
    this.#limiter.succeed(client);
    this.#dropExpiredSessions();
    return this.#issueSession(userAgent);
  }

  /** Valid session for this cookie token, renewed when it is a day old. */
  check(token: string | undefined): SessionCheck | null {
    if (!token) return null;
    const row = this.#findSession(token);
    if (!row) return null;
    const now = this.#now();
    if (now - (row.expiresAt.getTime() - SESSION_TTL_MS) < SESSION_RENEW_AFTER_MS) return { userId: row.userId, renewed: null };
    const expiresAt = now + SESSION_TTL_MS;
    this.deps.db.update(panelSessions).set({ expiresAt: new Date(expiresAt) }).where(eq(panelSessions.id, row.id)).run();
    return { userId: row.userId, renewed: { token, expiresAt, maxAgeSec: SESSION_TTL_MS / 1000 } };
  }

  logout(token: string | undefined): void {
    if (token) this.deps.db.delete(panelSessions).where(eq(panelSessions.id, sessionId(token))).run();
  }

  /** Sends a short code to the owner's Telegram chat. The code is shown nowhere else. */
  async sendTelegramCode(locale: "ru" | "en" | "tg", client: string): Promise<void> {
    this.#throttle(client);
    const telegram = this.deps.telegram;
    if (!this.hasOwner()) throw new AuthError("no_owner", "the panel has no owner yet");
    if (!telegram?.hasOwner()) throw new AuthError("telegram_unavailable", "the Telegram bot has no approved owner");
    const now = this.#now();
    this.#telegramSent = this.#telegramSent.filter((t) => now - t < 60 * 60_000);
    const last = this.#telegramSent.at(-1);
    if (last !== undefined && now - last < TELEGRAM_RESEND_MS) throw new AuthError("too_soon", "a code was sent a moment ago", TELEGRAM_RESEND_MS - (now - last));
    if (this.#telegramSent.length >= TELEGRAM_MAX_PER_HOUR) {
      throw new AuthError("too_soon", "too many codes this hour", this.#telegramSent[0]! + 60 * 60_000 - now);
    }
    const code = randomCode(2);
    try {
      await telegram.sendToOwner(TELEGRAM_TEXT[locale](code));
    } catch (error) {
      this.deps.logger.warn({ err: error }, "could not send the password code to Telegram");
      throw new AuthError("telegram_unavailable", `Telegram did not take the message: ${(error as Error).message}`);
    }
    this.#telegramSent.push(now);
    this.#telegramCode = { code, expiresAt: now + TELEGRAM_CODE_TTL_MS, attempts: 0 };
    this.deps.logger.info("password code sent to the owner's Telegram");
  }

  async resetWithTelegramCode(code: string, password: string, client: string, userAgent: string | undefined): Promise<IssuedSession> {
    this.#throttle(client);
    const pending = this.#telegramCode;
    if (!pending || this.#now() > pending.expiresAt) {
      this.#telegramCode = null;
      throw new AuthError("invalid_code", "no valid code; ask the bot for a new one");
    }
    if (!sameCode(code, pending.code)) {
      this.#limiter.fail(client);
      if (++pending.attempts >= TELEGRAM_CODE_ATTEMPTS) this.#telegramCode = null;
      throw new AuthError("invalid_code", "wrong code");
    }
    this.#telegramCode = null;
    this.#limiter.succeed(client);
    await this.#savePassword(password);
    this.deps.logger.info("panel owner password replaced with a Telegram code");
    return this.#issueSession(userAgent);
  }

  #throttle(client: string): void {
    const wait = this.#limiter.retryAfter(client);
    if (wait > 0) throw new AuthError("too_many_attempts", "too many attempts; wait and try again", wait);
  }

  async #savePassword(password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    this.deps.db
      .insert(panelUsers)
      .values({ id: OWNER_ID, role: "owner", passwordHash })
      .onConflictDoUpdate({ target: panelUsers.id, set: { passwordHash } })
      .run();
    // A new password signs out every browser, including a stranger's.
    this.deps.db.delete(panelSessions).where(eq(panelSessions.userId, OWNER_ID)).run();
  }

  #issueSession(userAgent: string | undefined): IssuedSession {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + SESSION_TTL_MS;
    this.deps.db
      .insert(panelSessions)
      .values({ id: sessionId(token), userId: OWNER_ID, expiresAt: new Date(expiresAt), userAgent: userAgent?.slice(0, 300) ?? null })
      .run();
    return { token, expiresAt, maxAgeSec: SESSION_TTL_MS / 1000 };
  }

  #findSession(token: string) {
    const row = this.deps.db.select().from(panelSessions).where(eq(panelSessions.id, sessionId(token))).get();
    return row && row.expiresAt.getTime() > this.#now() ? row : null;
  }

  #dropExpiredSessions(): void {
    this.deps.db
      .delete(panelSessions)
      .where(and(eq(panelSessions.userId, OWNER_ID), lt(panelSessions.expiresAt, new Date(this.#now()))))
      .run();
  }

  #owner() {
    return this.deps.db.select().from(panelUsers).where(eq(panelUsers.id, OWNER_ID)).get();
  }
}

function sessionId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}