<script setup lang="ts">
import { ProjectBriefFields, type ProjectBriefDto, type SaveProjectBriefRequest } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NFormItem, NInput, NModal, NPopconfirm, NSpace, NStep, NSteps, NTag } from "naive-ui";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean }>();
const { t, te } = useI18n();
type Field = keyof ProjectBriefFields;
const pages: Field[][] = [["goal", "audience", "scenarios"], ["inScope", "outOfScope", "rules"], ["data", "integrations", "constraints"], ["openQuestions"]];
const keys = pages.flat();
const saved = ref<ProjectBriefDto | null>(null);
const fields = ref(ProjectBriefFields.parse({}));
const step = ref(0), editing = ref(false), loading = ref(false), saving = ref(false);
const error = ref<string | null>(null);
const pending = ref<SaveProjectBriefRequest | null>(null);
const filled = computed(() => saved.value ? keys.filter(key => saved.value!.fields[key].trim()).length : 0);
const dirty = computed(() => saved.value && JSON.stringify(fields.value) !== JSON.stringify(saved.value.fields));
const explain = (e: unknown) => e instanceof ApiError && te(`company.errors.${e.body.error}`) ? t(`company.errors.${e.body.error}`) : t("company.errors.failed");

async function load(): Promise<void> {
  const id = props.projectId;
  loading.value = true;
  try {
    const result = await api.company.brief(id);
    if (id !== props.projectId) return;
    saved.value = result; fields.value = { ...result.fields }; step.value = result.step; error.value = null; pending.value = null;
  } catch (e) { if (id === props.projectId) error.value = explain(e); }
  finally { if (id === props.projectId) loading.value = false; }
}
function open(): void {
  if (!saved.value) return;
  fields.value = { ...saved.value.fields }; step.value = saved.value.step; error.value = null; editing.value = true;
}
async function save(nextStep = step.value): Promise<void> {
  if (!saved.value || props.disabled || saving.value) return;
  saving.value = true;
  const body = { revision: saved.value.revision, fields: { ...fields.value }, step: nextStep };
  const previous = pending.value;
  if (!previous || JSON.stringify({ revision: previous.revision, fields: previous.fields, step: previous.step }) !== JSON.stringify(body)) pending.value = { requestId: crypto.randomUUID(), ...body };
  try {
    const result = await api.company.saveBrief(props.projectId, pending.value!);
    saved.value = result; fields.value = { ...result.fields }; step.value = result.step; error.value = null; pending.value = null;
  } catch (e) { error.value = explain(e); }
  finally { saving.value = false; }
}
watch(() => props.projectId, () => { saved.value = null; editing.value = false; void load(); }, { immediate: true });
</script>

<template>
  <n-card :title="t('projectBrief.title')" class="brief-card">
    <template #header-extra><n-button text :loading="loading" :disabled="saving || editing" @click="load">{{ t('company.refresh') }}</n-button></template>
    <n-alert v-if="error && !editing" type="error">{{ error }}</n-alert>
    <template v-if="saved">
      <p>{{ saved.updatedAt ? t('projectBrief.filled', { count: filled, total: keys.length }) : t('projectBrief.empty') }}</p>
      <p v-if="saved.updatedAt">{{ t('projectBrief.savedAt') }}: {{ new Date(saved.updatedAt).toLocaleString() }}</p>
      <p>{{ t('projectBrief.scope') }}</p>
      <n-button :disabled="loading" @click="open">{{ t(disabled ? 'projectBrief.view' : 'projectBrief.open') }}</n-button>
    </template>
  </n-card>
  <n-modal v-model:show="editing" preset="card" class="brief-editor" :title="t('projectBrief.title')" :closable="false" :mask-closable="false" :close-on-esc="false">
    <n-steps :current="step + 1" size="small"><n-step v-for="index in 4" :key="index" :title="t(`projectBrief.steps.${index - 1}`)" /></n-steps>
    <p>{{ t('projectBrief.saveHint') }}</p>
    <n-alert v-if="error" type="error" class="brief-alert">{{ error }}</n-alert>
    <form @submit.prevent="save()">
      <n-form-item v-for="field in pages[step]" :key="field" :label="t(`projectBrief.fields.${field}`)">
        <n-input v-model:value="fields[field]" type="textarea" :aria-label="t(`projectBrief.fields.${field}`)" :placeholder="t(`projectBrief.examples.${field}`)" :maxlength="4000" :disabled="disabled || saving" :autosize="{ minRows: 2, maxRows: 6 }" />
      </n-form-item>
      <template v-if="step === 3">
        <h3>{{ t('projectBrief.summary') }}</h3>
        <p>{{ t('projectBrief.summaryHint') }}</p>
        <section v-for="field in keys" :key="field" class="brief-answer">
          <strong>{{ t(`projectBrief.fields.${field}`) }}</strong>
          <p v-if="fields[field].trim()">{{ fields[field] }}</p>
          <n-tag v-else size="small">{{ t('projectBrief.unknown') }}</n-tag>
        </section>
      </template>
      <n-space>
        <n-button v-if="step > 0" :disabled="saving" @click="step--">{{ t('projectBrief.back') }}</n-button>
        <n-button :disabled="disabled || saving" attr-type="submit" :loading="saving">{{ t('projectBrief.save') }}</n-button>
        <n-button v-if="step < 3" type="primary" :disabled="saving" @click="disabled ? step++ : save(step + 1)">{{ t(disabled ? 'projectBrief.next' : 'projectBrief.saveNext') }}</n-button>
        <n-popconfirm v-if="dirty" @positive-click="editing = false">
          <template #trigger><n-button :disabled="saving">{{ t('projectBrief.close') }}</n-button></template>
          {{ t('projectBrief.discard') }}
        </n-popconfirm>
        <n-button v-else :disabled="saving" @click="editing = false">{{ t('projectBrief.close') }}</n-button>
        <n-popconfirm v-if="error" @positive-click="load">
          <template #trigger><n-button :disabled="saving || loading">{{ t('projectBrief.reload') }}</n-button></template>
          {{ t('projectBrief.discard') }}
        </n-popconfirm>
      </n-space>
      <p v-if="!dirty && saved?.updatedAt">{{ t('projectBrief.saved') }}</p>
    </form>
  </n-modal>
</template>

<style scoped>
.brief-card { margin-bottom: 18px; }
.brief-alert { margin-bottom: 16px; }
.brief-answer { padding: 10px 0; border-bottom: 1px solid var(--border); }
.brief-answer p { white-space: pre-wrap; overflow-wrap: anywhere; }
p { line-height: 1.6; }
</style>
<style>
.brief-editor.n-card { width: min(820px, calc(100vw - 32px)); }
</style>
