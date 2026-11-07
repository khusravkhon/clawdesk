<script setup lang="ts">
// Stage 5: what each company agent can actually reach (read from where access is enforced), and the
// owner's grants and revocations. A change is shown as done only after the panel has checked it.
// Stage 7: a Google Doc is given as a read-only copy made with the owner's connection, refreshed on request.
import { normalizeResourceRef, ResourceRef, type AgentAccessDto, type AgentResourceDto, type CompanyAccessDto, type ResourceAccess } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NInput, NPopconfirm, NSelect, NSpace, NTag } from "naive-ui";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";

const { t, te } = useI18n();
const router = useRouter();
const data = ref<CompanyAccessDto | null>(null);
const loading = ref(false), busy = ref(false), error = ref<string | null>(null), notice = ref<string | null>(null);
const agentId = ref<string | null>(null), resource = ref<string | null>(null), level = ref<ResourceAccess>("read"), docLink = ref("");
/** The Google Doc chosen by its link (or ID), or null while the link is not a document's. */
const docRef = computed(() => { const value = normalizeResourceRef(`gdoc:${docLink.value.trim()}`); return typeof value === "string" && ResourceRef.safeParse(value).success ? value : null; });

const agentOptions = computed(() => (data.value?.agents ?? []).map((agent) => ({ value: agent.agentId, label: `${agent.name} (${agent.agentId})` })));
const resourceOptions = computed(() => [
  ...(agentId.value === "main" ? [] : (data.value?.folders ?? []).map((name) => ({ value: `folder:${name}`, label: `${t('access.kind.folder')}: ${name}` }))),
  ...(data.value?.servers ?? []).map((name) => ({ value: `mcp:${name}`, label: `${t('access.kind.mcp')}: ${name}` })),
  ...(agentId.value === "main" ? [] : [{ value: "gdoc:", label: t('access.gdocOption') }]),
]);
const levelOptions = computed(() => [{ value: "read", label: t('access.level.read') }, { value: "write", label: t('access.level.write') }]);
const explain = (e: unknown) => e instanceof ApiError && te(`access.errors.${e.body.error}`) ? t(`access.errors.${e.body.error}`) : t("access.failed");
const ref_ = (item: AgentResourceDto) => item.kind === "team-docs" ? `team-docs:${item.name}` : `${item.kind}:${item.name}`;

async function load(): Promise<void> {
  loading.value = true;
  try { data.value = await api.company.access(); error.value = null; }
  catch (e) { error.value = explain(e); }
  finally { loading.value = false; }
}
async function change(call: () => Promise<CompanyAccessDto>, done: string): Promise<void> {
  if (busy.value) return;
  busy.value = true; error.value = null; notice.value = null;
  try { data.value = await call(); notice.value = done; }
  catch (e) { error.value = explain(e); await load(); }
  finally { busy.value = false; }
}
const target = computed(() => resource.value === "gdoc:" ? docRef.value : resource.value);
const grant = () => agentId.value && target.value && change(() => api.company.grantAccess({ agentId: agentId.value!, resource: target.value!, access: target.value!.startsWith("mcp:") ? "write" : target.value!.startsWith("gdoc:") ? "read" : level.value }), t('access.granted'));
async function refresh(agent: AgentAccessDto, item: AgentResourceDto): Promise<void> {
  let changed = false;
  await change(async () => { const result = await api.company.refreshAccess({ agentId: agent.agentId, resource: `gdoc:${item.name}` }); changed = result.changed; return result; }, t('access.refreshed'));
  if (!error.value) notice.value = t(changed ? 'access.refreshedChanged' : 'access.refreshedSame');
}
const revoke = (agent: AgentAccessDto, item: AgentResourceDto) => change(() => api.company.revokeAccess({ agentId: agent.agentId, resource: ref_(item) }), t('access.revoked'));
onMounted(load);
</script>

<template>
  <div>
    <page-header :title="t('access.title')">
      <n-space>
        <n-button key="company" @click="router.push('/company')">{{ t('projects.toCompany') }}</n-button>
        <n-button key="refresh" :loading="loading" :disabled="busy" @click="load">{{ t('company.refresh') }}</n-button>
      </n-space>
    </page-header>
    <n-alert type="info" :bordered="false" class="block">{{ t('access.scope') }}</n-alert>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>
    <n-alert v-if="notice" type="success" class="block">{{ notice }}</n-alert>

    <n-card v-if="data" :title="t('access.grantTitle')" class="block">
      <n-space vertical>
        <n-select v-model:value="agentId" :options="agentOptions" :placeholder="t('access.agent')" :aria-label="t('access.agent')" :disabled="busy" @update:value="resource = null" />
        <n-select v-model:value="resource" :options="resourceOptions" :placeholder="t('access.resource')" :aria-label="t('access.resource')" :disabled="busy || !agentId" />
        <n-select v-if="resource?.startsWith('folder:')" v-model:value="level" :options="levelOptions" :aria-label="t('access.levelLabel')" :disabled="busy" />
        <p v-if="resource?.startsWith('mcp:')" class="meta">{{ t('access.mcpAll') }}</p>
        <template v-if="resource === 'gdoc:'">
          <n-input v-model:value="docLink" :placeholder="t('access.gdocLink')" :aria-label="t('access.gdocLink')" :disabled="busy" />
          <p class="meta">{{ t('access.gdocHint') }}</p>
        </template>
        <n-button type="primary" :loading="busy" :disabled="!agentId || !target" @click="grant">{{ t('access.grant') }}</n-button>
      </n-space>
    </n-card>

    <n-card v-for="agent in data?.agents ?? []" :key="agent.agentId" class="block" :title="`${agent.name} · ${agent.agentId}`">
      <template #header-extra><n-tag size="small" :type="agent.sandboxed ? 'success' : 'warning'">{{ t(agent.sandboxed ? 'access.sandboxed' : 'access.notSandboxed') }}</n-tag></template>
      <p v-if="agent.role === 'main'" class="meta">{{ t('access.mainNote') }}</p>
      <p v-else-if="!agent.sandboxed" class="meta">{{ t('access.notSandboxedNote') }}</p>
      <p v-if="!agent.resources.length" class="meta">{{ t('access.none') }}</p>
      <div v-for="item in agent.resources" :key="ref_(item)" class="row">
        <span>
          <n-tag size="small">{{ t(`access.kind.${item.kind}`) }}</n-tag>
          <strong> {{ item.title ?? item.name }}</strong> · {{ t(`access.level.${item.access}`) }}<template v-if="item.path"> · <code>{{ item.path }}</code></template>
          <template v-if="item.kind === 'gdoc'"> · {{ t('access.gdocVersion', { version: item.version ?? '—', at: new Date(item.copiedAt ?? 0).toLocaleString() }) }}</template>
          <n-tag v-if="item.state === 'error' || item.state === 'partial'" size="small" type="warning"> {{ t(`access.state.${item.state}`) }}</n-tag>
        </span>
        <n-button v-if="item.kind === 'gdoc'" size="small" :disabled="busy" @click="refresh(agent, item)">{{ t('access.refresh') }}</n-button>
        <n-popconfirm v-if="item.revocable" @positive-click="revoke(agent, item)">
          <template #trigger><n-button size="small" :disabled="busy">{{ t('access.revoke') }}</n-button></template>
          <span class="confirm">{{ t(item.kind === 'mcp' ? 'access.revokeMcp' : item.kind === 'gdoc' ? 'access.revokeGdoc' : item.kind === 'file' ? 'access.revokeFile' : 'access.revokeFolder', { name: item.title ?? item.name, agent: agent.name }) }}</span>
        </n-popconfirm>
        <span v-else class="meta">{{ t('access.viaTeam') }}</span>
      </div>
    </n-card>

    <details v-if="data?.history.length" class="block">
      <summary>{{ t('access.history') }}</summary>
      <p v-for="item in data.history" :key="item.id" class="meta">
        {{ new Date(item.createdAt).toLocaleString() }} · {{ item.agentId }} · {{ item.resource }} · {{ t(`access.level.${item.access}`) }} · {{ t('access.by', { by: item.grantedBy === 'owner' ? t('requests.owner') : item.grantedBy }) }}<template v-if="item.revokedAt"> · {{ t('access.revokedAt', { at: new Date(item.revokedAt).toLocaleString() }) }}</template>
      </p>
    </details>
    <p class="meta block">{{ t('access.limits') }}</p>
  </div>
</template>

<style scoped>
.block { margin-top: 12px; }
.meta { opacity: 0.75; font-size: 0.92em; line-height: 1.6; overflow-wrap: anywhere; }
.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
.confirm { display: inline-block; max-width: min(340px, 75vw); white-space: normal; }
code { font-size: 0.9em; }
</style>
