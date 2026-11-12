<script setup lang="ts">
import type { AgentListItemDto, LibraryCursor, LibraryHitDto, LibraryItemKind, LibraryMaterialDto } from "@clawdesk/shared";
import { FileText, Search, Trash2, Video, X } from "@lucide/vue";
import { NAlert, NButton, NCard, NEmpty, NInput, NPopconfirm, NRadioButton, NRadioGroup, NSpin, useMessage } from "naive-ui";
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
    <div class="detail-head">
      <h2>{{ material?.item.title ?? t("library.browser.savedText") }}</h2>
      <n-button size="small" quaternary circle :aria-label="t('library.browser.close')" @click="closeMaterial"><x :size="16" /></n-button>
    </div>
    <n-alert v-if="materialFailed" type="error">{{ t("library.browser.error") }}</n-alert>
    <template v-else-if="material">
      <p class="meta">{{ owner(material.item.agentId) }} · {{ date(material.item.at) }} · {{ processing(material.item) }}</p>
      <p v-if="!material.text" class="meta">{{ t("library.browser.noText") }}</p>
      <pre v-else>{{ material.text }}</pre>
    </template>
    <n-spin v-else />
  </n-card>
  <form class="filters" @submit.prevent="search">
    <n-radio-group v-model:value="kind" size="small" :aria-label="t('library.browser.type')">
      <n-radio-button value="">{{ t("library.browser.all") }}</n-radio-button>
      <n-radio-button value="document">{{ t("library.kind.document") }}</n-radio-button>
      <n-radio-button value="video">{{ t("library.kind.video") }}</n-radio-button>
    </n-radio-group>
    <select v-model="agent" :aria-label="t('library.browser.agent')">
      <option value="">{{ t("library.browser.agent") }}: {{ t("library.browser.all") }}</option>
      <option v-for="entry in agents" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
    </select>
    <n-input v-model:value="draft" round clearable class="query" :maxlength="200" :placeholder="t('library.placeholder')" :aria-label="t('library.browser.searchText')">
      <template #prefix><search :size="15" /></template>
    </n-input>
    <n-button attr-type="submit" type="primary" round>{{ t("library.search") }}</n-button>
  </form>
  <n-alert v-if="failed" type="error">{{ t("library.browser.error") }} <n-button size="tiny" @click="load(!!items.length)">{{ t("chat.sendRecovery.check") }}</n-button></n-alert>
  <n-empty v-else-if="!busy && !items.length" class="empty" :description="t(query ? 'library.browser.noResults' : agent ? 'library.emptyLibrary' : 'library.emptyAll')" />
  <ul v-if="items.length" class="items">
    <li v-for="item in items" :key="item.id" class="item" :class="{ open: item.id === selectedId }">
      <span class="glyph" :class="item.kind"><component :is="item.kind === 'video' ? Video : FileText" :size="18" :stroke-width="1.75" /></span>
      <div class="body">
        <strong>{{ item.title }}</strong>
        <p class="meta">{{ t(`library.kind.${item.kind}`) }} · {{ owner(item.agentId) }} · {{ date(item.at) }} · {{ processing(item) }}</p>
        <a v-if="sourceUrl(item)" :href="sourceUrl(item)" target="_blank" rel="noopener noreferrer">{{ item.source }}</a>
        <p v-else class="meta">{{ item.source }} · {{ t("library.browser.originalUnavailable") }}</p>
        <p v-for="snippet in item.snippets" :key="snippet.from" class="snippet">{{ snippet.text }}</p>
      </div>
      <div class="actions">
        <n-button size="small" round secondary @click="openMaterial(item.id)">{{ t("library.browser.savedText") }}</n-button>
        <n-popconfirm :positive-text="t('library.remove')" @positive-click="remove(item.id)">
          <template #trigger><n-button size="small" quaternary circle :aria-label="t('library.remove')"><trash2 :size="15" /></n-button></template>
          {{ t("library.browser.removeNote") }}
        </n-popconfirm>
      </div>
    </li>
  </ul>
  <div class="more">
    <n-spin v-if="busy" />
    <n-button v-else-if="cursor && !failed" round @click="load(true)">{{ t("library.browser.more") }}</n-button>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 18px; }
.query { flex: 1 1 220px; }
.query { --n-color: var(--surface) !important; }
.filters select { background: var(--surface); }
.empty { padding: 48px 0; }
.items { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.item { display: flex; align-items: flex-start; gap: 14px; padding: 16px 18px; border-radius: var(--radius-card); background: var(--surface); border: 1px solid var(--border); box-shadow: var(--card-shadow); transition: transform 0.25s var(--ease-out), box-shadow 0.25s ease, border-color 0.25s ease; }
.item:hover { transform: translateY(-2px); box-shadow: var(--card-shadow-hover); }
.item.open { border-color: var(--accent-bright); }
.glyph { width: 40px; height: 40px; flex: none; display: grid; place-items: center; border-radius: 14px; background: rgba(59, 130, 246, 0.13); color: #2563eb; }
.glyph.video { background: rgba(236, 72, 153, 0.13); color: #db2777; }
.body { flex: 1; min-width: 0; }
.body strong { font-size: 15px; overflow-wrap: anywhere; }
.body p, .body a { margin: 4px 0 0; overflow-wrap: anywhere; }
.body a { display: inline-block; font-size: 13px; }
.meta { color: var(--text-2); font-size: 13px; }
.snippet { padding: 8px 12px; border-radius: 12px; background: var(--surface-2); font-size: 13px; }
.actions { display: flex; align-items: center; gap: 6px; flex: none; }
.more { display: flex; justify-content: center; margin-top: 16px; }
.detail { margin-bottom: 18px; }
.detail-head { display: flex; align-items: flex-start; gap: 10px; }
.detail h2 { flex: 1; margin: 0 0 6px; font-size: 20px; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.detail pre { max-height: 55dvh; overflow: auto; margin: 12px 0 0; padding: 14px 16px; border-radius: 14px; background: var(--surface-2); font: inherit; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 600px) {
  .item { flex-wrap: wrap; }
  .actions { width: 100%; justify-content: flex-end; }
}
</style>
