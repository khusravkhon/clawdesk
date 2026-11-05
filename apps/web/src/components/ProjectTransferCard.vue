<script setup lang="ts">
// P8: carrying this project to another installation (a server, another computer) as a file. The folder
// belongs to this machine; the other installation gets exactly what is listed here, nothing else.
import type { ProjectTransferPreviewDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard } from "naive-ui";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string }>();
const { t, te } = useI18n();
const preview = ref<ProjectTransferPreviewDto | null>(null), busy = ref(false), error = ref<string | null>(null), done = ref<string | null>(null);
const explain = (e: unknown) => e instanceof ApiError && te(`projectTransfer.errors.${e.body.error}`) ? t(`projectTransfer.errors.${e.body.error}`) : t("projectTransfer.failed");
const size = (bytes: number) => bytes < 1024 * 1024 ? t("projectTransfer.kb", { n: Math.max(1, Math.round(bytes / 1024)) }) : t("projectTransfer.mb", { n: (bytes / 1024 / 1024).toFixed(1) });

async function show(): Promise<void> {
  busy.value = true; error.value = null; done.value = null;
  try { preview.value = await api.company.transferPreview(props.projectId); }
  catch (e) { error.value = explain(e); }
  finally { busy.value = false; }
}
async function download(): Promise<void> {
  busy.value = true; error.value = null;
  try {
    const result = await api.company.transferExport(props.projectId);
    const bytes = Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0));
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([bytes], { type: "application/gzip" }));
    link.download = result.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    done.value = t("projectTransfer.downloaded", { name: result.fileName });
  } catch (e) { error.value = explain(e); }
  finally { busy.value = false; }
}
</script>

<template>
  <n-card :title="t('projectTransfer.title')" class="block">
    <p>{{ t("projectTransfer.lead") }}</p>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>
    <n-alert v-if="done" type="success" class="block">{{ done }}</n-alert>
    <n-button v-if="!preview" class="block" :loading="busy" @click="show">{{ t("projectTransfer.show") }}</n-button>
    <template v-else>
      <p class="block">{{ t("projectTransfer.summary", { files: preview.files.length, size: size(preview.bytes), rules: preview.rules }) }}<template v-if="preview.folder"> {{ t("projectTransfer.folder", { name: preview.folder }) }}</template></p>
      <details v-if="preview.files.length"><summary>{{ t("projectTransfer.files") }}</summary><p v-for="item in preview.files" :key="item.path" class="hint"><code>{{ item.path }}</code> · {{ size(item.size) }}</p></details>
      <details v-if="preview.excluded.length" open><summary>{{ t("projectTransfer.excluded", { count: preview.excluded.length }) }}</summary><p v-for="item in preview.excluded" :key="item.path" class="hint"><code>{{ item.path }}</code> — {{ te(`projectTransfer.reasons.${item.reason}`) ? t(`projectTransfer.reasons.${item.reason}`) : item.reason }}</p></details>
      <p class="hint block">{{ t("projectTransfer.notCarried") }}</p>
      <n-button type="primary" class="block" :loading="busy" @click="download">{{ t("projectTransfer.download") }}</n-button>
    </template>
  </n-card>
</template>

<style scoped>
.block { margin-top: 12px; }
.hint { font-size: 0.92em; opacity: 0.75; line-height: 1.6; overflow-wrap: anywhere; }
</style>
