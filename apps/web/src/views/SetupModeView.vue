<script setup lang="ts">
// Screen 2: what this install is for — chosen once, right after the owner password.
import type { Locale, SpaceMode } from "@clawdesk/shared";
import { Building2, UserRound } from "@lucide/vue";
import { NAlert, NButton, NCard, NInput, NSelect, NSpace } from "naive-ui";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";
import { setLocale, supportedLocales } from "../i18n";
import { useSpaceStore } from "../stores/space";

const { t, locale } = useI18n();
const router = useRouter();
const store = useSpaceStore();

const mode = ref<SpaceMode | null>(null);
const name = ref("");
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
const saving = ref(false);
const error = ref<string | null>(null);

const modes: { id: SpaceMode; icon: typeof UserRound }[] = [
  { id: "personal", icon: UserRound },
  { id: "company", icon: Building2 },
];
const localeOptions = computed(() => supportedLocales.map((value) => ({ value, label: t(`lang.${value}`) })));
const timezoneOptions = computed(() => {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [timezone.value];
  return (zones.includes(timezone.value) ? zones : [timezone.value, ...zones]).map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
});

function pick(id: SpaceMode): void {
  mode.value = id;
  if (!name.value.trim()) name.value = t(`mode.${id}.defaultName`);
}

async function save(): Promise<void> {
  if (!mode.value) return;
  saving.value = true;
  error.value = null;
  try {
    store.set(await api.space.create({ mode: mode.value, name: name.value.trim(), locale: locale.value as Locale, timezone: timezone.value }));
    await router.replace({ name: "setup-ai" });
  } catch (e) {
    error.value = e instanceof ApiError ? e.body.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <page-header :title="t('mode.title')" :subtitle="t('mode.lead')" />
    <n-space vertical size="large">
      <div class="modes">
        <button v-for="m in modes" :key="m.id" type="button" class="mode" :class="{ active: mode === m.id }" @click="pick(m.id)">
          <component :is="m.icon" :size="22" />
          <strong>{{ t(`mode.${m.id}.title`) }}</strong>
          <span>{{ t(`mode.${m.id}.text`) }}</span>
        </button>
      </div>

      <n-card v-if="mode">
        <n-space vertical>
          <label class="field">
            <span>{{ t(`mode.${mode}.nameLabel`) }}</span>
            <n-input v-model:value="name" :maxlength="80" />
          </label>
          <label class="field">
            <span>{{ t("mode.language") }}</span>
            <n-select :value="locale" :options="localeOptions" @update:value="(v: Locale) => setLocale(v)" />
          </label>
          <label class="field">
            <span>{{ t("mode.timezone") }}</span>
            <n-select v-model:value="timezone" :options="timezoneOptions" filterable />
          </label>
          <n-alert type="info" :show-icon="false">{{ t("mode.once") }}</n-alert>
          <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>
          <n-button type="primary" size="large" :loading="saving" :disabled="!name.trim()" @click="save">{{ t("mode.continue") }}</n-button>
        </n-space>
      </n-card>
    </n-space>
  </div>
</template>

<style scoped>
.modes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
.mode {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--card-shadow);
  background: var(--surface);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.mode span {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
}
.mode:hover,
.mode:focus-visible {
  border-color: var(--accent);
  outline: none;
}
.mode.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
}
</style>
