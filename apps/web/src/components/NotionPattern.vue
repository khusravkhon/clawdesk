<script setup lang="ts">
// How the owner's data in Notion is organised (data sources screen). The chosen pattern goes into every
// agent's rules: the main agent keeps Notion in that structure, juniors hand it their results to file.
import type { NotionPattern, NotionPatternDto } from "@clawdesk/shared";
import { Brain, ListChecks, PenLine } from "@lucide/vue";
import { NButton, NInput, NSelect, NSwitch, useMessage } from "naive-ui";
import { computed, onMounted, ref, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const { t } = useI18n();
const message = useMessage();

const data = ref<NotionPatternDto | null>(null);
const pattern = ref<NotionPattern | null>(null);
const notes = ref("");
const digest = ref(false);
const digestHour = ref(8);
const weekly = ref(false);
const saving = ref(false);

const options: { value: NotionPattern | null; icon: Component | null }[] = [
  { value: "second_brain", icon: Brain },
  { value: "tasks_notes", icon: ListChecks },
  { value: "custom", icon: PenLine },
  { value: null, icon: null },
];
const key = (value: NotionPattern | null) => value ?? "none";
const hours = Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, "0")}:00`, value: h }));

function errText(e: unknown): string {
  if (!(e instanceof ApiError)) return String(e);
  if (e.body.error === "budget_usage_unavailable") return t("budget.unavailable");
  if (e.body.error === "budget_exceeded") return t("budget.exceeded." + e.body.message);
  return e.body.message;
}

function apply(dto: NotionPatternDto): void {
  data.value = dto;
  pattern.value = dto.pattern;
  notes.value = dto.notes;
  digest.value = dto.digestHour !== null;
  digestHour.value = dto.digestHour ?? 8;
  weekly.value = dto.weeklyReview;
}

const request = computed(() => ({
  pattern: pattern.value,
  notes: pattern.value ? notes.value.trim() : "",
  digestHour: pattern.value && digest.value ? digestHour.value : null,
  weeklyReview: !!pattern.value && weekly.value,
}));
const changed = computed(() => {
  const d = data.value;
  if (!d) return false;
  const r = request.value;
  return r.pattern !== d.pattern || r.notes !== d.notes || r.digestHour !== d.digestHour || r.weeklyReview !== d.weeklyReview;
});
const customTooShort = computed(() => pattern.value === "custom" && notes.value.trim().length < 20);

onMounted(async () => {
  try {
    apply(await api.sources.notionPattern());
  } catch (e) {
    message.error(errText(e));
  }
});

async function save(): Promise<void> {
  saving.value = true;
  const chose = request.value.pattern !== data.value?.pattern;
  try {
    apply(await api.sources.saveNotionPattern(request.value));
    message.success(request.value.pattern ? (chose ? t("sources.notion.pattern.savedMapping") : t("sources.notion.pattern.saved")) : t("sources.notion.pattern.off"));
  } catch (e) {
    message.error(errText(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="pattern">
    <h3>{{ t("sources.notion.pattern.title") }}</h3>
    <p class="hint">{{ t("sources.notion.pattern.about") }}</p>

    <div v-if="data" class="choices" role="radiogroup" :aria-label="t('sources.notion.pattern.title')">
      <button
        v-for="o in options"
        :key="key(o.value)"
        type="button"
        role="radio"
        class="choice"
        :class="{ on: pattern === o.value }"
        :aria-checked="pattern === o.value"
        @click="pattern = o.value"
      >
        <component :is="o.icon" v-if="o.icon" :size="16" class="icon" />
        <span class="text">
          <strong>{{ t(`sources.notion.pattern.${key(o.value)}.name`) }}</strong>
          <small>{{ t(`sources.notion.pattern.${key(o.value)}.about`) }}</small>
        </span>
      </button>
    </div>

    <template v-if="data && pattern">
      <label class="field">
        <span>{{ pattern === "custom" ? t("sources.notion.pattern.customLabel") : t("sources.notion.pattern.notesLabel") }}</span>
        <n-input
          v-model:value="notes"
          type="textarea"
          :autosize="{ minRows: pattern === 'custom' ? 4 : 2, maxRows: 10 }"
          :maxlength="4000"
          :placeholder="pattern === 'custom' ? t('sources.notion.pattern.customPlaceholder') : t('sources.notion.pattern.notesPlaceholder')"
        />
      </label>

      <label class="toggle">
        <n-switch v-model:value="digest" />
        <span>{{ t("sources.notion.pattern.digest") }}</span>
      </label>
      <n-select v-if="digest" v-model:value="digestHour" :options="hours" size="small" class="hour" :aria-label="t('sources.notion.pattern.digest')" />
      <label class="toggle">
        <n-switch v-model:value="weekly" />
        <span>{{ t("sources.notion.pattern.weekly") }}</span>
      </label>
      <p class="hint">
        {{ t("sources.notion.pattern.agents", { n: data.agents }) }}
      </p>
    </template>

    <n-button v-if="data" type="primary" size="small" :disabled="!changed || customTooShort" :loading="saving" @click="save">
      {{ t("sources.notion.pattern.save") }}
    </n-button>
    <p v-if="customTooShort" class="hint">{{ t("sources.notion.pattern.customTooShort") }}</p>
  </div>
</template>

<style scoped>
.pattern {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
}
.choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 8px;
  width: 100%;
}
.choice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  text-align: left;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border-subtle);
  background: var(--surface-2);
  color: var(--text);
  cursor: pointer;
  font: inherit;
}
.choice:hover {
  border-color: var(--border);
}
.choice.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.choice:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.icon {
  flex: none;
  margin-top: 2px;
  color: var(--accent);
}
.text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.text small {
  font-size: 12px;
  color: var(--text-2);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  font-size: 13px;
  color: var(--text-2);
}
.toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  cursor: pointer;
}
.toggle span {
  flex: 1;
  min-width: 0;
}
.hour {
  width: 96px;
  margin-left: 50px;
}
</style>
