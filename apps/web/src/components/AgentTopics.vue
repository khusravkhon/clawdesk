<script setup lang="ts">
// Telegram topics for agents: a group with topics, each topic answered by one agent (text or voice).
// The owner pastes each topic's link ("Copy link" in Telegram) next to the agent.
import { parseTopicLink, type AgentListItemDto, type AgentTopicsDto } from "@clawdesk/shared";
import { X } from "@lucide/vue";
import { NAlert, NButton, NInput, NPopconfirm, NSelect, NSpace, NSpin, useMessage } from "naive-ui";
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const { t } = useI18n();
const message = useMessage();
const props = withDefaults(defineProps<{ accountId?: string }>(), { accountId: "default" });

const agents = ref<AgentListItemDto[]>([]);
const current = ref<AgentTopicsDto | null>(null);
const links = reactive<Record<string, string>>({});
/** Agents listed with a link field: the ones with a topic in this bot, plus those the owner adds. */
const shown = ref<string[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

/** What a topic link looks like ("Copy link" on a topic in Telegram). */
const EXAMPLE_LINK = "https://t.me/c/1234567890/5";
const errText = (e: unknown) => (e instanceof ApiError ? e.body.message : String(e));
// Team agents get their topics on the team's screen.
const candidates = computed(() => agents.value.filter((a) => a.role === "main" || a.role === "specialist"));
const rows = computed(() => candidates.value.filter((a) => shown.value.includes(a.id)));
const addOptions = computed(() => candidates.value.filter((a) => !shown.value.includes(a.id)).map((a) => ({ label: `${a.emoji ?? (a.role === "main" ? "🧭" : "🤖")} ${a.name}`, value: a.id })));
const filled = computed(() => candidates.value.filter((a) => links[a.id]?.trim()));
const invalid = computed(() => filled.value.filter((a) => !parseTopicLink(links[a.id]!)).map((a) => a.name));
const dirty = computed(() => {
  const saved = new Map(current.value?.topics.map((x) => [x.agentId, x.link]) ?? []);
  return candidates.value.some((a) => (links[a.id]?.trim() ?? "") !== (saved.get(a.id) ?? ""));
});

function linkStatus(agentId: string): "error" | undefined {
  const link = links[agentId]?.trim();
  return link && !parseTopicLink(link) ? "error" : undefined;
}

function fill(dto: AgentTopicsDto): void {
  current.value = dto;
  for (const a of candidates.value) links[a.id] = dto.topics.find((x) => x.agentId === a.id)?.link ?? "";
  shown.value = candidates.value.filter((a) => links[a.id]).map((a) => a.id);
}

function addRow(id: string | null): void {
  if (id && !shown.value.includes(id)) shown.value = [...shown.value, id];
}

function removeRow(id: string): void {
  links[id] = "";
  shown.value = shown.value.filter((x) => x !== id);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [list, topics] = await Promise.all([api.agents(), api.telegram.topics(props.accountId)]);
    agents.value = list.agents;
    fill(topics);
  } catch (e) {
    error.value = errText(e);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = null;
  try {
    fill(await api.telegram.saveTopics({ topics: filled.value.map((a) => ({ agentId: a.id, link: links[a.id]!.trim() })) }, props.accountId));
    message.success(t("telegramTopics.saved"));
  } catch (e) {
    error.value = errText(e);
  } finally {
    saving.value = false;
  }
}

async function removeAll(): Promise<void> {
  saving.value = true;
  try {
    fill(await api.telegram.removeTopics(props.accountId));
    message.success(t("telegramTopics.removed"));
  } catch (e) {
    error.value = errText(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <n-spin :show="loading">
    <p class="hint">{{ t("telegramTopics.lead") }}</p>
    <ol class="howto">
      <li>{{ t("telegramTopics.step1") }}</li>
      <li>{{ t("telegramTopics.step2") }}</li>
      <li>{{ t("telegramTopics.step3") }}</li>
    </ol>
    <n-alert type="warning" :show-icon="false" class="block">{{ t("telegramTopics.privacy") }}</n-alert>

    <div v-for="a in rows" :key="a.id" class="row">
      <span class="name">{{ a.emoji ?? (a.role === 'main' ? '🧭' : '🤖') }} {{ a.name }}</span>
      <n-input v-model:value="links[a.id]" size="small" :placeholder="EXAMPLE_LINK" :status="linkStatus(a.id)" />
      <n-button quaternary circle size="small" :aria-label="t('telegramTopics.removeRow', { name: a.name })" @click="removeRow(a.id)">
        <template #icon><x :size="15" /></template>
      </n-button>
    </div>
    <p v-if="!candidates.length" class="hint">{{ t("telegramTopics.noAgents") }}</p>
    <p v-else-if="!rows.length" class="hint">{{ t("telegramTopics.noTopics") }}</p>
    <n-select v-if="addOptions.length" :value="null" :options="addOptions" size="small" filterable :placeholder="t('telegramTopics.addAgent')" class="add" @update:value="addRow" />
    <n-alert v-if="invalid.length" type="error" :show-icon="false" class="block">{{ t("telegramTopics.invalid", { names: invalid.join(", ") }) }}</n-alert>
    <n-alert v-if="error" type="error" :show-icon="false" class="block">{{ error }}</n-alert>

    <n-space align="center">
      <n-button type="primary" :loading="saving" :disabled="!dirty || !filled.length || invalid.length > 0" @click="save">{{ t("telegramTopics.save") }}</n-button>
      <n-popconfirm v-if="current?.chatId" @positive-click="removeAll">
        <template #trigger>
          <n-button quaternary type="error" :disabled="saving">{{ t("telegramTopics.remove") }}</n-button>
        </template>
        {{ t("telegramTopics.removeConfirm") }}
      </n-popconfirm>
      <span class="hint">{{ t("telegramTopics.restartHint") }}</span>
    </n-space>
  </n-spin>
</template>

<style scoped>
.howto {
  margin: 0 0 14px;
  padding-left: 20px;
  line-height: 1.8;
  font-size: 13.5px;
}
.hint {
  font-size: 13px;
  opacity: 0.75;
  margin: 0 0 10px;
}
.block {
  margin-bottom: 12px;
}
.add {
  max-width: 320px;
  margin: 4px 0 16px;
}
.row {
  display: grid;
  grid-template-columns: minmax(140px, 220px) minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}
.name {
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 600px) {
  .row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px;
  }
  .row .name {
    grid-column: 1 / -1;
  }
}
</style>
