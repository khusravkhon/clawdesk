<script setup lang="ts">
import type { CompanyDto, ProjectDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NEmpty, NFormItem, NInput, NModal, NPopconfirm, NSelect, NSkeleton, NSpace, NTag, useMessage } from "naive-ui";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";
import ProjectWorkspaceCard from "../components/ProjectWorkspaceCard.vue";
import ProjectBriefCard from "../components/ProjectBriefCard.vue";
import ProjectRulesCard from "../components/ProjectRulesCard.vue";
import ProjectBuilderCard from "../components/ProjectBuilderCard.vue";
import ProjectChecksCard from "../components/ProjectChecksCard.vue";

const { t, te } = useI18n();
const route = useRoute();
const router = useRouter();
const message = useMessage();
const data = ref<CompanyDto | null>(null);
const loading = ref(false);
const saving = ref(false);
const builderRefreshToken = ref(0), briefRefreshToken = ref(0);
const error = ref<string | null>(null);
const editing = ref(false);
const addingTeam = ref(false);
const pickedTeam = ref<string | null>(null);
const filter = ref<string | null>(typeof route.query.departmentId === "string" ? route.query.departmentId : null);
const draft = reactive({ id: "", requestId: "", revision: 0, name: "", description: "", departmentId: null as string | null, status: "draft" as ProjectDto["status"] });
const projectId = computed(() => typeof route.params.projectId === "string" ? route.params.projectId : null);
const project = computed(() => data.value?.projects.find((item) => item.id === projectId.value));
const departmentOptions = computed(() => (data.value?.departments ?? []).map((item) => ({ value: item.id, label: item.name, disabled: item.archived })));
const statusOptions = computed(() => ["draft", "planned", "archived"].map((value) => ({ value, label: t(`projects.status.${value}`) })));
const groups = computed(() => {
  const ids = [null, ...(data.value?.departments.map((item) => item.id) ?? [])];
  return ids.filter((id) => !filter.value || id === filter.value).map((id) => ({
    id: id ?? "company", name: data.value?.departments.find((item) => item.id === id)?.name ?? t("projects.companyLevel"),
    projects: data.value?.projects.filter((item) => item.departmentId === id) ?? [],
  })).filter((group) => group.projects.length);
});
const projectTeams = computed(() => data.value?.teams.filter((team) => team.projectId === projectId.value) ?? []);
const availableTeams = computed(() => (data.value?.teams ?? []).filter((team) => !team.projectId && (!project.value?.departmentId || !team.departmentId || team.departmentId === project.value.departmentId)).map((team) => ({ value: team.id, label: team.name })));
const canAdd = computed(() => !!project.value && project.value.status !== "archived" && !data.value?.departments.find((item) => item.id === project.value?.departmentId)?.archived);
const errorText = (e: unknown) => e instanceof ApiError && te(`company.errors.${e.body.error}`) ? t(`company.errors.${e.body.error}`) : t("company.errors.failed");

async function load(): Promise<void> {
  loading.value = true;
  try { data.value = await api.company.get(); error.value = null; }
  catch (e) { error.value = errorText(e); }
  finally { loading.value = false; }
}

function edit(item?: ProjectDto): void {
  Object.assign(draft, { id: item?.id ?? "", requestId: crypto.randomUUID(), revision: item?.revision ?? 0, name: item?.name ?? "", description: item?.description ?? "", departmentId: item ? item.departmentId : filter.value, status: item?.status ?? "draft" });
  editing.value = true;
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const body = { name: draft.name.trim(), description: draft.description.trim(), departmentId: draft.departmentId, status: draft.status };
    let id = draft.id;
    if (id) await api.company.updateProject(id, { ...body, revision: draft.revision });
    else id = (await api.company.createProject({ ...body, requestId: draft.requestId })).id;
    editing.value = false;
    message.success(t("projects.saved"));
    await load();
    builderRefreshToken.value++;
    await router.push(`/company/projects/${id}`);
  } catch (e) { message.error(errorText(e)); }
  finally { saving.value = false; }
}

async function assignTeam(id: string, target: string | null, revision: number): Promise<void> {
  saving.value = true;
  try { await api.company.assignTeamProject(id, { projectId: target, revision }); addingTeam.value = false; await load(); }
  catch (e) { message.error(errorText(e)); await load(); }
  finally { saving.value = false; }
}

async function addTeam(): Promise<void> {
  const team = data.value?.teams.find((item) => item.id === pickedTeam.value);
  if (team && projectId.value) await assignTeam(team.id, projectId.value, team.revision);
}

async function openTeamPicker(): Promise<void> {
  pickedTeam.value = null;
  await load();
  if (!error.value && canAdd.value) addingTeam.value = true;
}

watch(() => route.query.departmentId, (value) => { filter.value = typeof value === "string" ? value : null; });
onMounted(async () => {
  await load();
  if (data.value && route.query.create === "1") {
    edit();
    const query = { ...route.query }; delete query.create;
    await router.replace({ path: route.path, query });
  }
});
</script>

<template>
  <div :key="projectId ?? 'catalog'">
    <page-header :title="project?.name ?? t('projects.title')" :subtitle="data?.name">
      <n-space>
        <n-button key="company" @click="router.push(project?.departmentId ? `/company/departments/${project.departmentId}` : '/company')">{{ t('projects.toCompany') }}</n-button>
        <n-button v-if="projectId" key="catalog" @click="router.push('/company/projects')">{{ t('projects.catalog') }}</n-button>
        <n-button key="refresh" :loading="loading" :disabled="saving" @click="load">{{ t('company.refresh') }}</n-button>
        <n-button v-if="!projectId" key="create" type="primary" :disabled="!data || saving" @click="edit()">{{ t('projects.create') }}</n-button>
      </n-space>
    </page-header>
    <n-alert type="info" :bordered="false" class="block">{{ t('projects.scope') }}</n-alert>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>
    <n-skeleton v-if="loading && !data" height="180px" />
    <template v-if="data">
      <template v-if="!projectId">
        <n-form-item :label="t('projects.filter')"><n-select v-model:value="filter" :aria-label="t('projects.filter')" :options="departmentOptions.map(item => ({ ...item, disabled: false }))" clearable :placeholder="t('projects.allDepartments')" /></n-form-item>
        <n-empty v-if="!groups.length" :description="t('projects.empty')" />
        <n-card v-for="group in groups" :key="group.id" :title="group.name" class="block">
          <div v-for="item in group.projects" :key="item.id" class="project-row">
            <div><n-button text @click="router.push(`/company/projects/${item.id}`)">{{ item.name }}</n-button><p v-if="item.description" class="description">{{ item.description }}</p></div>
            <n-tag size="small">{{ t(`projects.status.${item.status}`) }}</n-tag>
          </div>
        </n-card>
      </template>
      <template v-else-if="project">
        <n-card :title="project.name" class="block">
          <template #header-extra><n-tag size="small">{{ t(`projects.status.${project.status}`) }}</n-tag></template>
          <p>{{ t('projects.owner') }}: {{ data.departments.find(item => item.id === project?.departmentId)?.name ?? t('projects.companyLevel') }}</p>
          <p v-if="project.description" class="description">{{ project.description }}</p>
          <n-button :disabled="saving" @click="edit(project)">{{ t('projects.edit') }}</n-button>
        </n-card>
        <project-builder-card :key="`builder-${project.id}`" :project-id="project.id" :disabled="!canAdd || saving" :refresh-token="builderRefreshToken" @changed="briefRefreshToken++" />
        <project-checks-card :key="`checks-${project.id}`" :project-id="project.id" :disabled="!canAdd || saving" :refresh-token="builderRefreshToken" />
        <project-brief-card :key="`brief-${project.id}`" :project-id="project.id" :disabled="!canAdd || saving" :refresh-token="briefRefreshToken" @changed="builderRefreshToken++" />
        <project-rules-card :key="`rules-${project.id}`" :project-id="project.id" :disabled="!canAdd || saving" @changed="builderRefreshToken++" />
        <project-workspace-card :key="project.id" :project-id="project.id" :disabled="!canAdd || saving" @changed="builderRefreshToken++" />
        <n-card :title="t('projects.teams')" class="block">
          <template #header-extra><n-button v-if="canAdd" text :disabled="saving || loading" @click="openTeamPicker">{{ t('projects.addTeam') }}</n-button></template>
          <n-empty v-if="!projectTeams.length" :description="t('projects.noTeams')" />
          <div v-for="team in projectTeams" :key="team.id" class="project-row">
            <span>{{ team.name }}</span>
            <n-popconfirm @positive-click="assignTeam(team.id, null, team.revision)">
              <template #trigger><n-button :disabled="saving">{{ t('projects.detach') }}</n-button></template>
              {{ t('projects.detachHint') }}
            </n-popconfirm>
          </div>
          <n-button text @click="router.push('/teams')">{{ t('company.allTeams') }}</n-button>
        </n-card>
      </template>
      <n-empty v-else :description="t('projects.notFound')" />
    </template>
    <n-modal v-model:show="editing" preset="card" :title="t(draft.id ? 'projects.edit' : 'projects.create')" class="project-editor" :mask-closable="!saving" :closable="!saving" :close-on-esc="!saving">
      <form @submit.prevent="save">
        <n-form-item :label="t('projects.name')"><n-input v-model:value="draft.name" :aria-label="t('projects.name')" :maxlength="100" :disabled="saving" /></n-form-item>
        <n-form-item :label="t('projects.description')"><n-input v-model:value="draft.description" :aria-label="t('projects.description')" type="textarea" :maxlength="4000" :disabled="saving" /></n-form-item>
        <n-form-item :label="t('projects.owner')"><n-select v-model:value="draft.departmentId" :aria-label="t('projects.owner')" :options="departmentOptions" clearable :placeholder="t('projects.companyLevel')" :disabled="saving" /></n-form-item>
        <n-form-item :label="t('projects.state')"><n-select v-model:value="draft.status" :aria-label="t('projects.state')" :options="statusOptions" :disabled="saving" /></n-form-item>
        <p>{{ t('projects.archiveHint') }}</p>
        <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!draft.name.trim()">{{ t('company.save') }}</n-button>
      </form>
    </n-modal>
    <n-modal v-model:show="addingTeam" preset="card" :title="t('projects.addTeam')" class="project-editor" :mask-closable="!saving" :closable="!saving" :close-on-esc="!saving">
      <form @submit.prevent="addTeam">
        <n-form-item :label="t('projects.selectTeam')"><n-select v-model:value="pickedTeam" :aria-label="t('projects.selectTeam')" :options="availableTeams" filterable :disabled="saving" /></n-form-item>
        <p>{{ t('projects.teamHint') }}</p>
        <n-alert v-if="!availableTeams.length" type="info" :show-icon="false">{{ t('projects.noAvailableTeams') }}</n-alert>
        <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!pickedTeam">{{ t('projects.addTeam') }}</n-button>
      </form>
    </n-modal>
  </div>
</template>

<style scoped>
.block { margin-bottom: 18px; }
.project-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.project-row:last-child { border-bottom: 0; }
.description { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2); line-height: 1.6; }
</style>
<style>
.project-editor.n-card { width: min(600px, calc(100vw - 32px)); }
</style>
