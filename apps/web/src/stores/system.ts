import type { AgentListDto, HealthDto } from "@clawdesk/shared";
import { defineStore } from "pinia";
import { ref } from "vue";
import { api, ApiError } from "../api/client";

export const useSystemStore = defineStore("system", () => {
  const health = ref<HealthDto | null>(null);
  const agents = ref<AgentListDto | null>(null);
  const loading = ref(false);
  const panelReachable = ref(true);
  const agentsError = ref<string | null>(null);

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      health.value = await api.health();
      panelReachable.value = true;
    } catch {
      panelReachable.value = false;
      health.value = null;
    }
    try {
      agents.value = health.value?.gateway.state === "connected" ? await api.agents() : null;
      agentsError.value = null;
    } catch (error) {
      agents.value = null;
      agentsError.value = error instanceof ApiError ? error.body.message : String(error);
    } finally {
      loading.value = false;
    }
  }

  return { health, agents, loading, panelReachable, agentsError, refresh };
});
