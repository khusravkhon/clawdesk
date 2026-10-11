<script setup lang="ts">
// "My agents": the main agent and its juniors (screen 7).
import type { AgentListDto, AgentListItemDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NEmpty, NList, NListItem, NPopconfirm, NSpace, NSpin, NTag, NThing, useMessage } from "naive-ui";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
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
  <n-space vertical size="large">
    <n-space justify="space-between" align="center">
      <h1 class="title">{{ t("agents.title") }}</h1>
      <n-button type="primary" @click="$router.push('/agents/new')">{{ t("agents.create") }}</n-button>
    </n-space>

    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <n-alert v-if="data && !data.sandboxEnabled" type="warning" :title="t('agents.noSandboxTitle')">{{ t("agents.noSandbox") }}</n-alert>

    <n-spin :show="loading">
      <n-card v-if="main" :title="t('agents.main')">
        <n-thing :title="`${main.emoji ?? '🧭'} ${main.name}`" :description="main.model ?? t('agents.noModel')" />
      </n-card>

      <n-card :title="t('agents.juniors')" class="mt">
        <n-empty v-if="!juniors.length" :description="t('agents.noJuniors')">
          <template #extra>
            <n-button size="small" @click="$router.push('/agents/new')">{{ t("agents.create") }}</n-button>
          </template>
        </n-empty>
        <n-list v-else>
          <n-list-item v-for="agent in juniors" :key="agent.id">
            <n-thing :title="`${agent.emoji ?? '🤖'} ${agent.name}`" :description="agent.purpose ?? undefined">
              <template #header-extra>
                <n-space size="small" align="center">
                  <n-tag v-if="agent.canAskMain" size="small" type="info">{{ t("agents.canAskMain") }}</n-tag>
                  <n-tag v-if="agent.role === null" size="small">{{ t("status.notInPanel") }}</n-tag>
                  <n-popconfirm @positive-click="remove(agent)">
                    <template #trigger>
                      <n-button size="small" quaternary type="error" :loading="deleting === agent.id">{{ t("agents.delete") }}</n-button>
                    </template>
                    {{ t("agents.confirmDelete", { name: agent.name }) }}
                  </n-popconfirm>
                </n-space>
              </template>
              <n-space size="small">
                <code>{{ agent.id }}</code>
                <span class="muted">{{ agent.model ?? "" }}</span>
              </n-space>
            </n-thing>
          </n-list-item>
        </n-list>
      </n-card>
    </n-spin>
  </n-space>
</template>

<style scoped>
.title {
  margin: 0;
  font-size: 22px;
}
.mt {
  margin-top: 16px;
}
.muted {
  opacity: 0.6;
  font-size: 13px;
}
</style>
