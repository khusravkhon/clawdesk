<script setup lang="ts">
// Screen 13: tokens and cost per agent per day. One measure per chart, one color: totals over days as a
// trend, agents as ranked bars, and each agent's own days as a small trend in its row (no stacked colors).
import type { DashboardRange, UsageDto } from "@clawdesk/shared";
import { NAlert, NCard, NEmpty, NRadioButton, NRadioGroup, NSkeleton } from "naive-ui";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import TrendChart from "../components/charts/TrendChart.vue";
import BarList, { type BarItem } from "../components/ui/BarList.vue";
import BudgetCard from "../components/BudgetCard.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import UsageMetrics from "../components/UsageMetrics.vue";
import { formatCompact, formatCost, formatDay, formatInt } from "../format";

const { t, locale } = useI18n();
const range = ref<DashboardRange>("30d");
const data = ref<UsageDto | null>(null);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    data.value = await api.usage(range.value);
    error.value = null;
  } catch (e) {
    error.value = e instanceof ApiError ? e.body.message : String(e);
  }
}
onMounted(load);
watch(range, load);

const loc = computed(() => locale.value);
const usage = computed(() => data.value?.usage ?? null);
const labels = computed(() => (data.value?.days ?? []).map((d) => formatDay(d, loc.value)));
const tokens = (v: number) => formatCompact(v, loc.value);
const total = computed(() => usage.value?.totals.tokens ?? 0);
const share = (v: number) => (total.value ? Math.round((v / total.value) * 100) : 0);

const agentBars = computed<BarItem[]>(() =>
  (data.value?.agents ?? []).map((a) => ({
    key: a.agentId,
    label: `${a.emoji ?? ""} ${a.name}`.trim(),
    sublabel: `${formatCost(a.cost, loc.value)} · ${share(a.tokens)}%`,
    value: a.tokens,
    display: tokens(a.tokens),
    title: `${a.name}: ${formatInt(a.tokens, loc.value)} ${t("dash.tokensUnit")} · ${formatCost(a.cost, loc.value)}`,
  })),
);
const modelBars = computed<BarItem[]>(() =>
  (usage.value?.byModel ?? []).slice(0, 8).map((m) => ({
    key: `${m.provider}/${m.model}`,
    label: m.model,
    sublabel: m.provider,
    value: m.tokens,
    display: tokens(m.tokens),
    title: `${m.provider}/${m.model}: ${formatInt(m.tokens, loc.value)} ${t("dash.tokensUnit")} · ${formatCost(m.cost, loc.value)} · ${m.calls} ${t("dash.calls")}`,
  })),
);
/** Same scale for every agent's small trend would hide small agents; each row uses its own (the bars compare). */
const activeAgents = computed(() => (data.value?.agents ?? []).filter((a) => a.tokens > 0));
</script>

<template>
  <div>
    <page-header :title="t('usage.title')" :subtitle="t('usage.subtitle')">
      <n-radio-group v-model:value="range" size="small">
        <n-radio-button value="7d">{{ t("dash.range.7d") }}</n-radio-button>
        <n-radio-button value="30d">{{ t("dash.range.30d") }}</n-radio-button>
        <n-radio-button value="90d">{{ t("dash.range.90d") }}</n-radio-button>
      </n-radio-group>
    </page-header>

    <n-alert v-if="error" type="error" class="gap">{{ error }}</n-alert>
    <n-skeleton v-if="!data && !error" text :repeat="6" />

    <template v-if="data && usage">
      <div class="tiles">
        <usage-metrics :usage="usage" />
      </div>

      <n-card :title="t('usage.byDay')" class="gap">
        <n-empty v-if="usage.daily.every((d) => d.tokens === 0)" :description="t('dash.trend.empty')" />
        <trend-chart v-else :labels="labels" :values="usage.daily.map((d) => d.tokens)" :name="t('dash.kpi.tokens')" :format="tokens" :height="220" />
      </n-card>

      <div class="cols">
        <n-card :title="t('usage.byAgent')">
          <n-empty v-if="!agentBars.some((b) => b.value > 0)" :description="t('usage.noAgents')" />
          <bar-list v-else :items="agentBars" />
        </n-card>
        <n-card :title="t('dash.models.title')">
          <n-empty v-if="!modelBars.length" :description="t('dash.models.empty')" />
          <bar-list v-else :items="modelBars" />
        </n-card>
      </div>

      <n-card v-if="activeAgents.length" :title="t('usage.agentDays')" class="gap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t("usage.agent") }}</th>
              <th class="num">{{ t("dash.kpi.tokens") }}</th>
              <th class="num">{{ t("dash.kpi.cost") }}</th>
              <th class="trend">{{ t("usage.byDay") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in activeAgents" :key="a.agentId">
              <td>{{ a.emoji }} {{ a.name }}</td>
              <td class="num">{{ formatInt(a.tokens, loc) }}</td>
              <td class="num">{{ formatCost(a.cost, loc) }}</td>
              <td class="trend"><trend-chart :labels="labels" :values="a.daily" :name="a.name" :format="tokens" :height="40" compact /></td>
            </tr>
          </tbody>
        </table>
      </n-card>

      <BudgetCard />
    </template>
  </div>
</template>

<style scoped>
.gap {
  margin-bottom: 16px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-2);
  padding: 0 8px 8px 0;
}
.table td {
  padding: 6px 8px 6px 0;
  border-top: 1px solid var(--border);
  vertical-align: middle;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.trend {
  width: 40%;
  min-width: 140px;
}
</style>
