<script setup lang="ts">
// P2: the requirements interview with the model. It asks 1–3 questions at a time with example answers,
// marks its guesses as assumptions for the owner to accept or reject, and retells the first version.
// Answers go into the brief; while the model thinks the dialog polls. Closing it loses nothing.
import type { ProjectInterviewDto } from "@clawdesk/shared";
import { NAlert, NButton, NCheckbox, NInput, NModal, NSpace, NSpin, NTag } from "naive-ui";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean }>();
const show = defineModel<boolean>("show", { required: true });
const emit = defineEmits<{ changed: [] }>();
const { t, te } = useI18n();
const state = ref<ProjectInterviewDto | null>(null);
const answers = reactive<Record<string, string>>({});
const accepted = reactive<Record<string, boolean | undefined>>({});
const busy = ref(false), error = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null, pending: { key: string; requestId: string } | null = null;

const asking = computed(() => state.value?.status === "asking");
const hasInput = computed(() => Object.values(answers).some((text) => text.trim()) || Object.values(accepted).some((value) => value !== undefined));
const explain = (e: unknown) => e instanceof ApiError && te(`projectInterview.errors.${e.body.error}`) ? t(`projectInterview.errors.${e.body.error}`) : t("projectInterview.failed");
function requestId(key: string): string {
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  return pending.requestId;
}
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = show.value && asking.value ? setTimeout(() => void load(), 2000) : null;
}
async function load(): Promise<void> {
  try {
    const before = state.value?.status;
    state.value = await api.company.interview(props.projectId);
    if (before === "asking" && state.value.status !== "asking") emit("changed");
    error.value = null;
  } catch (e) { error.value = explain(e); }
  schedule();
}
async function act(key: string, call: (id: string) => Promise<ProjectInterviewDto>, clear: boolean): Promise<void> {
  if (busy.value || props.disabled) return;
  busy.value = true;
  try {
    state.value = await call(requestId(key)); pending = null; error.value = null;
    if (clear) { for (const id of Object.keys(answers)) delete answers[id]; for (const id of Object.keys(accepted)) delete accepted[id]; }
    emit("changed");
  } catch (e) { if (e instanceof ApiError) pending = null; error.value = explain(e); await load(); }
  finally { busy.value = false; schedule(); }
}
const ask = () => act(`ask:${state.value?.revision}`, (id) => api.company.interviewAsk(props.projectId, { requestId: id, revision: state.value?.revision ?? 0 }), false);
function send(next: boolean): void {
  const current = state.value;
  if (!current) return;
  const body = {
    revision: current.revision, continue: next,
    answers: current.questions.filter((q) => answers[q.id]?.trim()).map((q) => ({ questionId: q.id, text: answers[q.id]!.trim() })),
    accept: current.assumptions.filter((a) => accepted[a.id] === true).map((a) => a.id),
    reject: current.assumptions.filter((a) => accepted[a.id] === false).map((a) => a.id),
  };
  void act(`answer:${JSON.stringify(body)}`, (id) => api.company.interviewAnswer(props.projectId, { requestId: id, ...body }), true);
}
const pick = (id: string, option: string) => { answers[id] = answers[id]?.trim() ? `${answers[id]!.trim()}; ${option}` : option; };
watch(show, (open) => { if (open) void load(); else if (timer) { clearTimeout(timer); timer = null; } });
onBeforeUnmount(() => { if (timer) clearTimeout(timer); });
</script>

<template>
  <n-modal v-model:show="show" preset="card" class="interview" :title="t('projectInterview.title')">
    <p class="hint">{{ t("projectInterview.lead") }}</p>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>
    <template v-if="state">
      <section v-if="state.summary" class="block summary">
        <h3>{{ t("projectInterview.summary") }}</h3>
        <p v-if="state.summary.building"><strong>{{ state.summary.building }}</strong></p>
        <p v-if="state.summary.users">{{ t("projectInterview.users") }}: {{ state.summary.users }}</p>
        <template v-for="part in (['inFirstVersion', 'notInFirstVersion', 'scenarios', 'openQuestions'] as const)" :key="part">
          <template v-if="state.summary[part].length">
            <h4>{{ t(`projectInterview.parts.${part}`) }}</h4>
            <ul><li v-for="(item, index) in state.summary[part]" :key="index">{{ item }}</li></ul>
          </template>
        </template>
        <p class="hint">{{ t("projectInterview.summaryNote") }}</p>
      </section>

      <n-alert v-if="state.status === 'failed'" type="warning" class="block" :title="t(`projectInterview.failure.${state.failure ?? 'model_unavailable'}`)">{{ t("projectInterview.failureHint") }}</n-alert>
      <p v-if="state.status === 'idle'" class="block">{{ t("projectInterview.idle") }}</p>
      <n-space v-if="asking" align="center" class="block"><n-spin size="small" /> {{ t("projectInterview.asking") }}</n-space>
      <n-alert v-if="state.status === 'done'" type="success" class="block">{{ t("projectInterview.done") }}</n-alert>

      <section v-for="question in state.status === 'ready' ? state.questions : []" :key="question.id" class="block question">
        <p><n-tag size="small">{{ t(`projectBrief.fields.${question.field}`) }}</n-tag> <strong>{{ question.text }}</strong></p>
        <n-space v-if="question.options.length" size="small" class="options">
          <n-button v-for="option in question.options" :key="option" size="tiny" secondary :disabled="busy || disabled" @click="pick(question.id, option)">{{ option }}</n-button>
        </n-space>
        <n-input v-model:value="answers[question.id]" type="textarea" :autosize="{ minRows: 1, maxRows: 5 }" maxlength="2000" :placeholder="t('projectInterview.answer')" :aria-label="question.text" :disabled="busy || disabled" />
      </section>

      <section v-if="!asking && state.assumptions.length" class="block">
        <h4>{{ t("projectInterview.assumptions") }}</h4>
        <p class="hint">{{ t("projectInterview.assumptionsHint") }}</p>
        <div v-for="item in state.assumptions" :key="item.id" class="assumption">
          <span><n-tag size="small" type="warning">{{ t("projectInterview.assumption") }}</n-tag> {{ item.text }}</span>
          <n-space size="small">
            <n-checkbox :checked="accepted[item.id] === true" :disabled="busy || disabled" @update:checked="(value: boolean) => accepted[item.id] = value ? true : undefined">{{ t("projectInterview.accept") }}</n-checkbox>
            <n-checkbox :checked="accepted[item.id] === false" :disabled="busy || disabled" @update:checked="(value: boolean) => accepted[item.id] = value ? false : undefined">{{ t("projectInterview.reject") }}</n-checkbox>
          </n-space>
        </div>
      </section>

      <n-space class="block">
        <n-button v-if="state.status === 'ready' || hasInput" type="primary" :loading="busy" :disabled="disabled || asking || !hasInput" @click="send(true)">{{ t("projectInterview.answerNext") }}</n-button>
        <n-button v-if="hasInput" :disabled="disabled || busy || asking" @click="send(false)">{{ t("projectInterview.saveOnly") }}</n-button>
        <n-button v-if="state.status !== 'ready' && !asking" :type="state.status === 'idle' ? 'primary' : 'default'" :loading="busy" :disabled="disabled" @click="ask">{{ t(state.status === 'idle' ? 'projectInterview.start' : 'projectInterview.askAgain') }}</n-button>
        <n-button :disabled="busy" @click="show = false">{{ t("projectInterview.close") }}</n-button>
      </n-space>

      <details v-if="state.answered.length" class="block">
        <summary>{{ t("projectInterview.answered", { count: state.answered.length }) }}</summary>
        <p v-for="(item, index) in state.answered" :key="index" class="hint">{{ item.question }} — {{ item.answer }}</p>
      </details>
    </template>
  </n-modal>
</template>

<style scoped>
.block { margin-top: 12px; }
.hint { font-size: 0.92em; opacity: 0.75; line-height: 1.6; }
.summary { padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
.summary h3, .summary h4 { margin: 8px 0 4px; }
.summary ul { margin: 0; padding-left: 20px; line-height: 1.6; }
.question p { margin: 0 0 6px; overflow-wrap: anywhere; }
.options { margin-bottom: 6px; }
.assumption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding: 6px 0; border-top: 1px solid var(--border); }
</style>
<style>
.interview.n-card { width: min(760px, calc(100vw - 32px)); }
</style>
