<script setup lang="ts">
// P7: the project's folder on GitHub. A new repository (private by default) gets exactly the files of the
// confirmed plan; secrets, local databases and dependencies are left out. Later changes go to a pull
// request on a new branch. The token stays on the server and is never shown again.
import type { ProjectGitHubChangesDto, ProjectGitHubDto, ProjectGitHubPlanDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NCheckbox, NFormItem, NInput, NPopconfirm, NRadioButton, NRadioGroup, NSpace, NTag } from "naive-ui";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean; refreshToken?: number }>();
const { t, te } = useI18n();
const status = ref<ProjectGitHubDto | null>(null);
const plan = ref<ProjectGitHubPlanDto | null>(null);
const changes = ref<ProjectGitHubChangesDto | null>(null);
const loading = ref(false), busy = ref(false), error = ref<string | null>(null);
const form = ref({ token: "", owner: "", name: "", visibility: "private" as "private" | "public", confirm: false });
const pr = ref({ title: "", body: "", confirm: false });
let pending: { key: string; requestId: string } | null = null;

const explain = (e: unknown) => e instanceof ApiError && te(`projectGitHub.errors.${e.body.error}`) ? t(`projectGitHub.errors.${e.body.error}`) : t("projectGitHub.failed");
const unfinished = computed(() => status.value?.repo && status.value.step !== "pushed");
const canCreate = computed(() => !!plan.value && form.value.confirm && form.value.owner && form.value.name && (status.value?.tokenSaved || form.value.token.trim()));
function requestId(key: string): string {
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  return pending.requestId;
}
async function load(): Promise<void> {
  loading.value = true;
  try {
    status.value = await api.company.projectGitHub(props.projectId);
    if (status.value.repo && !form.value.name) Object.assign(form.value, { owner: status.value.repo.owner, name: status.value.repo.name, visibility: status.value.repo.private ? "private" : "public" });
    error.value = null;
  } catch (e) { error.value = explain(e); }
  finally { loading.value = false; }
}
async function run(call: () => Promise<unknown>): Promise<void> {
  if (busy.value || props.disabled) return;
  busy.value = true; error.value = null;
  try { await call(); pending = null; }
  catch (e) { if (e instanceof ApiError) pending = null; error.value = explain(e); }
  finally { busy.value = false; await load(); }
}
const loadPlan = () => run(async () => { plan.value = await api.company.projectGitHubPlan(props.projectId); form.value.confirm = false; });
const create = () => run(async () => {
  const body = { owner: form.value.owner.trim(), name: form.value.name.trim(), visibility: form.value.visibility, planHash: plan.value!.planHash, confirm: true as const, ...(form.value.token.trim() ? { token: form.value.token.trim() } : {}) };
  await api.company.createProjectRepo(props.projectId, { requestId: requestId(`create:${body.owner}/${body.name}:${body.planHash}`), ...body });
  form.value.token = ""; plan.value = null;
});
const loadChanges = () => run(async () => { changes.value = await api.company.projectGitHubChanges(props.projectId); pr.value.confirm = false; });
const openPr = () => run(async () => {
  await api.company.projectPullRequest(props.projectId, { requestId: requestId(`pr:${changes.value!.changesHash}`), title: pr.value.title.trim(), body: pr.value.body.trim(), changesHash: changes.value!.changesHash, confirm: true });
  changes.value = null; pr.value = { title: "", body: "", confirm: false };
});
const disconnect = () => run(async () => { await api.company.disconnectProjectGitHub(props.projectId); });
watch(() => [props.projectId, props.refreshToken], () => { pending = null; plan.value = null; changes.value = null; void load(); }, { immediate: true });
</script>

<template>
  <n-card :title="t('projectGitHub.title')" class="block">
    <template #header-extra><n-button text :loading="loading" :disabled="busy" @click="load">{{ t('company.refresh') }}</n-button></template>
    <p>{{ t('projectGitHub.intro') }}</p>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>

    <template v-if="status && status.step === 'pushed' && status.repo">
      <p><n-tag type="success" size="small">{{ t(status.repo.private ? 'projectGitHub.private' : 'projectGitHub.public') }}</n-tag> <a :href="status.repo.url" target="_blank" rel="noopener">{{ status.repo.owner }}/{{ status.repo.name }}</a> · {{ t('projectGitHub.branch', { branch: status.repo.defaultBranch }) }}</p>
      <p v-if="status.local" class="meta">{{ status.local.changes ? t('projectGitHub.changesCount', { n: status.local.changes }) : t('projectGitHub.noChanges') }}</p>
      <n-button v-if="status.local?.changes" :disabled="disabled || busy" @click="loadChanges">{{ t('projectGitHub.preparePr') }}</n-button>
      <template v-if="changes">
        <p v-for="item in changes.changes" :key="item.path" class="meta"><n-tag size="small">{{ t(`projectTasks.change.${item.change}`) }}</n-tag> {{ item.path }}</p>
        <n-form-item :label="t('projectGitHub.prTitle')" class="block"><n-input v-model:value="pr.title" :maxlength="200" :aria-label="t('projectGitHub.prTitle')" /></n-form-item>
        <n-form-item :label="t('projectGitHub.prBody')"><n-input v-model:value="pr.body" type="textarea" :maxlength="10000" :autosize="{ minRows: 2, maxRows: 6 }" :aria-label="t('projectGitHub.prBody')" /></n-form-item>
        <n-checkbox v-model:checked="pr.confirm">{{ t('projectGitHub.prConfirm') }}</n-checkbox>
        <n-space class="block"><n-button type="primary" :loading="busy" :disabled="disabled || !pr.confirm || !pr.title.trim()" @click="openPr">{{ t('projectGitHub.openPr') }}</n-button></n-space>
      </template>
      <div v-if="status.pullRequests.length" class="block">
        <h4>{{ t('projectGitHub.pullRequests') }}</h4>
        <p v-for="item in status.pullRequests" :key="item.requestId" class="meta"><a :href="item.url" target="_blank" rel="noopener">#{{ item.number }}</a> · {{ item.branch }} · {{ new Date(item.at).toLocaleString() }}</p>
      </div>
    </template>

    <template v-else-if="status">
      <n-alert v-if="status.git && !status.repo" type="warning" class="block">{{ t('projectGitHub.hasGit') }}</n-alert>
      <n-alert v-if="unfinished" type="warning" class="block">{{ t('projectGitHub.unfinished', { repo: `${status.repo!.owner}/${status.repo!.name}`, step: t(`projectGitHub.step.${status.step}`) }) }}</n-alert>
      <template v-if="!status.git || unfinished">
        <n-form-item v-if="!status.tokenSaved" :label="t('projectGitHub.token')"><n-input v-model:value="form.token" type="password" show-password-on="click" :aria-label="t('projectGitHub.token')" :placeholder="'github_pat_…'" /></n-form-item>
        <p v-else class="meta">{{ t('projectGitHub.tokenSaved') }}</p>
        <p class="meta">{{ t('projectGitHub.tokenHint') }}</p>
        <n-space>
          <n-form-item :label="t('projectGitHub.owner')"><n-input v-model:value="form.owner" :aria-label="t('projectGitHub.owner')" :disabled="!!status.repo" /></n-form-item>
          <n-form-item :label="t('projectGitHub.name')"><n-input v-model:value="form.name" :aria-label="t('projectGitHub.name')" :disabled="!!status.repo" /></n-form-item>
        </n-space>
        <n-radio-group v-model:value="form.visibility" :disabled="!!status.repo" :aria-label="t('projectGitHub.visibility')">
          <n-radio-button value="private">{{ t('projectGitHub.private') }}</n-radio-button>
          <n-radio-button value="public">{{ t('projectGitHub.public') }}</n-radio-button>
        </n-radio-group>
        <n-space class="block"><n-button :loading="busy && !plan" :disabled="disabled || busy" @click="loadPlan">{{ t('projectGitHub.showPlan') }}</n-button></n-space>
        <template v-if="plan">
          <h4 class="block">{{ t('projectGitHub.planFiles', { n: plan.files.length }) }}</h4>
          <p v-for="file in plan.files" :key="file.path" class="meta">{{ file.path }}</p>
          <p v-if="plan.addGitignore" class="meta">+ .gitignore ({{ t('projectGitHub.gitignore') }})</p>
          <template v-if="plan.excluded.length">
            <h4 class="block">{{ t('projectGitHub.excluded') }}</h4>
            <p v-for="item in plan.excluded" :key="item.path" class="meta"><n-tag size="small" :type="item.reason === 'looks_like_secret' ? 'error' : 'default'">{{ t(`projectGitHub.reason.${item.reason}`) }}</n-tag> {{ item.path }}</p>
          </template>
          <n-checkbox v-model:checked="form.confirm" class="block">{{ t('projectGitHub.confirm', { repo: `${form.owner}/${form.name}`, visibility: t(form.visibility === 'private' ? 'projectGitHub.private' : 'projectGitHub.public') }) }}</n-checkbox>
          <n-space class="block"><n-button type="primary" :loading="busy" :disabled="disabled || !canCreate" @click="create">{{ t(unfinished ? 'projectGitHub.continue' : 'projectGitHub.create') }}</n-button></n-space>
        </template>
      </template>
    </template>

    <n-space v-if="status?.tokenSaved" class="block">
      <n-popconfirm @positive-click="disconnect">
        <template #trigger><n-button quaternary size="small" :disabled="busy">{{ t('projectGitHub.disconnect') }}</n-button></template>
        <span class="confirm">{{ t('projectGitHub.disconnectConfirm') }}</span>
      </n-popconfirm>
    </n-space>
    <p class="meta block">{{ t('projectGitHub.limits') }}</p>
  </n-card>
</template>

<style scoped>
.block { margin-top: 12px; }
.meta { opacity: 0.75; font-size: 0.92em; line-height: 1.6; overflow-wrap: anywhere; }
.confirm { display: inline-block; max-width: min(340px, 75vw); white-space: normal; }
h4 { margin: 0 0 6px; }
</style>
