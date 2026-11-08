<script setup lang="ts">
// Notes the owner keeps for one agent (screen 4). Each note carries where it came from and the day
// it is about, and the panel writes them all into that agent's USER.md, so the agent reads them as
// its own knowledge. Everything here is correctable: a fact without a source gets repeated forever.
import type { MemoryNoteDto, MemoryNotesDto } from "@clawdesk/shared";
import { Check, NotebookPen, Pencil, Trash2, X } from "@lucide/vue";
import { NAlert, NButton, NInput, NPopconfirm, NTag, useMessage } from "naive-ui";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import { formatDateTime, formatDay } from "../format";

const props = defineProps<{ agentId: string }>();
const { t, locale } = useI18n();
const message = useMessage();

const notes = ref<MemoryNoteDto[]>([]);
const loading = ref(true);
const saving = ref(false);
const applied = ref<boolean | null>(null);
const failed = ref(false);
let active = true;
const editing = ref<string | null>(null);
const draft = ref({ text: "", source: "", happenedOn: "" });

const body = () => ({
  text: draft.value.text.trim(),
  ...(draft.value.source.trim() ? { source: draft.value.source.trim() } : {}),
  ...(/^\d{4}-\d{2}-\d{2}$/.test(draft.value.happenedOn.trim()) ? { happenedOn: draft.value.happenedOn.trim() } : {}),
});
const reset = () => (draft.value = { text: "", source: "", happenedOn: "" });

function apply(dto: MemoryNotesDto): void {
  if (!active) return;
  notes.value = dto.notes;
  applied.value = dto.applied;
  failed.value = false;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    apply(await api.memory.notes(props.agentId));
  } catch {
    if (active) failed.value = true;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => { active = false; });

async function save(): Promise<void> {
  if (!draft.value.text.trim() || saving.value || loading.value || failed.value) return;
  saving.value = true;
  try {
    const result = editing.value ? await api.memory.update(props.agentId, editing.value, body()) : await api.memory.add(props.agentId, body());
    apply(result);
    if (active) message.success(t(result.applied ? "memory.notes.savedApplied" : "memory.notes.savedLocal"));
    editing.value = null;
    reset();
  } catch (e) {
    if (active) message.error(e instanceof ApiError ? (e.body.error === "note_rejected" ? t("memory.notes.error." + e.body.message) : e.body.message) : String(e));
  } finally {
    saving.value = false;
  }
}

function edit(note: MemoryNoteDto): void {
  editing.value = note.id;
  draft.value = { text: note.text, source: note.source ?? "", happenedOn: note.happenedOn ?? "" };
}

function cancel(): void {
  editing.value = null;
  reset();
}

async function remove(note: MemoryNoteDto): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    const result = await api.memory.remove(props.agentId, note.id);
    apply(result);
    if (active) message.success(t(result.applied ? "memory.notes.removedApplied" : "memory.notes.savedLocal"));
    if (editing.value === note.id) cancel();
  } catch (e) {
    if (active) message.error(e instanceof ApiError ? e.body.message : String(e));
  } finally { saving.value = false; }
}

const when = (note: MemoryNoteDto) => (note.happenedOn ? formatDay(note.happenedOn, locale.value) : null);

async function sync(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try { apply(await api.memory.sync(props.agentId)); }
  catch (e) { if (active) message.error(e instanceof ApiError ? e.body.message : String(e)); }
  finally { saving.value = false; }
}
</script>

<template>
  <section class="card">
    <h2 class="card-title"><notebook-pen :size="16" /> {{ t("memory.notes.title") }}</h2>
    <p class="hint">{{ t("memory.notes.lead") }}</p>
    <p class="hint">
      {{ t("memory.notes.distinction") }}
      <a href="#memory-search">{{ t("today.searchSetup") }}</a>
    </p>
    <n-alert v-if="failed" type="error">
      {{ t("memory.notes.loadFailed") }}
      <n-button size="small" :loading="loading" @click="load">{{ t("today.refresh") }}</n-button>
    </n-alert>
    <n-alert v-else-if="applied === false" type="warning" :bordered="false">
      {{ t("memory.notes.pending") }}
      <n-button size="small" :loading="saving" @click="sync">{{ t("memory.notes.retry") }}</n-button>
    </n-alert>

    <ul v-if="notes.length" class="notes">
      <li v-for="note in notes" :key="note.id">
        <div class="text">{{ note.text }}</div>
        <div class="marks">
          <span v-if="when(note)">{{ when(note) }}</span>
          <span v-if="note.source">{{ note.source }}</span>
          <span v-else class="no-source">{{ t("memory.notes.noSource") }}</span>
          <span>{{ t("memory.notes.recorded", { at: formatDateTime(new Date(note.updatedAt ?? note.createdAt).toISOString(), locale) }) }}</span>
          <n-tag size="small" :type="applied ? 'success' : 'warning'">{{ t(applied ? "memory.notes.applied" : "memory.notes.savedLocal") }}</n-tag>
        </div>
        <div class="row-actions">
          <n-button quaternary circle size="tiny" :disabled="saving" :aria-label="t('memory.notes.edit')" @click="edit(note)"><pencil :size="13" /></n-button>
          <n-popconfirm :positive-text="t('memory.notes.remove')" @positive-click="remove(note)">
            <template #trigger><n-button quaternary circle size="tiny" :disabled="saving" :aria-label="t('memory.notes.remove')"><trash-2 :size="13" /></n-button></template>
            {{ t("memory.notes.removeScope") }}
          </n-popconfirm>
        </div>
      </li>
    </ul>
    <p v-else-if="!loading && !failed" class="hint">{{ t("memory.notes.empty") }}</p>

    <div class="form">
      <n-input v-model:value="draft.text" type="textarea" :rows="2" :placeholder="t('memory.notes.textPlaceholder')" :maxlength="2000" :disabled="saving" />
      <div class="fields">
        <n-input v-model:value="draft.source" :placeholder="t('memory.notes.sourcePlaceholder')" :maxlength="300" :disabled="saving" />
        <input v-model="draft.happenedOn" type="date" :aria-label="t('memory.notes.factDate')" :disabled="saving" />
        <n-button type="primary" :loading="saving" :disabled="!draft.text.trim() || loading || failed" @click="save">
          <check :size="14" /> &nbsp;{{ editing ? t("memory.notes.saveEdit") : t("memory.notes.add") }}
        </n-button>
        <n-button v-if="editing" quaternary @click="cancel"><x :size="14" /> &nbsp;{{ t("memory.notes.cancel") }}</n-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hint {
  margin: 0 0 12px;
  font-size: 13px;
  opacity: 0.75;
}
.notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}
.notes li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.text {
  grid-column: 1;
  font-size: 14px;
  line-height: 1.4;
}
.marks {
  display: flex;
  flex-wrap: wrap;
  grid-column: 1;
  gap: 10px;
  font-size: 12px;
  opacity: 0.7;
}
.no-source {
  color: var(--warning, #b7791f);
}
.row-actions {
  display: flex;
  grid-row: 1 / span 2;
  grid-column: 2;
  align-items: center;
  gap: 2px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.fields :deep(.n-input) {
  flex: 1 1 160px;
}
</style>
