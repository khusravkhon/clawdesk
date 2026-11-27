<script setup lang="ts">
// The person's own Chrome for agents: install the OpenClaw extension, paste the pairing string once.
// The extension's own settings page is English only, so every label the person must find there is quoted as is.
import type { ChromeStatusDto } from "@clawdesk/shared";
import { Check, ClipboardPaste, Copy, ExternalLink, KeyRound, Puzzle, ShieldCheck } from "@lucide/vue";
import { NAlert, NButton, NSkeleton, useMessage } from "naive-ui";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";

const STORE_URL = "https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig";

const { t } = useI18n();
const message = useMessage();
const status = ref<ChromeStatusDto | null>(null);
const pairing = ref<string | null>(null);
const creating = ref(false);
const copied = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
  status.value = await api.chrome.status().catch(() => ({ available: false, connected: false }));
}

async function create(): Promise<void> {
  creating.value = true;
  try {
    pairing.value = (await api.chrome.pairing()).pairingString;
  } catch {
    message.error(t("chrome.createFailed"));
  } finally {
    creating.value = false;
  }
}

async function copy(): Promise<void> {
  if (!pairing.value) return;
  try {
    await navigator.clipboard.writeText(pairing.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    message.warning(t("chrome.copyFailed"));
  }
}

onMounted(() => {
  void load();
  // The person pastes the string in another tab: the page notices the connection by itself.
  timer = setInterval(() => { if (!document.hidden) void load(); }, 5000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="chrome">
    <page-header :title="t('chrome.title')" :subtitle="t('chrome.subtitle')" />

    <n-skeleton v-if="!status" height="84px" :sharp="false" />
    <section v-else class="status" :class="status.connected ? 'on' : status.available ? 'wait' : 'off'" role="status" data-testid="chrome-status">
      <span class="dot" aria-hidden="true" />
      <div>
        <strong>{{ t(status.connected ? "chrome.connected" : status.available ? "chrome.waiting" : "chrome.unavailable") }}</strong>
        <p>{{ t(status.connected ? "chrome.connectedText" : status.available ? "chrome.waitingText" : "chrome.unavailableText") }}</p>
      </div>
    </section>

    <template v-if="status?.available">
      <ol class="steps">
        <li class="step">
          <span class="num">1</span>
          <div class="body">
            <h3><puzzle :size="16" /> {{ t("chrome.step1.title") }}</h3>
            <p>{{ t("chrome.step1.text") }}</p>
            <n-button tag="a" :href="STORE_URL" target="_blank" rel="noopener" secondary>
              <template #icon><external-link :size="15" /></template>
              {{ t("chrome.step1.button") }}
            </n-button>
          </div>
        </li>

        <li class="step">
          <span class="num">2</span>
          <div class="body">
            <h3><key-round :size="16" /> {{ t("chrome.step2.title") }}</h3>
            <p>{{ t("chrome.step2.text") }}</p>
            <n-button v-if="!pairing" type="primary" :loading="creating" data-testid="chrome-create" @click="create">{{ t("chrome.step2.button") }}</n-button>
            <template v-else>
              <div class="secret">
                <!-- Never shown in full: it is a password to the browser, and a screen can be shared. -->
                <code aria-hidden="true">{{ pairing.slice(0, 10) }}••••••••••••••••</code>
                <n-button :type="copied ? 'success' : 'primary'" data-testid="chrome-copy" @click="copy">
                  <template #icon><check v-if="copied" :size="15" /><copy v-else :size="15" /></template>
                  {{ t(copied ? "chrome.step2.copied" : "chrome.step2.copy") }}
                </n-button>
              </div>
              <n-alert type="warning" :bordered="false" :show-icon="false" class="note">{{ t("chrome.step2.secret") }}</n-alert>
            </template>
          </div>
        </li>

        <li class="step">
          <span class="num">3</span>
          <div class="body">
            <h3><clipboard-paste :size="16" /> {{ t("chrome.step3.title") }}</h3>
            <ol class="how">
              <li>{{ t("chrome.step3.open") }} <kbd>Settings</kbd></li>
              <li>{{ t("chrome.step3.find") }} <kbd>Advanced manual pairing</kbd></li>
              <li>{{ t("chrome.step3.paste") }} <kbd>Pair manually</kbd></li>
            </ol>
            <p class="muted">{{ t("chrome.step3.ignore") }}</p>
          </div>
        </li>
      </ol>

      <section class="after">
        <h3><shield-check :size="16" /> {{ t("chrome.rules.title") }}</h3>
        <ul>
          <li>{{ t("chrome.rules.computer") }}</li>
          <li>{{ t("chrome.rules.tabs") }}</li>
          <li>{{ t("chrome.rules.login") }}</li>
          <li>{{ t("chrome.rules.terms") }}</li>
        </ul>
        <p class="try"><span>{{ t("chrome.try") }}</span> <q>{{ t("chrome.tryText") }}</q></p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.chrome { display: grid; gap: 16px; max-width: 760px; }
.status {
  display: flex; align-items: center; gap: 14px; padding: 18px 20px;
  border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface); box-shadow: var(--card-shadow);
}
.status strong { font-size: 16px; }
.status p { margin: 2px 0 0; font-size: 13px; color: var(--text-2); }
.dot { flex: none; width: 12px; height: 12px; border-radius: 50%; background: var(--muted); }
.status.on { border-color: var(--good); background: var(--good-soft); }
.status.on .dot { background: var(--good); box-shadow: 0 0 0 5px var(--good-soft); }
.status.wait .dot { background: var(--warning); animation: pulse 1.6s ease-in-out infinite; }
.status.off .dot { background: var(--critical); }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .status.wait .dot { animation: none; } }

.steps { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.step {
  display: flex; gap: 16px; padding: 18px 20px;
  border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface); box-shadow: var(--card-shadow);
}
.num {
  flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%;
  background: var(--accent-soft); color: var(--accent); font-weight: 600;
}
.body { min-width: 0; flex: 1; }
h3 { display: flex; align-items: center; gap: 8px; margin: 3px 0 6px; font-size: 15px; }
.body p { margin: 0 0 12px; font-size: 14px; line-height: 1.55; color: var(--text-2); }
.secret { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.secret code {
  flex: 1; min-width: 180px; padding: 8px 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--surface-2); font-size: 13px;
}
.note { margin-top: 12px; }
.how { margin: 0 0 10px; padding-left: 20px; font-size: 14px; line-height: 1.9; }
kbd {
  padding: 2px 7px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2);
  font: inherit; font-size: 13px; white-space: nowrap;
}
.body p.muted { margin: 0; font-size: 13px; }
.after { padding: 18px 20px; border: 1px dashed var(--border); border-radius: var(--radius-card); }
.after ul { margin: 0 0 12px; padding-left: 20px; font-size: 14px; line-height: 1.7; color: var(--text-2); }
.try { margin: 0; font-size: 14px; }
.try span { color: var(--text-2); }
.try q { font-style: italic; }
</style>
