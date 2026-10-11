<script setup lang="ts">
// First window after install: connect an AI to the main agent. Junior agents get
// their own access later, in the agent builder (same AiConnect component).
import { NButton, NCard, NSpace } from "naive-ui";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import PageHeader from "../components/ui/PageHeader.vue";
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
  <div>
    <page-header :title="t('setupAi.title')" :subtitle="t('setupAi.lead')" />
    <n-space vertical size="large">
      <n-card>
        <AiConnect agent-id="main" @connected="onConnected" />
      </n-card>
      <n-button v-if="done" type="primary" size="large" @click="router.push('/')">{{ t("setupAi.next") }}</n-button>
    </n-space>
  </div>
</template>

