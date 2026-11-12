<script setup lang="ts">
// The agent's main model and its backups (see apps/bff/src/ai-setup/model-chain.ts). When the main
// model hits a limit, runs out of money or its provider is overloaded, OpenClaw
// answers that one message with the next model in this list.
import { MAX_BACKUP_MODELS, type ModelChainDto, type ModelOptionDto } from "@clawdesk/shared";
import { ArrowDown, ArrowUp, Check, Layers, Plus, X } from "@lucide/vue";
import { NAlert, NButton, NSelect, NSkeleton, useMessage } from "naive-ui";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import AiConnect from "./AiConnect.vue";

const props = defineProps<{ agentId: string }>();
const { t } = useI18n();
const message = useMessage();

const data = ref<ModelChainDto | null>(null);
const chain = ref<ModelOptionDto[]>([]);
const picked = ref<string | null>(null);
const connecting = ref(false);
const saving = ref(false);
const loadError = ref<string | null>(null);

const errText = (e: unknown) => (e instanceof ApiError ? e.body.message : String(e));
const full = computed(() => chain.value.length >= 1 + MAX_BACKUP_MODELS);
const dirty = computed(() => JSON.stringify(chain.value.map((m) => m.ref)) !== JSON.stringify(data.value?.chain.map((m) => m.ref) ?? []));
const choices = computed(() => {
  const inChain = new Set(chain.value.map((m) => m.ref));
  const all = [...(data.value?.choices ?? []), ...(data.value?.chain ?? [])];
  return all.filter((m) => !inChain.has(m.ref)).map((m) => ({ label: `${m.label} · ${m.provider}`, value: m.ref }));
});
const notReady = computed(() => chain.value.some((m) => !m.ready));

function fill(dto: ModelChainDto): void {
  data.value = dto;
  chain.value = [...dto.chain];
}

async function load(): Promise<void> {
  loadError.value = null;
  try {
    fill(await api.ai.models(props.agentId));
  } catch (e) {
    loadError.value = errText(e);
  }
}

function move(i: number, delta: number): void {
  const next = [...chain.value];
  const [item] = next.splice(i, 1);
  next.splice(i + delta, 0, item!);
  chain.value = next;
}

function remove(i: number): void {
  chain.value = chain.value.filter((_, j) => j !== i);
}

function add(): void {
  const option = [...(data.value?.choices ?? []), ...(data.value?.chain ?? [])].find((m) => m.ref === picked.value);
  if (option && !full.value) chain.value = [...chain.value, option];
  picked.value = null;
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    fill(await api.ai.saveModels({ agentId: props.agentId, chain: chain.value.map((m) => m.ref) }));
    message.success(t("models.saved"));
  } catch (e) {
    message.error(errText(e));
  } finally {
    saving.value = false;
  }
}

async function onConnected(): Promise<void> {
  connecting.value = false;
  await load();
  message.success(t("models.added"));
}

onMounted(load);
</script>

<template>
  <section class="card">
    <h2 class="card-title"><layers :size="16" /> {{ t("models.title") }}</h2>
    <p class="hint">{{ t("models.lead") }}</p>
    <p class="hint">{{ t("models.followers") }}</p>

    <n-alert v-if="loadError" type="error" :bordered="false" class="block">
      {{ loadError }}
      <n-button size="tiny" class="retry" @click="load">{{ t("common.retry") }}</n-button>
    </n-alert>
    <n-skeleton v-else-if="!data" height="120px" :sharp="false" />

    <template v-else>
      <ol class="chain">
        <li v-for="(m, i) in chain" :key="m.ref" class="row">
          <span class="role" :class="{ main: i === 0 }">{{ i === 0 ? t("models.main") : t("models.backup", { n: i }) }}</span>
          <span class="name">
            {{ m.label }}
            <span class="provider">{{ m.provider }}</span>
          </span>
          <span class="state" :class="{ off: !m.ready }">{{ m.ready ? t("models.ready") : t("models.notReady") }}</span>
          <span class="actions">
            <n-button quaternary circle size="small" :disabled="i === 0" :aria-label="t('models.up')" @click="move(i, -1)">
              <template #icon><arrow-up :size="15" /></template>
            </n-button>
            <n-button quaternary circle size="small" :disabled="i === chain.length - 1" :aria-label="t('models.down')" @click="move(i, 1)">
              <template #icon><arrow-down :size="15" /></template>
            </n-button>
            <n-button quaternary circle size="small" :disabled="chain.length === 1" :aria-label="t('models.remove')" @click="remove(i)">
              <template #icon><x :size="15" /></template>
            </n-button>
          </span>
        </li>
      </ol>
      <p v-if="!chain.length" class="hint">{{ t("models.empty") }}</p>
      <n-alert v-if="notReady" type="warning" :bordered="false" class="block">{{ t("models.notReadyHint") }}</n-alert>

      <div class="add">
        <n-select
          v-model:value="picked"
          :options="choices"
          filterable
          size="small"
          class="pick"
          :disabled="full || !choices.length"
          :placeholder="choices.length ? t('models.pick') : t('models.noChoices')"
        />
        <n-button size="small" :disabled="!picked || full" @click="add">
          <template #icon><plus :size="15" /></template>
          {{ t("models.add") }}
        </n-button>
        <n-button size="small" secondary :disabled="full || dirty" @click="connecting = !connecting">{{ t("models.connectNew") }}</n-button>
      </div>
      <p v-if="full" class="hint">{{ t("models.full", { n: MAX_BACKUP_MODELS }) }}</p>
      <p v-else-if="dirty && !full" class="hint">{{ t("models.saveFirst") }}</p>

      <div v-if="connecting" class="connect">
        <p class="hint">{{ t("models.connectHint") }}</p>
        <AiConnect :agent-id="agentId" as-backup @connected="onConnected" />
      </div>

      <div class="save-row">
        <n-button type="primary" size="small" :disabled="!dirty || !chain.length" :loading="saving" @click="save">
          <template #icon><check :size="15" /></template>
          {{ t("models.save") }}
        </n-button>
        <n-button v-if="dirty" size="small" quaternary @click="fill(data!)">{{ t("models.reset") }}</n-button>
      </div>
      <p class="hint tip">{{ t("models.tip") }}</p>
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
  min-width: 0;
  margin-bottom: 24px;
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
.tip {
  margin: 12px 0 0;
}
.block {
  margin-bottom: 12px;
}
.retry {
  margin-left: 8px;
}
.chain {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
}
.role {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-2);
}
.role.main {
  color: var(--accent);
}
.name {
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
}
.state {
  font-size: 11.5px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}
.state.off {
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--border);
}
.actions {
  display: flex;
}
.add {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.pick {
  flex: 1 1 260px;
  min-width: 0;
}
.connect {
  border-top: 1px solid var(--border);
  padding-top: 14px;
  margin: 4px 0 14px;
}
.save-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
@media (max-width: 600px) {
  .row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "role state" "name actions";
  }
  .role {
    grid-area: role;
  }
  .state {
    grid-area: state;
    justify-self: end;
  }
  .name {
    grid-area: name;
  }
  .actions {
    grid-area: actions;
  }
}
</style>
