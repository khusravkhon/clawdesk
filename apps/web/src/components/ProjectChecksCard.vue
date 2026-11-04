<script setup lang="ts">
// Automated checks of a generated project (P6.1): run its own tests in an isolated container and show
// per test what happened. Unknown or blocked results are never shown as a pass.
import type { ProjectCheckRunDto, ProjectChecksDto, ProjectCheckStatus } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NEmpty, NSpace, NTag } from "naive-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean; refreshToken?: number }>();
const emit = defineEmits<{ changed: [] }>();
const { t, te } = useI18n();
const data = ref<ProjectChecksDto | null>(null);
const loading = ref(false), running = ref(false), error = ref<string | null>(null);
let pendingRequest: string | null = null, generation = 0, disposed = false;
const latest = computed(() => data.value?.latest ?? null);
const tagType = (status: ProjectCheckStatus | "blocked") => status === "passed" ? "success" : status === "failed" ? "error" : status === "skipped" ? "default" : "warning";
const explain = (e: unknown) => e instanceof ApiError && te(`projectChecks.errors.${e.body.error}`) ? t(`projectChecks.errors.${e.body.error}`) : e instanceof ApiError && te(`company.errors.${e.body.error}`) ? t(`company.errors.${e.body.error}`) : t("projectChecks.failed");
const counts = (run: ProjectCheckRunDto | ProjectChecksDto["history"][number]) => (["passed", "failed", "flaky", "skipped"] as const).filter(key => run.counts[key]).map(key => `${t(`projectChecks.status.${key}`)}: ${run.counts[key]}`).join(" · ");
const when = (at: number) => new Date(at).toLocaleString();
const seconds = (ms: number) => (ms / 1000).toFixed(1);

async function load(): Promise<void> {
  const sequence = ++generation, id = props.projectId;
  loading.value = true;
  try {
    const result = await api.company.projectChecks(id);
    if (!disposed && sequence === generation && id === props.projectId) { data.value = result; error.value = null; }
  } catch (e) { if (!disposed && sequence === generation) error.value = explain(e); }
  finally { if (!disposed && sequence === generation) loading.value = false; }
}
async function run(): Promise<void> {
  if (props.disabled || running.value) return;
  running.value = true; error.value = null;
  // The same request ID until an answer arrives: a retry after a lost response does not start a second run.
  pendingRequest ??= crypto.randomUUID();
  try {
    await api.company.runProjectChecks(props.projectId, { requestId: pendingRequest });
    pendingRequest = null;
    await load();
    emit("changed");
  } catch (e) {
    if (e instanceof ApiError) pendingRequest = null;
    error.value = explain(e);
  } finally { running.value = false; }
}
watch(() => [props.projectId, props.refreshToken], () => { data.value = null; pendingRequest = null; void load(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation++; });
</script>

<template>
  <n-card :title="t('projectChecks.title')" class="block">
    <template #header-extra><n-button text :loading="loading" :disabled="running" @click="load">{{ t('company.refresh') }}</n-button></template>
    <p>{{ t('projectChecks.intro') }}</p>
    <n-space class="checks-actions">
      <n-button type="primary" :loading="running" :disabled="disabled || loading" @click="run">{{ t('projectChecks.run') }}</n-button>
    </n-space>
    <p v-if="running">{{ t('projectChecks.running') }}</p>
    <n-alert v-if="error" type="error" class="checks-block">{{ error }}</n-alert>
    <n-empty v-if="data && !latest" :description="t('projectChecks.empty')" />
    <template v-if="latest">
      <n-space align="center" class="checks-block">
        <n-tag :type="latest.status === 'completed' ? (latest.counts.failed ? 'error' : latest.counts.flaky ? 'warning' : 'success') : 'warning'" size="small">{{ t(`projectChecks.run_${latest.status}`) }}</n-tag>
        <span>{{ when(latest.createdAt) }} · {{ t('projectChecks.duration', { seconds: seconds(latest.durationMs) }) }}</span>
      </n-space>
      <n-alert v-if="latest.status === 'blocked'" type="warning" class="checks-block">{{ t(`projectChecks.reasons.${latest.reason ?? 'runner_failed'}`) }}</n-alert>
      <p v-else>{{ counts(latest) }}</p>
      <section v-for="item in latest.tests" :key="item.id" class="checks-row">
        <n-space align="center"><n-tag :type="tagType(item.status)" size="small">{{ t(`projectChecks.status.${item.status}`) }}</n-tag><strong>{{ item.name }}</strong></n-space>
        <p class="checks-meta">{{ item.file }}</p>
        <p v-if="item.message" class="checks-message">{{ item.message }}</p>
      </section>
      <details v-if="data && data.history.length > 1" class="checks-block">
        <summary>{{ t('projectChecks.history') }}</summary>
        <p v-for="run in data.history" :key="run.id">{{ when(run.createdAt) }} · {{ t(`projectChecks.run_${run.status}`) }} · {{ run.status === 'blocked' ? t(`projectChecks.reasons.${run.reason ?? 'runner_failed'}`) : counts(run) }}</p>
      </details>
    </template>
    <p class="checks-meta checks-block">{{ t('projectChecks.limits') }}</p>
  </n-card>
</template>

<style scoped>
.checks-actions { margin: 12px 0; }
.checks-block { margin-top: 12px; }
.checks-row { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
.checks-meta { opacity: 0.7; font-size: 0.92em; overflow-wrap: anywhere; }
.checks-message { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: 0.9em; }
p { line-height: 1.6; }
</style>
