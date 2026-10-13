<script setup lang="ts">
// Data sources (screen 5): what the main agent can read — Notion, a folder, Google, GitHub, Figma.
import type { SourcesDto, StartGitHubSignInResultDto } from "@clawdesk/shared";
import { CheckCircle2, Copy, ExternalLink, File, Folder, FolderOpen, KeyRound, LogIn, RefreshCw } from "@lucide/vue";
import { NA, NAlert, NButton, NCollapseTransition, NInput, NPopconfirm, NSkeleton, useMessage } from "naive-ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import GoogleWizard from "../components/GoogleWizard.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { formatRelative, intlLocale } from "../format";

const { t, locale } = useI18n();
const message = useMessage();
const route = useRoute();
const router = useRouter();

const data = ref<SourcesDto | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const busy = ref<"oauth" | "token" | "disconnect" | null>(null);
const showToken = ref(false);
const token = ref("");

const errText = (e: unknown) => (e instanceof ApiError ? e.body.message : String(e));

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api.sources.status();
    error.value = null;
  } catch (e) {
    error.value = errText(e);
  } finally {
    loading.value = false;
  }
}

// --- GitHub: OpenClaw gets a code from GitHub; the person types it at github.com/login/device.
const gh = ref<StartGitHubSignInResultDto | null>(null);
const ghBusy = ref(false);
let ghTimer: number | undefined;

async function githubStart(): Promise<void> {
  ghBusy.value = true;
  try {
    gh.value = await api.sources.githubStart();
    window.open(gh.value.verificationUri, "_blank", "noopener");
    ghPoll(gh.value.pollAfterMs);
  } catch (e) {
    message.error(errText(e));
  } finally {
    ghBusy.value = false;
  }
}

function ghPoll(after: number): void {
  window.clearTimeout(ghTimer);
  ghTimer = window.setTimeout(async () => {
    const pending = gh.value;
    if (!pending) return;
    try {
      const res = await api.sources.githubPoll(pending.requestId);
      if (res.status === "pending") return ghPoll(res.retryAfterMs);
      gh.value = null;
      if (res.status === "success") message.success(t("sources.github.connected"));
      else message.error(t(`sources.github.${res.status}`));
      await load();
    } catch (e) {
      gh.value = null;
      message.error(errText(e));
    }
  }, Math.max(after, 2000));
}

async function githubDisconnect(): Promise<void> {
  data.value = await api.sources.githubDisconnect().catch((e) => (message.error(errText(e)), data.value));
}

async function copyCode(): Promise<void> {
  if (gh.value) await navigator.clipboard?.writeText(gh.value.userCode).catch(() => undefined);
}

// --- Figma: a personal access token for the read-only figma skill.
const figmaToken = ref("");
const figmaBusy = ref(false);
const figmaValid = computed(() => /^figd_[A-Za-z0-9_-]{20,}$/.test(figmaToken.value.trim()));

async function figmaConnect(): Promise<void> {
  figmaBusy.value = true;
  try {
    data.value = await api.sources.figmaToken(figmaToken.value.trim());
    figmaToken.value = "";
    message.success(t("sources.figma.connected"));
  } catch (e) {
    message.error(e instanceof ApiError && e.body.error === "figma_token_rejected" ? t("sources.figma.rejected") : errText(e));
  } finally {
    figmaBusy.value = false;
  }
}

async function figmaDisconnect(): Promise<void> {
  data.value = await api.sources.figmaDisconnect().catch((e) => (message.error(errText(e)), data.value));
}

onUnmounted(() => window.clearTimeout(ghTimer));

async function signIn(): Promise<void> {
  busy.value = "oauth";
  try {
    const res = await api.sources.notionOAuth();
    if (res.authorizationUrl) {
      // Notion brings the browser back to /api/sources/notion/callback, then here.
      window.location.assign(res.authorizationUrl);
      return;
    }
    message.success(t("sources.notion.connectedToast"));
    await load();
  } catch (e) {
    message.error(errText(e));
  } finally {
    busy.value = null;
  }
}

async function connectToken(): Promise<void> {
  busy.value = "token";
  try {
    data.value = await api.sources.notionToken(token.value.trim());
    token.value = "";
    showToken.value = false;
    message.success(t("sources.notion.connectedToast"));
  } catch (e) {
    message.error(e instanceof ApiError && e.body.error === "notion_token_rejected" ? t("sources.notion.tokenRejected") : errText(e));
  } finally {
    busy.value = null;
  }
}

async function disconnect(): Promise<void> {
  busy.value = "disconnect";
  try {
    data.value = await api.sources.notionDisconnect();
    message.success(t("sources.notion.disconnected"));
  } catch (e) {
    message.error(errText(e));
  } finally {
    busy.value = null;
  }
}

async function copyPath(): Promise<void> {
  const path = data.value?.folder.hostPath;
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    message.success(t("sources.folder.copied"));
  } catch {
    message.info(path);
  }
}

const tokenValid = computed(() => /^(ntn_|secret_)[A-Za-z0-9]{20,}$/.test(token.value.trim()));
const notion = computed(() => data.value?.notion ?? null);
const google = computed(() => data.value?.google ?? null);

async function removeGoogle(email: string): Promise<void> {
  try {
    data.value = await api.sources.googleRemove(email);
    message.success(t("sources.google.removed"));
  } catch (e) {
    message.error(errText(e));
  }
}
const folder = computed(() => data.value?.folder ?? null);

const formatSize = (bytes: number) =>
  new Intl.NumberFormat(intlLocale(locale.value), { style: "unit", unit: bytes >= 1_048_576 ? "megabyte" : "kilobyte", maximumFractionDigits: 1 }).format(
    bytes >= 1_048_576 ? bytes / 1_048_576 : Math.max(bytes / 1024, 0.1),
  );

onMounted(async () => {
  // Coming back from Notion's sign-in page.
  const result = route.query.notion;
  if (result === "connected") message.success(t("sources.notion.connectedToast"));
  else if (result === "denied") message.warning(t("sources.notion.denied"));
  else if (result === "error") message.error(t("sources.notion.signInFailed", { reason: String(route.query.reason ?? "") }));
  const g = route.query.google;
  if (g === "connected") message.success(t("sources.google.connected"));
  else if (g === "denied") message.warning(t("sources.google.denied"));
  else if (g === "error") message.error(t("sources.google.failed", { reason: String(route.query.reason ?? "") }));
  if (result || g) void router.replace({ query: {} });
  await load();
});
</script>

<template>
  <div>
    <page-header :title="t('sources.title')" :subtitle="t('sources.subtitle')">
      <n-button size="small" secondary :loading="loading" @click="load">
        <template #icon><refresh-cw :size="14" /></template>
        {{ t("status.refresh") }}
      </n-button>
    </page-header>

    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>

    <div class="grid">
      <!-- Notion -->
      <section class="card">
        <header class="card-head">
          <div class="logo notion">N</div>
          <div class="head-text">
            <h2>Notion</h2>
            <p>{{ t("sources.notion.about") }}</p>
          </div>
          <span v-if="notion?.connected" class="badge ok"><check-circle-2 :size="13" /> {{ t("sources.connected") }}</span>
        </header>

        <n-skeleton v-if="!data" text :repeat="3" />
        <template v-else-if="notion?.connected">
          <dl class="facts">
            <div>
              <dt>{{ t("sources.notion.method") }}</dt>
              <dd>{{ notion.method === "oauth" ? t("sources.notion.viaOAuth") : t("sources.notion.viaToken") }}</dd>
            </div>
            <div v-if="notion.workspace">
              <dt>{{ t("sources.notion.workspace") }}</dt>
              <dd>{{ notion.workspace }}</dd>
            </div>
            <div v-if="notion.integration">
              <dt>{{ t("sources.notion.integration") }}</dt>
              <dd>{{ notion.integration }}</dd>
            </div>
          </dl>
          <p class="hint">{{ notion.method === "oauth" ? t("sources.notion.oauthHint") : t("sources.notion.tokenHint") }}</p>
          <n-popconfirm @positive-click="disconnect">
            <template #trigger>
              <n-button size="small" secondary type="error" :loading="busy === 'disconnect'">{{ t("sources.disconnect") }}</n-button>
            </template>
            {{ t("sources.notion.confirmDisconnect") }}
          </n-popconfirm>
        </template>
        <template v-else>
          <n-button v-if="notion?.oauthAvailable" type="primary" block :loading="busy === 'oauth'" @click="signIn">
            <template #icon><log-in :size="16" /></template>
            {{ t("sources.notion.signIn") }}
          </n-button>
          <p v-if="notion?.oauthAvailable" class="hint">{{ t("sources.notion.signInHint") }}</p>
          <n-alert v-else type="info" :bordered="false" class="block">{{ t("sources.notion.noBridge") }}</n-alert>

          <n-button text class="alt" @click="showToken = !showToken">
            <template #icon><key-round :size="14" /></template>
            {{ t("sources.notion.useToken") }}
          </n-button>
          <n-collapse-transition :show="showToken">
            <ol class="steps">
              <li>
                {{ t("sources.notion.step1") }}
                <n-a href="https://www.notion.so/profile/integrations" target="_blank" rel="noopener noreferrer">
                  notion.so/profile/integrations <external-link :size="12" />
                </n-a>
              </li>
              <li>{{ t("sources.notion.step2") }}</li>
              <li>{{ t("sources.notion.step3") }}</li>
            </ol>
            <div class="token-row">
              <n-input v-model:value="token" type="password" show-password-on="click" :placeholder="t('sources.notion.tokenPlaceholder')" @keyup.enter="tokenValid && connectToken()" />
              <n-button type="primary" :disabled="!tokenValid" :loading="busy === 'token'" @click="connectToken">{{ t("sources.notion.connect") }}</n-button>
            </div>
            <p class="hint">{{ t("sources.privacy") }}</p>
          </n-collapse-transition>
        </template>
      </section>

      <!-- Folder -->
      <section class="card">
        <header class="card-head">
          <div class="logo folder"><folder-open :size="18" /></div>
          <div class="head-text">
            <h2>{{ t("sources.folder.title") }}</h2>
            <p>{{ t("sources.folder.about") }}</p>
          </div>
          <span v-if="folder?.available" class="badge ok"><check-circle-2 :size="13" /> {{ t("sources.connected") }}</span>
        </header>

        <n-skeleton v-if="!data" text :repeat="3" />
        <template v-else-if="folder?.available">
          <div class="path">
            <code>{{ folder.hostPath }}</code>
            <n-button quaternary circle size="small" :aria-label="t('sources.folder.copy')" @click="copyPath"><copy :size="14" /></n-button>
          </div>
          <p class="hint">{{ t("sources.folder.hint", { path: folder.agentPath }) }}</p>
          <div class="files-head">{{ t("sources.folder.count", { n: folder.total }) }}</div>
          <ul v-if="folder.files.length" class="files">
            <li v-for="f in folder.files" :key="f.name">
              <component :is="f.isDir ? Folder : File" :size="15" class="muted" />
              <span class="file-name">{{ f.name }}</span>
              <span class="file-meta num">{{ f.isDir ? "" : formatSize(f.size) }}</span>
              <span class="file-meta">{{ formatRelative(f.modifiedAt, locale) }}</span>
            </li>
          </ul>
          <p v-else class="hint">{{ t("sources.folder.empty") }}</p>
        </template>
        <n-alert v-else type="warning" :bordered="false">{{ t("sources.folder.notMounted") }}</n-alert>
      </section>

      <!-- Google -->
      <section class="card google-card">
        <header class="card-head">
          <div class="logo google">G</div>
          <div class="head-text">
            <h2>Google</h2>
            <p>{{ t("sources.google.about") }}</p>
          </div>
          <span v-if="google?.accounts.length" class="badge ok"><check-circle-2 :size="13" /> {{ t("sources.connected") }}</span>
        </header>
        <n-skeleton v-if="!data" text :repeat="3" />
        <template v-else-if="google?.accounts.length">
          <ul class="accounts">
            <li v-for="a in google.accounts" :key="a.email">
              <span class="acc">{{ a.email }}</span>
              <span class="muted small">{{ a.services.join(", ") }}</span>
              <n-popconfirm @positive-click="removeGoogle(a.email)">
                <template #trigger>
                  <n-button size="tiny" secondary type="error">{{ t("sources.disconnect") }}</n-button>
                </template>
                {{ t("sources.google.confirmRemove") }}
              </n-popconfirm>
            </li>
          </ul>
          <p class="hint">{{ t("sources.google.connectedHint") }}</p>
        </template>
        <n-alert v-else-if="!google?.available" type="info" :bordered="false">{{ t("sources.google.noGog") }}</n-alert>
        <google-wizard v-else :google="google" @updated="(d) => (data = d)" />
      </section>

      <!-- GitHub -->
      <section class="card">
        <header class="card-head">
          <div class="logo github">GH</div>
          <div class="head-text">
            <h2>GitHub</h2>
            <p>{{ t("sources.github.about") }}</p>
          </div>
          <span v-if="data?.github.connected" class="badge ok"><check-circle-2 :size="13" /> {{ t("sources.connected") }}</span>
        </header>
        <n-skeleton v-if="!data" text :repeat="2" />
        <template v-else-if="data.github.connected">
          <dl class="facts">
            <div>
              <dt>{{ t("sources.github.account") }}</dt>
              <dd>{{ data.github.account ?? "—" }}</dd>
            </div>
          </dl>
          <p class="hint">{{ t("sources.github.connectedHint") }}</p>
          <n-popconfirm @positive-click="githubDisconnect">
            <template #trigger>
              <n-button size="small" secondary type="error">{{ t("sources.disconnect") }}</n-button>
            </template>
            {{ t("sources.github.confirmDisconnect") }}
          </n-popconfirm>
        </template>
        <template v-else-if="gh">
          <p class="hint">{{ t("sources.github.enterCode") }}</p>
          <div class="code-row">
            <code class="code">{{ gh.userCode }}</code>
            <n-button size="small" secondary @click="copyCode"><template #icon><copy :size="14" /></template></n-button>
          </div>
          <n-a :href="gh.verificationUri" target="_blank" rel="noopener noreferrer">{{ gh.verificationUri }} <external-link :size="12" /></n-a>
          <p class="hint">{{ t("sources.github.waiting") }}</p>
        </template>
        <template v-else>
          <n-button type="primary" block :loading="ghBusy" @click="githubStart">
            <template #icon><log-in :size="16" /></template>
            {{ t("sources.github.signIn") }}
          </n-button>
          <p class="hint">{{ t("sources.github.signInHint") }}</p>
        </template>
      </section>

      <!-- Figma -->
      <section class="card">
        <header class="card-head">
          <div class="logo figma">F</div>
          <div class="head-text">
            <h2>Figma</h2>
            <p>{{ t("sources.figma.about") }}</p>
          </div>
          <span v-if="data?.figma.connected" class="badge ok"><check-circle-2 :size="13" /> {{ t("sources.connected") }}</span>
        </header>
        <n-skeleton v-if="!data" text :repeat="2" />
        <template v-else-if="data.figma.connected">
          <dl v-if="data.figma.handle" class="facts">
            <div>
              <dt>{{ t("sources.figma.account") }}</dt>
              <dd>{{ data.figma.handle }}</dd>
            </div>
          </dl>
          <p class="hint">{{ t("sources.figma.connectedHint") }}</p>
          <n-popconfirm @positive-click="figmaDisconnect">
            <template #trigger>
              <n-button size="small" secondary type="error">{{ t("sources.disconnect") }}</n-button>
            </template>
            {{ t("sources.figma.confirmDisconnect") }}
          </n-popconfirm>
        </template>
        <template v-else>
          <ol class="steps">
            <li>
              {{ t("sources.figma.step1") }}
              <n-a href="https://www.figma.com/settings" target="_blank" rel="noopener noreferrer">figma.com/settings <external-link :size="12" /></n-a>
            </li>
            <li>{{ t("sources.figma.step2") }}</li>
          </ol>
          <div class="token-row">
            <n-input v-model:value="figmaToken" type="password" show-password-on="click" placeholder="figd_…" @keyup.enter="figmaValid && figmaConnect()" />
            <n-button type="primary" :disabled="!figmaValid" :loading="figmaBusy" @click="figmaConnect">{{ t("sources.notion.connect") }}</n-button>
          </div>
          <p class="hint">{{ t("sources.privacy") }}</p>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 16px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px 20px;
  min-width: 0;
}
.google-card {
  grid-column: 1 / -1;
}
.accounts {
  list-style: none;
  margin: 0;
  padding: 0;
}
.accounts li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  font-size: 13px;
}
.acc {
  font-weight: 500;
}
.small {
  font-size: 12px;
  flex: 1;
}
.card-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}
.logo {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font-weight: 700;
  flex: none;
  background: var(--surface-2);
  color: var(--text);
}
.logo.notion {
  background: #fff;
  color: #111;
  font-family: Georgia, serif;
  font-size: 19px;
  box-shadow: 0 0 0 1px var(--border);
}
.logo.folder {
  color: var(--accent);
  background: var(--accent-soft);
}
.logo.github {
  background: #24292f;
  color: #fff;
  font-size: 13px;
}
.logo.figma {
  background: linear-gradient(135deg, #f24e1e, #a259ff);
  color: #fff;
}
.code-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 8px;
}
.code {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.1em;
}
.logo.google {
  color: #4285f4;
  font-size: 18px;
}
.head-text {
  flex: 1;
  min-width: 0;
}
h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.head-text p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-2);
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
  flex: none;
}
.badge.ok {
  color: var(--good-text);
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.alt {
  margin-top: 14px;
  font-size: 13px;
}
.steps {
  margin: 12px 0;
  padding-left: 20px;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
}
.token-row {
  display: flex;
  gap: 8px;
}
.facts {
  margin: 0 0 4px;
  display: grid;
  gap: 8px;
}
.facts div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  text-align: right;
}
.facts + .hint {
  margin-bottom: 14px;
}
.path {
  display: flex;
  align-items: center;
  gap: 6px;
}
.path code {
  font-size: 13px;
  padding: 4px 8px;
  overflow-wrap: anywhere;
}
.files-head {
  margin: 16px 0 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.files {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow: auto;
}
.files li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  font-size: 13px;
  border-top: 1px solid var(--border);
}
.files li:first-child {
  border-top: 0;
}
.file-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-meta {
  font-size: 12px;
  color: var(--muted);
  flex: none;
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
