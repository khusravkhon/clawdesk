<script setup lang="ts">
// "Навыки и MCP": skills (ClawHub, uploaded, written here) and MCP servers by address, added once
// and handed out per agent. Each agent's page shows the same lists as checkboxes.
import type { AgentListItemDto, ClawHubSkillDto, McpServerDto, SkillDto } from "@clawdesk/shared";
import { BookOpen, FileUp, PenLine, Plug, Search, Trash2 } from "@lucide/vue";
import { NAlert, NButton, NEmpty, NInput, NModal, NPopconfirm, NRadio, NRadioGroup, NSelect, NSkeleton, NSpace, NTabPane, NTabs, NTag, useMessage } from "naive-ui";
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";

const { t } = useI18n();
const message = useMessage();
const route = useRoute();
const router = useRouter();

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const tab = ref<"skills" | "mcp">(route.query.mcp ? "mcp" : "skills");
const agents = ref<AgentListItemDto[]>([]);
const skills = ref<SkillDto[] | null>(null);
const servers = ref<McpServerDto[] | null>(null);
const loadError = ref<string | null>(null);
const busy = ref<string | null>(null);

const errText = (e: unknown) => (e instanceof ApiError ? e.body.message : String(e));
const agentOptions = computed(() => agents.value.map((a) => ({ value: a.id, label: `${a.emoji ? `${a.emoji} ` : ""}${a.name}` })));
const allAgentIds = computed(() => agents.value.map((a) => a.id));

async function load(): Promise<void> {
  try {
    const [list, s, m] = await Promise.all([api.agents(), api.skills.list(), api.mcp.list()]);
    agents.value = list.agents;
    skills.value = s.skills;
    servers.value = m.servers;
  } catch (e) {
    loadError.value = errText(e);
  }
}

async function run<T>(key: string, fn: () => Promise<T>, done?: (result: T) => void, ok?: string): Promise<boolean> {
  busy.value = key;
  try {
    const result = await fn();
    done?.(result);
    if (ok) message.success(ok);
    return true;
  } catch (e) {
    message.error(errText(e));
    return false;
  } finally {
    busy.value = null;
  }
}

// --- skills ---

const setSkills = (dto: { skills: SkillDto[] }) => (skills.value = dto.skills);

function setSkillAgents(skill: SkillDto, agentIds: string[]): void {
  void run(`skill-agents:${skill.id}`, () => api.skills.setAgents(skill.id, agentIds), setSkills);
}

function removeSkill(skill: SkillDto): void {
  void run(`skill-remove:${skill.id}`, () => api.skills.remove(skill.id), setSkills, t("ext.removed"));
}

// ClawHub search
const hub = reactive({ open: false, query: "", searching: false, searched: false, results: [] as ClawHubSkillDto[], picked: null as ClawHubSkillDto | null, agentIds: [] as string[] });

function openHub(): void {
  Object.assign(hub, { open: true, picked: null, agentIds: [...allAgentIds.value.slice(0, 1)] });
}

async function searchHub(): Promise<void> {
  hub.searching = true;
  try {
    hub.results = (await api.skills.search(hub.query.trim())).results;
    hub.searched = true;
  } catch (e) {
    message.error(errText(e));
  } finally {
    hub.searching = false;
  }
}

async function addFromHub(): Promise<void> {
  const picked = hub.picked;
  if (!picked) return;
  const ok = await run("hub-add", () => api.skills.addClawHub({ installRef: picked.installRef, name: picked.name, summary: picked.summary, agentIds: hub.agentIds }), setSkills, t("ext.saved"));
  if (ok) hub.open = false;
}

// Written in the panel (new or edited)
const own = reactive({ open: false, id: null as string | null, name: "", description: "", instructions: "", agentIds: [] as string[] });

function openOwn(): void {
  Object.assign(own, { open: true, id: null, name: "", description: "", instructions: "", agentIds: [...allAgentIds.value.slice(0, 1)] });
}

async function editOwn(skill: SkillDto): Promise<void> {
  await run(`skill-edit:${skill.id}`, () => api.skills.content(skill.id), (content) => Object.assign(own, { open: true, id: skill.id, ...content, agentIds: [...skill.agents] }));
}

async function saveOwn(): Promise<void> {
  const body = { name: own.name.trim(), description: own.description.trim(), instructions: own.instructions.trim(), agentIds: own.agentIds };
  const ok = await run("own-save", () => (own.id ? api.skills.update(own.id, body) : api.skills.createOwn(body)), setSkills, t("ext.saved"));
  if (ok) own.open = false;
}

// Upload
const upload = reactive({ open: false, file: null as File | null, agentIds: [] as string[] });
const fileInput = ref<HTMLInputElement | null>(null);

function openUpload(): void {
  Object.assign(upload, { open: true, file: null, agentIds: [...allAgentIds.value.slice(0, 1)] });
}

function pickFile(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null;
  if (file && file.size > MAX_UPLOAD_BYTES) {
    message.error(t("ext.fileTooBig"));
    return;
  }
  upload.file = file;
}

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function sendUpload(): Promise<void> {
  const file = upload.file;
  if (!file) return;
  const ok = await run("upload", async () => api.skills.upload({ fileName: file.name, contentBase64: await base64Of(file), agentIds: upload.agentIds }), setSkills, t("ext.saved"));
  if (ok) upload.open = false;
}

// --- MCP ---

const setServers = (dto: { servers: McpServerDto[] }) => (servers.value = dto.servers);

function setServerAgents(server: McpServerDto, agentIds: string[]): void {
  void run(`mcp-agents:${server.name}`, () => api.mcp.setAgents(server.name, agentIds), setServers);
}

function removeServer(server: McpServerDto): void {
  void run(`mcp-remove:${server.name}`, () => api.mcp.remove(server.name), setServers, t("ext.removed"));
}

async function signIn(server: McpServerDto): Promise<void> {
  await run(`mcp-login:${server.name}`, () => api.mcp.login(server.name), (result) => {
    // The provider brings the browser back to this screen (/skills?mcp=connected).
    if (result.authorizationUrl) location.assign(result.authorizationUrl);
    else void load();
  });
}

const mcpForm = reactive({ open: false, name: "", url: "", auth: "oauth" as "oauth" | "token" | "none", token: "", agentIds: [] as string[] });
const mcpNameOk = computed(() => /^[a-z][a-z0-9-]{0,39}$/.test(mcpForm.name));
const mcpUrlOk = computed(() => /^https:\/\/[^\s]+$/.test(mcpForm.url.trim()));

function openMcp(): void {
  Object.assign(mcpForm, { open: true, name: "", url: "", auth: "oauth", token: "", agentIds: [...allAgentIds.value.slice(0, 1)] });
}

async function addMcp(): Promise<void> {
  const body = { name: mcpForm.name, url: mcpForm.url.trim(), auth: mcpForm.auth, agentIds: mcpForm.agentIds, ...(mcpForm.auth === "token" ? { token: mcpForm.token.trim() } : {}) };
  const ok = await run("mcp-add", () => api.mcp.add(body), setServers, t("ext.saved"));
  if (!ok) return;
  mcpForm.open = false;
  mcpForm.token = "";
  const added = servers.value?.find((s) => s.name === body.name);
  if (added?.auth === "oauth") await signIn(added);
}

function showOAuthResult(): void {
  const q = route.query;
  if (!q.mcp) return;
  if (q.mcp === "connected") message.success(t("ext.mcpConnected", { name: String(q.server ?? "") }));
  else if (q.mcp === "denied") message.warning(t("ext.mcpDenied"));
  else message.error(t("ext.mcpError", { reason: String(q.reason ?? "") }));
  void router.replace({ query: {} });
}

onMounted(() => {
  showOAuthResult();
  void load();
});
</script>

<template>
  <div>
    <page-header :title="t('ext.title')" :subtitle="t('ext.subtitle')" />

    <n-alert v-if="loadError" type="error" class="block">{{ loadError }}</n-alert>
    <n-skeleton v-else-if="!skills || !servers" height="300px" :sharp="false" />
    <n-tabs v-else v-model:value="tab" type="line" animated>
      <n-tab-pane name="skills" :tab="t('ext.tabSkills')">
        <p class="lead">{{ t("ext.skillsLead") }}</p>
        <n-space class="actions">
          <n-button type="primary" @click="openHub">
            <template #icon><search :size="16" /></template>
            {{ t("ext.findClawHub") }}
          </n-button>
          <n-button @click="openOwn">
            <template #icon><pen-line :size="16" /></template>
            {{ t("ext.writeSkill") }}
          </n-button>
          <n-button @click="openUpload">
            <template #icon><file-up :size="16" /></template>
            {{ t("ext.uploadSkill") }}
          </n-button>
        </n-space>

        <n-empty v-if="!skills.length" :description="t('ext.noSkills')" class="empty" />
        <section v-for="skill in skills" :key="skill.id" class="card">
          <div class="row">
            <book-open :size="18" class="icon" />
            <div class="grow">
              <div class="name">
                {{ skill.name }}
                <n-tag size="small" :bordered="false" :type="skill.kind === 'clawhub' ? 'info' : 'success'">{{ skill.kind === "clawhub" ? t("ext.kindClawhub") : t("ext.kindOwn") }}</n-tag>
              </div>
              <p v-if="skill.description" class="desc">{{ skill.description }}</p>
              <p class="mono muted">{{ skill.installRef ?? skill.slug }}</p>
            </div>
            <n-space :size="6" class="row-actions">
              <n-button v-if="skill.editable" size="small" quaternary :loading="busy === `skill-edit:${skill.id}`" @click="editOwn(skill)">{{ t("ext.edit") }}</n-button>
              <n-popconfirm :positive-text="t('ext.remove')" :negative-text="t('ext.cancel')" @positive-click="removeSkill(skill)">
                <template #trigger>
                  <n-button size="small" quaternary type="error" :loading="busy === `skill-remove:${skill.id}`" :aria-label="t('ext.remove')">
                    <template #icon><trash-2 :size="15" /></template>
                  </n-button>
                </template>
                {{ t("ext.removeConfirm", { name: skill.name }) }}
              </n-popconfirm>
            </n-space>
          </div>
          <label class="field">
            <span>{{ t("ext.agents") }}</span>
            <n-select
              :value="skill.agents"
              multiple
              :options="agentOptions"
              :placeholder="t('ext.noAgents')"
              :loading="busy === `skill-agents:${skill.id}`"
              :disabled="busy === `skill-agents:${skill.id}`"
              @update:value="(ids: string[]) => setSkillAgents(skill, ids)"
            />
          </label>
        </section>
      </n-tab-pane>

      <n-tab-pane name="mcp" :tab="t('ext.tabMcp')">
        <p class="lead">{{ t("ext.mcpLead") }}</p>
        <n-space class="actions">
          <n-button type="primary" @click="openMcp">
            <template #icon><plug :size="16" /></template>
            {{ t("ext.addMcp") }}
          </n-button>
        </n-space>

        <n-empty v-if="!servers.length" :description="t('ext.noMcp')" class="empty" />
        <section v-for="server in servers" :key="server.name" class="card">
          <div class="row">
            <plug :size="18" class="icon" />
            <div class="grow">
              <div class="name">
                {{ server.name }}
                <n-tag v-if="server.signedIn === true" size="small" :bordered="false" type="success">{{ t("ext.signedIn") }}</n-tag>
                <n-tag v-else-if="server.signedIn === false" size="small" :bordered="false" type="warning">{{ t("ext.notSignedIn") }}</n-tag>
                <n-tag v-if="!server.managed" size="small" :bordered="false">{{ t("ext.fromSources") }}</n-tag>
              </div>
              <p class="mono muted">{{ server.url }}</p>
            </div>
            <n-space :size="6" class="row-actions">
              <n-button v-if="server.managed && server.auth === 'oauth'" size="small" secondary :loading="busy === `mcp-login:${server.name}`" @click="signIn(server)">{{ t("ext.signIn") }}</n-button>
              <n-popconfirm v-if="server.managed" :positive-text="t('ext.remove')" :negative-text="t('ext.cancel')" @positive-click="removeServer(server)">
                <template #trigger>
                  <n-button size="small" quaternary type="error" :loading="busy === `mcp-remove:${server.name}`" :aria-label="t('ext.remove')">
                    <template #icon><trash-2 :size="15" /></template>
                  </n-button>
                </template>
                {{ t("ext.removeMcpConfirm", { name: server.name }) }}
              </n-popconfirm>
            </n-space>
          </div>
          <label class="field">
            <span>{{ t("ext.agents") }}</span>
            <n-select
              :value="server.agents"
              multiple
              :options="agentOptions"
              :placeholder="t('ext.noAgents')"
              :loading="busy === `mcp-agents:${server.name}`"
              :disabled="busy === `mcp-agents:${server.name}`"
              @update:value="(ids: string[]) => setServerAgents(server, ids)"
            />
          </label>
        </section>
      </n-tab-pane>
    </n-tabs>

    <!-- ClawHub search -->
    <n-modal v-model:show="hub.open" preset="card" :title="t('ext.findClawHub')" class="modal" :mask-closable="busy !== 'hub-add'">
      <template v-if="!hub.picked">
        <div class="search">
          <n-input v-model:value="hub.query" :placeholder="t('ext.searchPlaceholder')" clearable @keyup.enter="searchHub" />
          <n-button type="primary" :loading="hub.searching" @click="searchHub">{{ t("ext.search") }}</n-button>
        </div>
        <p v-if="hub.searched && !hub.results.length" class="muted">{{ t("ext.nothingFound") }}</p>
        <div v-for="r in hub.results" :key="r.installRef" class="result">
          <div class="grow">
            <div class="name">
              {{ r.name }}
              <n-tag v-if="r.notScanned" size="small" :bordered="false" type="warning">{{ t("ext.notScanned") }}</n-tag>
            </div>
            <p v-if="r.summary" class="desc clamp">{{ r.summary }}</p>
            <p class="mono muted">{{ r.installRef }}</p>
          </div>
          <n-button size="small" :disabled="skills?.some((s) => s.installRef === r.installRef)" @click="hub.picked = r">{{ t("ext.add") }}</n-button>
        </div>
      </template>
      <template v-else>
        <div class="name">{{ hub.picked.name }}</div>
        <p v-if="hub.picked.summary" class="desc">{{ hub.picked.summary }}</p>
        <n-alert v-if="hub.picked.notScanned" type="warning" :bordered="false" class="block">{{ t("ext.notScannedHint") }}</n-alert>
        <label class="field">
          <span>{{ t("ext.addTo") }}</span>
          <n-select v-model:value="hub.agentIds" multiple :options="agentOptions" />
        </label>
        <n-space justify="end">
          <n-button :disabled="busy === 'hub-add'" @click="hub.picked = null">{{ t("ext.cancel") }}</n-button>
          <n-button type="primary" :loading="busy === 'hub-add'" @click="addFromHub">{{ busy === "hub-add" ? t("ext.adding") : t("ext.add") }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- Written in the panel -->
    <n-modal v-model:show="own.open" preset="card" :title="own.id ? t('ext.edit') : t('ext.writeSkill')" class="modal" :mask-closable="false">
      <label class="field">
        <span>{{ t("ext.skillName") }}</span>
        <n-input v-model:value="own.name" maxlength="80" />
      </label>
      <label class="field">
        <span>{{ t("ext.skillDescription") }}</span>
        <n-input v-model:value="own.description" maxlength="500" :placeholder="t('ext.skillDescriptionPlaceholder')" />
      </label>
      <label class="field">
        <span>{{ t("ext.skillInstructions") }}</span>
        <n-input v-model:value="own.instructions" type="textarea" :autosize="{ minRows: 8, maxRows: 20 }" maxlength="40000" :placeholder="t('ext.skillInstructionsPlaceholder')" />
      </label>
      <label class="field">
        <span>{{ t("ext.addTo") }}</span>
        <n-select v-model:value="own.agentIds" multiple :options="agentOptions" />
      </label>
      <n-space justify="end">
        <n-button :disabled="busy === 'own-save'" @click="own.open = false">{{ t("ext.cancel") }}</n-button>
        <n-button type="primary" :loading="busy === 'own-save'" :disabled="!own.name.trim() || !own.description.trim() || !own.instructions.trim()" @click="saveOwn">{{ t("ext.save") }}</n-button>
      </n-space>
    </n-modal>

    <!-- Upload -->
    <n-modal v-model:show="upload.open" preset="card" :title="t('ext.uploadSkill')" class="modal" :mask-closable="busy !== 'upload'">
      <p class="lead">{{ t("ext.uploadLead") }}</p>
      <input ref="fileInput" type="file" accept=".md,.zip" class="hidden" @change="pickFile" />
      <n-space align="center" class="block">
        <n-button @click="fileInput?.click()">{{ t("ext.chooseFile") }}</n-button>
        <span v-if="upload.file" class="mono">{{ upload.file.name }}</span>
      </n-space>
      <label class="field">
        <span>{{ t("ext.addTo") }}</span>
        <n-select v-model:value="upload.agentIds" multiple :options="agentOptions" />
      </label>
      <n-space justify="end">
        <n-button :disabled="busy === 'upload'" @click="upload.open = false">{{ t("ext.cancel") }}</n-button>
        <n-button type="primary" :loading="busy === 'upload'" :disabled="!upload.file" @click="sendUpload">{{ t("ext.add") }}</n-button>
      </n-space>
    </n-modal>

    <!-- MCP by address -->
    <n-modal v-model:show="mcpForm.open" preset="card" :title="t('ext.addMcp')" class="modal" :mask-closable="false">
      <label class="field">
        <span>{{ t("ext.mcpName") }}</span>
        <n-input v-model:value="mcpForm.name" maxlength="40" placeholder="linear" :status="mcpForm.name && !mcpNameOk ? 'error' : undefined" />
        <small class="muted">{{ t("ext.mcpNameHint") }}</small>
      </label>
      <label class="field">
        <span>{{ t("ext.mcpUrl") }}</span>
        <n-input v-model:value="mcpForm.url" maxlength="500" placeholder="https://mcp.linear.app/mcp" :status="mcpForm.url && !mcpUrlOk ? 'error' : undefined" />
        <small class="muted">{{ t("ext.mcpUrlHint") }}</small>
      </label>
      <div class="field">
        <span>{{ t("ext.mcpAuth") }}</span>
        <n-radio-group v-model:value="mcpForm.auth">
          <n-space vertical :size="6">
            <n-radio value="oauth">{{ t("ext.authOauth") }}</n-radio>
            <n-radio value="token">{{ t("ext.authToken") }}</n-radio>
            <n-radio value="none">{{ t("ext.authNone") }}</n-radio>
          </n-space>
        </n-radio-group>
      </div>
      <label v-if="mcpForm.auth === 'token'" class="field">
        <span>{{ t("ext.mcpToken") }}</span>
        <n-input v-model:value="mcpForm.token" type="password" show-password-on="click" :input-props="{ autocomplete: 'off' }" />
        <small class="muted">{{ t("ext.mcpTokenHint") }}</small>
      </label>
      <label class="field">
        <span>{{ t("ext.addTo") }}</span>
        <n-select v-model:value="mcpForm.agentIds" multiple :options="agentOptions" />
      </label>
      <n-space justify="end">
        <n-button :disabled="busy === 'mcp-add'" @click="mcpForm.open = false">{{ t("ext.cancel") }}</n-button>
        <n-button type="primary" :loading="busy === 'mcp-add'" :disabled="!mcpNameOk || !mcpUrlOk || (mcpForm.auth === 'token' && !mcpForm.token.trim())" @click="addMcp">{{ t("ext.add") }}</n-button>
      </n-space>
    </n-modal>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 16px;
}
.lead {
  margin: 4px 0 14px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
.actions {
  margin-bottom: 16px;
}
.empty {
  margin: 32px 0;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
  margin-bottom: 12px;
  min-width: 0;
}
.row,
.result {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}
.result {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.icon {
  color: var(--accent);
  margin-top: 2px;
  flex-shrink: 0;
}
.grow {
  flex: 1 1 auto;
  min-width: 0;
}
.name {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-weight: 600;
  font-size: 14px;
}
.desc {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
}
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.muted {
  color: var(--muted);
  margin: 4px 0 0;
}
.row-actions {
  flex-shrink: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0 14px;
  font-size: 13px;
}
.field > span {
  color: var(--text-2);
  font-weight: 500;
}
.search {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.hidden {
  display: none;
}
.modal {
  width: min(640px, calc(100vw - 32px));
}
</style>
