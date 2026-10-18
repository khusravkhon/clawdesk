<script setup lang="ts">
import type { GatewayConnectionState } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NDescriptions, NDescriptionsItem, NEmpty, NList, NListItem, NPopconfirm, NSpace, NTag, NThing } from "naive-ui";
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import PageHeader from "../components/ui/PageHeader.vue";
import { useSystemStore } from "../stores/system";
import { api, ApiError } from "../api/client";

const { t } = useI18n();
const system = useSystemStore();
const restarting = ref(false);
const restartResult = ref<"success" | "error" | "warning" | null>(null);
const restartText = ref("");

async function restartGateway(): Promise<void> {
  if (restarting.value) return;
  restarting.value = true;
  restartResult.value = null;
  try {
    await api.system.restartGateway();
    restartResult.value = "success";
    restartText.value = t("status.restart.success");
  } catch (error) {
    const code = error instanceof ApiError ? error.body.error : "gateway_restart_unconfirmed";
    const keys: Record<string, string> = {
      gateway_restart_busy: "busy", gateway_unavailable: "unavailable",
      gateway_restart_rejected: "rejected", gateway_restart_unconfirmed: "unconfirmed",
    };
    restartResult.value = code === "gateway_restart_rejected" || code === "gateway_unavailable" ? "error" : "warning";
    restartText.value = t(`status.restart.${keys[code] ?? "unconfirmed"}`);
  } finally {
    restarting.value = false;
    await system.refresh();
  }
}

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
  <div>
    <page-header :title="t('status.title')">
      <n-button :loading="system.loading" @click="system.refresh()">{{ t("status.refresh") }}</n-button>
    </page-header>
    <n-space vertical size="large">
      <n-alert v-if="!system.panelReachable" type="error">{{ t("status.unreachable") }}</n-alert>

      <template v-if="system.health">
        <n-card :title="t('status.gateway')">
          <div id="gateway-restart" class="restart-controls">
            <p>{{ t("status.restart.about") }}</p>
            <n-popconfirm :positive-text="t('status.restart.button')" :negative-text="t('status.restart.cancel')" @positive-click="() => { void restartGateway(); }">
              <template #trigger>
                <n-button :loading="restarting" :disabled="restarting || system.health.gateway.state !== 'connected'" secondary>{{ t("status.restart.button") }}</n-button>
              </template>
              {{ t("status.restart.confirm") }}
            </n-popconfirm>
            <n-alert v-if="restarting" type="info" class="mt">{{ t("status.restart.waiting") }}</n-alert>
            <n-alert v-else-if="restartResult" :type="restartResult" class="mt">{{ restartText }}</n-alert>
            <n-alert v-else-if="system.health.gateway.state !== 'connected'" type="warning" class="mt">{{ t("status.restart.unavailable") }}</n-alert>
          </div>
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
  </div>
</template>

<style scoped>
.restart-controls {
  margin-bottom: 16px;
}
.mt {
  margin-top: 12px;
}
</style>
