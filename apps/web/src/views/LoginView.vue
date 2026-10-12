<script setup lang="ts">
// Screen 1: the owner signs in with the password. A forgotten password is replaced with a code the
// Telegram bot sends, or with an owner code from the server.
import type { AuthStateDto, Locale } from "@clawdesk/shared";
import { NAlert, NButton, NInput } from "naive-ui";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api/client";
import { authErrorText, ownerCodeCommand, safeNext, usePasswordPair } from "../auth";
import AuthFrame from "../components/AuthFrame.vue";
import { markSignedIn } from "../router";

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();

const state = ref<AuthStateDto | null>(null);
const mode = ref<"login" | "forgot">("login");
const password = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const sent = ref(false);
const code = ref("");
const pair = usePasswordPair(t);

onMounted(async () => {
  state.value = await api.auth.state().catch(() => null);
  if (state.value?.state === "setup") void router.replace({ name: "setup" });
  else if (state.value?.state === "ok") goNext();
});

function goNext(): void {
  markSignedIn();
  const next = safeNext(route.query.next);
  // OAuth return trips (/api/sources/…/callback) are server pages, not panel routes.
  if (next.startsWith("/api/")) location.assign(next);
  else void router.replace(next);
}

async function run(action: () => Promise<unknown>): Promise<boolean> {
  busy.value = true;
  error.value = null;
  try {
    await action();
    return true;
  } catch (e) {
    error.value = authErrorText(t, e);
    return false;
  } finally {
    busy.value = false;
  }
}

async function login(): Promise<void> {
  if (await run(() => api.auth.login(password.value))) goNext();
}

async function sendCode(): Promise<void> {
  if (await run(() => api.auth.telegramSend(locale.value as Locale))) sent.value = true;
}

async function reset(): Promise<void> {
  if (await run(() => api.auth.telegramReset(code.value.trim(), pair.password.value))) goNext();
}

function switchTo(next: "login" | "forgot"): void {
  mode.value = next;
  error.value = null;
}
</script>

<template>
  <auth-frame v-if="mode === 'login'" :title="t('auth.loginTitle')" :lead="t('auth.loginLead')">
    <form @submit.prevent="login">
      <!-- Lets password managers file the password under one name. -->
      <input type="text" name="username" autocomplete="username" value="ClawDesk" hidden />
      <n-input
        v-model:value="password"
        type="password"
        show-password-on="click"
        :placeholder="t('auth.password')"
        :input-props="{ autocomplete: 'current-password', autofocus: true }"
      />
      <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>
      <n-button attr-type="submit" type="primary" block :loading="busy" :disabled="!password">{{ t("auth.signIn") }}</n-button>
      <n-button text size="small" class="link" @click="switchTo('forgot')">{{ t("auth.forgot") }}</n-button>
    </form>
  </auth-frame>

  <auth-frame v-else :title="t('auth.forgot')" :lead="state?.telegramReset ? t('auth.telegramLead') : t('auth.noTelegram')">
    <form v-if="state?.telegramReset" @submit.prevent="reset">
      <n-button :type="sent ? 'default' : 'primary'" block :loading="busy && !sent" @click="sendCode">
        {{ sent ? t("auth.telegramResend") : t("auth.telegramSend") }}
      </n-button>
      <template v-if="sent">
        <p class="hint">{{ t("auth.telegramSent") }}</p>
        <n-input v-model:value="code" :placeholder="t('auth.telegramCode')" :input-props="{ autocomplete: 'one-time-code' }" />
        <input type="text" name="username" autocomplete="username" value="ClawDesk" hidden />
        <n-input v-model:value="pair.password.value" type="password" show-password-on="click" :placeholder="t('auth.newPassword')" :input-props="{ autocomplete: 'new-password' }" />
        <n-input v-model:value="pair.repeat.value" type="password" show-password-on="click" :placeholder="t('auth.repeatPassword')" :input-props="{ autocomplete: 'new-password' }" />
        <p class="hint">{{ pair.problem.value ?? pair.hint.value }}</p>
      </template>
      <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>
      <n-button v-if="sent" attr-type="submit" type="primary" block :loading="busy" :disabled="!pair.ok.value || code.trim().length < 8">
        {{ t("auth.changePassword") }}
      </n-button>
    </form>
    <div class="server">
      <p class="hint">{{ t("auth.serverWay") }}</p>
      <code class="command">{{ ownerCodeCommand() }}</code>
    </div>
    <n-button text size="small" class="link" @click="switchTo('login')">{{ t("auth.backToLogin") }}</n-button>
  </auth-frame>
</template>

<style scoped>
.link {
  align-self: center;
  margin-top: 4px;
}
.server {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.server + .link {
  display: block;
  margin: 14px auto 0;
}
</style>
