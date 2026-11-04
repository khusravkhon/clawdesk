<script setup lang="ts">
import type { ProjectWorkspaceDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NFormItem, NInput, NModal, NSelect, NSpace, NTag } from "naive-ui";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const { t, te } = useI18n();
const data = ref<ProjectWorkspaceDto | null>(null);
const error = ref<string | null>(null);
const loading = ref(false), saving = ref(false), editing = ref(false);
const mode = ref<"new" | "existing">("new");
const name = ref<string | null>("");
const requestId = ref("");
const valid = computed(() => !!name.value && /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u.test(name.value));
const explain = (e: unknown) => e instanceof ApiError && te(`company.errors.${e.body.error}`) ? t(`company.errors.${e.body.error}`) : t("company.errors.workspace_unavailable");

async function load(): Promise<void> {
  const id = props.projectId;
  loading.value = true;
  try { const result = await api.company.workspace(id); if (id === props.projectId) { data.value = result; error.value = null; } }
  catch (e) { if (id === props.projectId) error.value = explain(e); }
  finally { if (id === props.projectId) loading.value = false; }
}
function open(next: "new" | "existing"): void {
  mode.value = next; name.value = ""; requestId.value = crypto.randomUUID(); editing.value = true;
}
async function prepare(): Promise<void> {
  if (!valid.value || !name.value) return;
  saving.value = true;
  try {
    data.value = await api.company.prepareWorkspace(props.projectId, { mode: mode.value, name: name.value, requestId: requestId.value });
    error.value = null; editing.value = false;
    emit("changed");
  } catch (e) {
    error.value = explain(e);
    // A lost response may follow a successful preparation; read the actual binding before retrying.
    try { const result = await api.company.workspace(props.projectId); data.value = result; if (result.workspace) editing.value = false; } catch { /* Retain the original error and the same requestId. */ }
  } finally { saving.value = false; }
}
watch(() => props.projectId, () => { data.value = null; error.value = null; editing.value = false; void load(); }, { immediate: true });
</script>

<template>
  <n-card :title="t('projectWorkspace.title')" class="workspace-card">
    <template #header-extra><n-button text :loading="loading" :disabled="saving" @click="load">{{ t('company.refresh') }}</n-button></template>
    <p>{{ t('projectWorkspace.location') }}</p>
    <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>
    <template v-if="data">
      <p class="workspace-path">{{ t('projectWorkspace.root') }}: {{ data.rootPath }}</p>
      <template v-if="data.workspace">
        <n-tag :type="data.workspace.state === 'ready' ? 'success' : 'warning'">{{ t(`projectWorkspace.state.${data.workspace.state}`) }}</n-tag>
        <p class="workspace-path">{{ data.workspace.path }}</p>
        <p>{{ t(data.workspace.mode === 'new' ? 'projectWorkspace.created' : 'projectWorkspace.connected') }}</p>
      </template>
      <template v-else>
        <p>{{ t('projectWorkspace.empty') }}</p>
        <n-space>
          <n-button :disabled="disabled || saving || loading" @click="open('new')">{{ t('projectWorkspace.new') }}</n-button>
          <n-button :disabled="disabled || saving || loading || !data.available.length" @click="open('existing')">{{ t('projectWorkspace.existing') }}</n-button>
        </n-space>
        <p v-if="!data.available.length">{{ t('projectWorkspace.noExisting') }}</p>
        <p v-if="data.truncated">{{ t('projectWorkspace.truncated') }}</p>
      </template>
    </template>
    <p>{{ t('projectWorkspace.access') }}</p>
    <p>{{ t('projectWorkspace.backup') }}</p>
  </n-card>
  <n-modal v-model:show="editing" preset="card" class="project-editor" :title="t(mode === 'new' ? 'projectWorkspace.new' : 'projectWorkspace.existing')" :closable="!saving" :mask-closable="!saving" :close-on-esc="!saving">
    <form @submit.prevent="prepare">
      <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>
      <n-form-item :label="t('projectWorkspace.name')">
        <n-input v-if="mode === 'new'" v-model:value="name" :aria-label="t('projectWorkspace.name')" :maxlength="60" :disabled="saving" />
        <n-select v-else v-model:value="name" :aria-label="t('projectWorkspace.name')" :options="data?.available.map(value => ({ value, label: value }))" :disabled="saving" filterable />
      </n-form-item>
      <p>{{ t('projectWorkspace.nameHint') }}</p>
      <p class="workspace-path">{{ t('projectWorkspace.result') }}: {{ data?.rootPath }}/{{ name || '…' }}</p>
      <p>{{ t(mode === 'new' ? 'projectWorkspace.newPlan' : 'projectWorkspace.existingPlan') }}</p>
      <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!valid || disabled">{{ t('projectWorkspace.confirm') }}</n-button>
    </form>
  </n-modal>
</template>

<style scoped>
.workspace-card { margin-bottom: 18px; }
.workspace-path { overflow-wrap: anywhere; }
p { line-height: 1.6; }
</style>
