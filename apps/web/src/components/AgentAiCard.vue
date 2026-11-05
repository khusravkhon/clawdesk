<script setup lang="ts">
// A junior agent's own AI, after it was created: what it uses now and a way to connect a separate key or
// subscription (the same AiConnect the builder shows), then its own model chain. An agent that inherits the
// main agent's AI keeps following it until it gets its own.
import type { AiStatusDto } from "@clawdesk/shared";
import { Cpu } from "@lucide/vue";
import { NAlert, NButton, NTag } from "naive-ui";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import AiConnect from "./AiConnect.vue";
import ModelChain from "./ModelChain.vue";

const props = defineProps<{ agentId: string }>();
const { t } = useI18n();
const status = ref<AiStatusDto | null>(null);
const connecting = ref(false), connected = ref(false), failed = ref(false), chainKey = ref(0);

async function load(): Promise<void> {
  try { status.value = await api.ai.status(props.agentId); failed.value = false; }
  catch { failed.value = true; }
}
/** Connected: the agent stops following the main agent's models, then its own chain is shown. */
async function done(): Promise<void> {
  connecting.value = false;
  try { await api.ai.markOwn(props.agentId); } catch { /* the connection itself worked; following is fixed on the next try */ }
  connected.value = true; chainKey.value++; void load();
}
onMounted(load);
</script>

<template>
  <section class="card">
    <h2 class="card-title"><cpu :size="16" /> {{ t("agentAi.title") }}</h2>
    <p class="hint">{{ t("agentAi.lead") }}</p>
    <n-alert v-if="failed" type="warning" :bordered="false" class="block">{{ t("agentAi.statusFailed") }}</n-alert>
    <p v-else-if="status" class="block">
      <template v-if="status.connected">{{ t("agentAi.providers") }}: <n-tag v-for="provider in status.providers" :key="provider" size="small" class="tag">{{ provider }}</n-tag></template>
      <template v-else>{{ t("agentAi.none") }}</template>
    </p>
    <n-alert v-if="connected" type="success" :bordered="false" class="block">{{ t("agentAi.connected") }}</n-alert>
    <template v-if="connecting">
      <AiConnect :agent-id="agentId" @connected="done" />
      <n-button quaternary class="block" @click="connecting = false">{{ t("agentAi.cancel") }}</n-button>
    </template>
    <n-button v-else class="block" @click="connecting = true">{{ t("agentAi.connect") }}</n-button>
    <div class="block"><ModelChain :key="chainKey" :agent-id="agentId" /></div>
  </section>
</template>

<style scoped>
.block { margin-top: 10px; }
.tag { margin-right: 4px; }
</style>
