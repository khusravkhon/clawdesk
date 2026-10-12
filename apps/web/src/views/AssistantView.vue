<script setup lang="ts">
// Main assistant (screen 4): who it is, what it should know about the owner, and its memory.
import type { AssistantDto, AssistantProfile, MemoryProvider } from "@clawdesk/shared";
import { Brain, Check, Sparkles, UserRound } from "@lucide/vue";
import { NAlert, NButton, NInput, NInputNumber, NSkeleton, useMessage } from "naive-ui";
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";

const { t } = useI18n();
const message = useMessage();
const data = ref<AssistantDto | null>(null);
const form = reactive<AssistantProfile>({ name: "", emoji: "🧭", character: "", aboutUser: "", summaryMaxLines: 10 });
const saving = ref(false);
const memorySaving = ref<MemoryProvider | null>(null);

const EMOJIS = ["🧭", "🤖", "🦉", "🐱", "🦊", "🌟", "🧠", "💼", "🌿", "🚀", "☀️", "🎯"];
const styles = computed(() => [t("assistant.style.friendly"), t("assistant.style.business"), t("assistant.style.humor"), t("assistant.style.brief")]);

const errText = (e: unknown) => (e instanceof ApiError ? e.body.message : String(e));
const dirty = computed(() => {
  const p = data.value?.profile;
  return !p || p.name !== form.name || p.emoji !== form.emoji || p.character !== form.character || p.aboutUser !== form.aboutUser || p.summaryMaxLines !== form.summaryMaxLines;
});

function fill(dto: AssistantDto): void {
  data.value = dto;
  Object.assign(form, dto.profile);
}

async function load(): Promise<void> {
  try {
    fill(await api.assistant.get());
  } catch (e) {
    message.error(errText(e));
  }
}

function addStyle(s: string): void {
  form.character = form.character.trim() ? `${form.character.trim()} ${s}` : s;
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    fill(await api.assistant.save({ ...form }));
    message.success(t("assistant.saved", { name: form.name }));
  } catch (e) {
    message.error(errText(e));
  } finally {
    saving.value = false;
  }
}

async function setMemory(provider: MemoryProvider): Promise<void> {
  if (data.value?.memory.provider === provider) return;
  memorySaving.value = provider;
  try {
    const dto = await api.assistant.setMemory(provider);
    data.value = { ...dto, profile: data.value?.profile ?? dto.profile };
    message.success(t("assistant.memory.saved"));
  } catch (e) {
    message.error(errText(e));
  } finally {
    memorySaving.value = null;
  }
}

const memoryCurrent = computed(() => data.value?.memory.provider ?? "openai");

onMounted(load);
</script>

<template>
  <div>
    <page-header :title="t('assistant.title')" :subtitle="t('assistant.subtitle')" />

    <n-skeleton v-if="!data" height="300px" :sharp="false" />
    <template v-else>
      <n-alert v-if="!data.applied" type="info" :title="t('assistant.firstTitle')" class="block">{{ t("assistant.firstText") }}</n-alert>

      <div class="hero">
        <div class="avatar">{{ form.emoji }}</div>
        <div>
          <div class="hero-name">{{ form.name || t("agents.main") }}</div>
          <div class="hero-sub">{{ data.model ?? t("agents.noModel") }}</div>
        </div>
      </div>

      <div class="grid">
        <section class="card">
          <h2 class="card-title"><user-round :size="16" /> {{ t("assistant.whoTitle") }}</h2>
          <label class="field">
            <span>{{ t("assistant.name") }}</span>
            <n-input v-model:value="form.name" maxlength="60" :placeholder="t('assistant.namePlaceholder')" />
          </label>
          <div class="field">
            <span>{{ t("assistant.emoji") }}</span>
            <div class="emojis">
              <button v-for="e in EMOJIS" :key="e" type="button" class="emoji" :class="{ on: form.emoji === e }" :aria-label="e" @click="form.emoji = e">{{ e }}</button>
              <n-input v-model:value="form.emoji" size="small" class="emoji-input" maxlength="8" />
            </div>
          </div>
          <label class="field">
            <span>{{ t("assistant.character") }}</span>
            <n-input v-model:value="form.character" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" maxlength="2000" :placeholder="t('assistant.characterPlaceholder')" />
          </label>
          <div class="chips">
            <button v-for="s in styles" :key="s" type="button" class="chip" @click="addStyle(s)">+ {{ s }}</button>
          </div>
        </section>

        <section class="card">
          <h2 class="card-title"><sparkles :size="16" /> {{ t("assistant.aboutTitle") }}</h2>
          <p class="hint">{{ t("assistant.aboutHint") }}</p>
          <n-input v-model:value="form.aboutUser" type="textarea" :autosize="{ minRows: 8, maxRows: 18 }" maxlength="6000" :placeholder="t('assistant.aboutPlaceholder')" />
          <label class="field inline">
            <span>{{ t("assistant.summaryLines") }}</span>
            <n-input-number v-model:value="form.summaryMaxLines" :min="3" :max="50" size="small" class="lines" />
          </label>
        </section>
      </div>

      <div class="save-row">
        <n-button type="primary" :disabled="!dirty || !form.name.trim() || !form.emoji.trim()" :loading="saving" @click="save">
          <template #icon><check :size="16" /></template>
          {{ t("assistant.save") }}
        </n-button>
        <span class="muted small">{{ t("assistant.saveHint") }}</span>
      </div>

      <section class="card memory">
        <h2 class="card-title"><brain :size="16" /> {{ t("assistant.memory.title") }}</h2>
        <p class="hint">{{ t("assistant.memory.lead") }}</p>
        <n-alert v-if="data.memory.broken" type="warning" :bordered="false" class="block">{{ t("assistant.memory.broken") }}</n-alert>
        <div class="options">
          <button
            v-for="o in data.memory.options"
            :key="o"
            type="button"
            class="option"
            :class="{ on: memoryCurrent === o }"
            :disabled="!!memorySaving"
            @click="setMemory(o)"
          >
            <span class="opt-name">
              {{ t(`assistant.memory.opt.${o}`) }}
              <span v-if="o === data.memory.recommended" class="tag">{{ t("approvals.recommended") }}</span>
            </span>
            <span class="opt-desc">{{ t(`assistant.memory.desc.${o}`) }}</span>
            <span v-if="memorySaving === o" class="opt-desc">{{ t("assistant.memory.restarting") }}</span>
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 16px;
}
.hero {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 18px;
}
.avatar {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  font-size: 30px;
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.hero-name {
  font-size: 18px;
  font-weight: 600;
}
.hero-sub {
  font-size: 12.5px;
  color: var(--muted);
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  min-width: 0;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
}
.card-title :deep(svg) {
  color: var(--accent);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  font-size: 13px;
}
.field > span {
  color: var(--text-2);
  font-weight: 500;
}
.field.inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin: 14px 0 0;
}
.lines {
  width: 110px;
}
.emojis {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.emoji {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 18px;
  cursor: pointer;
}
.emoji.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.emoji-input {
  width: 70px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
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
.chip:hover {
  background: var(--surface-2);
}
.hint {
  margin: -6px 0 12px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.save-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0 24px;
  flex-wrap: wrap;
}
.small {
  font-size: 12px;
}
.options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.option {
  text-align: left;
  font: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.option.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.opt-name {
  font-weight: 600;
  font-size: 13.5px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.opt-desc {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
}
.tag {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}
@media (max-width: 900px) {
  .grid,
  .options {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
