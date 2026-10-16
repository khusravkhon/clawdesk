<script setup lang="ts">
import { NCheckbox, NCheckboxGroup, NSelect } from "naive-ui";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { WEEK_ORDER, weekdayShort } from "../cron";

const props = defineProps<{ modelValue: string; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const { t, locale } = useI18n();
type Mode = "daily" | "weekdays" | "weekends" | "custom";
const presetDays = { daily: "*", weekdays: "1,2,3,4,5", weekends: "0,6" };
const inferMode = (value: string): Mode => value === "*" ? "daily" : value === presetDays.weekdays ? "weekdays" : value === presetDays.weekends ? "weekends" : "custom";
const mode = ref<Mode>(inferMode(props.modelValue));
const options = computed(() => [
  { value: "daily", label: t("schedules.everyDay") },
  { value: "weekdays", label: t("schedules.repeatWeekdays") },
  { value: "weekends", label: t("schedules.repeatWeekends") },
  { value: "custom", label: t("schedules.repeatCustom") },
]);
const selected = computed(() => props.modelValue === "*" ? [...WEEK_ORDER] : props.modelValue.split(",").filter(Boolean).map(Number));
watch(() => props.modelValue, (value) => {
  if (value === "*" || mode.value !== "custom") mode.value = inferMode(value);
});

function setMode(value: Mode) {
  mode.value = value;
  emit("update:modelValue", value === "custom" ? (props.modelValue === "*" ? "1,2,3,4,5,6,0" : props.modelValue) : presetDays[value]);
}

function setDays(value: (string | number)[]) {
  emit("update:modelValue", [...new Set(value.map(Number))].sort((a, b) => a - b).join(","));
}
</script>

<template>
  <div class="repeat-control">
    <n-select :value="mode" :options="options" :disabled="disabled" :aria-label="t('schedules.repeat')" @update:value="setMode" />
    <n-checkbox-group v-if="mode === 'custom'" :value="selected" :disabled="disabled" :aria-label="t('schedules.days')" @update:value="setDays">
      <div class="weekdays">
        <n-checkbox v-for="day in WEEK_ORDER" :key="day" :value="day" :label="weekdayShort(day, locale)" />
      </div>
    </n-checkbox-group>
    <span v-if="mode === 'custom' && !modelValue && !disabled" class="validation" role="alert">{{ t('schedules.selectDays') }}</span>
  </div>
</template>

<style scoped>
.repeat-control { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.weekdays { display: flex; flex-wrap: wrap; gap: 10px 16px; }
.validation { font-size: 12px; color: var(--critical); }
</style>
