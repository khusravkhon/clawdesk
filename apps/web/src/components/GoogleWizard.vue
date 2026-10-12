<script setup lang="ts">
// Google source, step by step: the person's own Google Cloud project and OAuth client (free, ~10 min),
// then sign-in. Shown inside the Google card of the sources screen.
import type { GoogleService, GoogleSourceDto, SourcesDto } from "@clawdesk/shared";
import { Check, ExternalLink, LogIn, Upload } from "@lucide/vue";
import { NA, NButton, NCheckbox, NCheckboxGroup, NInput, NSwitch, useMessage } from "naive-ui";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ google: GoogleSourceDto }>();
const emit = defineEmits<{ updated: [SourcesDto] }>();
const { t } = useI18n();
const message = useMessage();

const CONSOLE = "https://console.cloud.google.com";
const apis: { id: GoogleService; label: string; api: string }[] = [
  { id: "gmail", label: "Gmail", api: "gmail.googleapis.com" },
  { id: "drive", label: "Drive", api: "drive.googleapis.com" },
  { id: "docs", label: "Docs", api: "docs.googleapis.com" },
  { id: "sheets", label: "Sheets", api: "sheets.googleapis.com" },
  { id: "calendar", label: "Calendar", api: "calendar-json.googleapis.com" },
];

const clientJson = ref("");
const uploading = ref(false);
const email = ref("");
const services = ref<GoogleService[]>(["gmail", "drive", "docs", "sheets", "calendar"]);
const allowChanges = ref(false);
const starting = ref(false);
const pasteMode = ref(false);
const pasted = ref("");
const completing = ref(false);

const errText = (e: unknown) => (e instanceof ApiError ? e.body.message : String(e));
const emailOk = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()));

async function readFile(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) clientJson.value = await file.text();
}

async function uploadClient(): Promise<void> {
  uploading.value = true;
  try {
    emit("updated", await api.sources.googleClient(clientJson.value.trim()));
    clientJson.value = "";
    message.success(t("sources.google.clientSaved"));
  } catch (e) {
    message.error(errText(e));
  } finally {
    uploading.value = false;
  }
}

async function signIn(): Promise<void> {
  starting.value = true;
  try {
    const res = await api.sources.googleLogin(email.value.trim(), services.value, !allowChanges.value);
    if (res.returnsToPanel) {
      // Google brings the browser back to /api/sources/google/callback, then to the sources screen.
      window.location.assign(res.authorizationUrl);
      return;
    }
    window.open(res.authorizationUrl, "_blank", "noopener");
    pasteMode.value = true;
  } catch (e) {
    message.error(errText(e));
  } finally {
    starting.value = false;
  }
}

async function completePasted(): Promise<void> {
  completing.value = true;
  try {
    emit("updated", await api.sources.googleComplete(pasted.value.trim()));
    pasteMode.value = false;
    pasted.value = "";
    message.success(t("sources.google.connected"));
  } catch (e) {
    message.error(errText(e));
  } finally {
    completing.value = false;
  }
}
</script>

<template>
  <ol class="wizard">
    <li :class="{ done: google.clientConfigured }">
      <div class="step-title">{{ t("sources.google.s1") }}</div>
      <p>
        {{ t("sources.google.s1text") }}
        <n-a :href="`${CONSOLE}/projectcreate`" target="_blank" rel="noopener noreferrer">{{ t("sources.google.openConsole") }} <external-link :size="12" /></n-a>
      </p>
    </li>
    <li :class="{ done: google.clientConfigured }">
      <div class="step-title">{{ t("sources.google.s2") }}</div>
      <p class="links">
        <n-a v-for="a in apis" :key="a.id" :href="`${CONSOLE}/apis/library/${a.api}`" target="_blank" rel="noopener noreferrer">{{ a.label }} API</n-a>
      </p>
    </li>
    <li :class="{ done: google.clientConfigured }">
      <div class="step-title">{{ t("sources.google.s3") }}</div>
      <p>
        {{ t("sources.google.s3text") }}
        <n-a :href="`${CONSOLE}/auth/overview`" target="_blank" rel="noopener noreferrer">{{ t("sources.google.consent") }} <external-link :size="12" /></n-a>
        ·
        <n-a :href="`${CONSOLE}/auth/audience`" target="_blank" rel="noopener noreferrer">{{ t("sources.google.testUsers") }} <external-link :size="12" /></n-a>
      </p>
    </li>
    <li :class="{ done: google.clientConfigured }">
      <div class="step-title">{{ t("sources.google.s4") }}</div>
      <p>
        {{ t("sources.google.s4text") }}
        <n-a :href="`${CONSOLE}/auth/clients/create`" target="_blank" rel="noopener noreferrer">{{ t("sources.google.createClient") }} <external-link :size="12" /></n-a>
      </p>
      <template v-if="!google.clientConfigured">
        <label class="file">
          <upload :size="14" />
          <span>{{ t("sources.google.chooseFile") }}</span>
          <input type="file" accept="application/json,.json" @change="readFile" />
        </label>
        <n-input v-model:value="clientJson" type="textarea" :rows="3" :placeholder="t('sources.google.jsonPlaceholder')" class="json" />
        <n-button size="small" type="primary" :disabled="clientJson.trim().length < 20" :loading="uploading" @click="uploadClient">{{ t("sources.google.saveClient") }}</n-button>
      </template>
      <p v-else class="ok"><check :size="14" /> {{ t("sources.google.clientReady") }}</p>
    </li>
    <li :class="{ disabled: !google.clientConfigured }">
      <div class="step-title">{{ t("sources.google.s5") }}</div>
      <template v-if="google.clientConfigured">
        <n-input v-model:value="email" :placeholder="t('sources.google.emailPlaceholder')" class="email" />
        <n-checkbox-group v-model:value="services" class="services">
          <n-checkbox v-for="a in apis" :key="a.id" :value="a.id" :label="a.label" />
        </n-checkbox-group>
        <label class="switch">
          <n-switch v-model:value="allowChanges" size="small" />
          <span>{{ t("sources.google.allowChanges") }}</span>
        </label>
        <p class="hint">{{ allowChanges ? t("sources.google.changesHint") : t("sources.google.readonlyHint") }}</p>
        <n-button type="primary" :disabled="!emailOk || !services.length" :loading="starting" @click="signIn">
          <template #icon><log-in :size="16" /></template>
          {{ t("sources.google.signIn") }}
        </n-button>
        <div v-if="pasteMode" class="paste">
          <p>{{ t("sources.google.pasteHint") }}</p>
          <n-input v-model:value="pasted" placeholder="http://localhost:…/?state=…&code=…" />
          <n-button size="small" type="primary" :disabled="!pasted.startsWith('http://')" :loading="completing" @click="completePasted">{{ t("sources.google.finish") }}</n-button>
        </div>
      </template>
    </li>
  </ol>
</template>

<style scoped>
.wizard {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: step;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
li {
  counter-increment: step;
  position: relative;
  padding-left: 34px;
  font-size: 13px;
}
li::before {
  content: counter(step);
  position: absolute;
  left: 0;
  top: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 600;
  background: var(--surface-2);
  color: var(--text-2);
}
li.done::before {
  content: "✓";
  background: color-mix(in srgb, var(--good) 20%, transparent);
  color: var(--good-text);
}
li.disabled {
  opacity: 0.55;
}
.step-title {
  font-weight: 600;
  margin-bottom: 4px;
}
p {
  margin: 0 0 8px;
  color: var(--text-2);
  line-height: 1.55;
}
.links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--accent);
  margin-bottom: 8px;
}
.file input {
  display: none;
}
.json,
.email {
  margin-bottom: 8px;
}
.services {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-bottom: 10px;
}
.switch {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
}
.ok {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--good-text);
}
.paste {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
