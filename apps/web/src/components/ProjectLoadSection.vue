<script setup lang="ts">
// P9: a load check of the project's app, with the conditions next to the numbers and a verdict that never
// claims more than was run.
import type { LoadRunDto, LoadRunsDto } from "@clawdesk/shared";
import { NAlert, NButton, NInputNumber, NSpace, NTag } from "naive-ui";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean }>();
const { t, te } = useI18n();
const data = ref<LoadRunsDto | null>(null), busy = ref(false), error = ref<string | null>(null);
const concurrency = ref(10), seconds = ref(10);
let pending: { key: string; requestId: string } | null = null;
const type = (run: LoadRunDto) => run.verdict === "confirmed" ? "success" : run.verdict === "failed" || run.verdict === "blocked" ? "error" : "warning";
const explain = (e: unknown) => e instanceof ApiError && te(`projectLoad.errors.${e.body.error}`) ? t(`projectLoad.errors.${e.body.error}`) : t("projectLoad.failed");

async function load(): Promise<void> {
  try {
    data.value = await api.company.loadRuns(props.projectId);
    if (data.value.target.simultaneous && !data.value.runs.length) concurrency.value = Math.min(50, data.value.target.simultaneous);
  } catch (e) { error.value = explain(e); }
}
async function run(): Promise<void> {
  const key = `${concurrency.value}:${seconds.value}`;
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  busy.value = true; error.value = null;
  try { await api.company.runLoad(props.projectId, { requestId: pending.requestId, concurrency: concurrency.value, durationSeconds: seconds.value }); pending = null; await load(); }
  catch (e) { if (e instanceof ApiError) pending = null; error.value = explain(e); }
  finally { busy.value = false; }
}
onMounted(load);
</script>

<template>
  <section class="load">
    <h3>{{ t("projectLoad.title") }}</h3>
    <p class="hint">{{ t("projectLoad.lead") }}</p>
    <p v-if="data" class="hint">
      <template v-if="data.target.simultaneous">{{ t("projectLoad.targetSimultaneous", { n: data.target.simultaneous }) }}</template>
      <template v-else-if="data.target.total">{{ t("projectLoad.targetTotal", { n: data.target.total }) }}</template>
      <template v-else>{{ t("projectLoad.noTarget") }}</template>
      <template v-if="data.target.evidence"> («{{ data.target.evidence }}»)</template>
    </p>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>
    <n-space align="center" class="block">
      <label>{{ t("projectLoad.concurrency") }} <n-input-number v-model:value="concurrency" :min="1" :max="50" size="small" class="number" :disabled="busy" /></label>
      <label>{{ t("projectLoad.seconds") }} <n-input-number v-model:value="seconds" :min="2" :max="20" size="small" class="number" :disabled="busy" /></label>
      <n-button :loading="busy" :disabled="disabled || !concurrency || !seconds" @click="run">{{ t("projectLoad.run") }}</n-button>
    </n-space>
    <div v-for="item in data?.runs ?? []" :key="item.id" class="run">
      <n-space align="center" size="small">
        <n-tag size="small" :type="type(item)">{{ t(`projectLoad.verdict.${item.verdict}`) }}</n-tag>
        <span class="hint">{{ new Date(item.createdAt).toLocaleString() }}</span>
      </n-space>
      <p class="hint">{{ t("projectLoad.conditions", { c: item.conditions.concurrency, s: Math.round(item.conditions.durationMs / 1000), cpu: item.conditions.appCpus, mem: item.conditions.appMemoryMb }) }} {{ item.conditions.requests.join(", ") }}; {{ item.conditions.data }}.</p>
      <p v-if="item.result">{{ t("projectLoad.result", { n: item.result.requests, rps: item.result.rps, p50: item.result.p50, p95: item.result.p95, p99: item.result.p99, errors: item.result.errors }) }}</p>
      <p v-else class="hint">{{ t("projectLoad.noResult", { error: item.error ?? "—" }) }}</p>
      <p class="hint">{{ t(`projectLoad.explain.${item.verdict}`, { n: item.target.simultaneous ?? item.target.total ?? 0 }) }}</p>
    </div>
  </section>
</template>

<style scoped>
.load { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.load h3 { margin: 0 0 4px; font-size: 1em; }
.block { margin-top: 10px; }
.hint { font-size: 0.92em; opacity: 0.75; line-height: 1.6; overflow-wrap: anywhere; }
.number { width: 90px; display: inline-flex; }
.run { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
.run p { margin: 4px 0 0; }
</style>
