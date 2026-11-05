<script setup lang="ts">
import type { CompanyDto, DepartmentDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NEmpty, NFormItem, NInput, NModal, NSelect, NSkeleton, NSpace, NSwitch, NTag, useMessage } from "naive-ui";
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";

const { t, te } = useI18n();
const route = useRoute();
const router = useRouter();
const message = useMessage();
const data = ref<CompanyDto | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const saving = ref(false);
const editing = ref(false);
const addingAgent = ref(false);
const pickedAgent = ref<string | null>(null);
const draft = reactive({ id: "", requestId: "", revision: 0, name: "", description: "", managerAgentId: null as string | null, archived: false });
const selectedId = computed(() => typeof route.params.departmentId === "string" ? route.params.departmentId : null);
const selected = computed(() => data.value?.departments.find((department) => department.id === selectedId.value));
const visible = computed(() => selectedId.value ? (selected.value ? [selected.value] : []) : data.value?.departments ?? []);
const managers = computed(() => (data.value?.managers ?? []).filter((manager) => !manager.departmentId || manager.departmentId === draft.id).map((manager) => ({ label: manager.name, value: manager.id })));
const teamOptions = computed(() => (data.value?.departments ?? []).map((department) => ({ label: department.name, value: department.id, disabled: department.archived })));
const visibleTeams = computed(() => (data.value?.teams ?? []).filter((team) => selectedId.value ? team.departmentId === selectedId.value : team.departmentId === null));
const visibleAgents = computed(() => (data.value?.agents ?? []).filter((agent) => agent.departmentId === selectedId.value));
const visibleProjects = computed(() => (data.value?.projects ?? []).filter((project) => !selectedId.value || project.departmentId === selectedId.value));
const projectsQuery = computed(() => selectedId.value ? { departmentId: selectedId.value } : {});
const agentOptions = computed(() => (data.value?.agents ?? []).filter((agent) => agent.available && !agent.managerOf && agent.departmentId !== selectedId.value).map((agent) => ({
  value: agent.id, label: `${agent.name} — ${data.value?.departments.find((department) => department.id === agent.departmentId)?.name ?? t('company.companyLevel')}`,
})));
const errorText = (e: unknown) => {
  if (e instanceof ApiError && te(`company.errors.${e.body.error}`)) return t(`company.errors.${e.body.error}`);
  return t("company.errors.failed");
};

async function load(): Promise<void> {
  loading.value = true;
  try { data.value = await api.company.get(); error.value = null; }
  catch (e) { error.value = errorText(e); }
  finally { loading.value = false; }
}

function edit(department?: DepartmentDto): void {
  Object.assign(draft, { id: department?.id ?? "", requestId: crypto.randomUUID(), revision: department?.revision ?? 0, name: department?.name ?? "", description: department?.description ?? "", managerAgentId: department?.managerAgentId ?? null, archived: department?.archived ?? false });
  editing.value = true;
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const body = { name: draft.name.trim(), description: draft.description.trim(), managerAgentId: draft.managerAgentId, archived: draft.archived };
    if (draft.id) await api.company.update(draft.id, { ...body, revision: draft.revision });
    else await api.company.create({ ...body, requestId: draft.requestId });
    editing.value = false;
    message.success(t("company.saved"));
    await load();
  } catch (e) { message.error(errorText(e)); }
  finally { saving.value = false; }
}

async function assign(id: string, departmentId: string | null, revision: number): Promise<void> {
  saving.value = true;
  try { await api.company.assignTeam(id, { departmentId, revision }); await load(); }
  catch (e) { message.error(errorText(e)); await load(); }
  finally { saving.value = false; }
}

async function assignAgent(id: string, departmentId: string | null, revision: number): Promise<void> {
  saving.value = true;
  try { await api.company.assignAgent(id, { departmentId, revision }); addingAgent.value = false; await load(); }
  catch (e) { message.error(errorText(e)); await load(); }
  finally { saving.value = false; }
}

function createAgent(role: "manager" | "member"): void {
  if (!selected.value || selected.value.archived) return;
  void router.push({ path: "/agents/new", query: { departmentId: selected.value.id, assignment: role } });
}

async function addAgent(): Promise<void> {
  const agent = data.value?.agents.find((item) => item.id === pickedAgent.value);
  if (!agent || !selected.value) return;
  await assignAgent(agent.id, selected.value.id, agent.revision);
}

onMounted(load);
</script>

<template>
  <div :key="selectedId ?? 'company'">
    <page-header :key="selectedId ?? 'company'" :title="selected?.name ?? (selectedId ? t('company.department') : t('company.title'))" :subtitle="data?.name">
      <n-space>
        <n-button v-if="selectedId" key="back" @click="router.push('/company')">{{ t('company.back') }}</n-button>
        <n-button key="refresh" :loading="loading" :disabled="saving" @click="load">{{ t('company.refresh') }}</n-button>
        <n-button v-if="!selectedId" key="requests" @click="router.push('/company/requests')">{{ t('requests.title') }}</n-button>
        <n-button v-if="!selectedId" key="create" type="primary" :disabled="!data || saving" @click="edit()">{{ t('company.create') }}</n-button>
      </n-space>
    </page-header>
    <n-alert type="info" :bordered="false" class="notice">{{ t("company.scope") }}</n-alert>
    <n-alert v-if="error" type="error" class="notice">{{ error }}</n-alert>
    <n-alert v-if="data && !data.gatewayAvailable" type="warning" class="notice">{{ t("company.offline") }}</n-alert>
    <n-skeleton v-if="!data && loading" height="180px" />
    <template v-if="data">
      <n-card v-if="!selectedId" class="notice" :title="t('company.main')">
        <n-button secondary @click="router.push('/assistant')">{{ t('company.mainEdit') }}</n-button>
      </n-card>
      <n-empty v-if="!visible.length" :description="t(selectedId ? 'company.notFound' : 'company.empty')" class="notice" />
      <div class="departments">
        <n-card v-for="department in visible" :key="department.id" :title="department.name">
          <template #header-extra><n-tag v-if="department.archived" size="small">{{ t('company.archived') }}</n-tag></template>
          <p v-if="department.description" class="description">{{ department.description }}</p>
          <p>{{ t('company.manager') }}: {{ department.managerName ?? t('company.noManager') }}</p>
          <p v-if="department.managerState !== 'ready'" class="muted">{{ t(`company.managerState.${department.managerState}`) }}</p>
          <p>{{ t('company.teamCount', { count: data.teams.filter(team => team.departmentId === department.id).length }) }}</p>
          <n-space>
            <n-button v-if="!selectedId" key="open" secondary @click="router.push(`/company/departments/${department.id}`)">{{ t('company.open') }}</n-button>
            <n-button key="edit" :disabled="saving" @click="edit(department)">{{ t('company.edit') }}</n-button>
            <n-button v-if="department.managerAgentId" key="manager" quaternary @click="router.push(`/agents/${department.managerAgentId}/edit`)">{{ t('company.managerEdit') }}</n-button>
            <n-button v-if="selectedId && !department.managerAgentId && !department.archived" key="new-manager" :disabled="saving || !data.gatewayAvailable" @click="createAgent('manager')">{{ t('company.createManager') }}</n-button>
          </n-space>
        </n-card>
      </div>
      <n-card class="notice" :title="t('projects.title')">
        <template #header-extra>
          <n-space>
            <n-button text @click="router.push({ path: '/company/projects', query: projectsQuery })">{{ t('projects.catalog') }}</n-button>
            <n-button v-if="!selected?.archived" text @click="router.push({ path: '/company/projects', query: { ...projectsQuery, create: '1' } })">{{ t('projects.create') }}</n-button>
          </n-space>
        </template>
        <n-empty v-if="!visibleProjects.length" :description="t('projects.empty')" />
        <div v-for="project in visibleProjects" :key="project.id" class="team">
          <n-button text @click="router.push(`/company/projects/${project.id}`)">{{ project.name }}</n-button>
          <n-tag size="small">{{ t(`projects.status.${project.status}`) }}</n-tag>
        </div>
      </n-card>
      <n-card class="notice" :title="t(selectedId ? 'company.teams' : 'company.unassigned')">
        <template #header-extra><n-button text @click="router.push('/teams')">{{ t('company.allTeams') }}</n-button></template>
        <n-empty v-if="!visibleTeams.length" :description="t('company.noTeams')" />
        <div v-for="team in visibleTeams" :key="team.id" class="team">
          <span>{{ team.name }}</span>
          <n-select :value="team.departmentId" :options="teamOptions" clearable :placeholder="t('company.unassigned')" :aria-label="t('company.teamDepartment', { name: team.name })" :disabled="saving" @update:value="value => assign(team.id, value, team.revision)" />
        </div>
      </n-card>
      <n-card class="notice" :title="t(selectedId ? 'company.departmentAgents' : 'company.independentAgents')">
        <template #header-extra>
          <n-space v-if="selected && !selected.archived">
            <n-button text :disabled="saving || !data.gatewayAvailable" @click="pickedAgent = null; addingAgent = true">{{ t('company.addExistingAgent') }}</n-button>
            <n-button text :disabled="saving || !data.gatewayAvailable" @click="createAgent('member')">{{ t('company.createAgent') }}</n-button>
          </n-space>
        </template>
        <n-empty v-if="!visibleAgents.length" :description="t('company.noAgents')" />
        <div v-for="agent in visibleAgents" :key="agent.id" class="team">
          <n-space align="center">
            <n-button text @click="router.push(`/agents/${agent.id}/edit`)">{{ agent.name }}</n-button>
            <n-tag v-if="agent.managerOf" size="small">{{ t('company.manager') }}</n-tag>
            <n-tag v-if="!agent.available" size="small" type="warning">{{ t('company.agentUnavailable') }}</n-tag>
          </n-space>
          <n-select :value="agent.departmentId" :options="teamOptions" clearable :placeholder="t('company.companyLevel')" :aria-label="t('company.agentDepartment', { name: agent.name })" :disabled="saving || !!agent.managerOf" @update:value="value => assignAgent(agent.id, value, agent.revision)" />
        </div>
        <p v-if="visibleAgents.some(agent => agent.managerOf)" class="muted">{{ t('company.managerMoveHint') }}</p>
      </n-card>
    </template>
    <n-modal v-model:show="addingAgent" preset="card" :title="t('company.addExistingAgent')" class="editor" :mask-closable="!saving" :closable="!saving" :close-on-esc="!saving">
      <form @submit.prevent="addAgent">
        <n-form-item :label="t('company.selectAgent')"><n-select v-model:value="pickedAgent" :aria-label="t('company.selectAgent')" :options="agentOptions" filterable :disabled="saving" /></n-form-item>
        <p class="muted">{{ t('company.memberHint') }}</p>
        <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!pickedAgent">{{ t('company.addExistingAgent') }}</n-button>
      </form>
    </n-modal>
    <n-modal v-model:show="editing" preset="card" :title="t(draft.id ? 'company.edit' : 'company.create')" class="editor" :mask-closable="!saving" :closable="!saving" :close-on-esc="!saving">
      <form @submit.prevent="save">
        <n-form-item :label="t('company.name')"><n-input v-model:value="draft.name" :aria-label="t('company.name')" :maxlength="80" :disabled="saving" /></n-form-item>
        <n-form-item :label="t('company.description')"><n-input v-model:value="draft.description" :aria-label="t('company.description')" type="textarea" :maxlength="2000" :disabled="saving" /></n-form-item>
        <n-form-item :label="t('company.manager')"><n-select v-model:value="draft.managerAgentId" :aria-label="t('company.manager')" :options="managers" clearable filterable :placeholder="t('company.noManager')" :disabled="saving || !data?.gatewayAvailable || draft.archived" /></n-form-item>
        <p v-if="draft.managerAgentId && !managers.some(manager => manager.value === draft.managerAgentId)" class="muted">{{ t('company.retainedManager') }}</p>
        <p class="muted">{{ t('company.managerHint') }} {{ t('company.managerCreationHint') }}</p>
        <n-form-item v-if="draft.id" :label="t('company.archived')"><n-switch v-model:value="draft.archived" :disabled="saving" /></n-form-item>
        <p v-if="draft.archived" class="muted">{{ t('company.archiveHint') }}</p>
        <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!draft.name.trim()">{{ t('company.save') }}</n-button>
      </form>
    </n-modal>
  </div>
</template>

<style scoped>
.notice { margin-bottom: 18px; }
.departments { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 16px; margin-bottom: 18px; }
.description { white-space: pre-wrap; overflow-wrap: anywhere; }
.muted { color: var(--text-2); font-size: 13px; line-height: 1.6; }
.team { display: grid; grid-template-columns: minmax(0, 1fr) minmax(160px, 300px); gap: 12px; align-items: center; padding: 12px 0; }
@media (max-width: 600px) { .team { grid-template-columns: 1fr; } }
</style>

<style>
.editor.n-card { width: min(560px, calc(100vw - 32px)); }
</style>
