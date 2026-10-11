<script setup lang="ts">
// First window after install: connect an AI to the main agent. Junior agents get
// their own access later, in the agent builder (same AiConnect component).
import { NButton, NCard, NSpace } from "naive-ui";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import AiConnect from "../components/AiConnect.vue";
import { markAiConnected } from "../router";

const { t } = useI18n();
const router = useRouter();
const done = ref(false);

function onConnected(): void {
  done.value = true;
  markAiConnected();
}
</script>

<template>
  <n-space vertical size="large">
    <div>
      <h1 class="title">{{ t("setupAi.title") }}</h1>
      <p class="lead">{{ t("setupAi.lead") }}</p>
    </div>
    <n-card>
      <AiConnect agent-id="main" @connected="onConnected" />
    </n-card>
    <n-button v-if="done" type="primary" size="large" @click="router.push('/status')">{{ t("setupAi.next") }}</n-button>
  </n-space>
</template>

<style scoped>
.title {
  margin: 0 0 4px;
  font-size: 24px;
}
.lead {
  margin: 0;
  opacity: 0.8;
}
</style>
