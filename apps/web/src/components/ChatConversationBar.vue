<script setup lang="ts">
// The conversation picker above a personal chat: the main conversation, the owner's own ones, and a new one.
import type { ChatConversation } from "@clawdesk/shared";
import { NButton, NInput, NSelect, useMessage } from "naive-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ agentId: string; conversationId: string | undefined }>();
const emit = defineEmits<{ select: [id: string] }>();

const { t } = useI18n();
const message = useMessage();
const conversations = ref<ChatConversation[]>([]);
const options = computed(() => [
  { value: "main", label: t("chat.conversations.main") },
  ...conversations.value.map(({ id, title }) => ({ value: id, label: title })),
]);
const formOpen = ref(false);
const title = ref("");
const creating = ref(false);
let alive = true;
let listVersion = 0;

const errorText = (error: unknown) => (error instanceof ApiError ? error.body.message : String(error));

async function load(agentId: string): Promise<void> {
  const version = ++listVersion;
  try {
    const result = await api.chat.conversations(agentId);
    if (alive && version === listVersion) conversations.value = result.conversations;
  } catch (error) {
    if (alive && version === listVersion) message.error(errorText(error));
  }
}

async function create(): Promise<void> {
  const name = title.value.trim();
  if (!name || creating.value) return;
  const { agentId, conversationId } = props;
  const stillHere = () => alive && agentId === props.agentId && conversationId === props.conversationId;
  creating.value = true;
  try {
    const created = await api.chat.createConversation(agentId, name);
    if (!alive || agentId !== props.agentId) return;
    conversations.value = [created, ...conversations.value];
    void load(agentId);
    if (stillHere()) {
      formOpen.value = false;
      title.value = "";
      emit("select", created.id);
    }
  } catch (error) {
    if (stillHere()) message.error(errorText(error));
  } finally {
    if (alive) creating.value = false;
  }
}

watch(() => props.agentId, (id) => {
  conversations.value = [];
  void load(id);
}, { immediate: true });
// Another chat opened: a half-typed title belongs to the one left behind.
watch(() => [props.agentId, props.conversationId], () => {
  formOpen.value = false;
  title.value = "";
});
onBeforeUnmount(() => { alive = false; });
</script>

<template>
  <div class="conversation-bar on-canvas">
    <n-select
      :value="conversationId ?? 'main'"
      :options="options"
      :aria-label="t('chat.conversations.label')"
      size="small"
      @update:value="(id: string) => emit('select', id)"
    />
    <n-button size="small" round secondary @click="formOpen = !formOpen">{{ t("chat.conversations.new") }}</n-button>
    <form v-if="formOpen" class="conversation-form" @submit.prevent="create">
      <n-input v-model:value="title" size="small" round class="title" :maxlength="80" :placeholder="t('chat.conversations.title')" :input-props="{ 'aria-label': t('chat.conversations.title') }" />
      <n-button attr-type="submit" size="small" type="primary" round :loading="creating" :disabled="!title.trim()">
        {{ t("chat.conversations.create") }}
      </n-button>
    </form>
  </div>
</template>

<style scoped>
.conversation-bar, .conversation-form {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.conversation-bar {
  padding: 0 0 10px;
}
.conversation-bar > .n-select {
  width: 220px;
  max-width: 100%;
}
.title {
  width: 220px;
  max-width: 100%;
}
</style>
