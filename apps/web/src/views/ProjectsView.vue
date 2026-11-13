<script setup lang="ts">
import type { CompanyDto, ProjectDto, ProjectImportDto } from "@clawdesk/shared";
import { ChevronRight, FolderKanban, Plus, RotateCw, Upload } from "@lucide/vue";
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
import ProjectTasksCard from "../components/ProjectTasksCard.vue";
import ProjectGitHubCard from "../components/ProjectGitHubCard.vue";
import ProjectTransferCard from "../components/ProjectTransferCard.vue";

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

/** P8: a project carried here from another installation as a .clawdesk-project file. */
const packageInput = ref<HTMLInputElement | null>(null), importing = ref(false), imported = ref<ProjectImportDto | null>(null);
const pickPackage = () => packageInput.value?.click();
async function importPackage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement, chosen = input.files?.[0];
  input.value = "";
  if (!chosen) return;
  importing.value = true; error.value = null; imported.value = null;
  try {
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    imported.value = await api.company.importProject({ data: btoa(binary) });
    await load();
    if (imported.value.state === "imported") await router.push(`/company/projects/${imported.value.projectId}`);
  } catch (e) { error.value = e instanceof ApiError && te(`projectTransfer.errors.${e.body.error}`) ? t(`projectTransfer.errors.${e.body.error}`) : t("projectTransfer.failed"); }
  finally { importing.value = false; }
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
  <div :key="projectId ?? 'catalog'" class="projects-view">
    <!-- Header for Single Project -->
    <page-header
      v-if="project"
      :title="project.name"
      :subtitle="data?.name"
      :breadcrumbs="[
        { label: t('company.title'), to: '/company' },
        { label: t('projects.title'), to: '/company/projects' },
        { label: project.name },
      ]"
      :back-to="'/company/projects'"
      :back-label="t('projects.catalog')"
    >
      <n-space>
        <n-button key="refresh" :loading="loading" :disabled="saving" @click="load">
          <template #icon><rotate-cw :size="15" /></template>
          {{ t('company.refresh') }}
        </n-button>
        <n-button key="edit" secondary :disabled="saving" @click="edit(project)">
          {{ t('projects.edit') }}
        </n-button>
      </n-space>
    </page-header>

    <!-- Header for Projects Catalog -->
    <page-header
      v-else
      :title="t('projects.title')"
      :subtitle="data?.name"
      :breadcrumbs="[
        { label: t('company.title'), to: '/company' },
        { label: t('projects.title') },
      ]"
      :back-to="'/company'"
      :back-label="t('company.title')"
    >
      <n-space>
        <n-button key="refresh" :loading="loading" :disabled="saving" @click="load">
          <template #icon><rotate-cw :size="15" /></template>
          {{ t('company.refresh') }}
        </n-button>
        <n-button key="import" :loading="importing" :disabled="!data || saving" @click="pickPackage">
          <template #icon><upload :size="15" /></template>
          {{ t('projectTransfer.import') }}
        </n-button>
        <n-button key="create" type="primary" :disabled="!data || saving" @click="edit()">
          <template #icon><plus :size="15" /></template>
          {{ t('projects.create') }}
        </n-button>
      </n-space>
    </page-header>

    <input ref="packageInput" type="file" accept=".clawdesk-project,application/gzip" class="hidden-input" @change="importPackage" />
    <n-alert type="info" :bordered="false" class="block">{{ t('projects.scope') }}</n-alert>
    <n-alert v-if="imported" :type="imported.state === 'imported' ? 'success' : 'warning'" class="block">{{ t(imported.state === 'imported' ? (imported.repeated ? 'projectTransfer.importedAgain' : 'projectTransfer.imported') : 'projectTransfer.importFolderFailed', { name: imported.name, folder: imported.folder ?? '—', files: imported.files, rules: imported.rules }) }}</n-alert>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>
    <n-skeleton v-if="loading && !data" height="180px" />

    <template v-if="data">
      <!-- Catalog list -->
      <template v-if="!projectId">
        <div class="filter-bar">
          <n-form-item :label="t('projects.filter')" class="filter-item">
            <n-select
              v-model:value="filter"
              :aria-label="t('projects.filter')"
              :options="departmentOptions.map(item => ({ ...item, disabled: false }))"
              clearable
              :placeholder="t('projects.allDepartments')"
            />
          </n-form-item>
        </div>

        <n-empty v-if="!groups.length" :description="t('projects.empty')">
          <template #extra><n-button size="small" round :disabled="!data || saving" @click="edit()">{{ t("projects.create") }}</n-button></template>
        </n-empty>

        <div v-for="group in groups" :key="group.id" class="group-section">
          <div class="group-title-row">
            <span class="group-name">{{ group.name }}</span>
            <span class="group-count">{{ group.projects.length }}</span>
          </div>

          <div class="projects-grid">
            <div
              v-for="item in group.projects"
              :key="item.id"
              class="project-tile"
              @click="router.push(`/company/projects/${item.id}`)"
            >
              <div class="tile-top">
                <div class="tile-title-row">
                  <folder-kanban :size="18" class="tile-icon" />
                  <span class="tile-title">{{ item.name }}</span>
                </div>
                <span class="status-pill" :class="item.status">
                  <span class="status-dot"></span>
                  {{ t(`projects.status.${item.status}`) }}
                </span>
              </div>
              <p v-if="item.description" class="tile-desc">{{ item.description }}</p>
              <div class="tile-footer">
                <span class="open-action">
                  <span>Открыть проект</span>
                  <chevron-right :size="14" />
                </span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Single Project View -->
      <template v-else-if="project">
        <n-card class="block project-card-overview">
          <div class="project-hero">
            <div class="project-hero-main">
              <div class="project-hero-title">
                <h2>{{ project.name }}</h2>
                <span class="status-pill" :class="project.status">
                  <span class="status-dot"></span>
                  {{ t(`projects.status.${project.status}`) }}
                </span>
              </div>
              <p class="owner-line">
                <span class="owner-label">{{ t('projects.owner') }}:</span>
                <span class="owner-val">{{ data.departments.find(item => item.id === project?.departmentId)?.name ?? t('projects.companyLevel') }}</span>
              </p>
              <p v-if="project.description" class="description">{{ project.description }}</p>
            </div>
            <div class="project-hero-actions">
              <n-button secondary :disabled="saving" @click="edit(project)">{{ t('projects.edit') }}</n-button>
            </div>
          </div>
        </n-card>

        <project-builder-card :key="`builder-${project.id}`" :project-id="project.id" :disabled="!canAdd || saving" :refresh-token="builderRefreshToken" @changed="briefRefreshToken++" />
        <project-checks-card :key="`checks-${project.id}`" :project-id="project.id" :disabled="!canAdd || saving" :refresh-token="builderRefreshToken" />
        <project-tasks-card :key="`tasks-${project.id}`" :project-id="project.id" :disabled="!canAdd || saving" :refresh-token="builderRefreshToken" @changed="builderRefreshToken++" />
        <project-git-hub-card :key="`github-${project.id}`" :project-id="project.id" :disabled="!canAdd || saving" :refresh-token="builderRefreshToken" />
        <project-brief-card :key="`brief-${project.id}`" :project-id="project.id" :disabled="!canAdd || saving" :refresh-token="briefRefreshToken" @changed="builderRefreshToken++" />
        <project-rules-card :key="`rules-${project.id}`" :project-id="project.id" :disabled="!canAdd || saving" @changed="builderRefreshToken++" />
        <project-workspace-card :key="project.id" :project-id="project.id" :disabled="!canAdd || saving" @changed="builderRefreshToken++" />
        <project-transfer-card :key="`transfer-${project.id}`" :project-id="project.id" />

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
        <p class="muted">{{ t('projects.archiveHint') }}</p>
        <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!draft.name.trim()">{{ t('company.save') }}</n-button>
      </form>
    </n-modal>

    <n-modal v-model:show="addingTeam" preset="card" :title="t('projects.addTeam')" class="project-editor" :mask-closable="!saving" :closable="!saving" :close-on-esc="!saving">
      <form @submit.prevent="addTeam">
        <n-form-item :label="t('projects.selectTeam')"><n-select v-model:value="pickedTeam" :aria-label="t('projects.selectTeam')" :options="availableTeams" filterable :disabled="saving" /></n-form-item>
        <p class="muted">{{ t('projects.teamHint') }}</p>
        <n-alert v-if="!availableTeams.length" type="info" :show-icon="false">{{ t('projects.noAvailableTeams') }}</n-alert>
        <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!pickedTeam">{{ t('projects.addTeam') }}</n-button>
      </form>
    </n-modal>
  </div>
</template>

<style scoped>
.hidden-input { display: none; }
.block { margin-bottom: 20px; }

.filter-bar {
  margin-bottom: 16px;
  max-width: 320px;
}
.filter-item {
  margin-bottom: 0;
}

.group-section {
  margin-bottom: 28px;
}

.group-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.group-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.group-count {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 9999px;
  background: var(--surface-2);
  color: var(--text-2);
}

.projects-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.project-tile {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--card-shadow);
  padding: 16px 18px;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.project-tile:hover {
  background: var(--surface-hover);
  border-color: var(--border-hover);
  transform: translateY(-2px);
  box-shadow: var(--card-shadow);
}

.tile-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.tile-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tile-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.tile-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tile-footer {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
}

.open-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  color: var(--text-2);
  font-weight: 500;
  transition: color 0.15s ease;
}
.project-tile:hover .open-action {
  color: var(--accent-hover, var(--accent));
}

.project-card-overview {
  background: var(--surface);
  border-radius: 14px;
}

.project-hero {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  flex-wrap: wrap;
}

.project-hero-main {
  flex: 1;
  min-width: 260px;
}

.project-hero-title {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.project-hero-title h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.owner-line {
  margin: 0 0 10px;
  font-size: 13.5px;
  color: var(--text-2);
}
.owner-label {
  margin-right: 6px;
  color: var(--muted);
}
.owner-val {
  font-weight: 500;
  color: var(--text);
}

.project-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.project-row:last-child {
  border-bottom: 0;
}

.description {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text-2);
  line-height: 1.6;
}
.muted {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
}
</style>
<style>
.project-editor.n-card { width: min(600px, calc(100vw - 32px)); }
</style>
