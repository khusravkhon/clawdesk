<script setup lang="ts">
import type { DashboardUsageDto } from "@clawdesk/shared";
import { Coins, MessageSquare, Zap } from "@lucide/vue";
import { NTooltip } from "naive-ui";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { formatCompact, formatCost, formatInt } from "../format";
import StatTile from "./ui/StatTile.vue";

const props = defineProps<{ usage: DashboardUsageDto | null }>();
const { t, locale } = useI18n();
const totals = computed(() => props.usage?.totals);
const breakdown = computed(() => totals.value?.tokenBreakdown);
</script>

<template>
  <stat-tile :icon="Zap" :label="t('usageMetrics.processed')" :value="totals ? formatCompact(totals.tokens, locale) : '—'">
    <template #note>
      <dl v-if="breakdown" class="details">
        <div><dt>{{ t('usageMetrics.input') }}</dt><dd>{{ formatInt(breakdown.input, locale) }}</dd></div>
        <div>
          <dt><n-tooltip trigger="hover"><template #trigger><span tabindex="0" class="hint-label">{{ t('usageMetrics.cache') }}</span></template>{{ t('usageMetrics.cacheHint') }}</n-tooltip></dt>
          <dd>{{ formatInt(breakdown.cacheRead, locale) }}</dd>
        </div>
        <div v-if="breakdown.cacheWrite"><dt>{{ t('usageMetrics.cacheWrite') }}</dt><dd>{{ formatInt(breakdown.cacheWrite, locale) }}</dd></div>
        <div><dt>{{ t('usageMetrics.output') }}</dt><dd>{{ formatInt(breakdown.output, locale) }}</dd></div>
      </dl>
      <span v-else>{{ t('usageMetrics.unavailable') }}</span>
    </template>
  </stat-tile>
  <stat-tile :icon="Coins" :label="t('usageMetrics.estimatedCost')" :value="totals ? formatCost(totals.cost, locale) : '—'">
    <template #note>
      <p class="line">{{ t('usageMetrics.estimateHint') }}</p>
      <p v-if="usage?.costIncomplete" class="line">{{ t('dash.kpi.costIncomplete') }}</p>
      <p v-if="totals" class="line">{{ t('dash.kpi.sessions', { n: totals.sessions }) }}</p>
    </template>
  </stat-tile>
  <stat-tile :icon="MessageSquare" :label="t('usageMetrics.modelCalls')" :value="totals?.modelCalls == null ? '—' : formatInt(totals.modelCalls, locale)">
    <template #note>
      <p class="line">{{ t('usageMetrics.callsHint') }}</p>
      <n-tooltip>
        <template #trigger><p tabindex="0" class="line hint-label">{{ t('usageMetrics.records', { n: totals?.messages ?? 0 }) }}</p></template>
        {{ t('usageMetrics.recordsHint') }}
      </n-tooltip>
      <p class="line">{{ t('usageMetrics.toolSteps', { n: totals?.toolCalls ?? 0, e: totals?.errors ?? 0 }) }}</p>
    </template>
  </stat-tile>
</template>

<style scoped>
.details { margin: 10px 0 0; display: grid; gap: 6px; }
.details > div { display: flex; justify-content: space-between; gap: 12px; }
dt { min-width: 0; overflow-wrap: anywhere; }
dd { margin: 0; color: var(--text-2); font-variant-numeric: tabular-nums; }
.line { margin: 8px 0 0; overflow-wrap: anywhere; }
.hint-label { text-decoration: underline dotted; text-underline-offset: 3px; cursor: help; }
</style>
