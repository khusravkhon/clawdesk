<script setup lang="ts">
import type { ApproveBusinessRuleRequest, BusinessRuleFields, BusinessRuleDto, BusinessRuleVersionDto, CreateBusinessRuleRequest, UpdateBusinessRuleRequest } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NEmpty, NFormItem, NInput, NModal, NPopconfirm, NSpace, NTag } from "naive-ui";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import ProjectAcceptanceDialog from "./ProjectAcceptanceDialog.vue";
import ProjectRuleAudit from "./ProjectRuleAudit.vue";

const props = defineProps<{ projectId: string; disabled: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const { t, te } = useI18n();
type Field = keyof BusinessRuleFields;
const keys: Field[] = ["title", "statement", "source", "role", "preconditions", "expectedResult", "exceptions", "allowedExample", "deniedExample", "openQuestions"];
const blank = (): BusinessRuleFields => ({ title: "", statement: "", source: "", role: "", preconditions: "", expectedResult: "", exceptions: "", allowedExample: "", deniedExample: "", openQuestions: "" });
const rules = ref<BusinessRuleDto[]>([]), loading = ref(false), saving = ref(false), loaded = ref(false);
const error = ref<string | null>(null), editorError = ref<string | null>(null);
const editing = ref(false), selected = ref<BusinessRuleDto | null>(null);
const fields = ref(blank()), initial = ref("");
const pending = ref<(CreateBusinessRuleRequest | UpdateBusinessRuleRequest) | null>(null);
const pendingApproval = ref<{ id: string; body: ApproveBusinessRuleRequest } | null>(null);
const history = ref<BusinessRuleVersionDto[] | null>(null), historyTitle = ref("");
const acceptanceRule = ref<BusinessRuleDto | null>(null);
const dirty = computed(() => JSON.stringify(fields.value) !== initial.value);
const valid = computed(() => fields.value.title.trim() && fields.value.statement.trim());
const explain = (e: unknown) => e instanceof ApiError && te(`company.errors.${e.body.error}`) ? t(`company.errors.${e.body.error}`) : t("company.errors.failed");
const complete = (rule: BusinessRuleDto) => [rule.fields.source, rule.fields.role, rule.fields.expectedResult, rule.fields.allowedExample, rule.fields.deniedExample].every(value => value.trim()) && !rule.fields.openQuestions.trim();

async function load(): Promise<void> {
  const id = props.projectId; loading.value = true;
  try { const result = await api.company.rules(id); if (id === props.projectId) { rules.value = result.rules; loaded.value = true; error.value = null; } }
  catch (e) { if (id === props.projectId) error.value = explain(e); }
  finally { if (id === props.projectId) loading.value = false; }
}
function open(rule: BusinessRuleDto | null): void {
  selected.value = rule;
  fields.value = rule ? { ...rule.fields } : blank();
  initial.value = JSON.stringify(fields.value); pending.value = null; editorError.value = null; editing.value = true;
}
/** From a conflict or a search result: the rule's editor (a new version), or its view when editing is off. */
function openById(id: string): void {
  const rule = rules.value.find(item => item.id === id);
  if (rule) props.disabled ? void showHistory(rule) : open(rule);
}
async function save(): Promise<void> {
  if (!valid.value || saving.value || props.disabled) return;
  saving.value = true;
  const content = { fields: { ...fields.value }, ...(selected.value ? { revision: selected.value.revision } : {}) };
  const before = pending.value;
  if (!before || JSON.stringify({ fields: before.fields, ...("revision" in before ? { revision: before.revision } : {}) }) !== JSON.stringify(content)) pending.value = { requestId: crypto.randomUUID(), ...content };
  try {
    if (selected.value) await api.company.updateRule(props.projectId, selected.value.id, pending.value as UpdateBusinessRuleRequest);
    else await api.company.createRule(props.projectId, pending.value!);
    editing.value = false; emit("changed"); await load();
  } catch (e) { editorError.value = explain(e); }
  finally { saving.value = false; }
}
async function approve(rule: BusinessRuleDto): Promise<void> {
  saving.value = true;
  const previous = pendingApproval.value;
  if (!previous || previous.id !== rule.id || previous.body.revision !== rule.revision || previous.body.version !== rule.version) pendingApproval.value = { id: rule.id, body: { requestId: crypto.randomUUID(), revision: rule.revision, version: rule.version, confirm: true } };
  try { await api.company.approveRule(props.projectId, rule.id, pendingApproval.value!.body); pendingApproval.value = null; emit("changed"); await load(); }
  catch (e) { const failure = explain(e); await load(); error.value = failure; }
  finally { saving.value = false; }
}
async function reloadEditing(): Promise<void> {
  if (!selected.value) return;
  saving.value = true;
  try {
    const result = await api.company.rules(props.projectId);
    rules.value = result.rules;
    const current = result.rules.find(rule => rule.id === selected.value?.id);
    if (current) open(current);
    else editorError.value = t('company.errors.rule_missing');
  } catch (e) { editorError.value = explain(e); }
  finally { saving.value = false; }
}
async function showHistory(rule: BusinessRuleDto): Promise<void> {
  saving.value = true;
  try { history.value = (await api.company.ruleHistory(props.projectId, rule.id)).versions; historyTitle.value = `${rule.code} — ${rule.fields.title}`; }
  catch (e) { error.value = explain(e); }
  finally { saving.value = false; }
}
watch(() => props.projectId, () => { rules.value = []; loaded.value = false; editing.value = false; history.value = null; void load(); }, { immediate: true });
</script>

<template>
  <n-card :title="t('projectRules.title')" class="rules-card">
    <template #header-extra><n-space><n-button text :loading="loading" :disabled="saving" @click="load">{{ t('company.refresh') }}</n-button><n-button :disabled="disabled || saving || !loaded" @click="open(null)">{{ t('projectRules.add') }}</n-button></n-space></template>
    <p>{{ t('projectRules.scope') }}</p>
    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <n-empty v-if="loaded && !rules.length" :description="t('projectRules.empty')" />
    <ProjectRuleAudit v-if="loaded && rules.length" :project-id="projectId" :disabled="disabled" :rules="rules" @open="openById" />
    <section v-for="rule in rules" :key="rule.id" class="rule-row">
      <strong>{{ rule.code }} · {{ rule.fields.title }}</strong>
      <n-space class="rule-status"><n-tag size="small">{{ t('projectRules.version', { version: rule.version }) }}</n-tag><n-tag size="small" :type="rule.approvedAt !== null ? 'success' : 'warning'">{{ t(rule.approvedAt !== null ? 'projectRules.approved' : 'projectRules.draft') }}</n-tag><n-tag size="small">{{ t('projectRules.untested') }}</n-tag></n-space>
      <p class="rule-text">{{ rule.fields.statement }}</p>
      <p v-if="rule.approvedAt !== null">{{ t('projectRules.owner') }} · {{ new Date(rule.approvedAt).toLocaleString() }}</p>
      <p v-else-if="!complete(rule)">{{ t('projectRules.incomplete') }}</p>
      <n-space>
        <n-button :disabled="disabled || saving" @click="open(rule)">{{ t('projectRules.edit') }}</n-button>
        <n-button :disabled="saving" @click="showHistory(rule)">{{ t('projectRules.history') }}</n-button>
        <n-button :disabled="saving" @click="acceptanceRule = rule">{{ t('projectAcceptance.title') }}</n-button>
        <n-popconfirm v-if="rule.approvedAt === null" @positive-click="approve(rule)">
          <template #trigger><n-button :disabled="disabled || saving || !complete(rule)">{{ t('projectRules.approve') }}</n-button></template>
          {{ t('projectRules.confirm', { code: rule.code, version: rule.version }) }}
        </n-popconfirm>
      </n-space>
    </section>
  </n-card>
  <n-modal v-model:show="editing" preset="card" class="rule-editor" :title="selected ? `${selected.code} — ${t('projectRules.edit')}` : t('projectRules.add')" :closable="false" :mask-closable="false" :close-on-esc="false">
    <p>{{ t('projectRules.editHint') }}</p>
    <n-alert v-if="editorError" type="error">{{ editorError }}</n-alert>
    <form @submit.prevent="save">
      <n-form-item v-for="key in keys" :key="key" :label="t(`projectRules.fields.${key}`)">
        <n-input v-model:value="fields[key]" :aria-label="t(`projectRules.fields.${key}`)" :type="key === 'title' ? 'text' : 'textarea'" :maxlength="key === 'title' ? 160 : 4000" :disabled="saving || disabled" :autosize="{ minRows: 2, maxRows: 5 }" />
      </n-form-item>
      <n-space>
        <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!valid || disabled || (!!selected && !dirty)">{{ t('projectRules.save') }}</n-button>
        <n-popconfirm v-if="dirty" @positive-click="editing = false"><template #trigger><n-button :disabled="saving">{{ t('projectBrief.close') }}</n-button></template>{{ t('projectBrief.discard') }}</n-popconfirm>
        <n-button v-else :disabled="saving" @click="editing = false">{{ t('projectBrief.close') }}</n-button>
        <n-popconfirm v-if="editorError && selected" @positive-click="reloadEditing"><template #trigger><n-button :disabled="saving">{{ t('projectBrief.reload') }}</n-button></template>{{ t('projectBrief.discard') }}</n-popconfirm>
      </n-space>
    </form>
  </n-modal>
  <n-modal :show="history !== null" preset="card" class="rule-editor" :title="historyTitle" @update:show="!$event && (history = null)">
    <p>{{ t('projectRules.historyHint') }}</p>
    <section v-for="version in history" :key="version.version" class="rule-row">
      <h3>{{ t('projectRules.version', { version: version.version }) }} · {{ t(version.approvedAt !== null ? 'projectRules.approved' : 'projectRules.draft') }}</h3>
      <p>{{ t('projectRules.author') }} · {{ new Date(version.createdAt).toLocaleString() }}</p>
      <p v-if="version.approvedAt !== null">{{ t('projectRules.owner') }} · {{ new Date(version.approvedAt).toLocaleString() }}</p>
      <p v-for="key in keys" :key="key" class="rule-text"><strong>{{ t(`projectRules.fields.${key}`) }}:</strong> {{ version.fields[key] || t(key === 'openQuestions' ? 'projectRules.noQuestions' : 'projectRules.notSpecified') }}</p>
    </section>
  </n-modal>
  <project-acceptance-dialog v-if="acceptanceRule" :project-id="projectId" :rule="acceptanceRule" :disabled="disabled" @close="acceptanceRule = null" />
</template>

<style scoped>
.rules-card { margin-bottom: 18px; }
.rule-row { padding: 18px 0; border-top: 1px solid var(--border); }
.rule-status { margin-top: 10px; }
.rule-text { white-space: pre-wrap; overflow-wrap: anywhere; }
p { line-height: 1.6; }
</style>
<style>
.rule-editor.n-card { width: min(800px, calc(100vw - 32px)); }
</style>
