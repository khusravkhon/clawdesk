<script setup lang="ts">
// System → OpenClaw: the running version and, when ClawDesk has verified a newer one, the owner's button to move
// to it (deploy/clawdesk-openclaw-update.mjs: backup, build, restart, checks, rollback). The Gateway and this
// panel restart during it, so the card keeps asking until the update has an outcome.
import type { OpenClawUpdateDto } from "@clawdesk/shared";
import { RefreshCw } from "@lucide/vue";
import { NAlert, NButton, NCard, NModal, NSpace, useMessage } from "naive-ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const { t, te } = useI18n();
const message = useMessage();

const ACTIVE = ["backup", "building", "switching", "checking", "rolling_back"];
const SHOW_RESULT_MS = 7 * 24 * 3600_000;

const info = ref<OpenClawUpdateDto | null>(null);
/** The panel did not answer: it restarts during the update. */
const unreachable = ref(false);
/** An update was started or seen running from this page: keep asking until it ends. */
const watching = ref(false);
const confirmOpen = ref(false);
const starting = ref(false);
let timer: number | undefined;

const status = computed(() => info.value?.status ?? null);
const active = computed(() => !!status.value && ACTIVE.includes(status.value.state));
const result = computed(() => {
  const s = status.value;
  if (!s || active.value || !s.finishedAt || Date.now() - Date.parse(s.finishedAt) > SHOW_RESULT_MS) return null;
  const type: "success" | "warning" | "error" = s.state === "done" ? "success" : s.state === "rolled_back" ? "warning" : "error";
  const reason = s.reason && te(`system.openclaw.reason.${s.reason}`) ? t(`system.openclaw.reason.${s.reason}`) : s.state === "done" ? "" : s.message ?? "";
  return { type, text: t(`system.openclaw.state.${s.state}`, { v: s.version }), reason };
});

async function load(): Promise<void> {
  try {
    info.value = await api.system.openclaw();
    unreachable.value = false;
    if (active.value) watching.value = true;
    else if (watching.value && status.value?.finishedAt) watching.value = false;
  } catch {
    unreachable.value = true;
  }
  window.clearTimeout(timer);
  if (watching.value) timer = window.setTimeout(load, 4000);
}

async function start(): Promise<void> {
  const offer = info.value?.offer;
  if (!offer) return;
  starting.value = true;
  try {
    await api.system.updateOpenclaw(offer.version);
    confirmOpen.value = false;
    watching.value = true;
    await load();
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  } finally {
    starting.value = false;
  }
}

onMounted(load);
onUnmounted(() => window.clearTimeout(timer));
</script>

<template>
  <n-card v-if="info?.available" :title="t('system.openclaw.title')" data-testid="openclaw-update">
    <p>{{ t("system.openclaw.running", { v: info.running ?? "—" }) }} <span class="muted">{{ t("system.openclaw.about") }}</span></p>

    <n-alert v-if="watching && unreachable" type="info" :bordered="false" class="gap">{{ t("system.openclaw.restarting") }}</n-alert>
    <n-alert v-else-if="active" type="info" :bordered="false" class="gap">
      {{ t(`system.openclaw.state.${status!.state}`, { v: status!.version }) }}
      <div v-if="status!.backup" class="muted small">{{ t("system.openclaw.backup", { backup: status!.backup }) }}</div>
    </n-alert>
    <n-alert v-else-if="result" :type="result.type" :bordered="false" class="gap">
      {{ result.text }} {{ result.reason }}
      <div v-if="status!.backup && result.type !== 'success'" class="muted small">{{ t("system.openclaw.backup", { backup: status!.backup }) }}</div>
    </n-alert>

    <template v-if="info.offer && !active && !(watching && unreachable)">
      <n-alert type="info" :bordered="false" class="gap">
        <strong>{{ t("system.openclaw.offer", { v: info.offer.version }) }}</strong>
        <p v-if="info.offer.newLine">{{ t("system.openclaw.newLine", { from: info.running, to: info.offer.version }) }}</p>
        <p class="muted">{{ t("system.openclaw.steps") }}</p>
      </n-alert>
      <n-button type="primary" class="gap" @click="confirmOpen = true">
        <template #icon><refresh-cw :size="16" /></template>
        {{ t("system.openclaw.update", { v: info.offer.version }) }}
      </n-button>
    </template>
    <p v-else-if="!active && !watching" class="muted">{{ t("system.openclaw.upToDate") }}</p>

    <n-modal :show="confirmOpen" preset="card" :title="t('system.openclaw.confirmTitle')" :closable="!starting" :mask-closable="!starting" style="width: min(460px, calc(100vw - 32px))" @update:show="(v: boolean) => !v && !starting && (confirmOpen = false)">
      <p>{{ t("system.openclaw.confirmText", { from: info.running, to: info.offer?.version }) }}</p>
      <p v-if="info.offer?.newLine" class="muted">{{ t("system.openclaw.newLine", { from: info.running, to: info.offer.version }) }}</p>
      <n-space justify="end">
        <n-button :disabled="starting" @click="confirmOpen = false">{{ t("system.openclaw.cancel") }}</n-button>
        <n-button type="primary" :loading="starting" data-testid="openclaw-update-confirm" @click="start">{{ t("system.openclaw.confirm") }}</n-button>
      </n-space>
    </n-modal>
  </n-card>
</template>

<style scoped>
.muted { color: var(--text-2); line-height: 1.5; }
.small { font-size: 12px; margin-top: 4px; }
.gap { margin-top: 12px; }
p { margin: 0 0 8px; }
</style>
