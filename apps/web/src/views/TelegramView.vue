<script setup lang="ts">
// Telegram screen (6): connect a bot, approve yourself as the owner, then
// schedules and the main assistant talk to you in Telegram.
import type { TelegramPairingRequestDto, TelegramStatusDto } from "@clawdesk/shared";
import { NA, NAlert, NButton, NCard, NInput, NPopconfirm, NSpace, NSpin, NStep, NSteps, NTag, NText, useMessage } from "naive-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const { t } = useI18n();
const message = useMessage();

const status = ref<TelegramStatusDto | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const token = ref("");
const connecting = ref(false);
const requests = ref<TelegramPairingRequestDto[]>([]);
const approving = ref<string | null>(null);
const testing = ref(false);
let pollTimer: ReturnType<typeof setInterval> | undefined;

const step = computed(() => (!status.value?.connected ? 1 : !status.value.owner ? 2 : 3));
const botLink = computed(() => (status.value?.bot ? `https://t.me/${status.value.bot.username}` : null));

async function load(): Promise<void> {
  loading.value = true;
  try {
    status.value = await api.telegram.status();
    error.value = null;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
  syncPolling();
}

// While waiting for the owner to message the bot, check for the pairing request every few seconds.
function syncPolling(): void {
  const waiting = step.value === 2;
  if (waiting && !pollTimer) {
    void pollPairing();
    pollTimer = setInterval(pollPairing, 3000);
  } else if (!waiting && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function pollPairing(): Promise<void> {
  try {
    requests.value = await api.telegram.pairing();
  } catch {
    // transient; next tick retries
  }
}

async function connect(): Promise<void> {
  connecting.value = true;
  error.value = null;
  try {
    status.value = await api.telegram.connect(token.value.trim());
    token.value = "";
    syncPolling();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    connecting.value = false;
  }
}

async function approve(req: TelegramPairingRequestDto): Promise<void> {
  approving.value = req.requestId;
  try {
    const res = await api.telegram.approve(req.requestId, req.accountId);
    message.success(t("telegram.approved", { n: res.schedulesRouted }));
    await load();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    approving.value = null;
  }
}

async function sendTest(): Promise<void> {
  testing.value = true;
  try {
    await api.telegram.test(t("telegram.testText"));
    message.success(t("telegram.testSent"));
  } catch (e) {
    error.value = errorText(e);
  } finally {
    testing.value = false;
  }
}

async function disconnect(): Promise<void> {
  await api.telegram.disconnect();
  await load();
}

const KNOWN_ERRORS = ["invalid_token", "telegram_unreachable", "no_owner", "invalid_request"];

function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return String(e);
  return KNOWN_ERRORS.includes(e.body.error) ? t(`telegram.err.${e.body.error}`) : e.body.message;
}

onMounted(load);
onBeforeUnmount(() => clearInterval(pollTimer));
</script>

<template>
  <n-space vertical size="large">
    <h1 class="title">Telegram</h1>

    <n-steps :current="step" size="small">
      <n-step :title="t('telegram.stepBot')" />
      <n-step :title="t('telegram.stepOwner')" />
      <n-step :title="t('telegram.stepDone')" />
    </n-steps>

    <n-alert v-if="error" type="error">{{ error }}</n-alert>

    <n-spin :show="loading && !status">
      <!-- 1. bot token -->
      <n-card v-if="step === 1" :title="t('telegram.stepBot')">
        <ol class="howto">
          <li>
            {{ t("telegram.howto1") }}
            <n-a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</n-a>
          </li>
          <li>{{ t("telegram.howto2") }}</li>
          <li>{{ t("telegram.howto3") }}</li>
        </ol>
        <n-input
          v-model:value="token"
          type="password"
          show-password-on="click"
          :placeholder="t('telegram.tokenPlaceholder')"
          :input-props="{ autocomplete: 'off', spellcheck: false }"
          class="block"
          @keyup.enter="token.trim() && connect()"
        />
        <p class="hint">{{ t("telegram.tokenPrivacy") }}</p>
        <n-button type="primary" :loading="connecting" :disabled="!token.trim()" @click="connect">{{ t("telegram.connect") }}</n-button>
        <p v-if="connecting" class="hint">{{ t("telegram.connecting") }}</p>
      </n-card>

      <!-- 2. owner pairing -->
      <n-card v-else-if="step === 2" :title="t('telegram.stepOwner')">
        <p>
          {{ t("telegram.writeBot") }}
          <n-a v-if="botLink" :href="botLink" target="_blank" rel="noopener noreferrer">@{{ status?.bot?.username }}</n-a>
        </p>
        <n-text depth="3">{{ t("telegram.waiting") }}</n-text>
        <n-space vertical class="mt">
          <n-card v-for="req in requests" :key="req.requestId" size="small" embedded>
            <n-space justify="space-between" align="center">
              <span>
                <strong>{{ req.senderLabel }}</strong>
                <n-text depth="3"> · id {{ req.senderId }}</n-text>
              </span>
              <n-button type="primary" size="small" :loading="approving === req.requestId" @click="approve(req)">{{ t("telegram.itsMe") }}</n-button>
            </n-space>
          </n-card>
        </n-space>
        <n-alert type="warning" :show-icon="false" class="mt">{{ t("telegram.onlyYours") }}</n-alert>
      </n-card>

      <!-- 3. connected -->
      <n-card v-else-if="status" :title="t('telegram.stepDone')">
        <n-space vertical>
          <n-space align="center">
            <n-tag :type="status.running ? 'success' : 'warning'" size="small">{{ status.running ? t("telegram.running") : t("telegram.notRunning") }}</n-tag>
            <span v-if="status.bot">
              {{ t("telegram.bot") }}: <n-a :href="botLink!" target="_blank" rel="noopener noreferrer">@{{ status.bot.username }}</n-a>
            </span>
            <span v-if="status.owner">· {{ t("telegram.owner") }}: {{ status.owner.label ?? status.owner.id }}</span>
          </n-space>
          <n-alert v-if="status.lastError" type="error" :show-icon="false">{{ status.lastError }}</n-alert>
          <p class="hint">{{ t("telegram.doneHint") }}</p>
          <n-space>
            <n-button :loading="testing" @click="sendTest">{{ t("telegram.sendTest") }}</n-button>
            <n-popconfirm @positive-click="disconnect">
              <template #trigger>
                <n-button quaternary type="error">{{ t("telegram.disconnect") }}</n-button>
              </template>
              {{ t("telegram.disconnectConfirm") }}
            </n-popconfirm>
          </n-space>
        </n-space>
      </n-card>
    </n-spin>
  </n-space>
</template>

<style scoped>
.title {
  margin: 0;
  font-size: 22px;
}
.howto {
  margin: 0 0 16px;
  padding-left: 20px;
  line-height: 1.8;
}
.block {
  display: block;
  margin-bottom: 8px;
}
.hint {
  font-size: 13px;
  opacity: 0.75;
}
.mt {
  margin-top: 16px;
}
</style>
