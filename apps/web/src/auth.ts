import { PASSWORD_MIN } from "@clawdesk/shared";
import { computed, ref } from "vue";
import { ApiError } from "./api/client";

type T = (key: string, values?: Record<string, unknown>) => string;

const KNOWN = new Set(["wrong_password", "invalid_code", "too_many_attempts", "too_soon", "telegram_unavailable", "no_owner"]);

/** Sign-in errors in the person's language; the server's text for anything unexpected. */
export function authErrorText(t: T, error: unknown): string {
  if (!(error instanceof ApiError)) return String(error);
  const sec = (error.body.details as { retryAfterSec?: number } | undefined)?.retryAfterSec ?? 0;
  if (error.body.error === "invalid_request") return t("auth.passwordHint", { n: PASSWORD_MIN });
  return KNOWN.has(error.body.error) ? t(`auth.errors.${error.body.error}`, { sec }) : error.body.message;
}

/** What to run on the server for a new owner code; it prints the link for this very panel. */
export function ownerCodeCommand(): string {
  return import.meta.env.DEV
    ? `pnpm --filter @clawdesk/bff owner-code ${location.origin}`
    : `docker compose -f deploy/docker-compose.yml exec panel node dist/cli/owner-code.js ${location.origin}`;
}

/** New password typed twice; `problem` is shown only once both fields have something. */
export function usePasswordPair(t: T) {
  const password = ref("");
  const repeat = ref("");
  const ok = computed(() => password.value.length >= PASSWORD_MIN && password.value === repeat.value);
  const problem = computed(() => {
    if (!password.value || !repeat.value) return null;
    if (password.value.length < PASSWORD_MIN) return t("auth.passwordHint", { n: PASSWORD_MIN });
    return password.value === repeat.value ? null : t("auth.mismatch");
  });
  return { password, repeat, ok, problem, hint: computed(() => t("auth.passwordHint", { n: PASSWORD_MIN })) };
}

/** `next` from the sign-in link, only if it points inside this panel. */
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
