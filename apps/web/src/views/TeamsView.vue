<script setup lang="ts">
// Screen 11 (company mode): teams — GitHub repository teams and company/project teams.
import type { PullRequestDto, TeamDto, TeamRepoStatusDto, TeamRole } from "@clawdesk/shared";
import { ExternalLink, FolderGit2, GitPullRequest, MessagesSquare, RefreshCw, Send, Trash2, Users } from "@lucide/vue";
import { NA, NAlert, NButton, NCard, NCheckbox, NCheckboxGroup, NEmpty, NInput, NModal, NPopconfirm, NSelect, NSkeleton, NSpace, NTag, useMessage } from "naive-ui";
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError, browserTimeZone } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";

const { t } = useI18n();
const router = useRouter();
const message = useMessage();

const teams = ref<TeamDto[] | null>(null);
const loadError = ref<string | null>(null);
const repo = reactive<Record<string, TeamRepoStatusDto | null>>({});
const busy = reactive<Record<string, string | null>>({});
const pr = reactive<Record<string, PullRequestDto | null>>({});

const KNOWN = new Set(["token_rejected", "repo_not_found", "no_push_permission", "github_unreachable", "nothing_to_push", "no_owner", "telegram_links", "git_failed", "project_executors", "telegram_group_linked"]);
const errText = (e: unknown) => (e instanceof ApiError ? (KNOWN.has(e.body.error) ? t(`teams.errors.${e.body.error}`, { detail: e.body.message }) : e.body.message) : String(e));
const ROLES: TeamRole[] = ["pm", "developer", "reviewer"];
const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";
const TOPIC_EXAMPLE = "https://t.me/c/1234567890/12";

async function load(): Promise<void> {
  try {
    teams.value = (await api.teams.list()).teams;
    loadError.value = null;
    for (const team of teams.value) {
      if (team.repoUrl) void loadRepo(team.id);
    }
  } catch (e) {
    loadError.value = errText(e);
  }
}

async function loadRepo(id: string): Promise<void> {
  repo[id] = await api.teams.repo(id).catch(() => null);
}

async function act(id: string, what: string, run: () => Promise<void>): Promise<void> {
  busy[id] = what;
  try {
    await run();
  } catch (e) {
    message.error(errText(e));
  } finally {
    busy[id] = null;
  }
}

/** Stage 8: where requests of the team's members that reach the owner arrive. */
const ownerRequestOptions = computed(() => [{ value: "direct", label: t("teams.ownerRequests.direct") }, { value: "topic", label: t("teams.ownerRequests.topic") }]);
const setOwnerRequests = (team: TeamDto, mode: "direct" | "topic") => act(team.id, "ownerRequests", async () => { await api.teams.ownerRequests(team.id, mode); team.ownerRequests = mode; });
const refresh = (id: string) => act(id, "fetch", async () => void (repo[id] = await api.teams.fetch(id)));
const push = (id: string) =>
  act(id, "push", async () => {
    pr[id] = await api.teams.push(id);
    await loadRepo(id);
  });
const remove = (id: string) =>
  act(id, "remove", async () => {
    await api.teams.remove(id);
    message.success(t("teams.removed"));
    await load();
  });

// --- New team.
const creating = ref(false);
const createError = ref<string | null>(null);
const showCreate = ref(false);
const form = reactive({ name: "", repoUrl: "", token: "", brief: "", roles: [...ROLES] as TeamRole[] });

async function create(): Promise<void> {
  creating.value = true;
  createError.value = null;
  try {
    await api.teams.create({ ...form, timezone: browserTimeZone() });
    Object.assign(form, { name: "", repoUrl: "", token: "", brief: "", roles: [...ROLES] });
    showCreate.value = false;
    message.success(t("teams.created"));
    await load();
  } catch (e) {
    createError.value = errText(e);
  } finally {
    creating.value = false;
  }
}

// --- Telegram group with one topic per role.
const linking = ref<TeamDto | null>(null);
const links = reactive<Record<string, string>>({});
const linkError = ref<string | null>(null);
const linkSaving = ref(false);
const canLink = computed(() => !!linking.value?.members.some((m) => links[m.agentId]?.trim()));

function openLink(team: TeamDto): void {
  linking.value = team;
  linkError.value = null;
  for (const m of team.members) links[m.agentId] = "";
}

async function saveLinks(): Promise<void> {
  const team = linking.value;
  if (!team) return;
  linkSaving.value = true;
  linkError.value = null;
  try {
    const topics = team.members.filter((m) => links[m.agentId]?.trim()).map((m) => ({ role: m.role, link: links[m.agentId]!.trim() }));
    await api.teams.linkTelegram(team.id, topics);
    linking.value = null;
    message.success(t("teams.telegramLinked"));
    await load();
  } catch (e) {
    linkError.value = errText(e);
  } finally {
    linkSaving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="teams-view">
    <page-header
      :title="t('teams.title')"
      :subtitle="t('teams.subtitle')"
      :breadcrumbs="[
        { label: t('company.title'), to: '/company' },
        { label: t('teams.title') },
      ]"
      :back-to="'/company'"
      :back-label="t('company.title')"
    >
      <n-space>
        <n-button key="refresh" :loading="!teams && !loadError" @click="load">
          <template #icon><refresh-cw :size="15" /></template>
          {{ t('company.refresh') }}
        </n-button>
        <n-button type="primary" @click="showCreate = !showCreate">
          <template #icon><users :size="15" /></template>
          {{ t("teams.new") }}
        </n-button>
      </n-space>
    </page-header>

    <n-space vertical size="large" class="main-content">
      <!-- Create team modal / card -->
      <n-card v-if="showCreate" :title="t('teams.new')" class="create-card">
        <form class="form" @submit.prevent="create">
          <label class="field"><span>{{ t("teams.name") }}</span><n-input v-model:value="form.name" :maxlength="60" /></label>
          <label class="field">
            <span>{{ t("teams.repoUrl") }}</span>
            <n-input v-model:value="form.repoUrl" placeholder="https://github.com/owner/repo" />
          </label>
          <label class="field">
            <span>{{ t("teams.token") }}</span>
            <n-input v-model:value="form.token" type="password" show-password-on="click" placeholder="github_pat_…" :input-props="{ autocomplete: 'off' }" />
            <small>
              {{ t("teams.tokenHint") }}
              <n-a :href="TOKEN_PAGE" target="_blank" rel="noopener noreferrer">{{ t("teams.tokenCreate") }} <external-link :size="12" /></n-a>
            </small>
          </label>
          <label class="field">
            <span>{{ t("teams.brief") }}</span>
            <n-input v-model:value="form.brief" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" :placeholder="t('teams.briefPlaceholder')" />
          </label>
          <div class="field">
            <span>{{ t("teams.roles") }}</span>
            <n-checkbox-group v-model:value="form.roles">
              <n-space>
                <n-checkbox v-for="r in ROLES" :key="r" :value="r" :label="t(`teams.role.${r}`)" />
              </n-space>
            </n-checkbox-group>
          </div>
          <n-alert type="info" :show-icon="false">{{ t("teams.howItWorks") }}</n-alert>
          <n-alert v-if="createError" type="error" :bordered="false">{{ createError }}</n-alert>
          <n-space>
            <n-button attr-type="submit" type="primary" :loading="creating" :disabled="!form.name.trim() || !form.repoUrl.trim() || !form.token.trim() || !form.roles.length">
              {{ creating ? t("teams.creating") : t("teams.create") }}
            </n-button>
            <n-button quaternary @click="showCreate = false">{{ t("teams.cancel") }}</n-button>
          </n-space>
        </form>
      </n-card>

      <n-skeleton v-if="!teams && !loadError" text :repeat="4" />
      <n-alert v-else-if="loadError" type="error">{{ loadError }}</n-alert>
      <n-empty v-else-if="!teams!.length && !showCreate" :description="t('teams.empty')" />

      <!-- Teams List -->
      <div v-for="team in teams ?? []" :key="team.id" class="team-card">
        <div class="team-card-head">
          <div class="team-title-cluster">
            <div class="team-title-row">
              <h3 class="team-name">{{ team.name }}</h3>
              <span v-if="team.repoUrl" class="team-badge github">
                <folder-git2 :size="13" />
                <span>GitHub команда</span>
              </span>
              <span v-else class="team-badge project">
                <users :size="13" />
                <span>Команда компании / проекта</span>
              </span>
            </div>
            <n-a v-if="team.repoUrl" :href="team.repoUrl" target="_blank" rel="noopener noreferrer" class="repo-link">
              {{ team.repoUrl.replace("https://github.com/", "") }} <external-link :size="12" />
            </n-a>
          </div>

          <n-popconfirm @positive-click="remove(team.id)">
            <template #trigger>
              <n-button quaternary circle type="error" :loading="busy[team.id] === 'remove'" :aria-label="t('teams.remove')">
                <trash-2 :size="15" />
              </n-button>
            </template>
            {{ t("teams.removeConfirm") }}
          </n-popconfirm>
        </div>

        <!-- Members of the team -->
        <div class="team-members-box">
          <span class="members-label">Участники команды ({{ team.members.length }}):</span>
          <div class="members-flow">
            <button
              v-for="m in team.members"
              :key="m.agentId"
              type="button"
              class="member-pill"
              @click="router.push(`/chat/${m.agentId}`)"
            >
              <span class="member-avatar">{{ m.emoji || '🤖' }}</span>
              <div class="member-text">
                <span class="member-name">{{ m.name }}</span>
                <span class="member-role">{{ t(`teams.role.${m.role}`) || t(`company.teamRoles.${m.role}`) || m.role }}</span>
              </div>
              <n-tag v-if="m.topicId" size="small" :bordered="false" type="info">TG</n-tag>
              <messages-square :size="13" class="chat-icon" />
            </button>
          </div>
        </div>

        <p v-if="team.docsFolder" class="docs-note">
          📁 {{ t("teams.docs", { folder: team.docsFolder }) }}
        </p>

        <!-- GitHub Repo Status & Branch info (only if repo exists) -->
        <div v-if="team.repoUrl" class="repo-section">
          <template v-if="repo[team.id]">
            <div class="repo-info-pill">
              <span>
                {{ t("teams.branch") }} <code>{{ repo[team.id]!.branch }}</code>:
                <strong>{{ t("teams.ahead", { n: repo[team.id]!.ahead }) }}</strong>
                <span v-if="repo[team.id]!.lastCommit" class="muted"> · {{ repo[team.id]!.lastCommit }}</span>
                <span v-if="repo[team.id]!.uncommitted" class="muted"> · {{ t("teams.uncommitted") }}</span>
              </span>
            </div>
          </template>
          <span v-else class="muted small-note">{{ t("teams.repoUnknown") }}</span>
        </div>

        <n-alert v-if="pr[team.id]" type="success" :bordered="false" class="pr-alert">
          {{ pr[team.id]!.created ? t("teams.prCreated") : t("teams.prUpdated") }}
          <n-a :href="pr[team.id]!.url" target="_blank" rel="noopener noreferrer">#{{ pr[team.id]!.number }} <external-link :size="12" /></n-a>
        </n-alert>

        <!-- Actions Row -->
        <div class="actions-row">
          <n-space align="center">
            <template v-if="team.repoUrl">
              <n-button secondary size="small" :loading="busy[team.id] === 'fetch'" @click="refresh(team.id)">
                <template #icon><refresh-cw :size="14" /></template>
                {{ t("teams.fetch") }}
              </n-button>
              <n-button type="primary" secondary size="small" :disabled="!repo[team.id]?.ahead" :loading="busy[team.id] === 'push'" @click="push(team.id)">
                <template #icon><git-pull-request :size="14" /></template>
                {{ t("teams.push") }}
              </n-button>
            </template>
            <n-button secondary size="small" @click="openLink(team)">
              <template #icon><send :size="14" /></template>
              {{ team.telegramChatId ? t("teams.telegramChange") : t("teams.telegram") }}
            </n-button>
          </n-space>

          <label v-if="team.telegramChatId" class="owner-requests-inline">
            <span class="req-label">{{ t("teams.ownerRequests.label") }}:</span>
            <n-select
              size="small"
              :value="team.ownerRequests"
              :options="ownerRequestOptions"
              :disabled="!!busy[team.id]"
              @update:value="(mode: 'direct' | 'topic') => setOwnerRequests(team, mode)"
            />
          </label>
        </div>
      </div>
    </n-space>

    <!-- Telegram Link Modal -->
    <n-modal :show="!!linking" preset="card" :title="t('teams.telegram')" style="width: min(560px, calc(100vw - 32px))" @update:show="(v: boolean) => !v && (linking = null)">
      <form v-if="linking" class="form" @submit.prevent="saveLinks">
        <ol class="steps">
          <li>{{ t("teams.tgStep1") }}</li>
          <li>{{ t("teams.tgStep2") }}</li>
          <li>{{ t("teams.tgStep3", { topics: linking.members.map((m) => t(`teams.role.${m.role}`)).join(", ") }) }}</li>
          <li>{{ t("teams.tgStep4") }}</li>
        </ol>
        <div v-for="member in linking.members" :key="member.agentId" class="field">
          <span>{{ member.emoji }} {{ t(`teams.role.${member.role}`) || member.role }} ({{ member.name }})</span>
          <n-input v-model:value="links[member.agentId]" :placeholder="TOPIC_EXAMPLE" />
        </div>
        <n-alert v-if="linkError" type="error" :bordered="false">{{ linkError }}</n-alert>
        <n-button attr-type="submit" type="primary" :loading="linkSaving" :disabled="!canLink">{{ t("teams.telegramSave") }}</n-button>
      </form>
    </n-modal>
  </div>
</template>

<style scoped>
.teams-view {
  display: flex;
  flex-direction: column;
}

.create-card {
  margin-bottom: 20px;
}

.team-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--card-shadow);
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  transition: all 0.18s ease;
}
.team-card:hover {
  border-color: var(--border-hover);
  box-shadow: var(--card-shadow);
}

.team-card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 14px;
}

.team-title-cluster {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.team-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.team-name {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--text);
}

.team-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 6px;
}
.team-badge.github {
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid transparent;
}
.team-badge.project {
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
}

.repo-link {
  font-size: 13px;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.team-members-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--surface-2);
  border-radius: 10px;
}

.members-label {
  font-size: 12px;
  color: var(--muted);
  font-weight: 500;
}

.members-flow {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.member-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
  transition: all 0.15s ease;
}
.member-pill:hover {
  border-color: var(--accent);
  background: var(--surface-hover);
  transform: translateY(-1px);
}

.member-avatar {
  font-size: 16px;
  flex-shrink: 0;
}

.member-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
}
.member-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.2;
}
.member-role {
  font-size: 11px;
  color: var(--text-2);
  font-weight: 400;
}

.chat-icon {
  color: var(--muted);
  margin-left: 2px;
}
.member-pill:hover .chat-icon {
  color: var(--accent);
}

.docs-note {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
}

.repo-section {
  font-size: 13px;
}
.repo-info-pill {
  padding: 6px 12px;
  border-radius: 6px;
  background: var(--surface-2);
  display: inline-block;
}

.actions-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--border-subtle);
}

.owner-requests-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.req-label {
  color: var(--muted);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
}
.field small {
  color: var(--muted);
  line-height: 1.5;
}
.steps {
  margin: 0;
  padding-left: 18px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}
.pr-alert {
  margin: 4px 0;
}
</style>
