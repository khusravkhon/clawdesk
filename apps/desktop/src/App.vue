<script setup lang="ts">
// The launcher: ClawDesk on this computer (Docker Desktop), the person's servers, adding one that has
// ClawDesk, installing it on a new one.
// The panel itself always opens in its own window, loaded from the server.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ExternalLink, Monitor, Plus, RefreshCw, Server as ServerIcon, Trash2, Wand2 } from "@lucide/vue";
import { darkTheme, NAlert, NButton, NCard, NConfigProvider, NEmpty, NGlobalStyle, NInput, NInputNumber, NMessageProvider, NPopconfirm, NRadio, NRadioGroup, NSpace } from "naive-ui";
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, errorText, type InstallInput, type Server } from "./api";
import LocalRecovery from './LocalRecovery.vue';

const { t } = useI18n();

// Follow the system's light/dark choice.
const dark = ref(window.matchMedia("(prefers-color-scheme: dark)").matches);
const media = window.matchMedia("(prefers-color-scheme: dark)");
const onScheme = (e: MediaQueryListEvent) => (dark.value = e.matches);
media.addEventListener("change", onScheme);
const theme = computed(() => (dark.value ? darkTheme : null));
const overrides = computed(() => ({ common: { primaryColor: dark.value ? "#7c70f0" : "#5b4fd9", primaryColorHover: dark.value ? "#8f85f3" : "#6c61e0", fontFamily: '"Inter Variable", system-ui, sans-serif', borderRadius: "8px" } }));
const syncTheme = () => document.documentElement.setAttribute("data-theme", dark.value ? "dark" : "light");

const view = ref<"list" | "add" | "install" | "local">("list");
const servers = ref<Server[]>([]);
const localServer = computed(() => servers.value.find((s) => s.local) ?? null);
const remoteServers = computed(() => servers.value.filter((s) => !s.local));
const error = ref<string | null>(null);
const opening = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    servers.value = await api.listServers();
    error.value = null;
  } catch (e) {
    error.value = errorText(e);
  }
}

async function open(id: string, path?: string): Promise<void> {
  opening.value = id;
  try {
    await api.openPanel(id, path);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    opening.value = null;
  }
}

async function remove(id: string): Promise<void> {
  await api.removeServer(id).catch((e) => (error.value = errorText(e)));
  await load();
}

// --- Add a server that already has ClawDesk.
const add = reactive({ name: "", host: "", port: 22, user: "root", password: "", privateKey: "", panelUrl: "" });
const adding = ref(false);
async function saveServer(): Promise<void> {
  adding.value = true;
  error.value = null;
  try {
    await api.addServer({
      name: add.name.trim() || add.host.trim(),
      host: add.host.trim(),
      port: add.port,
      user: add.user.trim(),
      password: add.password || null,
      privateKey: add.privateKey.trim() || null,
      panelUrl: add.panelUrl.trim() || null,
    });
    Object.assign(add, { name: "", host: "", password: "", privateKey: "", panelUrl: "" });
    view.value = "list";
    await load();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    adding.value = false;
  }
}

// --- Install on a fresh server.
const inst = reactive<InstallInput>({ name: "", host: "", port: 22, user: "root", password: "", https: "sslip", domain: null });
const installing = ref(false);
const log = ref<string[]>([]);
const step = ref<string | null>(null);
const result = ref<{ id: string; setupUrl: string | null } | null>(null);
const logBox = ref<HTMLElement | null>(null);
const unlisten: (() => void)[] = [];

/**
 * The installer found data a newer ClawDesk wrote (deploy/scripts/init.sh): nothing was changed, and the person
 * chooses — update this app, set the data aside and install clean, or cancel.
 */
const dataNewer = ref<{ data: string; app: string; retry: () => Promise<void> } | null>(null);
function newerData(e: unknown): { data: string; app: string } | null {
  const m = /data_newer:([\d.]+):([\d.]+)/.exec(errorText(e));
  return m ? { data: m[1]!, app: m[2]! } : null;
}

async function startInstall(setAside = false): Promise<void> {
  installing.value = true;
  error.value = null;
  dataNewer.value = null;
  log.value = [];
  result.value = null;
  try {
    const res = await api.installServer({ ...inst, name: inst.name.trim() || inst.host.trim(), domain: inst.https === "domain" ? (inst.domain ?? "").trim() : null, setAsideNewerData: setAside });
    result.value = { id: res.server.id, setupUrl: res.setupUrl };
    inst.password = "";
    await load();
  } catch (e) {
    const newer = newerData(e);
    if (newer) dataNewer.value = { ...newer, retry: () => startInstall(true) };
    else error.value = `${t("installFailed")}: ${errorText(e)}`;
  } finally {
    installing.value = false;
  }
}

// --- This computer: ClawDesk in Docker Desktop here (also how it updates: the app's own version of the code).
async function startLocal(setAside = false): Promise<void> {
  view.value = "local";
  installing.value = true;
  error.value = null;
  dataNewer.value = null;
  log.value = [];
  result.value = null;
  try {
    const res = await api.installLocal(t("thisComputer"), setAside);
    result.value = { id: res.server.id, setupUrl: res.setupUrl };
    await load();
  } catch (e) {
    const newer = newerData(e);
    if (newer) dataNewer.value = { ...newer, retry: () => startLocal(true) };
    else error.value = `${t("installFailed")}: ${errorText(e)}`;
  } finally {
    installing.value = false;
  }
}

/** The owner code's path (/setup?code=…) opened in the panel window, whichever way it is reached. */
async function openSetup(): Promise<void> {
  if (!result.value) return;
  const url = result.value.setupUrl ? new URL(result.value.setupUrl) : null;
  await open(result.value.id, url ? `${url.pathname}${url.search}` : undefined);
}

// --- Updates (GitHub releases).
const update = ref<Update | null>(null);
const updating = ref(false);
async function installUpdate(): Promise<void> {
  if (!update.value) return;
  updating.value = true;
  try {
    await update.value.downloadAndInstall();
    await relaunch();
  } catch (e) {
    error.value = errorText(e);
    updating.value = false;
  }
}

onMounted(async () => {
  syncTheme();
  await load();
  unlisten.push(
    await api.onInstallLog((e) => {
      log.value.push(e.line);
      if (log.value.length > 2000) log.value.splice(0, 500);
      requestAnimationFrame(() => logBox.value?.scrollTo({ top: logBox.value.scrollHeight }));
    }),
    await api.onInstallStep((e) => (step.value = e.step)),
  );
  // No network or no release yet: stay quiet.
  update.value = await check().catch(() => null);
});
onUnmounted(() => {
  unlisten.forEach((u) => u());
  media.removeEventListener("change", onScheme);
});
watch(dark, syncTheme);
// A finished install (on a server or here) is not shown again when another screen opens.
watch(view, () => {
  if (installing.value) return;
  result.value = null;
  log.value = [];
});
</script>

<template>
  <n-config-provider :theme="theme" :theme-overrides="overrides">
    <n-global-style />
    <n-message-provider>
      <main class="wrap">
        <header class="top">
          <div class="brand"><div class="logo">C</div><span>{{ t("title") }}</span></div>
          <n-button v-if="update" size="small" type="primary" :loading="updating" @click="installUpdate">
            {{ t("updateAvailable", { v: update.version }) }} · {{ t("updateInstall") }}
          </n-button>
        </header>

        <n-alert v-if="error" type="error" closable class="gap" @close="error = null">{{ error }}</n-alert>
        <n-alert v-if="dataNewer" type="warning" class="gap" :title="t('dataNewerTitle')">
          <p>{{ t("dataNewerText", { data: dataNewer.data, app: dataNewer.app }) }}</p>
          <n-space class="gap">
            <n-button type="primary" :disabled="!update || installing" :loading="updating" @click="installUpdate">{{ t("dataNewerUpdate") }}</n-button>
            <n-button :disabled="installing" @click="dataNewer.retry()">{{ t("dataNewerSetAside") }}</n-button>
            <n-button quaternary :disabled="installing" @click="dataNewer = null">{{ t("dataNewerCancel") }}</n-button>
          </n-space>
          <p v-if="!update" class="muted small">{{ t("dataNewerNoUpdate") }}</p>
          <p class="muted small">{{ t("dataNewerSetAsideHint") }}</p>
        </n-alert>

        <!-- Servers -->
        <template v-if="view === 'list'">
          <!-- This computer -->
          <n-card class="gap local">
            <div class="server">
              <monitor :size="20" class="muted" />
              <div class="grow">
                <strong>{{ t("thisComputer") }}</strong>
                <div v-if="localServer" class="muted small">{{ t("localRunsIn", { url: localServer.panelUrl }) }}</div>
                <div v-else class="muted small">{{ t("localLead") }}</div>
              </div>
              <template v-if="localServer">
                <n-button type="primary" :loading="opening === localServer.id" @click="open(localServer.id)"><template #icon><external-link :size="15" /></template>{{ t("open") }}</n-button>
                <n-button quaternary circle :title="t('localUpdate')" :aria-label="t('localUpdate')" @click="startLocal()"><refresh-cw :size="16" /></n-button>
                <n-popconfirm @positive-click="remove(localServer.id)">
                  <template #trigger><n-button quaternary circle :aria-label="t('remove')"><trash-2 :size="16" /></n-button></template>
                  {{ t("localRemoveConfirm") }}
                </n-popconfirm>
              </template>
              <n-button v-else @click="view = 'local'">{{ t("localSetup") }}</n-button>
            </div>
            <LocalRecovery v-if="localServer" />
          </n-card>

          <div class="row">
            <h1>{{ t("servers") }}</h1>
            <n-space>
              <n-button @click="view = 'add'"><template #icon><plus :size="16" /></template>{{ t("add") }}</n-button>
              <n-button type="primary" @click="view = 'install'"><template #icon><wand2 :size="16" /></template>{{ t("install") }}</n-button>
            </n-space>
          </div>
          <n-empty v-if="!remoteServers.length" :description="t('empty')" class="gap" />
          <n-card v-for="s in remoteServers" :key="s.id" class="gap">
            <div class="server">
              <server-icon :size="20" class="muted" />
              <div class="grow">
                <strong>{{ s.name }}</strong>
                <div class="muted small">{{ s.user }}@{{ s.host }}:{{ s.port }} · {{ s.panelUrl ?? t("viaTunnel") }}</div>
                <div class="muted small" :title="s.hostKey">{{ t("hostKey") }}: <code>{{ s.hostKey.slice(0, 24) }}…</code></div>
              </div>
              <n-button type="primary" :loading="opening === s.id" @click="open(s.id)"><template #icon><external-link :size="15" /></template>{{ t("open") }}</n-button>
              <n-popconfirm @positive-click="remove(s.id)">
                <template #trigger><n-button quaternary circle :aria-label="t('remove')"><trash-2 :size="16" /></n-button></template>
                {{ t("removeConfirm") }}
              </n-popconfirm>
            </div>
          </n-card>
        </template>

        <!-- Add an installed server -->
        <n-card v-else-if="view === 'add'" :title="t('add')">
          <form class="form" @submit.prevent="saveServer">
            <label>{{ t("name") }}<n-input v-model:value="add.name" /></label>
            <div class="two">
              <label>{{ t("host") }}<n-input v-model:value="add.host" placeholder="203.0.113.10" /></label>
              <label>{{ t("port") }}<n-input-number v-model:value="add.port" :min="1" :max="65535" :show-button="false" /></label>
            </div>
            <label>{{ t("user") }}<n-input v-model:value="add.user" /></label>
            <label>{{ t("password") }}<n-input v-model:value="add.password" type="password" show-password-on="click" /></label>
            <small class="muted">{{ t("passwordHint") }}</small>
            <label>{{ t("privateKey") }}<n-input v-model:value="add.privateKey" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></label>
            <label>{{ t("panelUrl") }}<n-input v-model:value="add.panelUrl" placeholder="https://panel.example.com" /></label>
            <small class="muted">{{ t("panelUrlHint") }}</small>
            <n-space>
              <n-button @click="view = 'list'">{{ t("back") }}</n-button>
              <n-button attr-type="submit" type="primary" :loading="adding" :disabled="!add.host.trim() || !(add.password || add.privateKey.trim())">{{ t("save") }}</n-button>
            </n-space>
          </form>
        </n-card>

        <!-- This computer: set up / update -->
        <n-card v-else-if="view === 'local'" :title="t('thisComputer')">
          <template v-if="!result">
            <p class="muted">{{ t("localExplain") }}</p>
            <ul class="muted needs">
              <li>{{ t("localNeedDocker") }}</li>
              <li>{{ t("localNeedGit") }}</li>
              <li>{{ t("localNeedTime") }}</li>
            </ul>
            <n-space>
              <n-button :disabled="installing" @click="view = 'list'">{{ t("back") }}</n-button>
              <n-button type="primary" :loading="installing" @click="startLocal()">{{ installing ? t("installing") : localServer ? t("localUpdate") : t("localStart") }}</n-button>
            </n-space>
          </template>
          <template v-else>
            <n-alert type="success" :bordered="false" class="gap">{{ result.setupUrl ? t("installDone") : t("localUpdated") }}</n-alert>
            <n-space>
              <n-button @click="view = 'list'">{{ t("back") }}</n-button>
              <n-button type="primary" :loading="opening === result.id" @click="openSetup">{{ result.setupUrl ? t("openSetup") : t("open") }}</n-button>
            </n-space>
          </template>
          <div v-if="log.length" class="log-wrap">
            <div class="label">{{ t("log") }}<span v-if="step && installing"> · {{ step }}</span></div>
            <pre ref="logBox" class="log">{{ log.join("\n") }}</pre>
          </div>
        </n-card>

        <!-- Install on a new server -->
        <n-card v-else :title="t('install')">
          <form v-if="!result" class="form" @submit.prevent="startInstall()">
            <p class="muted">{{ t("installLead") }}</p>
            <label>{{ t("name") }}<n-input v-model:value="inst.name" :disabled="installing" /></label>
            <div class="two">
              <label>{{ t("host") }}<n-input v-model:value="inst.host" placeholder="203.0.113.10" :disabled="installing" /></label>
              <label>{{ t("port") }}<n-input-number v-model:value="inst.port" :min="1" :max="65535" :show-button="false" :disabled="installing" /></label>
            </div>
            <label>{{ t("user") }}<n-input v-model:value="inst.user" :disabled="installing" /></label>
            <label>{{ t("password") }}<n-input v-model:value="inst.password" type="password" show-password-on="click" :disabled="installing" /></label>
            <small class="muted">{{ t("passwordHint") }}</small>
            <div>
              <div class="label">{{ t("https") }}</div>
              <n-radio-group v-model:value="inst.https" :disabled="installing">
                <n-space vertical>
                  <n-radio value="sslip">{{ t("httpsSslip") }}</n-radio>
                  <n-radio value="domain">{{ t("httpsDomain") }}</n-radio>
                  <n-radio value="tunnel">{{ t("httpsTunnel") }}</n-radio>
                </n-space>
              </n-radio-group>
            </div>
            <label v-if="inst.https === 'domain'">{{ t("domain") }}<n-input :value="inst.domain ?? ''" placeholder="panel.example.com" :disabled="installing" @update:value="(v: string) => (inst.domain = v)" /></label>
            <n-space>
              <n-button :disabled="installing" @click="view = 'list'">{{ t("back") }}</n-button>
              <n-button attr-type="submit" type="primary" :loading="installing" :disabled="!inst.host.trim() || !inst.password || (inst.https === 'domain' && !inst.domain?.trim())">
                {{ installing ? t("installing") : t("installStart") }}
              </n-button>
            </n-space>
          </form>
          <template v-else>
            <n-alert type="success" :bordered="false" class="gap">{{ t("installDone") }}</n-alert>
            <n-button type="primary" :loading="opening === result.id" @click="openSetup">{{ t("openSetup") }}</n-button>
          </template>
          <div v-if="log.length" class="log-wrap">
            <div class="label">{{ t("log") }}<span v-if="step && installing"> · {{ step }}</span></div>
            <pre ref="logBox" class="log">{{ log.join("\n") }}</pre>
          </div>
        </n-card>
      </main>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.wrap {
  max-width: 760px;
  margin: 0 auto;
  padding: 20px 20px 40px;
}
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
}
.logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #8f85f3, #5b4fd9);
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
h1 {
  font-size: 20px;
  margin: 0;
}
.gap {
  margin-bottom: 12px;
}
.server {
  display: flex;
  align-items: center;
  gap: 12px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.small {
  font-size: 12px;
  margin-top: 2px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form label,
.label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
}
.two {
  display: grid;
  grid-template-columns: 1fr 120px;
  gap: 12px;
}
.needs {
  margin: 0 0 14px;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.7;
}
.log-wrap {
  margin-top: 16px;
}
.log {
  max-height: 320px;
  overflow: auto;
  margin: 6px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
