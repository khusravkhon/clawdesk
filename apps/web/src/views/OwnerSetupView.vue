<script setup lang="ts">
// Owner password with the owner code from the server: the first run (the link init.sh prints) and
// recovery without Telegram (the owner-code command). Every other browser is signed out.
import type { AuthStateDto } from "@clawdesk/shared";
import { NAlert, NButton, NInput } from "naive-ui";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api/client";
import { authErrorText, ownerCodeCommand, usePasswordPair } from "../auth";
import AuthFrame from "../components/AuthFrame.vue";
import { markSignedIn } from "../router";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const state = ref<AuthStateDto | null>(null);
const code = ref(typeof route.query.code === "string" ? route.query.code : "");
const codeFromLink = !!code.value;
const busy = ref(false);
const error = ref<string | null>(null);
const pair = usePasswordPair(t);

const firstRun = computed(() => state.value?.state !== "login" && state.value?.state !== "ok");

onMounted(async () => {
  state.value = await api.auth.state().catch(() => null);
  // Keep the code out of the address bar (and browser history) once it is in the form.
  if (codeFromLink) void router.replace({ name: "setup" });
});

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await api.auth.setup(code.value.trim(), pair.password.value);
    markSignedIn();
    await router.replace("/");
  } catch (e) {
    error.value = authErrorText(t, e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <auth-frame :title="firstRun ? t('auth.setupTitle') : t('auth.resetTitle')" :lead="firstRun ? t('auth.setupLead') : t('auth.resetLead')">
    <form @submit.prevent="save">
      <template v-if="!codeFromLink">
        <n-input v-model:value="code" :placeholder="t('auth.ownerCode')" :input-props="{ autocomplete: 'off', spellcheck: false }" />
        <p class="hint">{{ t("auth.ownerCodeHint") }}</p>
        <code class="command">{{ ownerCodeCommand() }}</code>
      </template>
      <input type="text" name="username" autocomplete="username" value="ClawDesk" hidden />
      <n-input
        v-model:value="pair.password.value"
        type="password"
        show-password-on="click"
        :placeholder="t('auth.newPassword')"
        :input-props="{ autocomplete: 'new-password', autofocus: codeFromLink }"
      />
      <n-input v-model:value="pair.repeat.value" type="password" show-password-on="click" :placeholder="t('auth.repeatPassword')" :input-props="{ autocomplete: 'new-password' }" />
      <p class="hint">{{ pair.problem.value ?? pair.hint.value }}</p>
      <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>
      <n-button attr-type="submit" type="primary" block :loading="busy" :disabled="!pair.ok.value || code.trim().length < 6">{{ t("auth.savePassword") }}</n-button>
      <n-button v-if="!firstRun" text size="small" class="link" @click="router.push({ name: 'login' })">{{ t("auth.backToLogin") }}</n-button>
    </form>
  </auth-frame>
</template>

<style scoped>
.link {
  align-self: center;
}
</style>
