<script setup lang="ts">
// Screen 14: backups (nightly, on demand, encrypted download) and the factory reset.
import type { BackupDto, BackupsDto } from "@clawdesk/shared";
import { Download, HardDriveDownload, RotateCcw, TriangleAlert } from "@lucide/vue";
import { NAlert, NButton, NCard, NInput, NModal, NSkeleton, NSpace, NTag, useMessage } from "naive-ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import { authErrorText, usePasswordPair } from "../auth";
import AuditLog from "../components/AuditLog.vue";
import StorageUsage from "../components/StorageUsage.vue";
import { useSpaceStore } from "../stores/space";
import PageHeader from "../components/ui/PageHeader.vue";
import { formatBytes, formatDateTime } from "../format";

const { t, locale } = useI18n();
const message = useMessage();
const space = useSpaceStore();

const data = ref<BackupsDto | null>(null);
const loadError = ref<string | null>(null);
const creating = ref(false);

const errText = (e: unknown) => (e instanceof ApiError ? e.body.message : String(e));

async function load(): Promise<void> {
  try {
    data.value = await api.system.backups();
    loadError.value = null;
  } catch (e) {
    loadError.value = errText(e);
  }
}

async function createNow(): Promise<void> {
  creating.value = true;
  try {
    await api.system.createBackup();
    message.success(t("system.backupMade"));
  } catch (e) {
    message.error(errText(e));
  } finally {
    creating.value = false;
    await load();
  }
}

// --- Download: the copy is encrypted with a password typed here.
const downloadOf = ref<BackupDto | null>(null);
const pair = usePasswordPair(t);
const downloading = ref(false);

function openDownload(b: BackupDto): void {
  downloadOf.value = b;
  pair.password.value = "";
  pair.repeat.value = "";
}

async function downloadCopy(): Promise<void> {
  const b = downloadOf.value;
  if (!b) return;
  downloading.value = true;
  try {
    const blob = await api.system.downloadBackup(b.name, pair.password.value);
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: `${b.name}.enc` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    downloadOf.value = null;
  } catch (e) {
    message.error(errText(e));
  } finally {
    downloading.value = false;
  }
}

// --- Factory reset.
const resetOpen = ref(false);
const resetWord = computed(() => t("system.resetWord"));
const typedWord = ref("");
const resetPassword = ref("");
const resetting = ref(false);
const resetError = ref<string | null>(null);
/** After the reset started: the code to set a new password once the panel is back. */
const ownerCode = ref<string | null>(null);
let poll: number | undefined;

async function reset(): Promise<void> {
  resetting.value = true;
  resetError.value = null;
  try {
    const res = await api.system.reset(resetPassword.value);
    ownerCode.value = res.ownerCode;
    resetOpen.value = false;
    waitForRestart(res.ownerCode);
  } catch (e) {
    resetError.value = e instanceof ApiError && e.body.error === "wrong_password" ? authErrorText(t, e) : errText(e);
  } finally {
    resetting.value = false;
  }
}

/** The stack restarts; once the panel answers without an owner, open the new-password screen. */
function waitForRestart(code: string): void {
  const startedAt = Date.now();
  poll = window.setInterval(async () => {
    try {
      const res = await fetch("/api/auth/state");
      if (res.ok && ((await res.json()) as { state: string }).state === "setup") {
        window.clearInterval(poll);
        location.assign(`/setup?code=${encodeURIComponent(code)}`);
      }
    } catch {
      // the panel is restarting
    }
    if (Date.now() - startedAt > 10 * 60_000) window.clearInterval(poll);
  }, 3000);
}

const kindLabel = (kind: BackupDto["kind"]) => t(`system.kind.${kind}`);

onMounted(load);
onUnmounted(() => window.clearInterval(poll));
</script>

<template>
  <div>
    <page-header :title="t('system.title')" :subtitle="t('system.subtitle')" />

    <n-card v-if="ownerCode" class="restarting">
      <h2>{{ t("system.resettingTitle") }}</h2>
      <p>{{ t("system.resettingText") }}</p>
      <p class="code">{{ ownerCode }}</p>
      <p class="muted">{{ t("system.resettingHint") }}</p>
      <n-button tag="a" :href="`/setup?code=${encodeURIComponent(ownerCode)}`" secondary>{{ t("system.openSetup") }}</n-button>
    </n-card>

    <n-space v-else vertical size="large">
      <n-card :title="t('status.gateway')">
        <p>{{ t("status.restart.about") }}</p>
        <n-button tag="a" href="/status#gateway-restart" secondary>{{ t("status.restart.open") }}</n-button>
      </n-card>
      <storage-usage v-if="space.mode === 'personal'" />
      <n-card :title="t('system.backups')">
        <template #header-extra>
          <n-button v-if="data?.available" type="primary" :loading="creating || data?.running" @click="createNow">
            <template #icon><hard-drive-download :size="16" /></template>
            {{ t("system.backupNow") }}
          </n-button>
        </template>
        <n-skeleton v-if="!data && !loadError" text :repeat="3" />
        <n-alert v-else-if="loadError" type="error" :bordered="false">{{ loadError }}</n-alert>
        <n-alert v-else-if="!data!.available" type="info" :bordered="false">{{ t("system.unavailable") }}</n-alert>
        <template v-else>
          <p class="muted">{{ t("system.backupsAbout") }}</p>
          <n-alert v-if="data!.lastError" type="warning" :bordered="false" class="gap">{{ t("system.lastError", { error: data!.lastError }) }}</n-alert>
          <p v-if="!data!.backups.length" class="muted">{{ t("system.noBackups") }}</p>
          <ul v-else class="list">
            <li v-for="b in data!.backups" :key="b.name">
              <span class="when">{{ formatDateTime(b.createdAt, locale) }}</span>
              <n-tag size="small" :bordered="false" :type="b.kind === 'before-reset' ? 'warning' : 'default'">{{ kindLabel(b.kind) }}</n-tag>
              <span class="muted size">{{ formatBytes(b.size, locale) }}</span>
              <n-button size="small" secondary @click="openDownload(b)">
                <template #icon><download :size="14" /></template>
                {{ t("system.download") }}
              </n-button>
            </li>
          </ul>
          <p class="muted small">{{ t("system.restoreHint") }}</p>
          <code class="command">sudo bash deploy/scripts/restore.sh &lt;{{ t("system.file") }}&gt;</code>
        </template>
      </n-card>

      <audit-log />

      <n-card class="danger">
        <div class="danger-head">
          <triangle-alert :size="18" />
          <h3>{{ t("system.resetTitle") }}</h3>
        </div>
        <p class="muted">{{ t("system.resetAbout") }}</p>
        <n-button type="error" secondary :disabled="!data?.available" @click="resetOpen = true">
          <template #icon><rotate-ccw :size="16" /></template>
          {{ t("system.resetButton") }}
        </n-button>
      </n-card>
    </n-space>

    <n-modal :show="!!downloadOf" preset="card" :title="t('system.downloadTitle')" style="width: min(440px, calc(100vw - 32px))" @update:show="(v: boolean) => !v && (downloadOf = null)">
      <form class="form" @submit.prevent="downloadCopy">
        <p class="muted">{{ t("system.downloadAbout") }}</p>
        <input type="text" name="username" autocomplete="username" value="ClawDesk backup" hidden />
        <n-input v-model:value="pair.password.value" type="password" show-password-on="click" :placeholder="t('system.copyPassword')" :input-props="{ autocomplete: 'new-password' }" />
        <n-input v-model:value="pair.repeat.value" type="password" show-password-on="click" :placeholder="t('auth.repeatPassword')" :input-props="{ autocomplete: 'new-password' }" />
        <p class="muted small">{{ pair.problem.value ?? pair.hint.value }}</p>
        <n-button attr-type="submit" type="primary" block :loading="downloading" :disabled="!pair.ok.value">{{ t("system.download") }}</n-button>
      </form>
    </n-modal>

    <n-modal v-model:show="resetOpen" preset="card" :title="t('system.resetTitle')" style="width: min(440px, calc(100vw - 32px))">
      <form class="form" @submit.prevent="reset">
        <n-alert type="error" :bordered="false">{{ t("system.resetWarning") }}</n-alert>
        <p class="muted">{{ t("system.typeWord", { word: resetWord }) }}</p>
        <n-input v-model:value="typedWord" :placeholder="resetWord" :input-props="{ autocomplete: 'off' }" />
        <input type="text" name="username" autocomplete="username" value="ClawDesk" hidden />
        <n-input v-model:value="resetPassword" type="password" show-password-on="click" :placeholder="t('auth.password')" :input-props="{ autocomplete: 'current-password' }" />
        <n-alert v-if="resetError" type="error" :bordered="false">{{ resetError }}</n-alert>
        <n-button attr-type="submit" type="error" block :loading="resetting" :disabled="typedWord.trim().toUpperCase() !== resetWord.toUpperCase() || !resetPassword">
          {{ resetting ? t("system.resetBackingUp") : t("system.resetConfirm") }}
        </n-button>
      </form>
    </n-modal>
  </div>
</template>

<style scoped>
.muted {
  color: var(--text-2);
  margin: 0 0 12px;
  line-height: 1.5;
}
.small {
  font-size: 12px;
  margin-top: 14px;
  margin-bottom: 6px;
}
.gap {
  margin-bottom: 12px;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.when {
  font-variant-numeric: tabular-nums;
  min-width: 120px;
}
.size {
  margin: 0 auto 0 0;
}
.command {
  display: block;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--surface-2);
  font-size: 12px;
  word-break: break-all;
}
.danger {
  border-color: color-mix(in srgb, var(--critical) 35%, transparent);
}
.danger-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--critical);
  margin-bottom: 8px;
}
.danger-head h3 {
  margin: 0;
  font-size: 16px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form .muted {
  margin: 0;
}
.restarting h2 {
  margin: 0 0 8px;
  font-size: 18px;
}
.code {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
}
</style>
