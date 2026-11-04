<script setup lang="ts">
import type { AcceptanceCaseDto, AcceptanceFields, AcceptanceHistoryDto, AcceptanceSuiteDto, AutomatedCheckStatus, BusinessRuleDto, CreateAcceptanceRequest, ProjectCheckTestDto, RecordAcceptanceCheckRequest, UpdateAcceptanceRequest } from "@clawdesk/shared";
import { NAlert, NButton, NCheckbox, NEmpty, NFormItem, NInput, NModal, NPopconfirm, NSelect, NSpace, NTag } from "naive-ui";
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; rule: BusinessRuleDto; disabled: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { t, te } = useI18n();
const suite = ref<AcceptanceSuiteDto | null>(null), loading = ref(false), saving = ref(false);
const error = ref<string | null>(null), formError = ref<string | null>(null);
const editor = ref<"case" | "check" | null>(null), selected = ref<AcceptanceCaseDto | null>(null);
const fields = reactive<AcceptanceFields>({ title: "", kind: "allowed", given: "", action: "", expected: "", testRef: "" });
const check = reactive({ outcome: null as RecordAcceptanceCheckRequest["outcome"] | null, context: "", observed: "", evidence: "", confirm: false });
const fieldKeys = ["title", "given", "action", "expected", "testRef"] as const;
const initial = ref("");
const pendingCase = ref<CreateAcceptanceRequest | UpdateAcceptanceRequest | null>(null);
const pendingCheck = ref<RecordAcceptanceCheckRequest | null>(null);
const history = ref<AcceptanceHistoryDto | null>(null), historyCode = ref("");
const writable = computed(() => !!suite.value && !props.disabled && suite.value.currentVersion === suite.value.selectedVersion);
const validCase = computed(() => fields.title.trim() && fields.action.trim() && fields.expected.trim());
const validCheck = computed(() => check.outcome && check.context.trim() && check.observed.trim() && (check.outcome === "blocked" || check.evidence.trim()) && check.confirm);
const dirty = computed(() => JSON.stringify(editor.value === "case" ? fields : check) !== initial.value);
const options = (items: string[], key: string) => items.map(value => ({ value, label: t(`projectAcceptance.${key}.${value}`) }));
/** Tests of the latest run: a scenario links to one by picking it (a typed reference stays free text). */
const tests = ref<ProjectCheckTestDto[]>([]);
const testOptions = computed(() => [...tests.value.map(item => ({ value: item.id, label: `${item.name} (${item.file})` })), ...(fields.testRef && !tests.value.some(item => item.id === fields.testRef) ? [{ value: fields.testRef, label: fields.testRef }] : [])]);
const automatedType = (status: AutomatedCheckStatus) => status === "passed" ? "success" : status === "failed" ? "error" : status === "skipped" || status === "unlinked" ? "default" : "warning";
async function loadTests(): Promise<void> {
  try { tests.value = (await api.company.projectChecks(props.projectId)).latest?.tests ?? []; } catch { tests.value = []; }
}
const explain = (e: unknown) => e instanceof ApiError && te(`company.errors.${e.body.error}`) ? t(`company.errors.${e.body.error}`) : t("company.errors.failed");

async function load(version?: number): Promise<void> {
  loading.value = true;
  try { suite.value = await api.company.acceptanceSuite(props.projectId, props.rule.id, version); error.value = null; }
  catch (e) { error.value = explain(e); }
  finally { loading.value = false; }
}
function open(mode: "case" | "check", item: AcceptanceCaseDto | null): void {
  selected.value = item; editor.value = mode; formError.value = null; pendingCase.value = null; pendingCheck.value = null;
  if (mode === "case") Object.assign(fields, item?.fields ?? { title: "", kind: "allowed", given: "", action: "", expected: "", testRef: "" });
  else Object.assign(check, { outcome: null, context: "", observed: "", evidence: "", confirm: false });
  initial.value = JSON.stringify(mode === "case" ? fields : check);
}
async function saveCase(): Promise<void> {
  if (!suite.value || !writable.value || !validCase.value || saving.value) return;
  saving.value = true;
  const content = { ruleVersion: suite.value.selectedVersion, fields: { ...fields }, ...(selected.value ? { revision: selected.value.revision } : {}) };
  const previous = pendingCase.value;
  if (!previous || JSON.stringify({ ruleVersion: previous.ruleVersion, fields: previous.fields, ...("revision" in previous ? { revision: previous.revision } : {}) }) !== JSON.stringify(content)) pendingCase.value = { requestId: crypto.randomUUID(), ...content };
  try {
    if (selected.value) await api.company.updateAcceptance(props.projectId, props.rule.id, selected.value.id, pendingCase.value as UpdateAcceptanceRequest);
    else await api.company.createAcceptance(props.projectId, props.rule.id, pendingCase.value!);
    editor.value = null; await load(suite.value.selectedVersion);
  } catch (e) { formError.value = explain(e); }
  finally { saving.value = false; }
}
async function record(): Promise<void> {
  if (!suite.value || !selected.value || !writable.value || !suite.value.approved || !validCheck.value || !check.outcome || saving.value) return;
  saving.value = true;
  const content = { ruleVersion: suite.value.selectedVersion, revision: selected.value.revision, outcome: check.outcome, context: check.context, observed: check.observed, evidence: check.evidence, confirm: true as const };
  const previous = pendingCheck.value;
  if (!previous || JSON.stringify({ ruleVersion: previous.ruleVersion, revision: previous.revision, outcome: previous.outcome, context: previous.context, observed: previous.observed, evidence: previous.evidence, confirm: previous.confirm }) !== JSON.stringify(content)) pendingCheck.value = { requestId: crypto.randomUUID(), ...content };
  try { await api.company.recordAcceptance(props.projectId, props.rule.id, selected.value.id, pendingCheck.value!); editor.value = null; await load(suite.value.selectedVersion); }
  catch (e) { formError.value = explain(e); }
  finally { saving.value = false; }
}
async function showHistory(item: AcceptanceCaseDto): Promise<void> {
  saving.value = true;
  try { history.value = await api.company.acceptanceHistory(props.projectId, props.rule.id, item.id); historyCode.value = item.code; }
  catch (e) { error.value = explain(e); }
  finally { saving.value = false; }
}
watch(() => props.rule.id, () => { suite.value = null; void load(); void loadTests(); }, { immediate: true });
</script>

<template>
  <n-modal :show="true" preset="card" class="acceptance-dialog" :title="`${rule.code} — ${t('projectAcceptance.title')}`" :closable="!saving && !editor && !history" :mask-closable="false" :close-on-esc="!saving && !editor && !history" @update:show="!$event && emit('close')">
    <p>{{ t('projectAcceptance.scope') }}</p>
    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <template v-if="suite">
      <n-form-item :label="t('projectAcceptance.ruleVersion')"><n-select :value="suite.selectedVersion" :aria-label="t('projectAcceptance.ruleVersion')" :options="suite.versions.map(value => ({ value, label: t('projectRules.version', { version: value }) }))" :disabled="saving || loading || !!editor" @update:value="load" /></n-form-item>
      <p class="acceptance-text">{{ suite.statement }}</p>
      <n-alert v-if="suite.selectedVersion !== suite.currentVersion" type="warning">{{ t('projectAcceptance.oldVersion') }}</n-alert>
      <p v-else-if="!suite.approved">{{ t('projectAcceptance.approveFirst') }}</p>
      <n-space class="acceptance-actions"><n-button :loading="loading" :disabled="saving" @click="load(suite.selectedVersion)">{{ t('company.refresh') }}</n-button><n-button :disabled="!writable || saving" @click="open('case', null)">{{ t('projectAcceptance.add') }}</n-button></n-space>
      <n-empty v-if="!suite.cases.length" :description="t('projectAcceptance.empty')" />
      <section v-for="item in suite.cases" :key="item.id" class="acceptance-row">
        <h3>{{ item.code }} · {{ item.fields.title }}</h3>
        <n-space><n-tag size="small">{{ t('projectRules.version', { version: item.revision }) }}</n-tag><n-tag size="small">{{ t(`projectAcceptance.kinds.${item.fields.kind}`) }}</n-tag><n-tag size="small">{{ t(item.latestCheck ? `projectAcceptance.outcomes.${item.latestCheck.outcome}` : 'projectAcceptance.notRun') }}</n-tag><n-tag v-if="item.automated" size="small" :type="automatedType(item.automated.status)">{{ t('projectAcceptance.automatedLabel') }}: {{ t(`projectAcceptance.automated.${item.automated.status}`) }}</n-tag></n-space>
        <p v-if="item.automated && ['failed', 'flaky', 'changed', 'unlinked', 'blocked'].includes(item.automated.status)" class="acceptance-text">{{ t(`projectAcceptance.automatedHint.${item.automated.status}`) }}<template v-if="item.automated.message && item.automated.status !== 'blocked'"><br>{{ item.automated.message }}</template></p>
        <p v-if="item.fields.given" class="acceptance-text"><strong>{{ t('projectAcceptance.fields.given') }}:</strong> {{ item.fields.given }}</p>
        <p class="acceptance-text"><strong>{{ t('projectAcceptance.fields.action') }}:</strong> {{ item.fields.action }}</p>
        <p class="acceptance-text"><strong>{{ t('projectAcceptance.fields.expected') }}:</strong> {{ item.fields.expected }}</p>
        <p v-if="item.fields.testRef" class="acceptance-text"><strong>{{ t('projectAcceptance.fields.testRef') }}:</strong> {{ item.fields.testRef }}</p>
        <template v-if="item.latestCheck">
          <p>{{ t('projectAcceptance.manualOwner') }} · {{ new Date(item.latestCheck.createdAt).toLocaleString() }}</p>
          <p class="acceptance-text">{{ item.latestCheck.context }}</p><p class="acceptance-text">{{ item.latestCheck.observed }}</p><p v-if="item.latestCheck.evidence" class="acceptance-text">{{ item.latestCheck.evidence }}</p>
        </template>
        <n-space>
          <n-button :disabled="!writable || saving" @click="open('case', item)">{{ t('projectAcceptance.edit') }}</n-button>
          <n-button :disabled="!writable || !suite.approved || saving" @click="open('check', item)">{{ t('projectAcceptance.record') }}</n-button>
          <n-button :disabled="saving" @click="showHistory(item)">{{ t('projectRules.history') }}</n-button>
        </n-space>
      </section>
    </template>
  </n-modal>
  <n-modal :show="editor !== null" preset="card" class="acceptance-dialog" :title="t(editor === 'case' ? 'projectAcceptance.edit' : 'projectAcceptance.record')" :closable="false" :mask-closable="false" :close-on-esc="false">
    <n-alert v-if="formError" type="error">{{ formError }}</n-alert>
    <form @submit.prevent="editor === 'case' ? saveCase() : record()">
      <template v-if="editor === 'case'">
        <p>{{ t('projectAcceptance.editHint') }}</p>
        <n-form-item :label="t('projectAcceptance.kind')"><n-select v-model:value="fields.kind" :aria-label="t('projectAcceptance.kind')" :options="options(['allowed','denied','boundary'], 'kinds')" :disabled="saving" /></n-form-item>
        <n-form-item v-for="key in fieldKeys.filter(value => value !== 'testRef')" :key="key" :label="t(`projectAcceptance.fields.${key}`)"><n-input v-model:value="fields[key]" :aria-label="t(`projectAcceptance.fields.${key}`)" :type="key === 'title' ? 'text' : 'textarea'" :maxlength="key === 'title' ? 160 : 4000" :disabled="saving" :autosize="{ minRows: 2, maxRows: 5 }" /></n-form-item>
        <n-form-item :label="t('projectAcceptance.fields.testRef')"><n-select v-model:value="fields.testRef" :aria-label="t('projectAcceptance.fields.testRef')" :options="testOptions" filterable tag clearable :placeholder="t(tests.length ? 'projectAcceptance.pickTest' : 'projectAcceptance.noTestsYet')" :disabled="saving" @update:value="fields.testRef = $event ?? ''" /></n-form-item>
        <p v-if="!tests.length">{{ t('projectAcceptance.noTestsHint') }}</p>
      </template>
      <template v-else>
        <p>{{ selected?.code }} · {{ selected?.fields.title }} · {{ t('projectRules.version', { version: selected?.revision }) }}</p>
        <p class="acceptance-text"><strong>{{ t('projectAcceptance.fields.expected') }}:</strong> {{ selected?.fields.expected }}</p>
        <p>{{ t('projectAcceptance.manualHint') }}</p>
        <n-form-item :label="t('projectAcceptance.outcome')"><n-select v-model:value="check.outcome" :aria-label="t('projectAcceptance.outcome')" :options="options(['passed','failed','blocked'], 'outcomes')" :disabled="saving" /></n-form-item>
        <n-form-item v-for="key in (['context','observed','evidence'] as const)" :key="key" :label="t(`projectAcceptance.check.${key}`)"><n-input v-model:value="check[key]" type="textarea" :aria-label="t(`projectAcceptance.check.${key}`)" :maxlength="key === 'context' ? 1000 : key === 'evidence' ? 2000 : 4000" :disabled="saving" :autosize="{ minRows: 2, maxRows: 5 }" /></n-form-item>
        <n-checkbox v-model:checked="check.confirm" :disabled="saving">{{ t('projectAcceptance.confirm') }}</n-checkbox>
      </template>
      <n-space class="acceptance-actions">
        <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!writable || (editor === 'case' ? !validCase || (!!selected && !dirty) : !validCheck)">{{ t('company.save') }}</n-button>
        <n-popconfirm v-if="dirty" @positive-click="editor = null"><template #trigger><n-button :disabled="saving">{{ t('projectBrief.close') }}</n-button></template>{{ t('projectBrief.discard') }}</n-popconfirm>
        <n-button v-else :disabled="saving" @click="editor = null">{{ t('projectBrief.close') }}</n-button>
      </n-space>
    </form>
  </n-modal>
  <n-modal :show="history !== null" preset="card" class="acceptance-dialog" :title="`${historyCode} — ${t('projectRules.history')}`" @update:show="!$event && (history = null)">
    <section v-for="revision in history?.revisions" :key="revision.revision" class="acceptance-row">
      <h3>{{ t('projectRules.version', { version: revision.revision }) }} · {{ revision.fields.title }}</h3>
      <p>{{ new Date(revision.createdAt).toLocaleString() }}</p>
      <p>{{ t(`projectAcceptance.kinds.${revision.fields.kind}`) }}</p>
      <p v-for="key in fieldKeys.filter(value => value !== 'title')" :key="key" class="acceptance-text"><strong>{{ t(`projectAcceptance.fields.${key}`) }}:</strong> {{ revision.fields[key] || t('projectRules.notSpecified') }}</p>
      <p v-if="!revision.checks.length">{{ t('projectAcceptance.notRun') }}</p>
      <section v-for="run in revision.checks" :key="run.id" class="acceptance-row">
        <strong>{{ t(`projectAcceptance.outcomes.${run.outcome}`) }}</strong>
        <p>{{ t('projectAcceptance.manualOwner') }} · {{ new Date(run.createdAt).toLocaleString() }}</p>
        <p class="acceptance-text">{{ run.context }}</p><p class="acceptance-text">{{ run.observed }}</p><p v-if="run.evidence" class="acceptance-text">{{ run.evidence }}</p>
      </section>
    </section>
  </n-modal>
</template>

<style scoped>
.acceptance-row { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.acceptance-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.acceptance-actions { margin: 16px 0; }
p { line-height: 1.6; }
</style>
<style>
.acceptance-dialog.n-card { width: min(850px, calc(100vw - 32px)); }
</style>
