<script setup lang="ts">
// Subscription sign-in for one agent: the Gateway drives the steps, this shows
// the link / device code it issues and asks the person only when needed.
import type { AiSignInOption, SignInStateDto } from "@clawdesk/shared";
import { NAlert, NButton, NInput, NSpace, NText, useMessage } from "naive-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ agentId: string; option: AiSignInOption; asBackup?: boolean }>();
const emit = defineEmits<{ connected: [modelRef: string | null]; cancel: [] }>();
const { t } = useI18n();
const message = useMessage();

const state = ref<SignInStateDto | null>(null);
const startError = ref<string | null>(null);
const textAnswer = ref("");
const sending = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const active = computed(() => state.value?.status === "running" || state.value?.status === "waiting_for_user");
/** What the person brings back from the page: a code (Claude) or the address it redirected to. */
const paste = computed(() => state.value?.paste ?? (state.value?.url && !state.value.deviceCode ? "redirect" : null));
const KNOWN_ERRORS: Record<string, string> = { claude_code_rejected: "signIn.claudeRejected", claude_auth: "signIn.claudeAuth" };
const errorMessage = computed(() => {
  const known = state.value?.errorCode ? KNOWN_ERRORS[state.value.errorCode] : undefined;
  return known ? t(known) : state.value?.error;
});

async function start(): Promise<void> {
  startError.value = null;
  try {
    state.value = await api.ai.signIn.start({ agentId: props.agentId, authChoice: props.option.id, asBackup: props.asBackup });
    schedulePoll();
  } catch (error) {
    startError.value = errorText(error);
  }
}

function schedulePoll(): void {
  clearTimeout(timer);
  timer = setTimeout(poll, 1500);
}

async function poll(): Promise<void> {
  if (!state.value) return;
  try {
    state.value = await api.ai.signIn.get(state.value.sessionId);
  } catch (error) {
    startError.value = errorText(error);
    return;
  }
  if (state.value.status === "done") emit("connected", state.value.modelRef);
  if (active.value) schedulePoll();
}

async function answer(value: unknown): Promise<void> {
  if (!state.value?.prompt) return;
  sending.value = true;
  try {
    state.value = await api.ai.signIn.answer(state.value.sessionId, { stepId: state.value.prompt.stepId, value });
    textAnswer.value = "";
    schedulePoll();
  } catch (error) {
    startError.value = errorText(error);
  } finally {
    sending.value = false;
  }
}

async function cancel(): Promise<void> {
  clearTimeout(timer);
  if (state.value && active.value) await api.ai.signIn.cancel(state.value.sessionId).catch(() => undefined);
  emit("cancel");
}

async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    message.success(t("signIn.copied"));
  } catch {
    // clipboard blocked; the code is visible anyway
  }
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.body.message : String(error);
}

onMounted(start);
onBeforeUnmount(() => {
  clearTimeout(timer);
  if (state.value && active.value) void api.ai.signIn.cancel(state.value.sessionId).catch(() => undefined);
});
</script>

<template>
  <div class="flow">
    <h3 class="title">{{ option.label }}</h3>

    <n-alert v-if="startError" type="error" class="mb">{{ startError }}</n-alert>

    <template v-if="state">
      <!-- device code: open the page, type the code -->
      <div v-if="state.deviceCode" class="mb">
        <p>{{ t("signIn.deviceSteps") }}</p>
        <n-space align="center" class="mb">
          <span class="code">{{ state.deviceCode.code }}</span>
          <n-button size="small" @click="copyCode(state.deviceCode.code)">{{ t("signIn.copy") }}</n-button>
        </n-space>
        <n-button v-if="state.url" tag="a" :href="state.url" target="_blank" rel="noopener noreferrer" type="primary">
          {{ t("signIn.openPage") }}
        </n-button>
        <p v-if="state.deviceCode.expiresInMinutes" class="hint">{{ t("signIn.expires", { n: state.deviceCode.expiresInMinutes }) }}</p>
      </div>

      <!-- browser OAuth: open the page, then paste the redirect address (or Claude's code) back -->
      <div v-else-if="paste" class="mb">
        <p>{{ paste === "code" ? t("signIn.claudeSteps") : t("signIn.oauthSteps") }}</p>
        <n-button tag="a" :href="state.url!" target="_blank" rel="noopener noreferrer" type="primary">{{ t("signIn.openPage") }}</n-button>
      </div>

      <n-alert v-if="state.deviceCode || paste" type="warning" :show-icon="false" class="mb">
        {{ t("signIn.onlyYou") }}
      </n-alert>

      <!-- the Gateway asks something -->
      <div v-if="state.prompt" class="mb">
        <p v-if="state.prompt.message">{{ state.prompt.message }}</p>
        <template v-if="state.prompt.kind === 'text'">
          <n-input
            v-model:value="textAnswer"
            :type="state.prompt.sensitive ? 'password' : 'text'"
            :placeholder="paste === 'code' ? t('signIn.claudeCodePlaceholder') : paste ? t('signIn.pastePlaceholder') : ''"
            :input-props="{ autocomplete: 'off', spellcheck: false }"
            class="mb"
            @keyup.enter="textAnswer.trim() && answer(textAnswer.trim())"
          />
          <n-button type="primary" :loading="sending" :disabled="!textAnswer.trim()" @click="answer(textAnswer.trim())">
            {{ t("signIn.submit") }}
          </n-button>
        </template>
        <n-space v-else-if="state.prompt.kind === 'confirm'">
          <n-button type="primary" :loading="sending" @click="answer(true)">{{ t("signIn.yes") }}</n-button>
          <n-button :disabled="sending" @click="answer(false)">{{ t("signIn.no") }}</n-button>
        </n-space>
        <n-space v-else vertical>
          <n-button v-for="o in state.prompt.options" :key="String(o.value)" :disabled="sending" @click="answer(o.value)">{{ o.label }}</n-button>
        </n-space>
      </div>

      <p v-if="state.status === 'running'" class="mb progress">
        <n-text depth="3">{{ state.progress ?? t("signIn.working") }}</n-text>
      </p>

      <n-alert v-if="state.status === 'done'" type="success" :title="t('signIn.done')" class="mb">
        {{ state.modelRef ? t("signIn.doneModel", { model: state.modelRef }) : "" }}
      </n-alert>
      <n-alert v-if="state.status === 'error'" type="error" class="mb">{{ errorMessage }}</n-alert>
      <p v-if="option.id === 'claude-plan' && state.status !== 'error'" class="hint">{{ t("signIn.claudeLimits") }}</p>

      <details v-if="state.note && active" class="note">
        <summary>{{ t("signIn.details") }}</summary>
        <pre>{{ state.note }}</pre>
      </details>
    </template>

    <n-space>
      <n-button v-if="state?.status === 'error' || startError" @click="start">{{ t("common.retry") }}</n-button>
      <n-button v-if="state?.status !== 'done'" quaternary @click="cancel">{{ t("signIn.cancel") }}</n-button>
    </n-space>
  </div>
</template>

<style scoped>
.title {
  margin: 0 0 12px;
}
.mb {
  margin-bottom: 12px;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 2px;
}
.hint {
  font-size: 13px;
  opacity: 0.75;
}
.progress::before {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 8px;
  border-radius: 50%;
  background: var(--accent-bright);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}
.note pre {
  white-space: pre-wrap;
  font-size: 12px;
  opacity: 0.75;
}
</style>
