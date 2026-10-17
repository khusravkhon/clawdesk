<script setup lang="ts">
import { NAlert, NButton, NInput, NSpace } from 'naive-ui';
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, errorText, type LocalStatus, type RecoveryInspection } from './api';

const { t } = useI18n();
const target = ref<LocalStatus | null>(null);
const error = ref('');
const archive = ref('');
const password = ref('');
const confirmation = ref('');
const inspection = ref<RecoveryInspection | null>(null);
const busy = ref(false);
const expanded = ref(false);
const restored = ref(false);
async function refresh() {
  try { target.value = await api.localStatus(); error.value = ''; }
  catch (e) { error.value = errorText(e); }
}
async function inspect() {
  if (busy.value || !archive.value.trim()) return;
  busy.value = true; error.value = ''; restored.value = false;
  try { inspection.value = await api.inspectLocalBackup(archive.value.trim(), password.value); }
  catch (e) { inspection.value = null; error.value = errorText(e); }
  finally { busy.value = false; }
}
async function restore() {
  if (busy.value || !inspection.value || confirmation.value !== `RESTORE ${inspection.value.target.project}`) return;
  busy.value = true; error.value = '';
  try {
    await api.restoreLocal(inspection.value.receipt, confirmation.value, password.value);
    restored.value = true;
    await refresh();
  } catch (e) { error.value = errorText(e); }
  finally { busy.value = false; password.value = ''; confirmation.value = ''; inspection.value = null; }
}
watch(archive, () => { inspection.value = null; confirmation.value = ''; });
onMounted(refresh);
</script>

<template>
  <section class="recovery">
    <template v-if="target">
      <div class="small muted">{{ t('localIdentity', { project: target.project, address: target.address, version: target.version ?? t('unknownVersion'), folder: target.dataDir }) }}</div>
      <div class="small muted">{{ target.running ? t('localRunning') : t('localStopped') }}</div>
      <n-button size="small" class="toggle" :disabled="busy" @click="expanded = !expanded">{{ t('recoveryOpen') }}</n-button>
    </template>
    <n-alert v-if="error" type="error" class="gap">{{ error }}</n-alert>
    <n-alert v-if="restored" type="success">{{ t('recoveryDone') }}</n-alert>
    <form v-if="expanded" class="form" @submit.prevent="inspection ? restore() : inspect()">
      <p class="muted">{{ t('recoveryLead') }}</p>
      <label>{{ t('recoveryFile') }}<n-input v-model:value="archive" :disabled="busy" placeholder="C:\Backups\clawdesk-backup.tar.enc" /></label>
      <label>{{ t('recoveryPassword') }}<n-input v-model:value="password" :disabled="busy" type="password" autocomplete="off" /></label>
      <template v-if="inspection">
        <n-alert type="warning">{{ t('recoveryWarning', { project: inspection.target.project, folder: inspection.target.dataDir, address: inspection.target.address, date: inspection.manifest.createdAt, version: inspection.manifest.openclawVersion }) }}</n-alert>
        <label>{{ t('recoveryConfirm', { project: inspection.target.project }) }}<n-input v-model:value="confirmation" :disabled="busy" /></label>
      </template>
      <n-space>
        <n-button v-if="!inspection" attr-type="submit" :loading="busy" :disabled="!archive.trim()">{{ t('recoveryInspect') }}</n-button>
        <n-button v-else attr-type="submit" type="error" :loading="busy" :disabled="confirmation !== `RESTORE ${inspection.target.project}`">{{ t('recoveryStart') }}</n-button>
      </n-space>
    </form>
  </section>
</template>

<style scoped>
.recovery { margin-top: 12px; overflow-wrap: anywhere; }
.toggle { margin: 10px 0; }
.small { font-size: 12px; line-height: 1.6; }
.form { display: flex; flex-direction: column; gap: 12px; }
label { display: flex; flex-direction: column; gap: 6px; }
</style>
