<script setup lang="ts">
// Overview: usage, agents, schedules and system health at a glance.
import type { DashboardAgentState, DashboardDto, DashboardRange, HealthLevel } from "@clawdesk/shared";
import {
  AlertCircle,
  Bot,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Cpu,
  RefreshCw,
  Send,
  Sparkles,
  Server,
  Zap,
} from "@lucide/vue";
import { NAlert, NButton, NCard, NEmpty, NRadioButton, NRadioGroup, NSkeleton, NTooltip } from "naive-ui";
import { computed, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import TrendChart from "../components/charts/TrendChart.vue";
import BarList, { type BarItem } from "../components/ui/BarList.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import StatTile from "../components/ui/StatTile.vue";
import UsageMetrics from "../components/UsageMetrics.vue";
import { formatCompact, formatCost, formatDay, formatInt, formatRelative } from "../format";
import { modelErrorHint } from "../model-errors";

const { t, locale } = useI18n();
const range = ref<DashboardRange>("7d");
const data = ref<DashboardDto | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
let active = false;
let stopped = false;
let queued = false;
let rangeRevision = 0;

async function load(): Promise<void> {
  if (stopped || document.hidden) return;
  if (active) { queued = true; return; }
  active = true;
  const selected = range.value;
  const revision = rangeRevision;
  loading.value = true;
  try {
    const result = await api.dashboard(selected);
    if (!stopped && revision === rangeRevision) { data.value = result; error.value = null; }
  } catch (e) {
    if (!stopped && revision === rangeRevision) error.value = e instanceof ApiError ? e.body.message : String(e);
  } finally {
    active = false;
    loading.value = false;
    if (queued && !stopped) { queued = false; void load(); }
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
const visibilityChanged = () => { if (!document.hidden) void load(); };
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 30_000);
  document.addEventListener("visibilitychange", visibilityChanged);
});
onUnmounted(() => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", visibilityChanged); });
watch(range, () => { rangeRevision++; data.value = null; error.value = null; void load(); });

const loc = computed(() => locale.value);
const usage = computed(() => data.value?.usage ?? null);

// --- KPI tiles
const agentCounts = computed(() => {
  const list = data.value?.agents ?? [];
  return { total: list.length, working: list.filter((a) => a.state === "working").length, failed: list.filter((a) => a.state === "failed").length };
});
const runs = computed(() => data.value?.schedules?.runs ?? { ok: 0, error: 0, skipped: 0 });
const successRate = computed(() => {
  if (!data.value?.schedules?.historyComplete) return null;
  const done = runs.value.ok + runs.value.error;
  return done ? Math.round((runs.value.ok / done) * 100) : null;
});

// --- trend
type Metric = "tokens" | "cost" | "messages";
const metric = ref<Metric>("tokens");
const metricFormat = computed(() => (v: number) => (metric.value === "cost" ? formatCost(v, loc.value) : formatCompact(v, loc.value)));
const trendLabels = computed(() => (usage.value?.daily ?? []).map((d) => formatDay(d.date, loc.value)));
const trendValues = computed(() => (usage.value?.daily ?? []).map((d) => d[metric.value]));
const trendEmpty = computed(() => trendValues.value.every((v) => v === 0));

// --- models
const modelBars = computed<BarItem[]>(() =>
  (usage.value?.byModel ?? []).slice(0, 6).map((m) => ({
    key: `${m.provider}/${m.model}`,
    label: m.model,
    sublabel: m.provider,
    value: m.tokens,
    display: formatCompact(m.tokens, loc.value),
    title: `${m.provider}/${m.model}: ${formatInt(m.tokens, loc.value)} ${t("dash.tokensUnit")} · ${formatCost(m.cost, loc.value)} · ${m.calls} ${t("dash.calls")}`,
  })),
);

// --- agents
const agentMaxTokens = computed(() => Math.max(0, ...(data.value?.agents ?? []).map((a) => a.tokens)));
const stateIcon: Record<DashboardAgentState, Component> = { working: Zap, idle: CircleDashed, failed: AlertCircle };
const errorHint = (error: string | null) => modelErrorHint(t, error);
// The main agent is called "main" until the user names it; show a human name instead of the id.
const displayName = (a: { id: string; name: string; role: string | null }) => (a.role === "main" && a.name === a.id ? t("agents.main") : a.name);
const agentName = (id: string | null) => {
  const found = id ? data.value?.agents?.find((a) => a.id === id) : undefined;
  return found ? displayName(found) : (id ?? "—");
};

// --- health
const healthItems = computed(() => {
  const h = data.value?.health;
  if (!h) return [];
  const gw: HealthLevel = h.gateway === "connected" ? "ok" : h.gateway === "connecting" ? "warning" : "error";
  return [
    { key: "gateway", icon: Server, label: "Gateway", level: gw, detail: h.gateway === "connected" ? (h.gatewayVersion ?? "") : t(`status.state.${h.gateway}`) },
    { key: "ai", icon: Cpu, label: t("dash.health.ai"), level: h.ai, detail: h.aiProviders.join(", ") },
    { key: "telegram", icon: Send, label: "Telegram", level: h.telegram, detail: h.telegramBot ?? "" },
    { key: "free", icon: Sparkles, label: t("nav.freeModels"), level: h.freeModels, detail: "" },
  ];
});
const levelIcon: Record<HealthLevel, Component> = { ok: CheckCircle2, warning: AlertCircle, error: AlertCircle, off: CircleSlash };

const subtitle = computed(() => t("dash.subtitle", { days: range.value.replace("d", "") }));
</script>

<template>
  <div>
    <page-header :title="t('dash.title')" :subtitle="subtitle">
      <n-radio-group v-model:value="range" size="small">
        <n-radio-button value="7d">{{ t("dash.range.7d") }}</n-radio-button>
        <n-radio-button value="30d">{{ t("dash.range.30d") }}</n-radio-button>
        <n-radio-button value="90d">{{ t("dash.range.90d") }}</n-radio-button>
      </n-radio-group>
      <n-button size="small" secondary :loading="loading" @click="load">
        <template #icon><refresh-cw :size="14" /></template>
        {{ t("status.refresh") }}
      </n-button>
    </page-header>

    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>

    <!-- System health strip -->
    <section v-if="healthItems.length" class="health" :aria-label="t('dash.health.title')">
      <div v-for="item in healthItems" :key="item.key" class="health-item" :data-level="item.level">
        <component :is="item.icon" :size="16" :stroke-width="1.75" class="h-icon" />
        <div class="h-text">
          <div class="h-label">{{ item.label }}</div>
          <div v-if="item.detail" class="h-detail">{{ item.detail }}</div>
        </div>
        <span class="h-status">
          <component :is="levelIcon[item.level]" :size="14" />
          {{ t(`dash.level.${item.level}`) }}
        </span>
      </div>
    </section>

    <!-- KPI tiles -->
    <section class="tiles">
      <template v-if="data">
        <usage-metrics :usage="usage" />
        <stat-tile :icon="Bot" :label="t('dash.kpi.agents')" :value="String(agentCounts.total)">
          <template #note>
            <span v-if="agentCounts.working" class="good-text">{{ t("dash.kpi.working", { n: agentCounts.working }) }}</span>
            <span v-if="agentCounts.working && agentCounts.failed"> · </span>
            <span v-if="agentCounts.failed" class="critical-text">{{ t("dash.kpi.failed", { n: agentCounts.failed }) }}</span>
            <span v-if="!agentCounts.working && !agentCounts.failed">{{ t("dash.kpi.allIdle") }}</span>
          </template>
        </stat-tile>
        <stat-tile
          :icon="CalendarClock"
          :label="t('dash.kpi.schedules')"
          :value="successRate === null ? '—' : `${successRate}%`"
          :note="data.schedules && !data.schedules.historyComplete ? t('dash.schedules.partial') : successRate === null ? (data.errors.schedules ? t('dash.schedules.unavailable') : t('dash.kpi.noRuns')) : t('dash.kpi.runs', { ok: runs.ok, e: runs.error })"
        />
      </template>
      <template v-else>
        <n-skeleton v-for="i in 5" :key="i" height="104px" :sharp="false" />
      </template>
    </section>

    <!-- Trend + models -->
    <section class="grid two-one">
      <n-card :title="t('dash.trend.title')">
        <template #header-extra>
          <n-radio-group v-model:value="metric" size="small">
            <n-radio-button value="tokens">{{ t("dash.trend.tokens") }}</n-radio-button>
            <n-radio-button value="cost">{{ t("dash.trend.cost") }}</n-radio-button>
            <n-radio-button value="messages">{{ t("dash.trend.messages") }}</n-radio-button>
          </n-radio-group>
        </template>
        <n-alert v-if="data?.errors.usage" type="warning" :bordered="false">{{ data.errors.usage }}</n-alert>
        <div v-else class="chart-wrap">
          <trend-chart :labels="trendLabels" :values="trendValues" :name="t(`dash.trend.${metric}`)" :format="metricFormat" />
          <div v-if="data && trendEmpty" class="chart-empty">{{ t("dash.trend.empty") }}</div>
        </div>
      </n-card>

      <n-card :title="t('dash.models.title')">
        <bar-list v-if="modelBars.length" :items="modelBars" />
        <n-empty v-else :description="t('dash.models.empty')" size="small" class="empty" />
      </n-card>
    </section>

    <!-- Agents + schedules -->
    <section class="grid one-one">
      <n-card :title="t('dash.agents.title')">
        <template #header-extra>
          <n-button text size="small" @click="$router.push('/agents')">{{ t("dash.all") }}</n-button>
        </template>
        <n-alert v-if="data?.errors.agents" type="warning" :bordered="false">{{ data.errors.agents }}</n-alert>
        <n-empty v-else-if="data && !data.agents?.length" :description="t('status.noAgents')" size="small" class="empty" />
        <ul v-else class="agents">
          <li v-for="agent in data?.agents ?? []" :key="agent.id" class="agent">
            <div class="avatar">{{ agent.emoji ?? (agent.role === "main" ? "🧭" : "🤖") }}</div>
            <div class="agent-main">
              <div class="agent-top">
                <span class="agent-name">{{ displayName(agent) }}</span>
                <span v-if="agent.role === 'main' && displayName(agent) !== t('agents.main')" class="pill">{{ t("agents.main") }}</span>
              </div>
              <div class="agent-sub">
                {{ agent.model ?? t("agents.noModel") }}
                <template v-if="agent.lastActivityAt"> · {{ formatRelative(agent.lastActivityAt, loc) }}</template>
              </div>
              <div class="mini-track">
                <div class="mini-fill" :style="{ width: agentMaxTokens ? `${(agent.tokens / agentMaxTokens) * 100}%` : '0%' }" />
              </div>
            </div>
            <div class="agent-side">
              <n-tooltip :disabled="!agent.lastError">
                <template #trigger>
                  <span class="state" :data-state="agent.state">
                    <component :is="stateIcon[agent.state]" :size="13" />
                    {{ t(`dash.state.${agent.state}`) }}
                  </span>
                </template>
                {{ errorHint(agent.lastError) }}
              </n-tooltip>
              <span class="agent-tokens num">{{ formatCompact(agent.tokens, loc) }} {{ t("dash.tokensUnit") }}</span>
            </div>
          </li>
        </ul>
      </n-card>

      <n-card :title="t('dash.schedules.title')">
        <template #header-extra>
          <n-button text size="small" @click="$router.push('/schedules')">{{ t("dash.all") }}</n-button>
        </template>
        <n-alert v-if="data?.errors.schedules" type="warning" :bordered="false">{{ data.errors.schedules }}</n-alert>
        <template v-else-if="data?.schedules">
          <n-alert v-if="!data.schedules.historyComplete" type="warning" class="block">{{ t(data.schedules.historyReason === 'unknown_jobs' ? "dash.schedules.unknownJobs" : "dash.schedules.partial") }}</n-alert>
          <n-empty v-if="!data.schedules.upcoming.length" :description="t('dash.schedules.empty')" size="small" class="empty">
            <template #extra>
              <n-button size="small" @click="$router.push('/schedules')">{{ t("schedules.new") }}</n-button>
            </template>
          </n-empty>
          <template v-else>
            <div class="sub-title">{{ t("dash.schedules.upcoming") }}</div>
            <ul class="rows">
              <li v-for="job in data.schedules.upcoming.slice(0, 5)" :key="job.id" class="row">
                <calendar-clock :size="15" class="muted" />
                <span class="row-main">
                  <span class="row-name">{{ job.name }}</span>
                  <span class="muted"> · {{ agentName(job.agentId) }}</span>
                </span>
                <span class="row-side num">{{ job.nextRunAt ? formatRelative(job.nextRunAt, loc) : t("dash.schedules.paused") }}</span>
              </li>
            </ul>
          </template>
          <template v-if="data.schedules.recent.length">
            <div class="sub-title">{{ t("dash.schedules.recent") }}</div>
            <ul class="rows">
              <li v-for="run in data.schedules.recent" :key="`${run.jobName}-${run.at}`" class="row" :title="run.error ? errorHint(run.error) : undefined">
                <span class="run" :data-status="run.status">
                  <component :is="run.status === 'ok' ? CheckCircle2 : run.status === 'error' ? AlertCircle : CircleSlash" :size="15" />
                </span>
                <span class="row-main">
                  <span class="row-name">{{ run.jobName }}</span>
                  <span class="muted"> · {{ t(`dash.run.${run.status}`) }}</span>
                </span>
                <span class="row-side num">{{ formatRelative(run.at, loc) }}</span>
              </li>
            </ul>
          </template>
          <p v-if="data.schedules.systemJobs" class="foot-note">{{ t("dash.schedules.system", { n: data.schedules.systemJobs }) }}</p>
        </template>
      </n-card>
    </section>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 16px;
}
.health {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.health-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--card-shadow);
  min-width: 0;
  transition: transform 0.25s var(--ease-out);
}
.health-item:hover {
  transform: translateY(-2px);
}
.h-icon {
  color: var(--muted);
  flex: none;
}
.h-text {
  min-width: 0;
  flex: 1;
}
.h-label {
  font-size: 13px;
  font-weight: 500;
}
.h-detail {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.h-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  flex: none;
  color: var(--muted);
}
[data-level="ok"] .h-status {
  color: var(--good-text);
}
[data-level="warning"] .h-status {
  color: var(--warning);
}
[data-level="error"] .h-status {
  color: var(--critical);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.good-text {
  color: var(--good-text);
}
.critical-text {
  color: var(--critical);
}

.grid {
  display: grid;
  gap: 16px;
  margin-bottom: 16px;
}
.two-one {
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
}
.one-one {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.chart-wrap {
  position: relative;
}
.chart-empty {
  position: absolute;
  inset: 0 0 28px 40px;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 13px;
  pointer-events: none;
}
.empty {
  padding: 24px 0;
}

.agents,
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.agent {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}
.agent:first-child {
  border-top: 0;
  padding-top: 0;
}
.avatar {
  width: 36px;
  height: 36px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: var(--surface-2);
  font-size: 18px;
  flex: none;
}
.agent-main {
  flex: 1;
  min-width: 0;
}
.agent-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.agent-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pill {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  flex: none;
}
.agent-sub {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
.mini-track {
  height: 4px;
  margin-top: 8px;
  border-radius: 4px;
  background: var(--surface-2);
  overflow: hidden;
}
.mini-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--accent-gradient);
  transition: width 0.6s var(--ease-out);
}
.agent-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex: none;
}
.state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
}
.state[data-state="working"] {
  color: var(--accent);
  background: var(--accent-soft);
}
.state[data-state="failed"] {
  color: var(--critical);
}
.agent-tokens {
  font-size: 12px;
  color: var(--muted);
}

.sub-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 4px 0 8px;
}
.rows + .sub-title {
  margin-top: 18px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  font-size: 13px;
}
.row-main {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-name {
  font-weight: 500;
}
.row-side {
  color: var(--text-2);
  font-size: 12px;
  flex: none;
}
.run {
  display: inline-flex;
  color: var(--muted);
}
.run[data-status="ok"] {
  color: var(--good-text);
}
.run[data-status="error"] {
  color: var(--critical);
}
.foot-note {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--muted);
}

@media (max-width: 1100px) {
  .tiles {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .health {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .two-one,
  .one-one {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 600px) {
  .tiles,
  .health {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .tiles > :last-child:nth-child(odd) {
    grid-column: 1 / -1;
  }
  .health-item {
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 10px 12px;
  }
  .h-status {
    width: 100%;
  }
  :deep(.n-card-header) {
    flex-wrap: wrap;
    gap: 10px;
  }
  :deep(.n-card-header__extra) {
    margin-left: 0;
  }
}
</style>
