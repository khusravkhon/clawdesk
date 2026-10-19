<script setup lang="ts">
import type { LocalMemoryStatusDto, LocalMemorySearchDto } from "@clawdesk/shared";
import { NAlert, NButton, NCheckbox, NInput, NProgress, NTag } from "naive-ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const { t, te, locale } = useI18n();
const data = ref<LocalMemoryStatusDto | null>(null);
const consent = ref(false);
const requestPending = ref(false);
const disconnected = ref(false);
const searchQuery = ref("");
const searchAgent = ref("main");
const searching = ref(false);
const searchResult = ref<LocalMemorySearchDto | null>(null);
const searchError = ref<string | null>(null);
// The plugin ships in lockstep with OpenClaw, so its version is the running Gateway's.
const openclawVersion = ref("");
const active = computed(() => !!data.value && !["idle", "ready", "error"].includes(data.value.job.state));
const errorCode = computed(() => disconnected.value ? "bridge_unavailable" : data.value?.job.error ?? data.value?.error);
const reason = computed(() => {
  const key = `localMemory.errors.${errorCode.value}`;
  return te(key) ? t(key) : t("localMemory.errors.memory_failed");
});
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
async function refresh(): Promise<void> {
  if (requestPending.value || document.hidden) return;
  requestPending.value = true;
  try { data.value = await api.assistant.localMemory(); disconnected.value = false; }
  catch { disconnected.value = true; }
  finally { requestPending.value = false; }
}
async function poll(): Promise<void> {
  await refresh();
  if (!stopped) timer = setTimeout(poll, active.value || disconnected.value ? 2500 : 15000);
}
async function action(action: "setup" | "reindex" | "check"): Promise<void> {
  if (requestPending.value || active.value) return;
  requestPending.value = true;
  try { data.value = await api.assistant.localMemoryAction(action, consent.value); disconnected.value = false; }
  catch { disconnected.value = true; }
  finally { requestPending.value = false; }
}
async function search(): Promise<void> {
  searching.value = true;
  searchResult.value = null;
  searchError.value = null;
  try { searchResult.value = await api.assistant.localMemorySearch(searchAgent.value, searchQuery.value); }
  catch (error) {
    const code = error instanceof ApiError ? error.body.error : "memory_failed";
    searchError.value = t(te(`localMemory.errors.${code}`) ? `localMemory.errors.${code}` : "localMemory.errors.memory_failed");
  } finally { searching.value = false; }
}
onMounted(() => {
  void poll();
  api.health().then((h) => { openclawVersion.value = h.gateway.serverVersion ?? ""; }, () => {});
});
onUnmounted(() => { stopped = true; clearTimeout(timer); });
</script>

<template>
  <section class="local-memory" :aria-label="t('localMemory.title')">
    <h3>{{ t("localMemory.title") }}</h3>
    <p>{{ t("localMemory.about") }}</p>
    <n-alert v-if="errorCode" type="warning" :bordered="false">{{ reason }}</n-alert>
    <p v-if="data" role="status" aria-live="polite">
      {{ t(`localMemory.state.${data.job.state}`) }}
      <span v-if="data.checkedAt"> · {{ t("localMemory.checked") }} {{ new Date(data.checkedAt).toLocaleString(locale) }}</span>
    </p>
    <n-progress v-if="active && data?.job.percent !== null && data?.job.percent !== undefined" type="line" :percentage="data.job.percent" />
    <p v-if="active">{{ t("localMemory.canLeave") }}</p>
    <div v-for="agent in data?.agents ?? []" :key="agent.agentId" class="agent">
      <strong>{{ agent.agentId }}</strong> · {{ agent.provider ?? '—' }} · {{ agent.files ?? '—' }} {{ t("localMemory.files") }} / {{ agent.chunks ?? '—' }} {{ t("localMemory.chunks") }}
      <n-tag size="small" :type="agent.index === 'ready' ? 'success' : 'warning'">{{ t(`localMemory.index.${agent.index}`) }}</n-tag>
      <n-tag size="small" :type="agent.embeddings === 'ready' ? 'success' : agent.embeddings === 'error' ? 'error' : 'default'">{{ t(`localMemory.embeddings.${agent.embeddings}`) }}</n-tag>
    </div>
    <n-checkbox v-model:checked="consent" :disabled="active">{{ t("localMemory.consent", { version: openclawVersion }) }}</n-checkbox>
    <div class="actions">
      <n-button type="primary" :disabled="!consent || active || requestPending" @click="action('setup')">{{ t("localMemory.install") }}</n-button>
      <n-button :disabled="active || requestPending" @click="action('check')">{{ t("localMemory.check") }}</n-button>
      <n-button :disabled="active || requestPending" @click="action('reindex')">{{ t("localMemory.reindex") }}</n-button>
      <n-button :disabled="requestPending" @click="refresh">{{ t("localMemory.reconnect") }}</n-button>
    </div>
    <form class="search" @submit.prevent="search">
      <label>{{ t("localMemory.searchAgent") }}
        <select v-model="searchAgent">
          <option value="main">main</option>
          <option v-for="agent in data?.agents.filter(a => a.agentId !== 'main') ?? []" :key="agent.agentId" :value="agent.agentId">{{ agent.agentId }}</option>
        </select>
      </label>
      <n-input v-model:value="searchQuery" :placeholder="t('localMemory.searchHint')" :maxlength="500" :aria-label="t('localMemory.searchHint')" />
      <n-button attr-type="submit" :loading="searching" :disabled="active || !searchQuery.trim() || searching">{{ t("localMemory.search") }}</n-button>
    </form>
    <p v-if="searchError" role="alert">{{ searchError }}</p>
    <p v-if="searchResult?.stale">{{ t("localMemory.stale") }}</p>
    <p v-if="searchResult && !searchResult.results.length">{{ t("localMemory.noResults") }}</p>
    <div v-for="(result, i) in searchResult?.results ?? []" :key="i"><strong>{{ result.path }}</strong><p class="snippet">{{ result.snippet }}</p></div>
  </section>
</template>

<style scoped>
.local-memory { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
h3 { margin: 0 0 8px; font-size: 14px; }
p { color: var(--text-2); font-size: 13px; line-height: 1.6; }
.actions, .agent { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
.agent { font-size: 12px; }
.search { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 16px; }
.search label { display: flex; align-items: center; gap: 8px; }
.snippet { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
