<script setup lang="ts">
// Stage 4: an agent's charter — seven plain fields the owner sets, versions with a way back, what the agent
// can technically do next to it (the text grants nothing), and a warning when its AGENTS.md block no longer
// matches (the agent or someone rewrote it; the panel puts it back on its own within minutes or on request).
import { CHARTER_FIELDS, charterExpands, type AgentCharterDto, type AgentCharterFields } from "@clawdesk/shared";
import { ScrollText } from "@lucide/vue";
import { NAlert, NButton, NCheckbox, NInput, NPopconfirm, NTag, useMessage } from "naive-ui";
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ agentId: string }>();
const { t, te } = useI18n();
const message = useMessage();
const data = ref<AgentCharterDto | null>(null);
const form = reactive<AgentCharterFields>({ responsibleFor: "", mustDo: "", mayDo: "", forbidden: "", askPermission: "", escalateTo: "", verifyBy: "" });
const note = ref(""), confirm = ref(false), busy = ref(false), failed = ref(false);
let pending: { key: string; requestId: string } | null = null;

const dirty = computed(() => !!data.value && CHARTER_FIELDS.some((field) => form[field].trim() !== data.value!.fields[field].trim()));
const expands = computed(() => !!data.value && charterExpands(data.value.fields, { ...form }));
const explain = (e: unknown) => e instanceof ApiError && te(`agentCharter.errors.${e.body.error}`) ? t(`agentCharter.errors.${e.body.error}`) : t("agentCharter.failed");
function requestId(key: string): string {
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  return pending.requestId;
}
function fill(dto: AgentCharterDto): void {
  data.value = dto;
  Object.assign(form, dto.fields);
  confirm.value = false; note.value = "";
}
async function load(): Promise<void> {
  try { fill(await api.agentCharter(props.agentId)); failed.value = false; }
  catch { failed.value = true; }
}
async function run(key: string, call: (requestId: string) => Promise<AgentCharterDto>, done: string): Promise<void> {
  busy.value = true;
  try { fill(await call(requestId(key))); pending = null; message.success(t(done)); }
  catch (e) { if (e instanceof ApiError) pending = null; message.error(explain(e)); }
  finally { busy.value = false; }
}
const save = () => run(`save:${data.value!.version}:${JSON.stringify(form)}:${confirm.value}`, (requestId) => api.saveAgentCharter(props.agentId, { requestId, baseVersion: data.value!.version, fields: { ...form }, note: note.value.trim(), ...(expands.value ? { confirmExpansion: confirm.value } : {}) }), "agentCharter.saved");
const restore = (version: number) => run(`restore:${data.value!.version}:${version}`, (requestId) => api.restoreAgentCharter(props.agentId, { requestId, baseVersion: data.value!.version, version, confirmExpansion: true }), "agentCharter.restored");
const repair = () => run("repair", (requestId) => api.repairAgentCharter(props.agentId, { requestId }), "agentCharter.repaired");
onMounted(load);
</script>

<template>
  <section class="card">
    <h2 class="card-title"><scroll-text :size="16" /> {{ t("agentCharter.title") }}</h2>
    <p class="hint">{{ t("agentCharter.lead") }}</p>
    <n-alert v-if="failed" type="warning" :bordered="false" class="block">{{ t("agentCharter.loadFailed") }}</n-alert>
    <template v-else-if="data">
      <p class="block">
        <n-tag size="small">{{ data.version ? t("agentCharter.version", { version: data.version }) : t("agentCharter.defaults") }}</n-tag>
      </p>
      <n-alert v-if="data.file === 'changed' || data.file === 'missing'" type="warning" class="block" :title="t(`agentCharter.file.${data.file}`)">
        <p>{{ t("agentCharter.file.hint") }}</p>
        <n-button size="small" :loading="busy" @click="repair">{{ t("agentCharter.repair") }}</n-button>
      </n-alert>
      <p v-else-if="data.file === 'unavailable'" class="hint block">{{ t("agentCharter.file.unavailable") }}</p>

      <label v-for="field in CHARTER_FIELDS" :key="field" class="field">
        <span>{{ t(`agentCharter.fields.${field}`) }}</span>
        <n-input v-model:value="form[field]" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" maxlength="2000" :placeholder="t('agentCharter.notSpecified')" :disabled="busy" />
      </label>
      <label class="field">
        <span>{{ t("agentCharter.note") }}</span>
        <n-input v-model:value="note" maxlength="300" :disabled="busy" />
      </label>
      <n-alert v-if="dirty && expands" type="warning" class="block">
        <p>{{ t("agentCharter.expands") }}</p>
        <n-checkbox v-model:checked="confirm" :disabled="busy">{{ t("agentCharter.confirmExpansion") }}</n-checkbox>
      </n-alert>
      <n-button type="primary" class="block" :loading="busy" :disabled="!dirty || (expands && !confirm)" @click="save">{{ t("agentCharter.save") }}</n-button>

      <h3 class="sub">{{ t("agentCharter.powers.title") }}</h3>
      <p class="hint">{{ t("agentCharter.powers.lead") }}</p>
      <ul class="powers">
        <li>{{ t(data.powers.sandbox ? "agentCharter.powers.sandbox" : "agentCharter.powers.noSandbox") }}</li>
        <li>{{ data.powers.folder ? t("agentCharter.powers.folder", { name: data.powers.folder }) : t("agentCharter.powers.noFolder") }}</li>
        <li>{{ data.powers.grants.length ? t("agentCharter.powers.grants", { list: data.powers.grants.map((grant) => `${grant.resource} (${t(`agentCharter.powers.access.${grant.access}`)})`).join(", ") }) : t("agentCharter.powers.noGrants") }}</li>
        <li>{{ t(data.powers.canAskMain ? "agentCharter.powers.askMain" : "agentCharter.powers.noAskMain") }}</li>
        <li v-if="data.powers.team">{{ t(data.powers.lead ? "agentCharter.powers.leadOf" : "agentCharter.powers.memberOf", { team: data.powers.team }) }}</li>
        <li v-else-if="data.powers.lead">{{ t("agentCharter.powers.lead") }}</li>
        <li v-if="data.powers.manager">{{ t("agentCharter.powers.manager") }}</li>
        <li>{{ t("agentCharter.powers.external") }}</li>
      </ul>

      <details v-if="data.history.length" class="block">
        <summary>{{ t("agentCharter.history") }}</summary>
        <div v-for="item in [...data.history].reverse()" :key="item.version" class="history">
          <span>{{ t("agentCharter.version", { version: item.version }) }} · {{ t(`agentCharter.source.${item.source}`) }}<template v-if="item.note"> · {{ item.note }}</template> · {{ new Date(item.createdAt).toLocaleString() }}</span>
          <n-popconfirm v-if="item.version !== data.version" @positive-click="restore(item.version)">
            <template #trigger><n-button size="small" :disabled="busy">{{ t("agentCharter.restore") }}</n-button></template>
            <span class="confirm">{{ t("agentCharter.restoreConfirm", { version: item.version }) }}</span>
          </n-popconfirm>
        </div>
      </details>
    </template>
  </section>
</template>

<style scoped>
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; min-width: 0; }
.card-title { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; font-size: 15px; font-weight: 600; }
.card-title :deep(svg) { color: var(--accent); }
.hint { margin: -6px 0 12px; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
.field { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; font-size: 13px; }
.block { margin-top: 10px; }
.sub { margin: 18px 0 4px; font-size: 1em; }
.powers { margin: 6px 0 0; padding-left: 20px; line-height: 1.7; }
.history { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
.confirm { display: inline-block; max-width: min(340px, 75vw); white-space: normal; }
</style>
