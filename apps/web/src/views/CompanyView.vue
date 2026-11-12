<script setup lang="ts">
import type { CompanyDto, DepartmentDto } from "@clawdesk/shared";
import {
  Activity,
  Bot,
  Building2,
  CheckSquare,
  ChevronRight,
  Cpu,
  FileText,
  FolderKanban,
  Inbox,
  Plus,
  RotateCw,
  Shield,
  Trash2,
  Users,
} from "@lucide/vue";
import { NAlert, NButton, NCard, NEmpty, NFormItem, NInput, NModal, NPopconfirm, NSelect, NSkeleton, NSpace, NSwitch, NTag, useMessage } from "naive-ui";
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

/** Stage 4: the team's lead — one of its members or a standalone agent; requests of the team reach it first. */
const leadOptions = (team: CompanyDto["teams"][number]) => [
  ...team.members.map((member) => ({ label: member.name, value: member.id })),
  ...(data.value?.agents ?? []).filter((agent) => !team.departmentId || !agent.departmentId || agent.departmentId === team.departmentId).map((agent) => ({ label: `${agent.name} · ${t("company.standaloneAgent")}`, value: agent.id })),
];
async function assignLead(id: string, agentId: string | null, revision: number): Promise<void> {
  saving.value = true;
  try { await api.company.assignTeamLead(id, { agentId, revision }); await load(); }
  catch (e) { message.error(errorText(e)); await load(); }
  finally { saving.value = false; }
}

/** Stage 3: a team without a repository, its members made from company specialist templates. */
const ROLES = ["team-lead", "marketing", "analyst", "sales", "support", "hr", "operations", "custom"] as const;
type Role = (typeof ROLES)[number];
const roleOptions = computed(() => ROLES.map((role) => ({ value: role, label: t(`company.teamRoles.${role}`) })));
const creatingTeam = ref(false);
const teamDraft = reactive({ requestId: "", name: "", context: "", projectId: null as string | null, lead: 0 as number | null, members: [] as { templateId: Role; name: string; purpose: string }[] });
const teamProjects = computed(() => (data.value?.projects ?? []).filter((project) => project.status !== "archived" && (!selectedId.value || !project.departmentId || project.departmentId === selectedId.value)).map((project) => ({ value: project.id, label: project.name })));
function newTeam(): void {
  Object.assign(teamDraft, { requestId: crypto.randomUUID(), name: "", context: "", projectId: null, lead: 0, members: [{ templateId: "team-lead", name: "", purpose: "" }, { templateId: "marketing", name: "", purpose: "" }] });
  creatingTeam.value = true;
}
async function createTeam(): Promise<void> {
  saving.value = true;
  try {
    await api.company.createTeam({ requestId: teamDraft.requestId, name: teamDraft.name.trim(), context: teamDraft.context.trim(), departmentId: selectedId.value, projectId: teamDraft.projectId, members: teamDraft.members.map((member) => ({ templateId: member.templateId, name: member.name.trim(), purpose: member.purpose.trim() })), lead: teamDraft.lead, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
    creatingTeam.value = false;
    message.success(t("company.teamCreated", { name: teamDraft.name.trim() }));
    await load();
  } catch (e) { message.error(errorText(e)); }
  finally { saving.value = false; }
}

async function removeTeam(id: string): Promise<void> {
  saving.value = true;
  try { await api.teams.remove(id); }
  catch (e) { message.error(errorText(e)); }
  finally { await load(); saving.value = false; }
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
  <div :key="selectedId ?? 'company'" class="company-view">
    <!-- Header when viewing a specific department -->
    <page-header
      v-if="selectedId"
      :key="selectedId"
      :title="selected?.name ?? t('company.department')"
      :subtitle="data?.name"
      :breadcrumbs="[
        { label: t('company.title'), to: '/company' },
        { label: selected?.name ?? t('company.department') },
      ]"
      :back-to="'/company'"
      :back-label="t('company.title')"
    >
      <n-space>
        <n-button key="refresh" :loading="loading" :disabled="saving" @click="load">
          <template #icon><rotate-cw :size="15" /></template>
          {{ t('company.refresh') }}
        </n-button>
        <n-button v-if="selected" key="edit" secondary :disabled="saving" @click="edit(selected)">
          {{ t('company.edit') }}
        </n-button>
      </n-space>
    </page-header>

    <!-- Header for Company Root -->
    <page-header
      v-else
      key="company"
      :title="t('company.title')"
      :subtitle="data?.name"
      :breadcrumbs="[{ label: t('company.title') }]"
    >
      <n-space>
        <n-button key="refresh" :loading="loading" :disabled="saving" @click="load">
          <template #icon><rotate-cw :size="15" /></template>
          {{ t('company.refresh') }}
        </n-button>
        <n-button key="create" type="primary" :disabled="!data || saving" @click="edit()">
          <template #icon><plus :size="15" /></template>
          {{ t('company.create') }}
        </n-button>
      </n-space>
    </page-header>

    <!-- Sub-navigation Pills for Company Modules -->
    <nav v-if="!selectedId" class="subnav-bar">
      <router-link to="/company" class="subnav-pill active">
        <building-2 :size="15" />
        <span>{{ t('company.structure') || 'Структура' }}</span>
      </router-link>
      <router-link to="/company/activity" class="subnav-pill">
        <activity :size="15" />
        <span>{{ t('activity.title') }}</span>
      </router-link>
      <router-link to="/company/work-items" class="subnav-pill">
        <check-square :size="15" />
        <span>{{ t('workItems.title') }}</span>
      </router-link>
      <router-link to="/company/requests" class="subnav-pill">
        <inbox :size="15" />
        <span>{{ t('requests.title') }}</span>
      </router-link>
      <router-link to="/company/documents" class="subnav-pill">
        <file-text :size="15" />
        <span>{{ t('documents.title') }}</span>
      </router-link>
      <router-link to="/company/access" class="subnav-pill">
        <shield :size="15" />
        <span>{{ t('access.title') }}</span>
      </router-link>
      <router-link to="/company/capabilities" class="subnav-pill">
        <cpu :size="15" />
        <span>{{ t('capabilities.title') }}</span>
      </router-link>
    </nav>

    <n-alert type="info" :bordered="false" class="notice">{{ t("company.scope") }}</n-alert>
    <n-alert v-if="error" type="error" class="notice">{{ error }}</n-alert>
    <n-alert v-if="data && !data.gatewayAvailable" type="warning" class="notice">{{ t("company.offline") }}</n-alert>
    <n-skeleton v-if="!data && loading" height="180px" />

    <template v-if="data">
      <!-- Main Agent Hero Section -->
      <div v-if="!selectedId" class="main-agent-hero">
        <div class="main-agent-info">
          <div class="main-agent-badge">
            <bot :size="18" class="main-agent-icon" />
            <span class="main-agent-title">{{ t('company.main') }}</span>
          </div>
          <p class="main-agent-desc">Координирует работу отделов, принимает эскалации и распределяет задачи</p>
        </div>
        <n-button secondary class="main-agent-btn" @click="router.push('/assistant')">
          {{ t('company.mainEdit') }}
          <template #icon><chevron-right :size="14" /></template>
        </n-button>
      </div>

      <n-empty v-if="!visible.length" :description="t(selectedId ? 'company.notFound' : 'company.empty')" class="notice" />

      <!-- Departments Grid -->
      <div class="departments-grid">
        <div v-for="department in visible" :key="department.id" class="department-card">
          <div class="dept-header">
            <div class="dept-title-group">
              <h3 class="dept-name">{{ department.name }}</h3>
              <n-tag v-if="department.archived" size="small" type="warning">{{ t('company.archived') }}</n-tag>
            </div>
          </div>
          <p v-if="department.description" class="dept-desc">{{ department.description }}</p>
          <div class="dept-meta">
            <div class="meta-row">
              <span class="meta-label">{{ t('company.manager') }}:</span>
              <span class="meta-val">{{ department.managerName ?? t('company.noManager') }}</span>
            </div>
            <p v-if="department.managerState !== 'ready'" class="meta-sub muted">
              {{ t(`company.managerState.${department.managerState}`) }}
            </p>
            <div class="meta-row">
              <span class="meta-label">Команды:</span>
              <span class="meta-val">{{ data.teams.filter(team => team.departmentId === department.id).length }}</span>
            </div>
          </div>
          <div class="dept-actions">
            <n-button v-if="!selectedId" secondary size="small" class="open-dept-btn" @click="router.push(`/company/departments/${department.id}`)">
              {{ t('company.open') }}
              <template #icon><chevron-right :size="14" /></template>
            </n-button>
            <n-button size="small" :disabled="saving" @click="edit(department)">
              {{ t('company.edit') }}
            </n-button>
            <n-button v-if="department.managerAgentId" size="small" quaternary @click="router.push(`/agents/${department.managerAgentId}/edit`)">
              {{ t('company.managerEdit') }}
            </n-button>
            <n-button v-if="selectedId && !department.managerAgentId && !department.archived" size="small" type="primary" :disabled="saving || !data.gatewayAvailable" @click="createAgent('manager')">
              {{ t('company.createManager') }}
            </n-button>
          </div>
        </div>
      </div>

      <!-- Projects Section -->
      <n-card class="notice projects-card" :title="t('projects.title')">
        <template #header-extra>
          <n-space align="center">
            <n-button text @click="router.push({ path: '/company/projects', query: projectsQuery })">
              {{ t('projects.catalog') }}
              <template #icon><chevron-right :size="14" /></template>
            </n-button>
            <n-button v-if="!selected?.archived" size="small" secondary @click="router.push({ path: '/company/projects', query: { ...projectsQuery, create: '1' } })">
              <template #icon><plus :size="14" /></template>
              {{ t('projects.create') }}
            </n-button>
          </n-space>
        </template>

        <n-empty v-if="!visibleProjects.length" :description="t('projects.empty')" />

        <div v-else class="company-projects-list">
          <div
            v-for="project in visibleProjects"
            :key="project.id"
            class="interactive-item company-project-row"
            @click="router.push(`/company/projects/${project.id}`)"
          >
            <div class="project-info-cluster">
              <div class="project-name-line">
                <folder-kanban :size="17" class="project-item-icon" />
                <span class="project-item-name">{{ project.name }}</span>
              </div>
              <p v-if="project.description" class="project-item-desc">{{ project.description }}</p>
            </div>
            <div class="project-status-cluster">
              <span class="status-pill" :class="project.status">
                <span class="status-dot"></span>
                {{ t(`projects.status.${project.status}`) }}
              </span>
              <chevron-right :size="16" class="row-chevron" />
            </div>
          </div>
        </div>
      </n-card>

      <!-- Teams Section -->
      <n-card class="notice" :title="t(selectedId ? 'company.teams' : 'company.unassigned')">
        <template #header-extra>
          <n-space>
            <n-button v-if="!selected?.archived" text :disabled="saving || !data.gatewayAvailable" @click="newTeam">{{ t('company.createTeam') }}</n-button>
            <n-button text @click="router.push('/teams')">{{ t('company.allTeams') }}</n-button>
          </n-space>
        </template>
        <n-empty v-if="!visibleTeams.length" :description="t('company.noTeams')" />
        <div v-for="team in visibleTeams" :key="team.id" class="team">
          <div class="team-name">
            <div class="team-header-row">
              <span class="team-label">{{ team.name }}</span>
              <span v-if="team.members?.length" class="team-members-tag">
                <users :size="12" />
                <span>{{ team.members.length }}</span>
              </span>
              <n-popconfirm v-if="team.canRemove" @positive-click="removeTeam(team.id)">
                <template #trigger>
                  <n-button quaternary circle size="tiny" type="error" :aria-label="`${t('teams.remove')} ${team.name}`" :disabled="saving || !data.gatewayAvailable">
                    <trash-2 :size="13" />
                  </n-button>
                </template>
                {{ t('company.removeTeamConfirm', { name: team.name }) }}
              </n-popconfirm>
            </div>
            <n-select size="small" :value="team.leadAgentId" :options="leadOptions(team)" clearable :placeholder="t('company.noLead')" :aria-label="t('company.teamLead', { name: team.name })" :disabled="saving" @update:value="value => assignLead(team.id, value, team.revision)" />
          </div>
          <n-select :value="team.departmentId" :options="teamOptions" clearable :placeholder="t('company.unassigned')" :aria-label="t('company.teamDepartment', { name: team.name })" :disabled="saving" @update:value="value => assign(team.id, value, team.revision)" />
        </div>
      </n-card>

      <!-- Agents Section -->
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

    <n-modal v-model:show="creatingTeam" preset="card" :title="t('company.createTeam')" class="editor" :mask-closable="!saving" :closable="!saving" :close-on-esc="!saving">
      <form @submit.prevent="createTeam">
        <p class="muted">{{ t('company.teamHint') }}</p>
        <n-form-item :label="t('company.teamName')"><n-input v-model:value="teamDraft.name" :maxlength="80" :disabled="saving" /></n-form-item>
        <n-form-item :label="t('company.teamContext')"><n-input v-model:value="teamDraft.context" type="textarea" :maxlength="2000" :autosize="{ minRows: 2, maxRows: 5 }" :placeholder="t('company.teamContextExample')" :disabled="saving" /></n-form-item>
        <n-form-item :label="t('company.teamProject')"><n-select v-model:value="teamDraft.projectId" :options="teamProjects" clearable :placeholder="t('company.noProject')" :disabled="saving" /></n-form-item>
        <h4>{{ t('company.teamMembers') }}</h4>
        <div v-for="(member, index) in teamDraft.members" :key="index" class="member-row">
          <n-select v-model:value="member.templateId" :options="roleOptions" :aria-label="t('company.teamRole')" :disabled="saving" />
          <n-input v-model:value="member.name" :maxlength="60" :placeholder="t('company.memberName')" :disabled="saving" />
          <n-input v-model:value="member.purpose" :maxlength="1000" :placeholder="t('company.memberPurpose')" :disabled="saving" />
          <n-space align="center">
            <label class="lead-pick"><input type="radio" name="lead" :checked="teamDraft.lead === index" :disabled="saving" @change="teamDraft.lead = index" /> {{ t('company.teamLeadPick') }}</label>
            <n-button v-if="teamDraft.members.length > 1" size="small" quaternary :disabled="saving" @click="teamDraft.members.splice(index, 1); teamDraft.lead = teamDraft.lead === index ? null : teamDraft.lead !== null && teamDraft.lead > index ? teamDraft.lead - 1 : teamDraft.lead">{{ t('company.removeMember') }}</n-button>
          </n-space>
        </div>
        <n-space class="block">
          <n-button v-if="teamDraft.members.length < 8" :disabled="saving" @click="teamDraft.members.push({ templateId: 'marketing', name: '', purpose: '' })">{{ t('company.addMember') }}</n-button>
          <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!teamDraft.name.trim() || !teamDraft.context.trim() || !teamDraft.members.length">{{ t('company.createTeamSubmit', { count: teamDraft.members.length }) }}</n-button>
        </n-space>
        <p class="muted">{{ t('company.teamCost') }}</p>
      </form>
    </n-modal>

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
.company-view {
  display: flex;
  flex-direction: column;
}

.notice {
  margin-bottom: 20px;
}

/* Main Agent Hero Card */
.main-agent-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--card-shadow);
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.main-agent-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.main-agent-icon {
  color: var(--accent);
}
.main-agent-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
}
.main-agent-btn {
  border-radius: 8px;
}

/* Departments Grid */
.departments-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.department-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--card-shadow);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: all 0.18s ease;
}
.department-card:hover {
  border-color: var(--border-hover);
  box-shadow: var(--card-shadow);
}

.dept-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dept-name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.dept-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.dept-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--surface-2);
  border-radius: 8px;
}
.meta-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}
.meta-label {
  color: var(--muted);
}
.meta-val {
  font-weight: 500;
  color: var(--text);
}
.meta-sub {
  margin: 0;
  font-size: 12px;
}

.dept-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: auto;
  padding-top: 4px;
}

/* Projects list on /company */
.company-projects-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.company-project-row {
  padding: 12px 16px;
}

.project-info-cluster {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.project-name-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.project-item-icon {
  color: var(--accent);
  flex-shrink: 0;
}
.project-item-name {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text);
}

.project-item-desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-status-cluster {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.row-chevron {
  color: var(--muted);
  transition: transform 0.15s ease, color 0.15s ease;
}
.company-project-row:hover .row-chevron {
  color: var(--text);
  transform: translateX(2px);
}

.team {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 260px);
  gap: 16px;
  align-items: center;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  margin-bottom: 10px;
  transition: all 0.15s ease;
}
.team:last-child {
  margin-bottom: 0;
}
.team:hover {
  border-color: var(--border-hover);
}
@media (max-width: 600px) {
  .team { grid-template-columns: 1fr; }
}

.team-name {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.team-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.team-label {
  font-weight: 600;
  font-size: 14px;
  color: var(--text);
}
.team-members-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 1px 6px;
  border-radius: 4px;
}

.member-row {
  display: grid;
  gap: 6px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.lead-pick {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 0.92em;
}

.block { margin-top: 12px; }
.description { white-space: pre-wrap; overflow-wrap: anywhere; }
.muted { color: var(--text-2); font-size: 13px; line-height: 1.6; }
</style>

<style>
.editor.n-card { width: min(560px, calc(100vw - 32px)); }
</style>
