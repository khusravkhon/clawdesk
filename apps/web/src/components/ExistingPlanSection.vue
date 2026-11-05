<script setup lang="ts">
// Acceptance 2: for an existing project, a limited change plan the main agent's model proposes from the
// folder's reading, the brief and the approved rules. It is shown only; nothing in the folder changes.
import type { ExistingPlanDto } from "@clawdesk/shared";
import { NAlert, NButton, NSpin, NTag } from "naive-ui";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean }>();
const { t, te } = useI18n();
const state = ref<ExistingPlanDto | null>(null), busy = ref(false), error = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null, pending: { key: string; requestId: string } | null = null, disposed = false;
const explain = (e: unknown) => e instanceof ApiError && te(`existingPlan.errors.${e.body.error}`) ? t(`existingPlan.errors.${e.body.error}`) : t("existingPlan.failed");

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = !disposed && state.value?.status === "planning" ? setTimeout(() => void load(), 2000) : null;
}
async function load(): Promise<void> {
  try { state.value = await api.company.existingPlan(props.projectId); error.value = null; }
  catch (e) { error.value = explain(e); }
  schedule();
}
async function ask(): Promise<void> {
  const key = `plan:${state.value?.revision ?? 0}`;
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  busy.value = true;
  try { state.value = await api.company.askExistingPlan(props.projectId, { requestId: pending.requestId, revision: state.value?.revision ?? 0 }); pending = null; error.value = null; }
  catch (e) { if (e instanceof ApiError) pending = null; error.value = explain(e); }
  finally { busy.value = false; schedule(); }
}
onMounted(load);
onBeforeUnmount(() => { disposed = true; if (timer) clearTimeout(timer); });
</script>

<template>
  <section class="builder-plan">
    <h3>{{ t("existingPlan.title") }}</h3>
    <p class="hint">{{ t("existingPlan.lead") }}</p>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>
    <n-alert v-if="state?.status === 'failed'" type="warning" class="block">{{ t(`existingPlan.failure.${state.failure ?? 'model_unavailable'}`) }}</n-alert>
    <p v-if="state?.status === 'planning'" class="block"><n-spin size="small" /> {{ t("existingPlan.planning") }}</p>
    <n-button v-else class="block" :loading="busy" :disabled="disabled" @click="ask">{{ t(state?.plan ? "existingPlan.again" : "existingPlan.ask") }}</n-button>
    <template v-if="state?.plan">
      <p class="block"><strong>{{ state.plan.summary }}</strong></p>
      <p v-if="state.basis" class="hint">{{ t("existingPlan.basis", { files: state.basis.files, deps: state.basis.dependencies.join(", ") || "—" }) }}</p>
      <template v-if="state.plan.keep.length"><h4>{{ t("existingPlan.keep") }}</h4><ul><li v-for="(item, index) in state.plan.keep" :key="index">{{ item }}</li></ul></template>
      <h4>{{ t("existingPlan.changes") }}</h4>
      <div v-for="(change, index) in state.plan.changes" :key="index" class="change">
        <p><n-tag size="small" :type="change.risk === 'high' ? 'error' : change.risk === 'medium' ? 'warning' : 'success'">{{ t(`existingPlan.risk.${change.risk}`) }}</n-tag> <strong>{{ change.area }}</strong> — {{ change.what }}</p>
        <p v-if="change.files.length" class="hint"><template v-for="(file, fileIndex) in change.files" :key="file"><code>{{ file }}</code><template v-if="!change.known[fileIndex]"> ({{ t("existingPlan.newFile") }})</template><template v-if="fileIndex < change.files.length - 1">, </template></template></p>
      </div>
      <template v-if="state.plan.risks.length"><h4>{{ t("existingPlan.risks") }}</h4><ul><li v-for="(item, index) in state.plan.risks" :key="index">{{ item }}</li></ul></template>
      <template v-if="state.plan.questions.length"><h4>{{ t("existingPlan.questions") }}</h4><ul><li v-for="(item, index) in state.plan.questions" :key="index">{{ item }}</li></ul></template>
      <p class="hint">{{ t("existingPlan.notRun") }}</p>
    </template>
  </section>
</template>

<style scoped>
.block { margin-top: 10px; }
.hint { font-size: 0.92em; opacity: 0.75; line-height: 1.6; overflow-wrap: anywhere; }
.change { padding: 6px 0; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
.change p { margin: 4px 0; }
</style>
