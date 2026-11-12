<script setup lang="ts">
import type { AgentListItemDto, LibraryCursor, LibraryHitDto, LibraryItemKind, LibraryMaterialDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NEmpty, NInput, NPopconfirm, NSpin, useMessage } from "naive-ui";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { api } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";
import { intlLocale } from "../format";

const { t, locale } = useI18n();
const route = useRoute();
const message = useMessage();
const agents = ref<AgentListItemDto[]>([]);
const agent = ref("");
const kind = ref<LibraryItemKind | "">("");
const draft = ref("");
const query = ref("");
const items = ref<LibraryHitDto[]>([]);
const cursor = ref<LibraryCursor | null>(null);
const busy = ref(false);
const failed = ref(false);
const selectedId = ref<string | null>(null);
const material = ref<LibraryMaterialDto | null>(null);
const materialFailed = ref(false);
let pageVersion = 0;
let detailVersion = 0;
let alive = true;

async function load(more = false): Promise<void> {
  if (more && (busy.value || !cursor.value)) return;
  const version = ++pageVersion;
  if (!more) { items.value = []; cursor.value = null; }
  busy.value = true;
  failed.value = false;
  try {
    const page = await api.library.page({ agentId: agent.value || undefined, kind: kind.value || undefined, query: query.value, cursor: more ? cursor.value! : undefined });
    if (!alive || version !== pageVersion) return;
    items.value = more ? [...items.value, ...page.items] : page.items;
    cursor.value = page.next;
  } catch {
    if (alive && version === pageVersion) failed.value = true;
  } finally {
    if (alive && version === pageVersion) busy.value = false;
  }
}

function search(): void {
  query.value = draft.value.trim();
  void load();
}

async function openMaterial(id: string): Promise<void> {
  const version = ++detailVersion;
  selectedId.value = id;
  material.value = null;
  materialFailed.value = false;
  try {
    const data = await api.library.material(id);
    if (alive && version === detailVersion) material.value = data;
  } catch {
    if (alive && version === detailVersion) materialFailed.value = true;
  }
}

function closeMaterial(): void {
  ++detailVersion;
  selectedId.value = null;
  material.value = null;
}

async function remove(id: string): Promise<void> {
  try {
    await api.library.remove(id);
    if (!alive) return;
    if (selectedId.value === id) closeMaterial();
    await load();
  } catch {
    if (alive) message.error(t("library.browser.error"));
  }
}

function sourceUrl(item: LibraryHitDto): string | undefined {
  if (item.kind !== "video") return undefined;
  try {
    const url = new URL(item.source);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch { /* A missing or invalid source stays plain text. */ }
  return undefined;
}

function processing(item: LibraryHitDto): string {
  if (!item.processing) return t("library.browser.processingUnknown");
  if (item.processing.startsWith("subtitles") || item.processing.startsWith("video_")) return t(`library.browser.${item.processing}`);
  return t(`chat.read.state.${item.processing}`);
}

const owner = (id: string) => agents.value.find((entry) => entry.id === id)?.name ?? id;
const date = (at: number) => new Intl.DateTimeFormat(intlLocale(locale.value), { dateStyle: "medium", timeStyle: "short" }).format(at);

onMounted(() => {
  void load();
  void api.agents().then((result) => { if (alive) agents.value = result.agents; }).catch(() => {});
});
onBeforeUnmount(() => { alive = false; });
watch([agent, kind], () => void load());
watch(() => route.query.material, (id) => {
  if (typeof id === "string") void openMaterial(id);
}, { immediate: true });
</script>

<template>
  <page-header :title="t('today.materials')" :subtitle="t('library.browser.subtitle')" />
  <n-card v-if="selectedId" class="detail">
    <div class="actions">
      <h2>{{ material?.item.title ?? t("library.browser.savedText") }}</h2>
      <n-button size="small" @click="closeMaterial">{{ t("library.browser.close") }}</n-button>
    </div>
    <n-alert v-if="materialFailed" type="error">{{ t("library.browser.error") }}</n-alert>
    <template v-else-if="material">
      <p>{{ owner(material.item.agentId) }} · {{ date(material.item.at) }} · {{ processing(material.item) }}</p>
      <p v-if="!material.text">{{ t("library.browser.noText") }}</p>
      <pre v-else>{{ material.text }}</pre>
    </template>
    <n-spin v-else />
  </n-card>
  <form class="filters" @submit.prevent="search">
    <label>
      {{ t("library.browser.agent") }}
      <select v-model="agent">
        <option value="">{{ t("library.browser.all") }}</option>
        <option v-for="entry in agents" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
      </select>
    </label>
    <label>
      {{ t("library.browser.type") }}
      <select v-model="kind">
        <option value="">{{ t("library.browser.all") }}</option>
        <option value="document">{{ t("library.kind.document") }}</option>
        <option value="video">{{ t("library.kind.video") }}</option>
      </select>
    </label>
    <label class="query">
      {{ t("library.browser.searchText") }}
      <n-input v-model:value="draft" :maxlength="200" :placeholder="t('library.placeholder')" />
    </label>
    <n-button attr-type="submit" type="primary">{{ t("library.search") }}</n-button>
  </form>
  <n-alert v-if="failed" type="error">{{ t("library.browser.error") }} <n-button size="tiny" @click="load(!!items.length)">{{ t("chat.sendRecovery.check") }}</n-button></n-alert>
  <n-empty v-else-if="!busy && !items.length" :description="t(query ? 'library.browser.noResults' : agent ? 'library.emptyLibrary' : 'library.emptyAll')" />
  <ul v-if="items.length" class="items">
    <li v-for="item in items" :key="item.id">
      <strong>{{ item.title }}</strong>
      <p>{{ t(`library.kind.${item.kind}`) }} · {{ owner(item.agentId) }} · {{ date(item.at) }} · {{ processing(item) }}</p>
      <a v-if="sourceUrl(item)" :href="sourceUrl(item)" target="_blank" rel="noopener noreferrer">{{ item.source }}</a>
      <p v-else>{{ item.source }} · {{ t("library.browser.originalUnavailable") }}</p>
      <p v-for="snippet in item.snippets" :key="snippet.from">{{ snippet.text }}</p>
      <div class="actions">
        <n-button size="small" @click="openMaterial(item.id)">{{ t("library.browser.savedText") }}</n-button>
        <n-popconfirm :positive-text="t('library.remove')" @positive-click="remove(item.id)">
          <template #trigger><n-button size="small">{{ t("library.remove") }}</n-button></template>
          {{ t("library.browser.removeNote") }}
        </n-popconfirm>
      </div>
    </li>
  </ul>
  <n-spin v-if="busy" />
  <n-button v-else-if="cursor && !failed" @click="load(true)">{{ t("library.browser.more") }}</n-button>
</template>

<style scoped>
.filters, .actions { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; }
.filters, .detail { margin-bottom: 18px; }
.filters label { display: grid; gap: 4px; max-width: 100%; }
.query { flex: 1 1 200px; }
.filters select { padding: 7px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
.items { display: grid; gap: 10px; padding: 0; list-style: none; }
.items li { padding: 14px; border: 1px solid var(--border); border-radius: 10px; }
.items p, .items a { margin: 6px 0; overflow-wrap: anywhere; }
.detail pre { max-height: 55dvh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.detail h2 { flex: 1 1 180px; margin: 0; overflow-wrap: anywhere; }
</style>
