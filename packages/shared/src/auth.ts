import { z } from "zod";

// Panel sign-in (screen 1). One owner, password only. The first password needs the owner code
// the server prints at install; a forgotten one is replaced with a code sent by the Telegram bot,
// or with a new owner code from the server.

/** "setup": no owner yet; "login": owner exists, this browser is signed out; "ok": signed in. */
export const AuthState = z.enum(["setup", "login", "ok"]);
export type AuthState = z.infer<typeof AuthState>;

export const AuthStateDto = z.object({
  state: AuthState,
  /** The Telegram bot has an approved owner, so it can send a reset code. */
  telegramReset: z.boolean(),
});
export type AuthStateDto = z.infer<typeof AuthStateDto>;

export const PASSWORD_MIN = 10;
const Password = z.string().min(PASSWORD_MIN, `at least ${PASSWORD_MIN} characters`).max(200);
const Code = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{6,40}$/, "this does not look like a code");

/** Sets the owner's password with the owner code from the server (first run or recovery). */
export const SetOwnerPasswordRequest = z.object({ code: Code, password: Password });
export type SetOwnerPasswordRequest = z.infer<typeof SetOwnerPasswordRequest>;

export const LoginRequest = z.object({ password: z.string().min(1).max(200) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const TelegramResetRequest = z.object({ locale: z.enum(["ru", "en", "tg"]).default("ru") });
export type TelegramResetRequest = z.infer<typeof TelegramResetRequest>;

/** Replaces the password with the code the bot sent. */
export const TelegramResetConfirmRequest = z.object({ code: Code, password: Password });
export type TelegramResetConfirmRequest = z.infer<typeof TelegramResetConfirmRequest>;
