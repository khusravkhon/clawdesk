<script setup lang="ts">
import type { StorageCategory, StoragePreviewDto, StorageStatusDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NInputNumber, NModal, NSpace, NCheckbox, useMessage } from "naive-ui";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import { formatBytes } from "../format";

const { t, locale } = useI18n();
const message = useMessage();
const data = ref<StorageStatusDto | null>(null);
const quotaMiB = ref<number | null>(null);
const busy = ref(false), error = ref<string | null>(null);
const preview = ref<StoragePreviewDto | null>(null), confirmed = ref(false);
const retained = ref<string[]>([]);
const text = (e: unknown) => t(`storage.errors.${e instanceof ApiError && ["storage_busy", "preview_expired", "storage_quota_exceeded"].includes(e.body.error) ? e.body.error : "storage_unavailable"}`);
const bytes = (value: number) => formatBytes(value, locale.value);
async function run(action: () => Promise<void>) {
  busy.value = true; error.value = null;
  try { await action(); } catch (e) { error.value = text(e); } finally { busy.value = false; }
}
async function load() {
  await run(async () => { data.value = await api.system.storage(); quotaMiB.value = data.value.videoQuotaBytes === null ? null : data.value.videoQuotaBytes / 1024 ** 2; });
}
async function saveQuota() {
  await run(async () => { data.value = await api.system.storageQuota(quotaMiB.value === null ? null : Math.floor(quotaMiB.value * 1024 ** 2)); message.success(t("storage.saved")); });
}
async function inspect(category: StorageCategory) {
  await run(async () => { confirmed.value = false; preview.value = await api.system.storagePreview(category); });
}
async function cleanup() {
  const selected = preview.value;
  if (!selected || !confirmed.value) return;
  await run(async () => {
    const result = await api.system.storageCleanup(selected.token);
    preview.value = null;
    retained.value = result.retained.map((item) => `${item.originalName} → ${item.name}`);
    if (result.retainedCount) error.value = t("storage.retained", { count: result.retainedCount });
    message.success(t("storage.cleaned", { files: result.deleted, bytes: bytes(result.bytes), skipped: result.skipped }));
    data.value = await api.system.storage();
  });
}
onMounted(load);
</script>

<template>
  <n-card :title="t('storage.title')">
    <template #header-extra><n-button size="small" :loading="busy" @click="load">{{ t("storage.refresh") }}</n-button></template>
    <p>{{ t("storage.about") }}</p>
    <n-alert v-if="error" type="warning" :bordered="false">{{ error }}</n-alert>
    <ul v-if="retained.length" class="preview"><li v-for="name in retained" :key="name">{{ name }}</li></ul>
    <template v-if="data">
      <p>{{ t("storage.free") }}: {{ data.freeBytes === null ? '—' : bytes(data.freeBytes) }}</p>
      <div v-for="category in (['videos', 'history'] as const)" :key="category" class="usage-row">
        <span>{{ t(`storage.${category}`) }}: {{ data[category].available ? bytes(data[category].bytes) : '—' }} · {{ data[category].available ? data[category].files : '—' }} {{ t("storage.files") }}</span>
        <span v-if="data[category].retainedFiles">{{ t("storage.retained", { count: data[category].retainedFiles }) }}</span>
        <ul v-if="data[category].retainedNames.length" class="preview"><li v-for="name in data[category].retainedNames" :key="name">{{ name }}</li></ul>
        <n-button size="small" :disabled="busy || !data[category].available" @click="inspect(category)">{{ t("storage.preview") }}</n-button>
      </div>
      <p>{{ t("storage.reserved", { bytes: bytes(data.reservedBytes), jobs: data.activeDownloads }) }}</p>
      <label for="video-quota">{{ t("storage.quota") }}</label>
      <n-space align="center" class="quota">
        <n-input-number id="video-quota" v-model:value="quotaMiB" :min="1" :max="104857600" :precision="0" :placeholder="t('storage.unlimited')" :disabled="busy" clearable />
        <n-button :loading="busy" @click="saveQuota">{{ t("storage.save") }}</n-button>
      </n-space>
      <p class="muted">{{ t("storage.quotaHint") }}</p>
    </template>
  </n-card>
  <n-modal :show="!!preview" preset="card" :title="t('storage.confirmTitle')" style="width: min(650px, calc(100vw - 32px))" @update:show="(show: boolean) => !show && !busy && (preview = null)">
    <template v-if="preview">
      <n-alert type="warning" :bordered="false">{{ t("storage.confirmAbout", { files: preview.files, bytes: bytes(preview.bytes) }) }}</n-alert>
      <p>{{ t(`storage.${preview.category}`) }} · {{ t("storage.expires") }}</p>
      <ul class="preview"><li v-for="(entry, index) in preview.entries" :key="index">{{ entry.name }} · {{ bytes(entry.bytes) }}</li></ul>
      <p v-if="preview.more">{{ t("storage.more") }}</p>
      <n-checkbox v-model:checked="confirmed" :disabled="busy">{{ t("storage.confirmCheck") }}</n-checkbox>
      <n-space class="quota"><n-button :disabled="busy" @click="preview = null">{{ t("storage.cancel") }}</n-button><n-button type="error" :loading="busy" :disabled="!confirmed || !preview.files" @click="cleanup">{{ t("storage.delete") }}</n-button></n-space>
      <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>
    </template>
  </n-modal>
</template>

<style scoped>
.usage-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0; }
.quota { margin: 12px 0; }
.preview { max-height: 260px; overflow: auto; padding-left: 20px; overflow-wrap: anywhere; }
.muted { color: var(--text-2); }
</style>
