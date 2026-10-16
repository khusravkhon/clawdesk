<script setup lang="ts">
// Editing a junior agent after creation: name, emoji and its instruction files; saving it as one of
// the owner's own templates ("My templates") so the next agent like it takes one click in the builder.
import type { AgentProfileDto } from "@clawdesk/shared";
import { BookmarkPlus, Check, FileText, UserRound } from "@lucide/vue";
import { NAlert, NButton, NInput, NSkeleton, useMessage } from "naive-ui";
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import AgentExtensions from "../components/AgentExtensions.vue";
import PageHeader from "../components/ui/PageHeader.vue";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const message = useMessage();
const agentId = String(route.params.agentId);

const data = ref<AgentProfileDto | null>(null);
const loadError = ref<string | null>(null);
const form = reactive({ name: "", emoji: "", soul: "", user: "", agents: "" });
const saving = ref(false);
const tpl = reactive({ title: "", description: "" });
const savingTemplate = ref(false);
const savedTemplate = ref<string | null>(null);

const errText = (e: unknown) => (e instanceof ApiError ? e.body.message : String(e));
const dirty = computed(() => {
  const d = data.value;
  return !!d && (d.name !== form.name || (d.emoji ?? "") !== form.emoji || d.files.soul !== form.soul || d.files.user !== form.user || d.files.agents !== form.agents);
});

function fill(dto: AgentProfileDto): void {
  data.value = dto;
  Object.assign(form, { name: dto.name, emoji: dto.emoji ?? "", soul: dto.files.soul, user: dto.files.user, agents: dto.files.agents });
  if (!tpl.title) tpl.title = dto.name;
}

async function load(): Promise<void> {
  try {
    fill(await api.agentProfile(agentId));
  } catch (e) {
    loadError.value = errText(e);
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    fill(
      await api.saveAgentProfile(agentId, {
        name: form.name.trim(),
        emoji: form.emoji.trim() || null,
        files: { soul: form.soul, user: form.user, agents: form.agents },
      }),
    );
    message.success(t("agentEdit.saved", { name: form.name.trim() }));
  } catch (e) {
    message.error(errText(e));
  } finally {
    saving.value = false;
  }
}

async function saveTemplate(): Promise<void> {
  savingTemplate.value = true;
  try {
    const created = await api.saveAsTemplate(agentId, { title: tpl.title.trim(), description: tpl.description.trim() });
    savedTemplate.value = created.title.ru;
  } catch (e) {
    message.error(errText(e));
  } finally {
    savingTemplate.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <page-header :title="data ? t('agentEdit.title', { name: data.name }) : t('agentEdit.titleEmpty')" :subtitle="t('agentEdit.subtitle')">
      <n-button quaternary @click="router.push('/agents')">{{ t("builder.backToList") }}</n-button>
    </page-header>

    <n-alert v-if="loadError" type="error" class="block">{{ loadError }}</n-alert>
    <n-skeleton v-else-if="!data" height="300px" :sharp="false" />
    <template v-else>
      <section class="card">
        <h2 class="card-title"><user-round :size="16" /> {{ t("agentEdit.who") }}</h2>
        <div class="who">
          <label class="field emoji">
            <span>{{ t("assistant.emoji") }}</span>
            <n-input v-model:value="form.emoji" maxlength="8" />
          </label>
          <label class="field grow">
            <span>{{ t("assistant.name") }}</span>
            <n-input v-model:value="form.name" maxlength="60" />
          </label>
        </div>
        <p v-if="data.folder" class="hint">📁 {{ t("agentEdit.folder", { name: data.folder }) }}</p>
      </section>

      <section class="card">
        <h2 class="card-title"><file-text :size="16" /> {{ t("agentEdit.instructions") }}</h2>
        <p class="hint">{{ t("agentEdit.instructionsLead") }}</p>
        <label class="field">
          <span>{{ t("agentEdit.soul") }}</span>
          <n-input v-model:value="form.soul" type="textarea" :autosize="{ minRows: 8, maxRows: 24 }" maxlength="20000" class="mono" />
        </label>
        <label class="field">
          <span>{{ t("agentEdit.user") }}</span>
          <n-input v-model:value="form.user" type="textarea" :autosize="{ minRows: 3, maxRows: 12 }" maxlength="20000" class="mono" />
        </label>
        <label class="field">
          <span>{{ t("agentEdit.agents") }}</span>
          <n-input v-model:value="form.agents" type="textarea" :autosize="{ minRows: 3, maxRows: 16 }" maxlength="20000" class="mono" />
        </label>
      </section>

      <div class="save-row">
        <n-button type="primary" :disabled="!dirty || !form.name.trim()" :loading="saving" @click="save">
          <template #icon><check :size="16" /></template>
          {{ t("assistant.save") }}
        </n-button>
        <n-button secondary @click="router.push('/schedules')">{{ t("agentEdit.schedules") }}</n-button>
        <span class="muted small">{{ t("agentEdit.saveHint") }}</span>
      </div>

      <AgentExtensions :agent-id="agentId" />

      <section v-if="data.role === 'specialist'" class="card">
        <h2 class="card-title"><bookmark-plus :size="16" /> {{ t("agentEdit.asTemplate") }}</h2>
        <p class="hint">{{ t("agentEdit.asTemplateLead") }}</p>
        <n-alert v-if="savedTemplate" type="success" :bordered="false" class="block">
          {{ t("agentEdit.templateSaved", { name: savedTemplate }) }}
          <n-button size="tiny" class="inline-btn" @click="router.push('/agents/new')">{{ t("agents.create") }}</n-button>
        </n-alert>
        <template v-else>
          <label class="field">
            <span>{{ t("agentEdit.templateTitle") }}</span>
            <n-input v-model:value="tpl.title" maxlength="60" />
          </label>
          <label class="field">
            <span>{{ t("agentEdit.templateDescription") }}</span>
            <n-input v-model:value="tpl.description" maxlength="300" :placeholder="t('agentEdit.templateDescriptionPlaceholder')" />
          </label>
          <n-alert v-if="dirty" type="info" :bordered="false" class="block">{{ t("agentEdit.saveFirst") }}</n-alert>
          <n-button :disabled="!tpl.title.trim() || dirty" :loading="savingTemplate" @click="saveTemplate">{{ t("agentEdit.saveTemplate") }}</n-button>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 16px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 16px;
  min-width: 0;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
}
.card-title :deep(svg) {
  color: var(--accent);
}
.who {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  font-size: 13px;
}
.field > span {
  color: var(--text-2);
  font-weight: 500;
}
.field.emoji {
  width: 90px;
}
.field.grow {
  flex: 1 1 240px;
}
.mono :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.55;
}
.hint {
  margin: -6px 0 12px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.save-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 24px;
  flex-wrap: wrap;
}
.small {
  font-size: 12px;
}
.inline-btn {
  margin-left: 8px;
}
</style>
