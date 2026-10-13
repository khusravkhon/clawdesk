<script setup lang="ts">
// Action log on the System screen: the panel's own actions and what agents did (OpenClaw's ledger).
import type { AgentAuditEventDto, AuditEventDto } from "@clawdesk/shared";
import { NButton, NCard, NEmpty, NTabPane, NTabs, NTag } from "naive-ui";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import { formatDateTime } from "../format";

const { t, te, locale } = useI18n();
const panel = ref<AuditEventDto[]>([]);
const agents = ref<AgentAuditEventDto[]>([]);
const nextPanel = ref<number | null>(null);
const nextAgents = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load(more: "panel" | "agents" | null = null): Promise<void> {
  loading.value = true;
  try {
    const page = await api.system.audit(more === "panel" ? { before: nextPanel.value ?? undefined } : more === "agents" ? { cursor: nextAgents.value ?? undefined } : {});
    if (more !== "agents") {
      panel.value = more ? [...panel.value, ...page.panel] : page.panel;
      nextPanel.value = page.nextPanel;
    }
    if (more !== "panel") {
      agents.value = more ? [...agents.value, ...page.agents] : page.agents;
      nextAgents.value = page.nextAgents;
    }
    error.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

/** Known actions read as words; unknown ones show their route. */
const actionText = (action: string) => (te(`audit.action.${action}`) ? t(`audit.action.${action}`) : action);
const agentText = (e: AgentAuditEventDto) => (e.action.startsWith("tool.") ? t("audit.tool", { tool: e.toolName ?? "?" }) : t("audit.run"));
const statusType = (s: string) => (s === "succeeded" ? "success" : s === "failed" ? "error" : "default");

onMounted(() => load());
</script>

<template>
  <n-card :title="t('audit.title')">
    <p class="muted">{{ t("audit.about") }}</p>
    <p v-if="error" class="muted">{{ error }}</p>
    <n-tabs type="line" animated>
      <n-tab-pane name="panel" :tab="t('audit.panelTab')">
        <n-empty v-if="!panel.length && !loading" :description="t('audit.empty')" />
        <ul class="log">
          <li v-for="e in panel" :key="e.id">
            <span class="when">{{ formatDateTime(new Date(e.at).toISOString(), locale) }}</span>
            <n-tag size="small" :bordered="false" :type="e.result === 'ok' ? 'success' : 'error'">{{ e.result === "ok" ? t("audit.ok") : t("audit.failed", { code: e.detail ?? "" }) }}</n-tag>
            <span>{{ actionText(e.action) }}</span>
            <code v-if="e.target">{{ e.target }}</code>
          </li>
        </ul>
        <n-button v-if="nextPanel" size="small" quaternary :loading="loading" @click="load('panel')">{{ t("audit.more") }}</n-button>
      </n-tab-pane>
      <n-tab-pane name="agents" :tab="t('audit.agentsTab')">
        <n-empty v-if="!agents.length && !loading" :description="t('audit.empty')" />
        <ul class="log">
          <li v-for="e in agents" :key="e.id">
            <span class="when">{{ formatDateTime(new Date(e.at).toISOString(), locale) }}</span>
            <n-tag size="small" :bordered="false" :type="statusType(e.status)">{{ e.status }}</n-tag>
            <code>{{ e.agentId ?? "—" }}</code>
            <span>{{ agentText(e) }}</span>
            <span v-if="e.errorCode" class="muted">· {{ e.errorCode }}</span>
          </li>
        </ul>
        <n-button v-if="nextAgents" size="small" quaternary :loading="loading" @click="load('agents')">{{ t("audit.more") }}</n-button>
      </n-tab-pane>
    </n-tabs>
  </n-card>
</template>

<style scoped>
.muted {
  color: var(--text-2);
  margin: 0 0 8px;
  font-size: 13px;
}
.log {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
}
.log li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.when {
  min-width: 110px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
code {
  font-size: 12px;
}
</style>
