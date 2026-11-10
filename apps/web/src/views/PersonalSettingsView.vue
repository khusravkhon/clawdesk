<script setup lang="ts">
import { NAlert, NButton, NCard, NInput, useMessage } from "naive-ui";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, browserTimeZone } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";
import { useSpaceStore } from "../stores/space";
import { PERSONAL_SETTINGS_GROUPS } from "../personal-settings";

const { t } = useI18n();
const space = useSpaceStore();
const message = useMessage();
const name = ref(space.space?.name ?? "");
const timezone = ref(space.space?.timezone ?? browserTimeZone());
const saving = ref(false);
const failed = ref(false);
const valid = computed(() => {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone.value.trim() }); return true; }
  catch { return false; }
});
const changed = computed(() => name.value.trim() !== space.space?.name || timezone.value.trim() !== space.space?.timezone);
const groups = PERSONAL_SETTINGS_GROUPS;

async function save(): Promise<void> {
  if (saving.value || !valid.value || !name.value.trim()) return;
  saving.value = true;
  failed.value = false;
  try {
    const result = await api.space.update({ name: name.value.trim(), timezone: timezone.value.trim() });
    space.set(result);
    name.value = result.name;
    timezone.value = result.timezone;
    message.success(t("personalSettings.saved"));
  } catch { failed.value = true; }
  finally { saving.value = false; }
}
</script>

<template>
  <page-header :title="t('personalSettings.title')" />
  <n-card v-if="space.space" :title="t('personalSettings.space')">
    <form class="form" @submit.prevent="save">
      <label>{{ t("personalSettings.name") }}<n-input v-model:value="name" maxlength="80" :disabled="saving" /></label>
      <label>{{ t("personalSettings.zone") }}
        <n-input v-model:value="timezone" maxlength="64" placeholder="Asia/Dushanbe" :disabled="saving" />
      </label>
      <p>{{ t("personalSettings.zoneEffect", { device: browserTimeZone() }) }}</p>
      <n-alert v-if="!valid || failed" type="error">{{ t(!valid ? "personalSettings.invalidZone" : "personalSettings.failed") }}</n-alert>
      <n-button attr-type="submit" type="primary" :loading="saving" :disabled="!name.trim() || !valid || !changed">{{ t("today.save") }}</n-button>
    </form>
  </n-card>
  <router-link v-else to="/setup/mode">{{ t("personalSettings.setup") }}</router-link>
  <div class="groups">
    <n-card v-for="group in groups" :key="group.key" :title="t('personalSettings.' + group.key)">
      <ul><li v-for="[to, label] in group.links" :key="to"><router-link :to="to">{{ t(label) }}</router-link></li></ul>
    </n-card>
  </div>
</template>

<style scoped>
.form { display: grid; gap: 10px; max-width: 640px; }
.form label { display: grid; gap: 4px; }
.form button { justify-self: start; }
.groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 235px), 1fr)); gap: 12px; margin-top: 16px; }
.groups ul { margin: 0; padding-inline-start: 20px; }
</style>
