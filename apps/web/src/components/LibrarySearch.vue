<script setup lang="ts">
// Search across what the panel already read for this agent: documents from the chat and video
// transcripts. It searches only this agent's materials — the same boundary the agent itself has —
// and every hit names its source, so the owner can go back to the page, sheet or timecode.
import type { LibraryHitDto } from "@clawdesk/shared";
import { Search, Trash2 } from "@lucide/vue";
import { NButton, NInput, useMessage } from "naive-ui";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import { formatRelative } from "../format";

const props = defineProps<{ agentId: string }>();
const { t, locale } = useI18n();
const message = useMessage();

const query = ref("");
const hits = ref<LibraryHitDto[] | null>(null);
const searched = ref(0);
const partial = ref(false);
const busy = ref(false);

async function search(): Promise<void> {
  const text = query.value.trim();
  if (!text || busy.value) return;
  busy.value = true;
  try {
    const result = await api.library.search(text, props.agentId);
    hits.value = result.hits;
    searched.value = result.searched;
    partial.value = result.partial;
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  } finally {
    busy.value = false;
  }
}

async function remove(hit: LibraryHitDto): Promise<void> {
  try {
    await api.library.remove(hit.id);
    hits.value = (hits.value ?? []).filter((item) => item.id !== hit.id);
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  }
}

const when = (hit: LibraryHitDto) => formatRelative(hit.at, locale.value);
</script>

<template>
  <div class="library">
    <div class="bar">
      <n-input v-model:value="query" size="small" :placeholder="t('library.placeholder')" :maxlength="200" @keydown.enter="search" />
      <n-button size="small" secondary :loading="busy" :disabled="!query.trim()" @click="search">
        <search :size="13" /> &nbsp;{{ t("library.search") }}
      </n-button>
    </div>

    <template v-if="hits">
      <p v-if="!hits.length" class="hint">{{ searched ? t("library.nothing", { count: searched }) : t("library.emptyLibrary") }}</p>
      <p v-else-if="partial" class="hint">{{ t("library.partial") }}</p>
      <ul v-if="hits.length" class="hits">
        <li v-for="hit in hits" :key="hit.id">
          <div class="head">
            <b>{{ hit.title }}</b>
            <span class="muted">{{ t("library.kind." + hit.kind) }}<template v-if="hit.locator"> · {{ hit.locator }}</template> · {{ when(hit) }}</span>
            <n-button quaternary circle size="tiny" :aria-label="t('library.remove')" @click="remove(hit)"><trash-2 :size="12" /></n-button>
          </div>
          <p v-for="(snippet, i) in hit.snippets" :key="i" class="snippet">{{ snippet.text }}</p>
          <a v-if="hit.kind === 'video'" class="source" :href="hit.source" target="_blank" rel="noopener noreferrer">{{ hit.source }}</a>
          <span v-else class="source">{{ hit.source }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.library {
  padding: 0 4px 8px;
}
.bar {
  display: flex;
  gap: 8px;
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  opacity: 0.7;
}
.hits {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  max-height: 240px;
  overflow-y: auto;
}
.hits li {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.muted {
  flex: 1;
  font-size: 12px;
  opacity: 0.65;
}
.snippet {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.45;
}
.source {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: inherit;
  opacity: 0.65;
  word-break: break-all;
}
</style>
