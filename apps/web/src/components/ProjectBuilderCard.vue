<script setup lang="ts">
import type { BuilderMutationRequest, ProjectBriefFields, ProjectBuilderDto, ProjectPreviewRequest, ProjectWorkspaceAnalysisDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NCheckbox, NFormItem, NInput, NSelect, NSpace, NTag } from "naive-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean; refreshToken?: number }>();
const emit = defineEmits<{ changed: [] }>();
const { t, te } = useI18n();
const data = ref<ProjectBuilderDto | null>(null);
const analysis = ref<ProjectWorkspaceAnalysisDto | null>(null);
const loading = ref(false), busy = ref(false), error = ref<string | null>(null);
const answer = ref("");
const answerField = ref<keyof ProjectBriefFields | null>(null);
const templateId = ref<"task-board-v1" | null>(null);
const confirmed = ref(false), html = ref("");
const frame = ref<HTMLIFrameElement | null>(null);
let generation = 0, previewGeneration = 0, disposed = false;
let pending: { signature: string; request: BuilderMutationRequest } | null = null;
const question = computed(() => answer.value.trim() && answerField.value ? { field: answerField.value } : data.value?.questions[0]);
const savedAnswers = computed(() => Object.entries(data.value?.brief.fields ?? {}).filter(([, value]) => value.trim()) as [keyof ProjectBriefFields, string][]);
const selected = computed(() => data.value?.templates.find(item => item.id === templateId.value));
const existing = computed(() => data.value?.workspace?.mode === "existing");
const recentAnswers = computed(() => savedAnswers.value.filter(([field]) => field !== "openQuestions").slice(-2));
const blocked = computed(() => props.disabled || busy.value || loading.value);
const ready = computed(() => !!data.value?.plan && !data.value.stale && !data.value.blockers.length && !existing.value);
const explain = (e: unknown) => e instanceof ApiError && te(`projectBuilder.errors.${e.body.error}`) ? t(`projectBuilder.errors.${e.body.error}`) : e instanceof ApiError && te(`company.errors.${e.body.error}`) ? t(`company.errors.${e.body.error}`) : t("projectBuilder.failed");
const blockerText = (code: string) => te(`projectBuilder.blockers.${code}`) ? t(`projectBuilder.blockers.${code}`) : t("projectBuilder.blocked");
function updateAnswer(value: string): void {
  if (!answer.value.trim()) answerField.value = question.value?.field ?? null;
  answer.value = value;
  if (!value.trim()) answerField.value = null;
}

async function preview(): Promise<void> {
  const sequence = ++previewGeneration;
  html.value = "";
  if (data.value?.runtime.state !== "running") return;
  const id = props.projectId;
  try {
    const result = await api.company.builderPreview(id);
    if (!disposed && id === props.projectId && sequence === previewGeneration) html.value = result;
  } catch (e) { if (!disposed && id === props.projectId && sequence === previewGeneration) error.value = explain(e); }
}
async function load(): Promise<void> {
  const sequence = ++generation, id = props.projectId;
  loading.value = true;
  try {
    const result = await api.company.builder(id);
    if (disposed || id !== props.projectId || sequence !== generation) return;
    if (data.value?.workspace?.path !== result.workspace?.path) analysis.value = null;
    data.value = result; error.value = null; confirmed.value = false;
    templateId.value ??= result.plan?.templateId ?? null;
    await preview();
  } catch (e) { if (!disposed && id === props.projectId && sequence === generation) error.value = explain(e); }
  finally { if (!disposed && id === props.projectId && sequence === generation) loading.value = false; }
}
async function inspect(): Promise<void> {
  if (blocked.value || !existing.value) return;
  const id = props.projectId, sequence = generation;
  busy.value = true; error.value = null;
  try {
    const result = await api.company.analyzeBuilder(id);
    if (!disposed && id === props.projectId && sequence === generation) analysis.value = result;
  } catch (e) { if (!disposed && id === props.projectId && sequence === generation) error.value = explain(e); }
  finally { if (!disposed && id === props.projectId) busy.value = false; }
}
type Action = "answer" | "plan" | "approve" | "prepare" | "start" | "stop";
async function act(action: Action): Promise<void> {
  if (!data.value || (action === "stop" ? busy.value || loading.value : blocked.value)) return;
  const id = props.projectId, sequence = generation;
  const field = question.value?.field;
  const extra = action === "answer" ? { field, value: answer.value.trim() } : action === "plan" ? { templateId: templateId.value } : action === "approve" || action === "prepare" ? { confirm: true as const } : {};
  const signature = JSON.stringify({ action, revision: data.value.revision, ...extra });
  if (!pending || pending.signature !== signature) pending = { signature, request: { requestId: crypto.randomUUID(), revision: data.value.revision } };
  const body = pending.request;
  busy.value = true; error.value = null;
  try {
    let result: ProjectBuilderDto;
    if (action === "answer") {
      if (!field || !answer.value.trim()) return;
      result = await api.company.answerBuilder(id, { ...body, field, value: answer.value.trim() });
    } else if (action === "plan") {
      if (!templateId.value) return;
      result = await api.company.planBuilder(id, { ...body, templateId: templateId.value });
    } else if (action === "approve") result = await api.company.approveBuilder(id, { ...body, confirm: true });
    else if (action === "prepare") result = await api.company.prepareBuilder(id, { ...body, confirm: true });
    else if (action === "start") result = await api.company.startBuilder(id, body);
    else result = await api.company.stopBuilder(id, body);
    if (disposed || id !== props.projectId || sequence !== generation) return;
    data.value = result; pending = null; confirmed.value = false;
    if (action === "answer") { answer.value = ""; answerField.value = null; }
    if (action === "answer" || action === "prepare") emit("changed");
    await preview();
  } catch (e) { if (!disposed && id === props.projectId && sequence === generation) error.value = explain(e); }
  finally { if (!disposed && id === props.projectId) busy.value = false; }
}
let inFlight = 0;
const messageIds = new Set<string>();
async function onPreviewMessage(event: MessageEvent): Promise<void> {
  const target = frame.value?.contentWindow;
  if (!target || event.source !== target || data.value?.runtime.state !== "running" || props.disabled) return;
  const msg = event.data;
  if (!msg || typeof msg !== "object" || msg.type !== "clawdesk-preview-request" || typeof msg.id !== "string" || msg.id.length > 100 || messageIds.has(msg.id) || inFlight >= 8) return;
  if (!["GET", "POST", "PATCH", "DELETE"].includes(msg.method) || typeof msg.path !== "string" || !/^\/api\/tasks(?:\/[a-zA-Z0-9_-]+)?$/.test(msg.path) || msg.path.length > 160) return;
  let encoded: string;
  try { encoded = JSON.stringify(msg.body ?? null); } catch { return; }
  if (encoded.length > 10_000) return;
  const id = props.projectId, sequence = previewGeneration;
  messageIds.add(msg.id); inFlight++;
  try {
    const result = await api.company.builderPreviewRequest(id, { method: msg.method, path: msg.path, body: msg.body } as ProjectPreviewRequest);
    if (!disposed && id === props.projectId && sequence === previewGeneration && target === frame.value?.contentWindow) target.postMessage({ type: "clawdesk-preview-response", id: msg.id, status: result.status, body: result.body }, "*");
  } catch (e) {
    if (!disposed && id === props.projectId && sequence === previewGeneration && target === frame.value?.contentWindow) {
      error.value = explain(e);
      target.postMessage({ type: "clawdesk-preview-response", id: msg.id, status: 502, body: JSON.stringify({ error: "preview_unavailable" }) }, "*");
    }
  } finally { inFlight--; messageIds.delete(msg.id); }
}
watch(() => props.projectId, () => { generation++; previewGeneration++; data.value = null; analysis.value = null; answer.value = ""; answerField.value = null; html.value = ""; templateId.value = null; pending = null; busy.value = false; void load(); }, { immediate: true });
watch(() => props.refreshToken, () => { if (!busy.value) void load(); });
onMounted(() => window.addEventListener("message", onPreviewMessage));
onBeforeUnmount(() => { disposed = true; generation++; previewGeneration++; window.removeEventListener("message", onPreviewMessage); });
</script>

<template>
  <n-card :title="t('projectBuilder.title')" class="builder-card">
    <template #header-extra><n-button text :loading="loading" :disabled="busy" @click="load">{{ t('company.refresh') }}</n-button></template>
    <p>{{ t('projectBuilder.intro') }}</p>
    <n-alert v-if="error" type="error" class="builder-block">{{ error }} <n-button text :disabled="busy" @click="load">{{ t('projectBuilder.reload') }}</n-button></n-alert>
    <template v-if="data">
      <p v-if="data.runtime.state === 'running'"><n-button :disabled="busy || loading" :loading="busy" @click="act('stop')">{{ t('projectBuilder.stop') }}</n-button></p>
      <template v-if="existing">
        <n-alert type="info" class="builder-block">{{ t('projectBuilder.existing') }}</n-alert>
        <p class="builder-path">{{ data.workspace?.path }}</p>
        <n-button :disabled="blocked" :loading="busy" @click="inspect">{{ t('projectBuilder.inspect') }}</n-button>
        <section v-if="analysis" class="builder-plan">
          <h3>{{ t('projectBuilder.analysisTitle') }}</h3>
          <p>{{ t(analysis.hasGit ? 'projectBuilder.gitPresent' : 'projectBuilder.gitAbsent') }}</p>
          <h4>{{ t('projectBuilder.dependencies') }}</h4>
          <ul v-if="analysis.dependencies.length"><li v-for="item in analysis.dependencies" :key="item">{{ item }}</li></ul><p v-else>{{ t('projectBuilder.noDependencies') }}</p>
          <h4>{{ t('projectBuilder.projectFiles') }}</h4>
          <ul><li v-for="file in analysis.files" :key="file"><code>{{ file }}</code></li></ul>
          <p v-if="analysis.truncated">{{ t('projectBuilder.truncated') }}</p>
        </section>
      </template>
      <template v-else>
      <p>{{ t('projectBrief.filled', { count: savedAnswers.length, total: 10 }) }}</p>
      <section v-for="[field, value] in recentAnswers" :key="field" class="builder-answer"><strong>{{ t(`projectBuilder.questions.${field}`) }}</strong><p>{{ value }}</p></section>
      <details v-if="savedAnswers.length" class="builder-block">
        <summary>{{ t('projectBrief.summary') }}</summary>
        <section v-for="[field, value] in savedAnswers" :key="field" class="builder-answer"><strong>{{ t(`projectBrief.fields.${field}`) }}</strong><p>{{ value }}</p></section>
      </details>
      <form v-if="question" class="builder-conversation" @submit.prevent="act('answer')">
        <p>{{ t('projectBuilder.guided') }}</p>
        <n-form-item :label="t(`projectBuilder.questions.${question.field}`)"><n-input :value="answer" @update:value="updateAnswer" type="textarea" :aria-label="t(`projectBuilder.questions.${question.field}`)" :placeholder="t(`projectBrief.examples.${question.field}`)" :maxlength="4000" :disabled="blocked" :autosize="{ minRows: 3, maxRows: 8 }" /></n-form-item>
        <n-button attr-type="submit" type="primary" :loading="busy" :disabled="blocked || !answer.trim()">{{ t('projectBuilder.answer') }}</n-button>
      </form>
      <p v-else>{{ t('projectBuilder.answered') }}</p>
      <h3>{{ t('projectBuilder.templates') }}</h3>
      <n-form-item :label="t('projectBuilder.choose')"><n-select v-model:value="templateId" :aria-label="t('projectBuilder.choose')" :options="data.templates.map(item => ({ value: item.id, label: t(`projectBuilder.templateNames.${item.id}`) }))" :placeholder="t('projectBuilder.choose')" :disabled="blocked" /></n-form-item>
      <template v-if="selected"><p>{{ t('projectBuilder.templateDescription') }}</p><p>{{ t('projectBuilder.templateLimits') }}</p></template>
      <n-button :disabled="blocked || !templateId" :loading="busy" @click="act('plan')">{{ t(data.plan ? 'projectBuilder.replan' : 'projectBuilder.plan') }}</n-button>
      <section v-if="data.plan" class="builder-plan">
        <h3>{{ t('projectBuilder.planTitle', { name: data.plan.projectName }) }}</h3>
        <n-alert v-if="existing" type="info" class="builder-block">{{ t('projectBuilder.existing') }}</n-alert>
        <n-alert v-if="data.stale" type="warning" class="builder-block">{{ t('projectBuilder.stale') }}</n-alert>
        <h4>{{ t('projectBuilder.features') }}</h4><ul><li v-for="(_, index) in data.plan.features" :key="index">{{ t(`projectBuilder.featureItems.${index}`) }}</li></ul>
        <h4>{{ t('projectBuilder.limits') }}</h4><ul><li v-for="(_, index) in data.plan.limitations" :key="index">{{ t(`projectBuilder.limitItems.${index}`) }}</li></ul>
        <p v-if="data.brief.fields.outOfScope"><strong>{{ t('projectBrief.fields.outOfScope') }}</strong>: {{ data.brief.fields.outOfScope }}</p>
        <p><strong>{{ t('projectBrief.fields.openQuestions') }}</strong>: {{ data.brief.fields.openQuestions || t('projectBuilder.noOpenQuestions') }}</p>
        <p class="builder-path"><strong>{{ t('projectBuilder.path') }}</strong>: {{ data.plan.snapshot.workspace?.path || t('projectBuilder.noFolder') }}</p>
        <details class="builder-block"><summary>{{ t('projectBrief.summary') }}</summary><section v-for="(value, field) in data.plan.brief" :key="field" class="builder-answer"><strong>{{ t(`projectBrief.fields.${field}`) }}</strong><p>{{ value || t(field === 'openQuestions' ? 'projectBuilder.noOpenQuestions' : 'projectBrief.unknown') }}</p></section></details>
        <details v-if="data.plan.rules.length" class="builder-block"><summary>{{ t('projectRules.title') }}</summary><section v-for="rule in data.plan.rules" :key="rule.id" class="builder-answer"><strong>{{ rule.code }} · {{ rule.fields.title }} · {{ t('projectRules.version', { version: rule.version }) }}</strong><p>{{ rule.fields.statement }}</p><section v-for="(value, field) in rule.fields" :key="field"><template v-if="value && field !== 'title' && field !== 'statement'"><strong>{{ t(`projectRules.fields.${field}`) }}</strong><p>{{ value }}</p></template></section></section></details>
        <details class="builder-block"><summary>{{ t('projectBuilder.files') }}</summary><ul><li v-for="file in data.plan.files" :key="file"><code>{{ file }}</code></li></ul></details>
        <n-alert v-if="data.blockers.length" type="warning" class="builder-block"><ul><li v-for="code in data.blockers" :key="code">{{ blockerText(code) }}</li></ul></n-alert>
        <template v-if="!data.plan.approvedAt || data.stale">
          <n-checkbox v-model:checked="confirmed" :disabled="blocked || !ready">{{ t('projectBuilder.confirm') }}</n-checkbox>
          <p><n-button type="primary" :disabled="blocked || !ready || !confirmed" :loading="busy" @click="act('approve')">{{ t('projectBuilder.approve') }}</n-button></p>
        </template>
        <template v-else>
          <n-tag type="success">{{ t('projectBuilder.approved') }}</n-tag>
          <p>{{ t('projectBuilder.prepareHint') }}</p>
          <n-space>
            <n-button v-if="data.runtime.state === 'empty' || data.runtime.state === 'failed' || data.runtime.planId !== data.plan.id" type="primary" :disabled="blocked || !ready" :loading="busy" @click="act('prepare')">{{ t('projectBuilder.prepare') }}</n-button>
            <n-button v-if="['prepared', 'stopped', 'failed'].includes(data.runtime.state) && data.runtime.planId === data.plan.id" type="primary" :disabled="blocked || !ready" :loading="busy" @click="act('start')">{{ t('projectBuilder.start') }}</n-button>
          </n-space>
        </template>
      </section>
      <p><n-tag>{{ t(`projectBuilder.states.${data.runtime.state}`) }}</n-tag></p>
      <n-alert v-if="data.runtime.error" type="error" class="builder-block">{{ te(`projectBuilder.errors.${data.runtime.error}`) ? t(`projectBuilder.errors.${data.runtime.error}`) : t('projectBuilder.runtimeFailed') }}</n-alert>
      <template v-if="data.runtime.state === 'running'">
        <h3>{{ t('projectBuilder.preview') }}</h3><p>{{ t('projectBuilder.previewHint') }}</p>
        <n-button :disabled="busy || loading" @click="preview">{{ t('projectBuilder.reloadPreview') }}</n-button>
        <iframe v-if="html" ref="frame" :title="t('projectBuilder.preview')" :srcdoc="html" sandbox="allow-scripts" referrerpolicy="no-referrer" class="builder-preview" />
      </template>
      </template>
    </template>
  </n-card>
</template>

<style scoped>
.builder-card { margin-bottom: 18px; }
.builder-block { margin: 16px 0; }
.builder-conversation, .builder-plan { border-top: 1px solid var(--border); padding-top: 16px; margin-top: 18px; }
.builder-answer { padding: 10px 0; border-bottom: 1px solid var(--border); }
.builder-answer p, .builder-path { white-space: pre-wrap; overflow-wrap: anywhere; }
.builder-preview { display: block; width: 100%; height: 580px; margin-top: 16px; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
p, li { line-height: 1.6; overflow-wrap: anywhere; }
summary { cursor: pointer; }
</style>
