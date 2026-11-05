<script setup lang="ts">
// Stage 6, part 2: company tasks. The owner sets and starts a task; the executor works on one at a time,
// reports the result with a tool, and the owner accepts it or returns it with a comment. A request the
// executor files for the task blocks it until it is answered.
import type { WorkItemDto, WorkItemsDto, WorkItemStatus } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NCheckbox, NDatePicker, NEmpty, NFormItem, NInput, NPopconfirm, NRadioButton, NRadioGroup, NSelect, NSpace, NTag } from "naive-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";

const { t, te } = useI18n();
const router = useRouter();
const data = ref<WorkItemsDto | null>(null);
const loading = ref(false), busy = ref<string | null>(null), error = ref<string | null>(null);
const filter = ref<"active" | "review" | "all">("active");
const form = ref({ title: "", description: "", criteria: "", executorAgentId: null as string | null, deadline: null as number | null, start: true });
const comments = ref<Record<string, string>>({});
let pending: { key: string; requestId: string } | null = null, timer: ReturnType<typeof setInterval> | undefined;

const ACTIVE: WorkItemStatus[] = ["draft", "queued", "running", "blocked", "review"];
const shown = computed(() => (data.value?.items ?? []).filter((item) => filter.value === "all" || (filter.value === "review" ? item.status === "review" : ACTIVE.includes(item.status))));
const executors = computed(() => (data.value?.executors ?? []).map((item) => ({ value: item.agentId, label: `${item.name} (${item.agentId})` })));
const statusType = (status: WorkItemStatus) => ({ draft: "default", queued: "info", running: "info", blocked: "warning", review: "success", done: "success", failed: "error", cancelled: "default" } as const)[status];
const explain = (e: unknown) => e instanceof ApiError && te(`workItems.errors.${e.body.error}`) ? t(`workItems.errors.${e.body.error}`) : t("workItems.failed");
const time = (value: number) => new Date(value).toLocaleString();
const canCreate = computed(() => form.value.title.trim() && form.value.description.trim() && form.value.criteria.trim() && form.value.executorAgentId);
function requestId(key: string): string {
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  return pending.requestId;
}

async function load(): Promise<void> {
  loading.value = true;
  try { data.value = await api.company.workItems(); error.value = null; }
  catch (e) { error.value = explain(e); }
  finally { loading.value = false; }
}
async function create(): Promise<void> {
  if (!canCreate.value || busy.value) return;
  const body = { title: form.value.title.trim(), description: form.value.description.trim(), criteria: form.value.criteria.trim(), executorAgentId: form.value.executorAgentId!, deadlineAt: form.value.deadline, start: form.value.start };
  busy.value = "create"; error.value = null;
  try {
    await api.company.createWorkItem({ requestId: requestId(`create:${JSON.stringify(body)}`), ...body });
    pending = null; form.value = { title: "", description: "", criteria: "", executorAgentId: body.executorAgentId, deadline: null, start: true };
  } catch (e) { if (e instanceof ApiError) pending = null; error.value = explain(e); }
  finally { busy.value = null; await load(); }
}
async function act(item: WorkItemDto, action: "start" | "cancel" | "accept" | "return" | "resume"): Promise<void> {
  const comment = (comments.value[item.id] ?? "").trim();
  if (busy.value || (action === "return" && !comment)) return;
  busy.value = item.id; error.value = null;
  try {
    await api.company.actOnWorkItem(item.id, { requestId: requestId(`${item.id}:${item.revision}:${action}`), revision: item.revision, action, comment });
    pending = null; comments.value[item.id] = "";
  } catch (e) { if (e instanceof ApiError) pending = null; error.value = explain(e); }
  finally { busy.value = null; await load(); }
}
onMounted(() => { void load(); timer = setInterval(() => { if (!busy.value) void load(); }, 10_000); });
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div>
    <page-header :title="t('workItems.title')">
      <n-space>
        <n-button key="company" @click="router.push('/company')">{{ t('projects.toCompany') }}</n-button>
        <n-button key="refresh" :loading="loading" @click="load">{{ t('company.refresh') }}</n-button>
      </n-space>
    </page-header>
    <n-alert type="info" :bordered="false" class="block">{{ t('workItems.scope') }}</n-alert>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>

    <n-card :title="t('workItems.new')" class="block">
      <n-form-item :label="t('workItems.fields.title')"><n-input v-model:value="form.title" :maxlength="160" :aria-label="t('workItems.fields.title')" /></n-form-item>
      <n-form-item :label="t('workItems.fields.description')"><n-input v-model:value="form.description" type="textarea" :maxlength="4000" :autosize="{ minRows: 2, maxRows: 8 }" :aria-label="t('workItems.fields.description')" /></n-form-item>
      <n-form-item :label="t('workItems.fields.criteria')"><n-input v-model:value="form.criteria" type="textarea" :maxlength="2000" :autosize="{ minRows: 2, maxRows: 6 }" :aria-label="t('workItems.fields.criteria')" /></n-form-item>
      <n-form-item :label="t('workItems.fields.executor')"><n-select v-model:value="form.executorAgentId" :options="executors" :aria-label="t('workItems.fields.executor')" /></n-form-item>
      <n-form-item :label="t('workItems.fields.deadline')"><n-date-picker v-model:value="form.deadline" type="datetime" clearable :aria-label="t('workItems.fields.deadline')" /></n-form-item>
      <n-space align="center">
        <n-checkbox v-model:checked="form.start">{{ t('workItems.startNow') }}</n-checkbox>
        <n-button type="primary" :loading="busy === 'create'" :disabled="!canCreate" @click="create">{{ t(form.start ? 'workItems.createStart' : 'workItems.createDraft') }}</n-button>
      </n-space>
    </n-card>

    <n-radio-group v-model:value="filter" class="block" :aria-label="t('workItems.filter')">
      <n-radio-button value="active">{{ t('workItems.filters.active') }}</n-radio-button>
      <n-radio-button value="review">{{ t('workItems.filters.review') }}</n-radio-button>
      <n-radio-button value="all">{{ t('workItems.filters.all') }}</n-radio-button>
    </n-radio-group>
    <n-empty v-if="!shown.length" :description="t('workItems.empty')" class="block" />
    <n-card v-for="item in shown" :key="item.id" class="block" :title="`${item.code} · ${item.title}`">
      <template #header-extra>
        <n-space>
          <n-tag v-if="item.overdue" type="error" size="small">{{ t('workItems.overdue') }}</n-tag>
          <n-tag :type="statusType(item.status)">{{ t(`workItems.status.${item.status}`) }}<template v-if="item.queuePosition"> · {{ t('workItems.position', { n: item.queuePosition }) }}</template></n-tag>
        </n-space>
      </template>
      <p class="meta">{{ t('workItems.fields.executor') }}: {{ item.executor.name }} ({{ item.executor.agentId }}) · {{ time(item.createdAt) }}<template v-if="item.deadlineAt"> · {{ t('workItems.fields.deadline') }}: {{ time(item.deadlineAt) }}</template></p>
      <p class="text">{{ item.description }}</p>
      <p class="meta">{{ t('workItems.fields.criteria') }}: {{ item.criteria }}</p>
      <n-alert v-if="item.block" type="warning" class="block">{{ t('workItems.blocked') }}: {{ item.block.text }}</n-alert>
      <n-alert v-if="item.result" :type="item.status === 'failed' ? 'error' : 'success'" class="block" :title="t(item.status === 'failed' ? 'workItems.failedResult' : 'workItems.result')"><span class="text">{{ item.result }}</span></n-alert>
      <details class="block">
        <summary>{{ t('workItems.history') }}</summary>
        <p v-for="(event, index) in item.events" :key="index" class="meta">
          {{ time(event.at) }} · {{ t(`workItems.event.${event.kind}`) }} · {{ event.actor === 'owner' ? t('requests.owner') : event.actor === 'panel' ? t('requests.panel') : event.actor }}<template v-if="event.text">: {{ event.text }}</template>
          <n-tag v-if="event.delivery === 'pending' || event.delivery === 'failed'" size="small" :type="event.delivery === 'failed' ? 'error' : 'warning'">{{ t(`requests.delivery.${event.delivery}`) }}</n-tag>
        </p>
      </details>
      <template v-if="ACTIVE.includes(item.status) || item.status === 'failed'">
        <n-input v-if="item.status === 'review' || item.status === 'blocked'" v-model:value="comments[item.id]" type="textarea" class="block" :maxlength="2000" :autosize="{ minRows: 1, maxRows: 4 }" :placeholder="t('workItems.comment')" :aria-label="t('workItems.comment')" />
        <n-space class="block">
          <n-button v-if="item.status === 'draft' || item.status === 'failed'" type="primary" :loading="busy === item.id" @click="act(item, 'start')">{{ t(item.status === 'failed' ? 'workItems.actions.retry' : 'workItems.actions.start') }}</n-button>
          <n-button v-if="item.status === 'review'" type="primary" :loading="busy === item.id" @click="act(item, 'accept')">{{ t('workItems.actions.accept') }}</n-button>
          <n-button v-if="item.status === 'review'" :disabled="!!busy || !comments[item.id]?.trim()" @click="act(item, 'return')">{{ t('workItems.actions.return') }}</n-button>
          <n-button v-if="item.status === 'blocked'" :disabled="!!busy" @click="act(item, 'resume')">{{ t('workItems.actions.resume') }}</n-button>
          <n-popconfirm v-if="item.status !== 'failed'" @positive-click="act(item, 'cancel')">
            <template #trigger><n-button quaternary :disabled="!!busy">{{ t('workItems.actions.cancel') }}</n-button></template>
            <span class="confirm">{{ t('workItems.cancelConfirm') }}</span>
          </n-popconfirm>
        </n-space>
      </template>
    </n-card>
    <p class="meta block">{{ t('workItems.limits') }}</p>
  </div>
</template>

<style scoped>
.block { margin-top: 12px; }
.meta { opacity: 0.75; font-size: 0.92em; line-height: 1.6; overflow-wrap: anywhere; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.confirm { display: inline-block; max-width: min(340px, 75vw); white-space: normal; }
</style>
