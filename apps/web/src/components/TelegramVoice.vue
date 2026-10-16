<script setup lang="ts">
import { TELEGRAM_AUDIO_PROVIDERS, type TelegramAudioProvider, type TelegramVoiceDto } from "@clawdesk/shared";
import { NA, NAlert, NButton, NInput, NSelect, NSpace, NSpin, NSwitch, NTag, useMessage } from "naive-ui";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const { t, te } = useI18n();
const message = useMessage();
const status = ref<TelegramVoiceDto | null>(null);
const key = ref("");
const provider = ref<TelegramAudioProvider>("openai");
const model = ref<string>(TELEGRAM_AUDIO_PROVIDERS.openai.models[0]);
const selected = computed(() => TELEGRAM_AUDIO_PROVIDERS[provider.value]);
const providers = Object.entries(TELEGRAM_AUDIO_PROVIDERS).map(([value, item]) => ({ value, label: item.label }));
const models = computed(() => selected.value.models.map((value) => ({ value, label: value })));
const dirty = computed(() => provider.value !== status.value?.provider || model.value !== status.value?.model);
const configured = computed(() => status.value?.configuredProviders?.includes(provider.value) ?? false);
const keyInvalid = computed(() => !!key.value.trim() && (!key.value.trim().startsWith(selected.value.keyPrefix) || !/^[A-Za-z0-9_-]{20,1024}$/.test(key.value.trim())));
const canSave = computed(() => !keyInvalid.value && (!!key.value.trim() || configured.value));
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const errorText = (e: unknown) => e instanceof ApiError && te(`telegramVoice.errors.${e.body.error}`) ? t(`telegramVoice.errors.${e.body.error}`) : e instanceof ApiError ? e.body.message : t("telegramVoice.errors.audio_unreachable");
watch(provider, () => { model.value = selected.value.models[0]; error.value = null; }, { flush: "sync" });
watch(key, (value) => {
  const match = providers.find((item) => value.trim().startsWith(TELEGRAM_AUDIO_PROVIDERS[item.value as TelegramAudioProvider].keyPrefix));
  if (match) provider.value = match.value as TelegramAudioProvider;
});

function applyStatus(value: TelegramVoiceDto) {
  status.value = value;
  provider.value = value.provider;
  model.value = value.model;
}

async function load() {
  loading.value = true;
  error.value = null;
  try { applyStatus(await api.telegram.voice()); }
  catch (e) { error.value = errorText(e); }
  finally { loading.value = false; }
}

async function save() {
  if (saving.value || !canSave.value) return;
  saving.value = true;
  error.value = null;
  const value = key.value.trim();
  try {
    applyStatus(value ? await api.telegram.saveVoiceKey(value, provider.value, model.value) : await api.telegram.setVoice(true, provider.value, model.value));
    key.value = "";
    message.success(t("telegramVoice.saved"));
  } catch (e) { error.value = errorText(e); }
  finally { saving.value = false; }
}

async function toggle(enabled: boolean) {
  saving.value = true;
  error.value = null;
  try { applyStatus(await api.telegram.setVoice(enabled)); }
  catch (e) { error.value = errorText(e); }
  finally { saving.value = false; }
}

onMounted(load);
</script>

<template>
  <n-spin :show="loading">
    <n-space align="center" class="block">
      <n-switch :value="status?.enabled ?? false" :disabled="!status?.configured || loading || saving || dirty" :loading="saving" :aria-label="t('telegramVoice.title')" @update:value="toggle" />
      <n-tag size="small" :type="status?.enabled ? 'success' : 'default'">{{ status?.enabled ? t('telegramVoice.enabled') : status?.configured ? t('telegramVoice.disabled') : t('telegramVoice.needsKey') }}</n-tag>
      <span v-if="status" class="detail">{{ TELEGRAM_AUDIO_PROVIDERS[status.provider].label }} / {{ status.model }} · {{ t('telegramVoice.limit', { n: status.maxAudioMb }) }}</span>
    </n-space>
    <div class="provider-row block">
      <div><label for="telegram-audio-provider">{{ t('telegramVoice.provider') }}</label><n-select v-model:value="provider" :options="providers" :disabled="loading || saving" :input-props="{ id: 'telegram-audio-provider' }" /></div>
      <div><label for="telegram-audio-model">{{ t('telegramVoice.model') }}</label><n-select v-model:value="model" :options="models" :disabled="loading || saving" :input-props="{ id: 'telegram-audio-model' }" /></div>
    </div>
    <n-alert type="warning" :show-icon="false" class="block">{{ t('telegramVoice.billing', { provider: selected.label }) }}</n-alert>
    <label for="telegram-voice-key">{{ t('telegramVoice.keyLabel', { provider: selected.label }) }} <n-tag v-if="configured" size="small" type="success">{{ t('telegramVoice.keySaved') }}</n-tag></label>
    <div class="key-row">
      <n-input v-model:value="key" type="password" show-password-on="click" :placeholder="`${selected.keyPrefix}...`" :status="keyInvalid ? 'error' : undefined" :disabled="saving || loading" :input-props="{ id: 'telegram-voice-key', autocomplete: 'off', spellcheck: false }" @keyup.enter="save" />
      <n-button type="primary" :loading="saving" :disabled="!canSave || loading || saving" @click="save">{{ t('telegramVoice.save') }}</n-button>
    </div>
    <n-alert v-if="keyInvalid" type="error" :show-icon="false" class="block">{{ t('telegramVoice.errors.audio_key_provider_mismatch') }}</n-alert>
    <n-a :href="selected.keyUrl" target="_blank" rel="noopener noreferrer">{{ t('telegramVoice.getKey', { provider: selected.label }) }}</n-a>
    <n-alert v-if="error" type="error" :show-icon="false" class="error">{{ error }} <n-button text :disabled="saving" @click="load">{{ t('status.refresh') }}</n-button></n-alert>
  </n-spin>
</template>

<style scoped>
.block { margin-bottom: 16px; }
.detail { font-size: 13px; opacity: 0.75; overflow-wrap: anywhere; }
label { display: block; margin-bottom: 8px; font-size: 13px; }
.key-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin-bottom: 10px; }
.provider-row { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(0, 2fr); gap: 10px; }
.error { margin-top: 12px; }
@media (max-width: 600px) { .key-row, .provider-row { grid-template-columns: minmax(0, 1fr); } }
</style>
