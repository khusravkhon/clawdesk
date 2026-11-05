<script setup lang="ts">
// Stage 6: requests agents filed up the company structure. Each shows its route and history; the owner
// answers, denies, asks to clarify or closes a request at any level. Agents answer in their own chats.
import type { WorkRequestDto, WorkRequestStatus } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NEmpty, NInput, NRadioButton, NRadioGroup, NSpace, NTag } from "naive-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";

const { t, te } = useI18n();
const router = useRouter();
const requests = ref<WorkRequestDto[]>([]);
const loading = ref(false), busy = ref<string | null>(null), error = ref<string | null>(null);
const filter = ref<"mine" | "active" | "all">("mine");
const drafts = ref<Record<string, string>>({});
let pending: { key: string; requestId: string } | null = null, timer: ReturnType<typeof setInterval> | undefined;

const active = (status: WorkRequestStatus) => status === "open" || status === "clarify";
const atOwner = (request: WorkRequestDto) => active(request.status) && request.route[request.level]?.kind === "owner";
const shown = computed(() => requests.value.filter((request) => filter.value === "all" || (filter.value === "active" ? active(request.status) : atOwner(request))));
const statusType = (status: WorkRequestStatus) => ({ open: "info", clarify: "warning", answered: "success", denied: "error", expired: "error", cancelled: "default" } as const)[status];
const explain = (e: unknown) => e instanceof ApiError && te(`requests.errors.${e.body.error}`) ? t(`requests.errors.${e.body.error}`) : t("requests.failed");
const time = (value: number) => new Date(value).toLocaleString();
function requestId(key: string): string {
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  return pending.requestId;
}

async function load(): Promise<void> {
  loading.value = true;
  try { requests.value = (await api.company.requests()).requests; error.value = null; }
  catch (e) { error.value = explain(e); }
  finally { loading.value = false; }
}
async function act(request: WorkRequestDto, action: "answer" | "deny" | "clarify" | "cancel"): Promise<void> {
  const text = (drafts.value[request.id] ?? "").trim();
  if (busy.value || (action !== "cancel" && !text)) return;
  busy.value = request.id; error.value = null;
  try {
    await api.company.actOnRequest(request.id, { requestId: requestId(`${request.id}:${request.revision}:${action}:${text}`), revision: request.revision, action, text });
    pending = null; drafts.value[request.id] = "";
  } catch (e) { if (e instanceof ApiError) pending = null; error.value = explain(e); }
  finally { busy.value = null; await load(); }
}
onMounted(() => { void load(); timer = setInterval(() => { if (!busy.value) void load(); }, 10_000); });
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div>
    <page-header :title="t('requests.title')">
      <n-space>
        <n-button key="company" @click="router.push('/company')">{{ t('projects.toCompany') }}</n-button>
        <n-button key="refresh" :loading="loading" @click="load">{{ t('company.refresh') }}</n-button>
      </n-space>
    </page-header>
    <n-alert type="info" :bordered="false" class="block">{{ t('requests.scope') }}</n-alert>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>
    <n-radio-group v-model:value="filter" class="block" :aria-label="t('requests.filter')">
      <n-radio-button value="mine">{{ t('requests.filters.mine') }}</n-radio-button>
      <n-radio-button value="active">{{ t('requests.filters.active') }}</n-radio-button>
      <n-radio-button value="all">{{ t('requests.filters.all') }}</n-radio-button>
    </n-radio-group>
    <n-empty v-if="!shown.length" :description="t(`requests.empty.${filter}`)" class="block" />
    <n-card v-for="request in shown" :key="request.id" class="block" :title="`${request.code} · ${request.subject}`">
      <template #header-extra><n-tag :type="statusType(request.status)">{{ t(`requests.status.${request.status}`) }}</n-tag></template>
      <p class="meta">{{ t(`requests.kind.${request.kind}`) }} · {{ t('requests.from') }}: {{ request.from.name }} ({{ request.from.agentId }}) · {{ time(request.createdAt) }}<template v-if="active(request.status)"> · {{ t('requests.deadline') }}: {{ time(request.deadlineAt) }}</template></p>
      <p class="text">{{ request.details }}</p>
      <p v-if="request.taskRef" class="meta">{{ t('requests.task') }}: {{ request.taskRef }}</p>
      <p class="meta">
        {{ t('requests.route') }}:
        <template v-for="(level, index) in request.route" :key="index"><span :class="{ current: active(request.status) && index === request.level }">{{ level.name }}</span><span v-if="index < request.route.length - 1"> → </span></template>
      </p>
      <n-alert v-if="request.answer" :type="request.status === 'answered' ? 'success' : 'error'" class="block" :title="t(request.status === 'answered' ? 'requests.answeredBy' : 'requests.deniedBy', { name: request.answer.by === 'owner' ? t('requests.owner') : request.answer.name })">
        <span class="text">{{ request.answer.text }}</span>
      </n-alert>
      <details class="block">
        <summary>{{ t('requests.history') }}</summary>
        <p v-for="(event, index) in request.events" :key="index" class="meta">
          {{ time(event.at) }} · {{ t(`requests.event.${event.kind}`) }} · {{ event.actor === 'owner' ? t('requests.owner') : event.actor === 'panel' ? t('requests.panel') : event.actor }}<template v-if="event.text">: {{ event.text }}</template>
          <n-tag v-if="event.delivery === 'pending' || event.delivery === 'failed'" size="small" :type="event.delivery === 'failed' ? 'error' : 'warning'">{{ t(`requests.delivery.${event.delivery}`) }}</n-tag>
        </p>
      </details>
      <template v-if="active(request.status)">
        <n-input v-model:value="drafts[request.id]" type="textarea" class="block" :maxlength="4000" :autosize="{ minRows: 2, maxRows: 6 }" :placeholder="t('requests.answerPlaceholder')" :aria-label="t('requests.answerPlaceholder')" :disabled="busy === request.id" />
        <p v-if="!atOwner(request)" class="meta">{{ t('requests.notYours', { name: request.route[request.level]?.name ?? '' }) }}</p>
        <n-space class="block">
          <n-button type="primary" :loading="busy === request.id" :disabled="!drafts[request.id]?.trim()" @click="act(request, 'answer')">{{ t('requests.actions.answer') }}</n-button>
          <n-button :disabled="busy === request.id || !drafts[request.id]?.trim()" @click="act(request, 'clarify')">{{ t('requests.actions.clarify') }}</n-button>
          <n-button :disabled="busy === request.id || !drafts[request.id]?.trim()" @click="act(request, 'deny')">{{ t('requests.actions.deny') }}</n-button>
          <n-button quaternary :disabled="busy === request.id" @click="act(request, 'cancel')">{{ t('requests.actions.cancel') }}</n-button>
        </n-space>
      </template>
    </n-card>
    <p class="meta block">{{ t('requests.limits') }}</p>
  </div>
</template>

<style scoped>
.block { margin-top: 12px; }
.meta { opacity: 0.75; font-size: 0.92em; line-height: 1.6; overflow-wrap: anywhere; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.current { font-weight: 600; text-decoration: underline; }
</style>
