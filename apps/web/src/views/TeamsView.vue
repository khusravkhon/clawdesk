<script setup lang="ts">
// Screen 11 (company mode): project teams — a GitHub repository with a PM, a developer and a reviewer.
import type { PullRequestDto, TeamDto, TeamRepoStatusDto, TeamRole } from "@clawdesk/shared";
import { ExternalLink, GitPullRequest, MessagesSquare, RefreshCw, Send, Trash2, Users } from "@lucide/vue";
import { NA, NAlert, NButton, NCard, NCheckbox, NCheckboxGroup, NEmpty, NInput, NModal, NPopconfirm, NSkeleton, NSpace, NTag, useMessage } from "naive-ui";
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

const KNOWN = new Set(["token_rejected", "repo_not_found", "no_push_permission", "github_unreachable", "nothing_to_push", "no_owner", "telegram_links", "git_failed"]);
const errText = (e: unknown) => (e instanceof ApiError ? (KNOWN.has(e.body.error) ? t(`teams.errors.${e.body.error}`, { detail: e.body.message }) : e.body.message) : String(e));
const ROLES: TeamRole[] = ["pm", "developer", "reviewer"];
const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";
const TOPIC_EXAMPLE = "https://t.me/c/1234567890/12";

async function load(): Promise<void> {
  try {
    teams.value = (await api.teams.list()).teams;
    loadError.value = null;
    for (const team of teams.value) void loadRepo(team.id);
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
const canLink = computed(() => !!linking.value?.members.some((m) => links[m.role]?.trim()));

function openLink(team: TeamDto): void {
  linking.value = team;
  linkError.value = null;
  for (const m of team.members) links[m.role] = "";
}

async function saveLinks(): Promise<void> {
  const team = linking.value;
  if (!team) return;
  linkSaving.value = true;
  linkError.value = null;
  try {
    const topics = team.members.filter((m) => links[m.role]?.trim()).map((m) => ({ role: m.role, link: links[m.role]!.trim() }));
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
  <div>
    <page-header :title="t('teams.title')" :subtitle="t('teams.subtitle')">
      <n-button type="primary" @click="showCreate = !showCreate">
        <template #icon><users :size="16" /></template>
        {{ t("teams.new") }}
      </n-button>
    </page-header>

    <n-space vertical size="large">
      <n-card v-if="showCreate" :title="t('teams.new')">
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

      <n-card v-for="team in teams ?? []" :key="team.id">
        <div class="head">
          <div>
            <h3>{{ team.name }}</h3>
            <n-a :href="team.repoUrl" target="_blank" rel="noopener noreferrer" class="muted">{{ team.repoUrl.replace("https://github.com/", "") }} <external-link :size="12" /></n-a>
          </div>
          <n-popconfirm @positive-click="remove(team.id)">
            <template #trigger>
              <n-button quaternary circle type="error" :loading="busy[team.id] === 'remove'" :aria-label="t('teams.remove')"><trash-2 :size="16" /></n-button>
            </template>
            {{ t("teams.removeConfirm") }}
          </n-popconfirm>
        </div>

        <div class="members">
          <button v-for="m in team.members" :key="m.agentId" type="button" class="member" @click="router.push(`/chat/${m.agentId}`)">
            <span>{{ m.emoji }}</span>
            <strong>{{ t(`teams.role.${m.role}`) }}</strong>
            <n-tag v-if="m.topicId" size="small" :bordered="false" type="info">Telegram</n-tag>
            <messages-square :size="14" class="muted" />
          </button>
        </div>

        <p v-if="team.docsFolder" class="muted small">{{ t("teams.docs", { folder: team.docsFolder }) }}</p>

        <div class="repo">
          <template v-if="repo[team.id]">
            <span>
              {{ t("teams.branch") }} <code>{{ repo[team.id]!.branch }}</code>:
              <strong>{{ t("teams.ahead", { n: repo[team.id]!.ahead }) }}</strong>
              <span v-if="repo[team.id]!.lastCommit" class="muted"> · {{ repo[team.id]!.lastCommit }}</span>
              <span v-if="repo[team.id]!.uncommitted" class="muted"> · {{ t("teams.uncommitted") }}</span>
            </span>
          </template>
          <span v-else class="muted">{{ t("teams.repoUnknown") }}</span>
        </div>

        <n-alert v-if="pr[team.id]" type="success" :bordered="false" class="gap">
          {{ pr[team.id]!.created ? t("teams.prCreated") : t("teams.prUpdated") }}
          <n-a :href="pr[team.id]!.url" target="_blank" rel="noopener noreferrer">#{{ pr[team.id]!.number }} <external-link :size="12" /></n-a>
        </n-alert>

        <n-space>
          <n-button secondary :loading="busy[team.id] === 'fetch'" @click="refresh(team.id)">
            <template #icon><refresh-cw :size="14" /></template>
            {{ t("teams.fetch") }}
          </n-button>
          <n-button type="primary" secondary :disabled="!repo[team.id]?.ahead" :loading="busy[team.id] === 'push'" @click="push(team.id)">
            <template #icon><git-pull-request :size="14" /></template>
            {{ t("teams.push") }}
          </n-button>
          <n-button secondary @click="openLink(team)">
            <template #icon><send :size="14" /></template>
            {{ team.telegramChatId ? t("teams.telegramChange") : t("teams.telegram") }}
          </n-button>
        </n-space>
      </n-card>
    </n-space>

    <n-modal :show="!!linking" preset="card" :title="t('teams.telegram')" style="width: min(560px, calc(100vw - 32px))" @update:show="(v: boolean) => !v && (linking = null)">
      <form v-if="linking" class="form" @submit.prevent="saveLinks">
        <ol class="steps">
          <li>{{ t("teams.tgStep1") }}</li>
          <li>{{ t("teams.tgStep2") }}</li>
          <li>{{ t("teams.tgStep3", { topics: linking.members.map((m) => t(`teams.role.${m.role}`)).join(", ") }) }}</li>
          <li>{{ t("teams.tgStep4") }}</li>
        </ol>
        <div v-for="member in linking.members" :key="member.role" class="field">
          <span>{{ member.emoji }} {{ t(`teams.role.${member.role}`) }}</span>
          <n-input v-model:value="links[member.role]" :placeholder="TOPIC_EXAMPLE" />
        </div>
        <n-alert v-if="linkError" type="error" :bordered="false">{{ linkError }}</n-alert>
        <n-button attr-type="submit" type="primary" :loading="linkSaving" :disabled="!canLink">{{ t("teams.telegramSave") }}</n-button>
      </form>
    </n-modal>
  </div>
</template>

<style scoped>
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
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}
.head h3 {
  margin: 0 0 4px;
  font-size: 17px;
}
.muted {
  color: var(--text-2);
}
.small {
  font-size: 12px;
  margin: 0 0 10px;
}
.members {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.member {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.member:hover {
  border-color: var(--accent);
}
.repo {
  margin-bottom: 12px;
  font-size: 13px;
}
.repo code {
  font-size: 12px;
}
.gap {
  margin-bottom: 12px;
}
.steps {
  margin: 0;
  padding-left: 18px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}
</style>
