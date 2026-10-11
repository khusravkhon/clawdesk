<script setup lang="ts">
import type { GatewayConnectionState } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NDescriptions, NDescriptionsItem, NEmpty, NList, NListItem, NSpace, NTag, NThing } from "naive-ui";
import { onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useSystemStore } from "../stores/system";

const { t } = useI18n();
const system = useSystemStore();

const stateType: Record<GatewayConnectionState, "success" | "warning" | "error" | "info" | "default"> = {
  idle: "default",
  connecting: "info",
  connected: "success",
  pairing_required: "warning",
  auth_failed: "error",
  disconnected: "error",
};

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void system.refresh();
  timer = setInterval(() => void system.refresh(), 5_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <n-space vertical size="large">
    <n-space justify="space-between" align="center">
      <h1 class="title">{{ t("status.title") }}</h1>
      <n-button :loading="system.loading" @click="system.refresh()">{{ t("status.refresh") }}</n-button>
    </n-space>

    <n-alert v-if="!system.panelReachable" type="error">{{ t("status.unreachable") }}</n-alert>

    <template v-if="system.health">
      <n-card :title="t('status.gateway')">
        <n-descriptions :column="1" label-placement="left" bordered>
          <n-descriptions-item :label="t('status.panel')">{{ system.health.version }}</n-descriptions-item>
          <n-descriptions-item label="Gateway">
            <n-tag :type="stateType[system.health.gateway.state]" size="small">
              {{ t(`status.state.${system.health.gateway.state}`) }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item :label="t('status.version')">{{ system.health.gateway.serverVersion ?? "—" }}</n-descriptions-item>
          <n-descriptions-item :label="t('status.protocol')">{{ system.health.gateway.protocol ?? "—" }}</n-descriptions-item>
          <n-descriptions-item :label="t('status.scopes')">
            <n-space size="small">
              <n-tag v-for="scope in system.health.gateway.scopes" :key="scope" size="small">{{ scope }}</n-tag>
            </n-space>
          </n-descriptions-item>
        </n-descriptions>
        <n-alert v-if="system.health.gateway.hint" type="warning" class="mt">{{ system.health.gateway.hint }}</n-alert>
      </n-card>

      <n-card :title="t('status.agents')">
        <n-alert v-if="system.agentsError" type="error">{{ system.agentsError }}</n-alert>
        <n-empty v-else-if="!system.agents?.agents.length" :description="t('status.noAgents')" />
        <n-list v-else>
          <n-list-item v-for="agent in system.agents.agents" :key="agent.id">
            <n-thing :title="`${agent.emoji ?? '🤖'} ${agent.name}`" :description="agent.model ?? undefined">
              <template #header-extra>
                <n-space size="small">
                  <n-tag v-if="agent.isDefault" type="success" size="small">{{ t("status.default") }}</n-tag>
                  <n-tag v-if="!agent.role" size="small">{{ t("status.notInPanel") }}</n-tag>
                </n-space>
              </template>
              <code>{{ agent.id }}</code>
            </n-thing>
          </n-list-item>
        </n-list>
      </n-card>
    </template>
  </n-space>
</template>

<style scoped>
.title {
  margin: 0;
  font-size: 22px;
}
.mt {
  margin-top: 12px;
}
</style>
