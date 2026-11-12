<script setup lang="ts">
// "My agents": the main agent and its juniors (screen 7).
import type { AgentListDto, AgentListItemDto } from "@clawdesk/shared";
import { MessagesSquare, Pencil, Plus, Trash2 } from "@lucide/vue";
import { NAlert, NButton, NEmpty, NPopconfirm, NSpace, NSpin, NTag, useMessage } from "naive-ui";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import PageHeader from "../components/ui/PageHeader.vue";
import { api, ApiError } from "../api/client";

const { t } = useI18n();
const message = useMessage();
const data = ref<AgentListDto | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const deleting = ref<string | null>(null);

const main = computed(() => data.value?.agents.find((a) => a.role === "main") ?? null);
const juniors = computed(() => data.value?.agents.filter((a) => a.role !== "main") ?? []);

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api.agents();
    error.value = null;
  } catch (e) {
    error.value = e instanceof ApiError ? e.body.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function remove(agent: AgentListItemDto): Promise<void> {
  deleting.value = agent.id;
  try {
    await api.deleteAgent(agent.id);
    message.success(t("agents.deleted", { name: agent.name }));
    await load();
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  } finally {
    deleting.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <page-header :title="t('agents.title')">
      <n-button quaternary round @click="$router.push('/free-models')">{{ t("agents.freeModels") }}</n-button>
      <n-button type="primary" round @click="$router.push('/agents/new')">
        <template #icon><plus :size="16" /></template>
        {{ t("agents.create") }}
      </n-button>
    </page-header>
    <n-space vertical size="large">
      <n-alert v-if="error" type="error">{{ error }}</n-alert>
      <n-alert v-if="data && !data.sandboxEnabled" type="warning" :title="t('agents.noSandboxTitle')">{{ t("agents.noSandbox") }}</n-alert>

      <n-spin :show="loading">
        <!-- The main agent: the ink card, the others stand under it. -->
        <section v-if="main" class="main">
          <div class="avatar big">{{ main.emoji ?? "🧭" }}</div>
          <div class="main-text">
            <div class="label">{{ t("agents.main") }}</div>
            <div class="main-name">{{ main.name === main.id ? t("agents.main") : main.name }}</div>
            <div class="main-model">{{ main.model ?? t("agents.noModel") }}</div>
          </div>
          <div class="main-actions">
            <n-button round secondary class="on-ink" @click="$router.push('/chat')">
              <template #icon><messages-square :size="15" /></template>
              {{ t("nav.chat") }}
            </n-button>
            <n-button round secondary class="on-ink" @click="$router.push('/assistant')">{{ t("assistant.configure") }}</n-button>
          </div>
        </section>

        <h2 class="group-title">{{ t("agents.juniors") }}</h2>
        <n-empty v-if="!juniors.length" :description="t('agents.noJuniors')" class="empty">
          <template #extra>
            <n-button size="small" round @click="$router.push('/agents/new')">{{ t("agents.create") }}</n-button>
          </template>
        </n-empty>
        <div v-else class="grid">
          <article v-for="agent in juniors" :key="agent.id" class="agent">
            <header>
              <div class="avatar">{{ agent.emoji ?? "🤖" }}</div>
              <div class="head-text">
                <div class="name">{{ agent.name }}</div>
                <div class="model">{{ agent.model ?? t("agents.noModel") }}</div>
              </div>
            </header>
            <p v-if="agent.purpose" class="purpose">{{ agent.purpose }}</p>
            <div class="tags">
              <code>{{ agent.id }}</code>
              <n-tag v-if="agent.canAskMain" size="small" type="success" :bordered="false">{{ t("agents.canAskMain") }}</n-tag>
              <n-tag v-if="agent.folder" size="small" :bordered="false">📁 {{ agent.folder }}</n-tag>
              <n-tag v-if="agent.role === null" size="small" :bordered="false">{{ t("status.notInPanel") }}</n-tag>
            </div>
            <footer>
              <n-button size="small" round type="primary" @click="$router.push(`/chat/${agent.id}`)">
                <template #icon><messages-square :size="14" /></template>
                {{ t("nav.chat") }}
              </n-button>
              <n-button v-if="agent.role" size="small" round secondary @click="$router.push(`/agents/${agent.id}/edit`)">
                <template #icon><pencil :size="13" /></template>
                {{ t("agents.edit") }}
              </n-button>
              <n-popconfirm @positive-click="remove(agent)">
                <template #trigger>
                  <n-button size="small" quaternary circle type="error" class="remove" :loading="deleting === agent.id" :aria-label="t('agents.delete')"><trash2 :size="14" /></n-button>
                </template>
                {{ t("agents.confirmDelete", { name: agent.name }) }}
              </n-popconfirm>
            </footer>
          </article>
        </div>
      </n-spin>
    </n-space>
  </div>
</template>

<style scoped>
.main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  padding: 22px 24px;
  border-radius: 24px;
  background: var(--ink);
  color: var(--ink-text);
  box-shadow: var(--card-shadow-hover);
}
.avatar {
  width: 44px;
  height: 44px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 15px;
  background: var(--surface-2);
  font-size: 22px;
}
.avatar.big {
  width: 60px;
  height: 60px;
  border-radius: 20px;
  font-size: 30px;
  background: var(--accent-gradient);
}
.main-text {
  flex: 1 1 200px;
  min-width: 0;
}
.label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.6;
}
.main-name {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.03em;
  overflow-wrap: anywhere;
}
.main-model {
  font-size: 13px;
  opacity: 0.65;
}
.main-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* Buttons on the ink card: light glass, so they read on black (and on white in the dark theme). */
.on-ink {
  --n-color: color-mix(in srgb, var(--ink-text) 14%, transparent) !important;
  --n-color-hover: color-mix(in srgb, var(--ink-text) 22%, transparent) !important;
  --n-color-pressed: color-mix(in srgb, var(--ink-text) 18%, transparent) !important;
  --n-color-focus: color-mix(in srgb, var(--ink-text) 22%, transparent) !important;
  --n-text-color: var(--ink-text) !important;
  --n-text-color-hover: var(--ink-text) !important;
  --n-text-color-pressed: var(--ink-text) !important;
  --n-text-color-focus: var(--ink-text) !important;
}
.group-title {
  margin: 26px 0 12px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-2);
}
.empty {
  padding: 40px 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 14px;
}
.agent {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
  border-radius: var(--radius-card);
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--card-shadow);
  transition:
    transform 0.25s var(--ease-out),
    box-shadow 0.25s ease;
}
.agent:hover {
  transform: translateY(-3px);
  box-shadow: var(--card-shadow-hover);
}
.agent header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.head-text {
  min-width: 0;
}
.name {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.model {
  font-size: 12.5px;
  color: var(--muted);
}
.purpose {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--text-2);
}
.tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.agent footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  padding-top: 4px;
}
.remove {
  margin-left: auto;
}
</style>
