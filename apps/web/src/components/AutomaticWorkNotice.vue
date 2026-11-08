<script setup lang="ts">
import type { BudgetDto } from "@clawdesk/shared";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";

defineProps<{ kind: "schedule" | "video" }>();
const { t } = useI18n();
const limits = ref<Pick<BudgetDto, "dailyUsd" | "monthlyUsd"> | null>(null);
onMounted(async () => { try { limits.value = await api.budget.limits(); } catch { /* The server still checks limits. */ } });
</script>

<template>
  <p class="automatic">
    {{ t('budget.automatic.' + kind) }}
    <span v-if="limits">{{ t('today.quick.limits', { daily: limits.dailyUsd || '—', monthly: limits.monthlyUsd || '—' }) }}</span>
    <span v-else>{{ t('budget.automatic.limitsUnknown') }}</span>
    <router-link to="/usage">{{ t('budget.title') }}</router-link>
  </p>
</template>

<style scoped>
.automatic { margin: 4px 0; font-size: 13px; overflow-wrap: anywhere; }
.automatic > * { margin-inline-start: 6px; }
</style>
