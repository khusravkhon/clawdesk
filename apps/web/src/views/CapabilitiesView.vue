<script setup lang="ts">
// P0: what this installation can actually do, checked now, and what each capability enables or limits.
import type { CapabilitiesDto, CapabilityState } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NSpace, NTag } from "naive-ui";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";

const { t } = useI18n();
const router = useRouter();
const data = ref<CapabilitiesDto | null>(null), loading = ref(false), failed = ref(false);
const tagType = (state: CapabilityState) => state === "ok" ? "success" : state === "unknown" ? "default" : "warning";

async function load(): Promise<void> {
  loading.value = true;
  try { data.value = await api.capabilities(); failed.value = false; }
  catch { failed.value = true; }
  finally { loading.value = false; }
}
onMounted(load);
</script>

<template>
  <div>
    <page-header :title="t('capabilities.title')" :subtitle="t('capabilities.subtitle')">
      <n-space>
        <n-button key="company" @click="router.push('/company')">{{ t('projects.toCompany') }}</n-button>
        <n-button key="refresh" :loading="loading" @click="load">{{ t('capabilities.check') }}</n-button>
      </n-space>
    </page-header>
    <n-alert type="info" :bordered="false" class="block">{{ t('capabilities.lead') }}</n-alert>
    <n-alert v-if="failed" type="error" class="block">{{ t('capabilities.failed') }}</n-alert>
    <p v-if="loading" class="hint block" role="status">{{ t('capabilities.checking') }}</p>
    <n-card v-if="data" class="block">
      <div v-for="item in data.items" :key="item.id" class="row">
        <div>
          <strong>{{ t(`capabilities.items.${item.id}.title`) }}</strong>
          <n-tag size="small" :type="tagType(item.state)" class="tag">{{ t(`capabilities.state.${item.state}`) }}</n-tag>
          <span v-if="item.value" class="value">{{ item.value }}</span>
          <p class="hint">{{ item.state === 'unknown' ? t('capabilities.unknownHint') : t(`capabilities.items.${item.id}.${item.state === 'ok' ? 'gives' : 'without'}`) }}</p>
        </div>
      </div>
      <p class="hint block">{{ t('capabilities.checkedAt', { at: new Date(data.checkedAt).toLocaleString() }) }}</p>
    </n-card>
  </div>
</template>

<style scoped>
.block { margin-top: 12px; }
.row { padding: 10px 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
.tag { margin-left: 8px; }
.value { margin-left: 8px; font-family: ui-monospace, monospace; font-size: 0.9em; }
.hint { margin: 4px 0 0; font-size: 0.92em; opacity: 0.75; line-height: 1.6; }
</style>
