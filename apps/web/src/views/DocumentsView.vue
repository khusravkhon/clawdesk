<script setup lang="ts">
// «Документы»: the owner's files for agents without any connection. A file comes here from the bot in Telegram,
// from the chat (the main agent saves it into «Входящие») or from this page; one file goes to one agent as a
// read-only copy with what the owner wants done with it. The copy is checked before it is shown as given.
import type { OwnerFileDto, OwnerFileGrantDto, OwnerFilesDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NEmpty, NInput, NModal, NPopconfirm, NSelect, NSpace } from "naive-ui";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";
import { formatBytes, formatDateTime } from "../format";

const MAX_BYTES = 20 * 1024 * 1024;
const { t, te, locale } = useI18n();
const router = useRouter();
const data = ref<OwnerFilesDto | null>(null);
const loading = ref(false), busy = ref(false), error = ref<string | null>(null), notice = ref<string | null>(null);
const picker = ref<HTMLInputElement | null>(null);
const sharing = ref<OwnerFileDto | null>(null);
const agentId = ref<string | null>(null), instruction = ref("");

const agentOptions = computed(() => (data.value?.agents ?? []).map((agent) => ({ value: agent.agentId, label: `${agent.name} (${agent.agentId})` })));
const givenOf = (file: string) => (data.value?.given ?? []).filter((item) => item.file === file);
const explain = (e: unknown) => e instanceof ApiError && te(`documents.errors.${e.body.error}`) ? t(`documents.errors.${e.body.error}`) : e instanceof ApiError && te(`access.errors.${e.body.error}`) ? t(`access.errors.${e.body.error}`) : t("documents.failed");
const fileName = (file: string) => file.split("/").at(-1) ?? file;
const folderOf = (file: string) => (file.includes("/") ? file.split("/")[0] : "");

async function load(): Promise<void> {
  loading.value = true;
  try { data.value = await api.company.documents(); error.value = null; }
  catch (e) { error.value = explain(e); }
  finally { loading.value = false; }
}

async function act(call: () => Promise<OwnerFilesDto>, done: string): Promise<boolean> {
  if (busy.value) return false;
  busy.value = true; error.value = null; notice.value = null;
  try { data.value = await call(); notice.value = done; return true; }
  catch (e) { error.value = explain(e); await load(); return false; }
  finally { busy.value = false; }
}

async function upload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > MAX_BYTES) { error.value = t("documents.errors.file_too_large"); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await act(() => api.company.uploadDocument(file.name, btoa(binary)), t("documents.uploaded", { name: file.name }));
}

function openShare(file: OwnerFileDto): void {
  sharing.value = file; agentId.value = null; instruction.value = "";
}

async function share(): Promise<void> {
  const file = sharing.value;
  if (!file || !agentId.value || !instruction.value.trim()) return;
  const agent = data.value?.agents.find((item) => item.agentId === agentId.value)?.name ?? agentId.value;
  if (await act(() => api.company.shareDocument({ agentId: agentId.value!, file: file.path, instruction: instruction.value.trim() }), t("documents.shared", { name: fileName(file.path), agent }))) sharing.value = null;
}

const revoke = (item: OwnerFileGrantDto) => act(async () => { await api.company.revokeAccess({ agentId: item.agentId, resource: `file:${item.file}` }); return api.company.documents(); }, t("documents.revoked", { name: fileName(item.file), agent: item.agentName }));

onMounted(load);
</script>

<template>
  <div>
    <page-header
      :title="t('documents.title')"
      :subtitle="t('documents.subtitle')"
      :breadcrumbs="[
        { label: t('company.title'), to: '/company' },
        { label: t('documents.title') },
      ]"
      :back-to="'/company'"
      :back-label="t('company.title')"
    >
      <n-space>
        <n-button key="refresh" :loading="loading" :disabled="busy" @click="load">{{ t('company.refresh') }}</n-button>
        <n-button key="upload" type="primary" :loading="busy" @click="picker?.click()">{{ t('documents.upload') }}</n-button>
      </n-space>
    </page-header>
    <input ref="picker" type="file" class="hidden" @change="upload" />

    <n-alert type="info" :bordered="false" class="block">
      <p>{{ t('documents.howTelegram') }}</p>
      <p class="meta">{{ t('documents.howHere') }}</p>
    </n-alert>
    <n-alert v-if="error" type="error" :bordered="false" class="block">{{ error }}</n-alert>
    <n-alert v-if="notice" type="success" :bordered="false" class="block">{{ notice }}</n-alert>

    <n-card class="block" :title="t('documents.files')">
      <n-empty v-if="data && !data.files.length" :description="t('documents.empty')">
        <template #extra><n-button size="small" round :loading="busy" @click="picker?.click()">{{ t("documents.upload") }}</n-button></template>
      </n-empty>
      <div v-for="file in data?.files ?? []" :key="file.path" class="row">
        <div class="file">
          <strong>{{ fileName(file.path) }}</strong>
          <span class="meta"><template v-if="folderOf(file.path)">{{ folderOf(file.path) }} · </template>{{ formatBytes(file.size, locale) }} · {{ formatDateTime(new Date(file.modifiedAt).toISOString(), locale) }}</span>
          <span v-for="item in givenOf(file.path)" :key="item.agentId" class="given">
            {{ t('documents.givenTo', { agent: item.agentName }) }}<template v-if="item.path"> · <code>{{ item.path }}</code></template>
            <n-popconfirm @positive-click="revoke(item)">
              <template #trigger><n-button size="tiny" quaternary :disabled="busy">{{ t('access.revoke') }}</n-button></template>
              <span class="confirm">{{ t('access.revokeFile', { name: fileName(item.file), agent: item.agentName }) }}</span>
            </n-popconfirm>
          </span>
        </div>
        <n-button size="small" :disabled="busy || !data?.agents.length" @click="openShare(file)">{{ t('documents.share') }}</n-button>
      </div>
    </n-card>

    <n-modal :show="!!sharing" preset="card" :title="t('documents.shareTitle', { name: sharing ? fileName(sharing.path) : '' })" :mask-closable="!busy" :closable="!busy" style="width: min(520px, calc(100vw - 32px))" @update:show="(v: boolean) => !v && !busy && (sharing = null)">
      <n-space vertical>
        <label>{{ t('documents.agent') }}<n-select v-model:value="agentId" :options="agentOptions" :placeholder="t('documents.agentPlaceholder')" :disabled="busy" filterable /></label>
        <label>{{ t('documents.instruction') }}<n-input v-model:value="instruction" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :maxlength="4000" :placeholder="t('documents.instructionPlaceholder')" :disabled="busy" /></label>
        <p class="meta">{{ t('documents.shareHint') }}</p>
        <n-space justify="end">
          <n-button :disabled="busy" @click="sharing = null">{{ t('documents.cancel') }}</n-button>
          <n-button type="primary" :loading="busy" :disabled="!agentId || !instruction.trim()" @click="share">{{ t('documents.shareConfirm') }}</n-button>
        </n-space>
      </n-space>
    </n-modal>
  </div>
</template>

<style scoped>
.block { margin-bottom: 16px; }
.hidden { display: none; }
.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.2)); }
.row:last-child { border-bottom: none; }
.file { display: flex; flex-direction: column; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.meta { color: var(--text-2); font-size: 13px; }
.given { font-size: 13px; color: var(--text-2); }
.confirm { overflow-wrap: anywhere; }
label { display: flex; flex-direction: column; gap: 6px; }
p { margin: 0 0 4px; }
</style>
