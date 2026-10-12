<script setup lang="ts">
// New or edited schedule: which agent, what to do, at what time and on which days.
import type { AgentListItemDto, ScheduleDto } from "@clawdesk/shared";
import { NButton, NInput, NSelect, NTimePicker } from "naive-ui";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { parseCron, toCron, WEEK_ORDER, weekdayShort } from "../cron";

const props = defineProps<{ agents: AgentListItemDto[]; schedule?: ScheduleDto; saving?: boolean }>();
const emit = defineEmits<{ save: [{ agentId: string; label: string; prompt: string; cron: string }]; cancel: [] }>();
const { t, locale } = useI18n();

const parsed = parseCron(props.schedule?.cron ?? null);
const agentId = ref(props.schedule?.agentId ?? props.agents.find((a) => a.role === "main")?.id ?? props.agents[0]?.id ?? "main");
const label = ref(props.schedule?.label ?? "");
const prompt = ref(props.schedule?.prompt ?? "");
// The time picker works in ms since midnight (UTC-free: only the time of day matters here).
const time = ref<number>(((parsed?.hour ?? 8) * 60 + (parsed?.minute ?? 0)) * 60_000);
const days = ref<number[]>(parsed?.days ?? []);

const agentOptions = computed(() =>
  props.agents.map((a) => ({ value: a.id, label: `${a.emoji ?? (a.role === "main" ? "🧭" : "🤖")}  ${a.role === "main" && a.name === a.id ? t("agents.main") : a.name}` })),
);

function toggle(day: number): void {
  days.value = days.value.includes(day) ? days.value.filter((d) => d !== day) : [...days.value, day];
}

const valid = computed(() => label.value.trim() && prompt.value.trim() && agentId.value);

function save(): void {
  const minutes = Math.round(time.value / 60_000);
  emit("save", { agentId: agentId.value, label: label.value.trim(), prompt: prompt.value.trim(), cron: toCron({ hour: Math.floor(minutes / 60) % 24, minute: minutes % 60, days: days.value }) });
}

const presets = computed(() => [
  { label: t("schedules.preset.plan"), prompt: t("schedules.preset.planPrompt"), hour: 8 },
  { label: t("schedules.preset.mail"), prompt: t("schedules.preset.mailPrompt"), hour: 9 },
  { label: t("schedules.preset.evening"), prompt: t("schedules.preset.eveningPrompt"), hour: 20 },
]);
function usePreset(p: { label: string; prompt: string; hour: number }): void {
  label.value = p.label;
  prompt.value = p.prompt;
  time.value = p.hour * 3_600_000;
}
</script>

<template>
  <div class="form">
    <div v-if="!schedule" class="presets">
      <span class="muted">{{ t("schedules.presetsTitle") }}</span>
      <button v-for="p in presets" :key="p.label" type="button" class="chip" @click="usePreset(p)">{{ p.label }}</button>
    </div>
    <div class="grid">
      <label>
        <span>{{ t("schedules.agent") }}</span>
        <n-select v-model:value="agentId" :options="agentOptions" :disabled="!!schedule" />
      </label>
      <label>
        <span>{{ t("schedules.name") }}</span>
        <n-input v-model:value="label" :placeholder="t('schedules.namePlaceholder')" maxlength="120" />
      </label>
    </div>
    <label>
      <span>{{ t("schedules.task") }}</span>
      <n-input v-model:value="prompt" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" :placeholder="t('schedules.taskPlaceholder')" maxlength="4000" />
    </label>
    <div class="when">
      <label class="time">
        <span>{{ t("schedules.time") }}</span>
        <n-time-picker v-model:value="time" format="HH:mm" :minutes="5" time-zone="UTC" :actions="null" />
      </label>
      <div class="days">
        <span>{{ t("schedules.days") }}</span>
        <div class="day-row">
          <button type="button" class="day" :class="{ on: !days.length }" @click="days = []">{{ t("schedules.everyDay") }}</button>
          <button v-for="d in WEEK_ORDER" :key="d" type="button" class="day" :class="{ on: days.includes(d) }" @click="toggle(d)">{{ weekdayShort(d, locale) }}</button>
        </div>
      </div>
    </div>
    <div class="actions">
      <n-button type="primary" :disabled="!valid" :loading="saving" @click="save">{{ schedule ? t("schedules.saveChanges") : t("schedules.create") }}</n-button>
      <n-button quaternary @click="emit('cancel')">{{ t("schedules.cancel") }}</n-button>
    </div>
  </div>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
label,
.days {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
label > span,
.days > span {
  color: var(--text-2);
  font-weight: 500;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.when {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  align-items: flex-start;
}
.time {
  width: 140px;
}
.day-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.day,
.chip {
  font: inherit;
  font-size: 12.5px;
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
.day.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.presets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.chip:hover {
  background: var(--surface-2);
}
.actions {
  display: flex;
  gap: 8px;
}
@media (max-width: 640px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
