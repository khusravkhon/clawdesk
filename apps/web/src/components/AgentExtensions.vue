<script setup lang="ts">
// One agent's share of the "Навыки и MCP" lists: a checkbox per skill and per MCP server.
import type { McpServerDto, SkillDto } from "@clawdesk/shared";
import { Blocks } from "@lucide/vue";
import { NAlert, NButton, NCheckbox, NSkeleton, useMessage } from "naive-ui";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, ApiError } from "../api/client";

const props = defineProps<{ agentId: string }>();
const { t } = useI18n();
const message = useMessage();
const router = useRouter();

const skills = ref<SkillDto[] | null>(null);
const servers = ref<McpServerDto[] | null>(null);
const loadError = ref<string | null>(null);
const busy = ref<string | null>(null);

const errText = (e: unknown) => (e instanceof ApiError ? e.body.message : String(e));
const toggled = (ids: string[], on: boolean) => (on ? [...new Set([...ids, props.agentId])] : ids.filter((id) => id !== props.agentId));

async function load(): Promise<void> {
  try {
    const [s, m] = await Promise.all([api.skills.list(), api.mcp.list()]);
    skills.value = s.skills;
    servers.value = m.servers;
  } catch (e) {
    loadError.value = errText(e);
  }
}

async function setSkill(skill: SkillDto, on: boolean): Promise<void> {
  busy.value = `skill:${skill.id}`;
  try {
    skills.value = (await api.skills.setAgents(skill.id, toggled(skill.agents, on))).skills;
  } catch (e) {
    message.error(errText(e));
  } finally {
    busy.value = null;
  }
}

async function setServer(server: McpServerDto, on: boolean): Promise<void> {
  busy.value = `mcp:${server.name}`;
  try {
    servers.value = (await api.mcp.setAgents(server.name, toggled(server.agents, on))).servers;
  } catch (e) {
    message.error(errText(e));
  } finally {
    busy.value = null;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <h2 class="card-title"><blocks :size="16" /> {{ t("ext.onAgent") }}</h2>
    <p class="hint">{{ t("ext.onAgentLead") }}</p>
    <n-alert v-if="loadError" type="error" :bordered="false">{{ loadError }}</n-alert>
    <n-skeleton v-else-if="!skills || !servers" text :repeat="3" />
    <template v-else>
      <p v-if="!skills.length && !servers.length" class="hint">{{ t("ext.noneYet") }}</p>
      <div v-if="skills.length" class="group">
        <div class="group-title">{{ t("ext.skillsShort") }}</div>
        <n-checkbox
          v-for="skill in skills"
          :key="skill.id"
          :checked="skill.agents.includes(agentId)"
          :disabled="!!busy"
          class="item"
          @update:checked="(on: boolean) => setSkill(skill, on)"
        >
          {{ skill.name }}<span v-if="busy === `skill:${skill.id}`" class="muted"> …</span>
        </n-checkbox>
      </div>
      <div v-if="servers.length" class="group">
        <div class="group-title">{{ t("ext.mcpShort") }}</div>
        <n-checkbox
          v-for="server in servers"
          :key="server.name"
          :checked="server.agents.includes(agentId)"
          :disabled="!!busy"
          class="item"
          @update:checked="(on: boolean) => setServer(server, on)"
        >
          {{ server.name }}<span v-if="busy === `mcp:${server.name}`" class="muted"> …</span>
        </n-checkbox>
      </div>
      <n-button size="small" secondary @click="router.push('/skills')">{{ t("ext.manage") }}</n-button>
    </template>
  </section>
</template>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--card-shadow);
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
.hint {
  margin: -6px 0 12px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.muted {
  color: var(--muted);
}
</style>
