<script setup lang="ts">
// Spending limits (screen 13). The owner says what a day and a month may cost; at the limit the
// panel pauses its own scheduled runs and refuses to start a new video job, and resumes exactly
// what it paused once spending allows. The owner's own messages are never blocked.
import type { BudgetDto } from "@clawdesk/shared";
import { NAlert, NButton, NInputNumber, useMessage } from "naive-ui";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import { formatCost } from "../format";

const { t, locale } = useI18n();
const message = useMessage();

const data = ref<BudgetDto | null>(null);
const daily = ref(0);
const monthly = ref(0);
const saving = ref(false);

const money = (value: number) => formatCost(value, locale.value);
const changed = computed(() => !!data.value && (daily.value !== data.value.dailyUsd || monthly.value !== data.value.monthlyUsd));

function apply(dto: BudgetDto): void {
  data.value = dto;
  daily.value = dto.dailyUsd;
  monthly.value = dto.monthlyUsd;
}

async function load(): Promise<void> {
  try {
    apply(await api.budget.get());
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  }
}
onMounted(load);

async function save(): Promise<void> {
  saving.value = true;
  try {
    apply(await api.budget.save({ dailyUsd: daily.value ?? 0, monthlyUsd: monthly.value ?? 0 }));
    message.success(t("budget.saved"));
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section v-if="data" class="card">
    <h2 class="card-title">{{ t("budget.title") }}</h2>
    <p class="hint">{{ t("budget.lead") }}</p>

    <n-alert v-if="data.exceeded" type="warning" :bordered="false" class="block">
      {{ t("budget.exceeded." + data.reason) }}
      <template v-if="data.pausedSchedules">&nbsp;{{ t("budget.paused", { count: data.pausedSchedules }) }}</template>
    </n-alert>
    <n-alert v-if="data.costIncomplete" type="info" :bordered="false" class="block">{{ t("budget.incomplete") }}</n-alert>

    <dl class="spent">
      <div>
        <dt>{{ t("budget.today") }}</dt>
        <dd>{{ money(data.spentTodayUsd) }}<span v-if="data.dailyUsd"> / {{ money(data.dailyUsd) }}</span></dd>
      </div>
      <div>
        <dt>{{ t("budget.month") }}</dt>
        <dd>{{ money(data.spentMonthUsd) }}<span v-if="data.monthlyUsd"> / {{ money(data.monthlyUsd) }}</span></dd>
      </div>
    </dl>

    <div class="fields">
      <label>
        <span class="label">{{ t("budget.dailyLimit") }}</span>
        <n-input-number v-model:value="daily" :min="0" :precision="2" :step="1" />
      </label>
      <label>
        <span class="label">{{ t("budget.monthlyLimit") }}</span>
        <n-input-number v-model:value="monthly" :min="0" :precision="2" :step="5" />
      </label>
      <n-button type="primary" :loading="saving" :disabled="!changed" @click="save">{{ t("budget.save") }}</n-button>
    </div>
    <p class="hint">{{ t("budget.zeroHint") }}</p>
  </section>
</template>

<style scoped>
.block {
  margin-bottom: 12px;
}
.hint {
  margin: 0 0 12px;
  font-size: 13px;
  opacity: 0.75;
}
.spent {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  margin: 0 0 14px;
}
.spent dt {
  font-size: 12px;
  opacity: 0.7;
}
.spent dd {
  margin: 2px 0 0;
  font-size: 18px;
  font-weight: 600;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.label {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  opacity: 0.7;
}
</style>
