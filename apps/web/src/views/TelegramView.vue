<script setup lang="ts">
// Telegram screen (6): connect a bot, approve yourself as the owner, then
// schedules and the main assistant talk to you in Telegram.
import type { AgentListItemDto, TelegramBotDto, TelegramPairingRequestDto, TelegramStatusDto } from "@clawdesk/shared";
import { Plus, RefreshCw } from "@lucide/vue";
import { NA, NAlert, NButton, NCard, NInput, NPopconfirm, NSelect, NSpace, NSpin, NStep, NSteps, NSwitch, NTag, NText, useMessage } from "naive-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import AgentTopics from "../components/AgentTopics.vue";
import TelegramVoice from "../components/TelegramVoice.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { api, ApiError } from "../api/client";

const { t } = useI18n();
const message = useMessage();

const status = ref<TelegramStatusDto | null>(null);
const accounts = ref<TelegramBotDto[]>([]);
const agents = ref<AgentListItemDto[]>([]);
const accountId = ref("default");
const agentId = ref("main");
const adding = ref(false);
const routeSaving = ref(false);
let polling = false;
let disposed = false;
const botOptions = computed(() => accounts.value.map((a) => ({ label: a.bot ? `@${a.bot.username}` : a.accountId, value: a.accountId })));
const agentOptions = computed(() => agents.value.map((a) => ({ label: `${a.emoji ?? ''} ${a.name}`.trim(), value: a.id })));
const loading = ref(false);
const error = ref<string | null>(null);
const token = ref("");
const connecting = ref(false);
const requests = ref<TelegramPairingRequestDto[]>([]);
const approving = ref<string | null>(null);
const testing = ref(false);
const approvalsSaving = ref(false);
let pollTimer: ReturnType<typeof setInterval> | undefined;

const step = computed(() => (adding.value || !status.value?.connected ? 1 : !status.value.owner ? 2 : 3));
const botLink = computed(() => (status.value?.bot ? `https://t.me/${status.value.bot.username}` : null));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [bots, list] = await Promise.all([api.telegram.accounts(), api.agents()]);
    accounts.value = bots;
    agents.value = list.agents;
    if (!adding.value) {
      const selected = bots.find((a) => a.accountId === accountId.value) ?? bots[0];
      if (selected) {
        accountId.value = selected.accountId;
        agentId.value = selected.agentId;
        status.value = selected;
      } else {
        adding.value = true;
        status.value = null;
      }
    }
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
  if (polling || step.value !== 2) return;
  polling = true;
  const selected = accountId.value;
  try {
    const [nextStatus, pending] = await Promise.all([api.telegram.status(selected), api.telegram.pairing(selected)]);
    if (disposed || selected !== accountId.value || adding.value) return;
    status.value = nextStatus;
    requests.value = pending;
    error.value = null;
    syncPolling();
  } catch (e) {
    // transient; next tick retries while the failure stays visible
    if (!disposed && selected === accountId.value) error.value = errorText(e);
  } finally {
    polling = false;
  }
}

async function selectBot(id: string): Promise<void> {
  accountId.value = id;
  adding.value = false;
  requests.value = [];
  token.value = "";
  await load();
}

function addBot(): void {
  adding.value = true;
  token.value = "";
  agentId.value = "main";
  error.value = null;
  syncPolling();
}

async function assignAgent(id: string): Promise<void> {
  routeSaving.value = true;
  try {
    await api.telegram.assignAgent(accountId.value, id);
    await load();
    message.success(t("telegram.routeSaved"));
  } catch (e) {
    error.value = errorText(e);
  } finally {
    routeSaving.value = false;
  }
}

async function connect(): Promise<void> {
  connecting.value = true;
  error.value = null;
  try {
    if (adding.value) {
      const bot = await api.telegram.addBot(token.value.trim(), agentId.value);
      accountId.value = bot.accountId;
    } else {
      await api.telegram.connect(token.value.trim(), agentId.value, accountId.value);
    }
    adding.value = false;
    token.value = "";
    await load();
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
    await api.telegram.test(t("telegram.testText"), accountId.value);
    message.success(t("telegram.testSent"));
  } catch (e) {
    error.value = errorText(e);
  } finally {
    testing.value = false;
  }
}

/** Restarts the Gateway (about 10 s): approval buttons are an OpenClaw channel setting. */
async function setApprovals(enabled: boolean): Promise<void> {
  approvalsSaving.value = true;
  try {
    status.value = await api.telegram.approvals(enabled, accountId.value);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    approvalsSaving.value = false;
  }
}

async function disconnect(): Promise<void> {
  try {
    await api.telegram.disconnect(accountId.value);
    await load();
  } catch (e) {
    error.value = errorText(e);
  }
}

const KNOWN_ERRORS = ["invalid_token", "telegram_unreachable", "no_owner", "invalid_request"];

function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return String(e);
  return KNOWN_ERRORS.includes(e.body.error) ? t(`telegram.err.${e.body.error}`) : e.body.message;
}

onMounted(load);
onBeforeUnmount(() => { disposed = true; clearInterval(pollTimer); });
</script>

<template>
  <div>
    <page-header title="Telegram" :subtitle="t('telegram.subtitle')">
      <n-button size="small" secondary :loading="loading" @click="load"><template #icon><refresh-cw :size="14" /></template>{{ t('status.refresh') }}</n-button>
      <n-button size="small" type="primary" :disabled="adding || connecting || !!approving || routeSaving" @click="addBot"><template #icon><plus :size="14" /></template>{{ t('telegram.addBot') }}</n-button>
    </page-header>
    <div v-if="accounts.length" class="bot-select">
      <label>{{ t('telegram.bot') }}</label>
      <n-select :value="adding ? null : accountId" :options="botOptions" :placeholder="t('telegram.addBot')" :disabled="connecting || !!approving || routeSaving" @update:value="selectBot" />
    </div>
    <n-space vertical size="large">
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
          <label class="field-label">{{ t('telegram.agent') }}</label>
          <n-select v-model:value="agentId" :options="agentOptions" class="block" />
          <n-button type="primary" :loading="connecting" :disabled="!token.trim()" @click="connect">{{ t("telegram.connect") }}</n-button>
          <p v-if="connecting" class="hint">{{ t("telegram.connecting") }}</p>
        </n-card>

        <!-- 2. owner pairing -->
        <n-card v-else-if="step === 2" :title="t('telegram.stepOwner')">
          <n-alert v-if="status?.lastError || !status?.running" type="warning" class="block">{{ status?.lastError || t('telegram.notRunning') }}</n-alert>
          <p>
            {{ t("telegram.writeBot") }}
            <n-a v-if="botLink" :href="botLink" target="_blank" rel="noopener noreferrer">@{{ status?.bot?.username }}</n-a>
          </p>
          <n-text depth="3">{{ t("telegram.waiting") }}</n-text>
          <n-space vertical class="mt">
            <div v-for="req in requests" :key="req.requestId" class="pairing-row">
              <n-space justify="space-between" align="center">
                <span>
                  <strong>{{ req.senderLabel }}</strong>
                  <n-text depth="3"> · id {{ req.senderId }}</n-text>
                </span>
                <n-button type="primary" size="small" :loading="approving === req.requestId" @click="approve(req)">{{ t("telegram.itsMe") }}</n-button>
              </n-space>
            </div>
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
            <label class="field-label">{{ t('telegram.agent') }}</label>
            <n-select :value="agentId" :options="agentOptions" :loading="routeSaving" :disabled="routeSaving" @update:value="assignAgent" />
            <div>
              <n-space align="center">
                <n-switch :value="status.approvals" :loading="approvalsSaving" @update:value="setApprovals" />
                <span>{{ t("telegram.approvals") }}</span>
              </n-space>
              <p class="hint">{{ t("telegram.approvalsHint") }}</p>
            </div>
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

        <n-card v-if="status && step === 3" :title="t('telegramVoice.title')" class="mt">
          <TelegramVoice />
        </n-card>
        <!-- 4. a topic per agent in a group -->
        <n-card v-if="status && step === 3" :title="t('telegramTopics.title')" class="mt">
          <AgentTopics :key="accountId" :account-id="accountId" />
        </n-card>
      </n-spin>
    </n-space>
  </div>
</template>

<style scoped>
.bot-select { display: grid; grid-template-columns: auto minmax(0, 360px); align-items: center; gap: 12px; margin-bottom: 20px; }
.field-label { display: block; margin: 8px 0; font-size: 13px; }
.pairing-row { border-top: 1px solid var(--border); padding: 12px 0; }
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
