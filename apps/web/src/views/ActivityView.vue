<script setup lang="ts">
// Stage 9: the company's work list — what every agent is doing, why it waits, what it works on. States come
// from confirmed runs, tasks and requests; nothing is shown as working without a run the Gateway reported.
import type { AgentActivityDto, AgentActivityState } from "@clawdesk/shared";
import { NAlert, NButton, NEmpty, NInput, NRadioButton, NRadioGroup, NSpace, NTag } from "naive-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import PageHeader from "../components/ui/PageHeader.vue";
import { useActivityStore } from "../stores/activity";

const { t } = useI18n();
const router = useRouter();
const store = useActivityStore();
const filter = ref<"all" | "working" | "waiting" | "problems">("all");
const search = ref("");
let leave: (() => void) | null = null;

const GROUP: Record<AgentActivityState, "working" | "waiting" | "problems" | "idle"> = { working: "working", waiting_for_agent: "waiting", waiting_for_owner: "waiting", blocked: "problems", error: "problems", offline: "problems", unknown: "problems", queued: "idle", idle: "idle" };
const shown = computed(() => (store.data?.agents ?? []).filter((agent) => (filter.value === "all" || GROUP[agent.state] === filter.value) && (!search.value.trim() || `${agent.name} ${agent.agentId} ${agent.team?.name ?? ""} ${agent.department?.name ?? ""}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))));
const tagType = (state: AgentActivityState) => ({ working: "info", idle: "default", queued: "default", waiting_for_agent: "warning", waiting_for_owner: "warning", blocked: "warning", error: "error", offline: "error", unknown: "default" } as const)[state];
const ago = (at: number | null) => at === null ? "—" : new Date(at).toLocaleTimeString();
const open = (agent: AgentActivityDto) => router.push(agent.agentId === "main" ? "/chat/main" : `/chat/${agent.agentId}`);
onMounted(() => { leave = store.use(); });
onBeforeUnmount(() => leave?.());
</script>

<template>
  <div>
    <page-header :title="t('activity.title')">
      <n-space>
        <n-button key="office" type="primary" @click="router.push('/company/office')">{{ t('activity.office') }}</n-button>
        <n-button key="company" @click="router.push('/company')">{{ t('projects.toCompany') }}</n-button>
        <n-button key="refresh" @click="store.refresh()">{{ t('company.refresh') }}</n-button>
      </n-space>
    </page-header>
    <n-alert type="info" :bordered="false" class="block">{{ t('activity.scope') }}</n-alert>
    <n-alert v-if="store.data && !store.data.gatewayConnected" type="warning" class="block">{{ t('activity.noGateway') }}</n-alert>
    <n-alert v-if="!store.live" type="default" class="block">{{ t('activity.notLive') }}</n-alert>
    <n-space v-if="store.data" class="block" align="center">
      <n-tag type="info">{{ t('activity.counts.working', { n: store.data.counts.working }) }}</n-tag>
      <n-tag>{{ t('activity.counts.idle', { n: store.data.counts.idle }) }}</n-tag>
      <n-tag type="warning">{{ t('activity.counts.waiting', { n: store.data.counts.waiting }) }}</n-tag>
      <n-tag type="warning">{{ t('activity.counts.blocked', { n: store.data.counts.blocked }) }}</n-tag>
      <n-tag type="error">{{ t('activity.counts.error', { n: store.data.counts.error }) }}</n-tag>
      <n-tag type="error">{{ t('activity.counts.offline', { n: store.data.counts.offline }) }}</n-tag>
    </n-space>
    <n-space class="block" align="center">
      <n-radio-group v-model:value="filter" :aria-label="t('activity.filter')">
        <n-radio-button value="all">{{ t('activity.filters.all') }}</n-radio-button>
        <n-radio-button value="working">{{ t('activity.filters.working') }}</n-radio-button>
        <n-radio-button value="waiting">{{ t('activity.filters.waiting') }}</n-radio-button>
        <n-radio-button value="problems">{{ t('activity.filters.problems') }}</n-radio-button>
      </n-radio-group>
      <n-input v-model:value="search" clearable :placeholder="t('activity.search')" :aria-label="t('activity.search')" style="max-width: 260px" />
    </n-space>
    <n-empty v-if="store.data && !shown.length" :description="t('activity.empty')" class="block" />
    <div class="table block" role="table" :aria-label="t('activity.title')">
      <div class="row head" role="row">
        <span role="columnheader">{{ t('activity.columns.agent') }}</span>
        <span role="columnheader">{{ t('activity.columns.state') }}</span>
        <span role="columnheader">{{ t('activity.columns.detail') }}</span>
        <span role="columnheader">{{ t('activity.columns.last') }}</span>
      </div>
      <div v-for="agent in shown" :key="agent.agentId" class="row" role="row" tabindex="0" @click="open(agent)" @keydown.enter="open(agent)">
        <span role="cell"><strong>{{ agent.name }}</strong><br /><span class="meta">{{ agent.position ? t(`activity.positions.${agent.position}`, agent.position) : t(`activity.roles.${agent.role}`) }}<template v-if="agent.team"> · {{ agent.team.name }}</template><template v-if="agent.department"> · {{ agent.department.name }}</template></span></span>
        <span role="cell"><n-tag size="small" :type="tagType(agent.state)">{{ t(`activity.state.${agent.state}`) }}</n-tag><template v-if="agent.runs > 1"> ×{{ agent.runs }}</template></span>
        <span role="cell">{{ agent.detail }}<template v-if="agent.action"><br /><span class="meta">{{ t('activity.action', { tool: agent.action }) }}</span></template><template v-if="agent.inbox"><br /><span class="meta">{{ t('activity.inbox', { n: agent.inbox }) }}</span></template></span>
        <span role="cell" class="meta">{{ ago(agent.lastActivityAt) }}</span>
      </div>
    </div>
    <p class="meta block">{{ t('activity.limits') }}</p>
  </div>
</template>

<style scoped>
.block { margin-top: 12px; }
.meta { opacity: 0.75; font-size: 0.9em; overflow-wrap: anywhere; }
.table { display: grid; gap: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.row { display: grid; grid-template-columns: minmax(140px, 1.3fr) minmax(110px, 0.8fr) minmax(160px, 2fr) minmax(70px, 0.5fr); gap: 10px; padding: 10px 12px; border-top: 1px solid var(--border); align-items: start; cursor: pointer; overflow-wrap: anywhere; }
.row.head { border-top: none; cursor: default; font-weight: 600; opacity: 0.8; }
.row:not(.head):hover, .row:not(.head):focus-visible { background: var(--hover, rgba(127, 127, 127, 0.08)); outline: none; }
@media (max-width: 640px) { .row { grid-template-columns: 1fr 1fr; } .row.head { display: none; } }
</style>
