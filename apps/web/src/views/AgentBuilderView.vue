<script setup lang="ts">
// Junior-agent builder (screen 8): template → about → data → schedule → AI access → create.
import { FolderName, type CreateAgentResultDto, type ScheduleInput, type TemplateDto } from "@clawdesk/shared";
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NGi,
  NGrid,
  NInput,
  NRadio,
  NRadioGroup,
  NSpace,
  NSpin,
  NStep,
  NSteps,
  NSwitch,
  NText,
  NTimePicker,
} from "naive-ui";
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import PageHeader from "../components/ui/PageHeader.vue";
import { useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import AiConnect from "../components/AiConnect.vue";
import { useLocalized } from "../localized";

type ScheduleRow = { presetId: string | null; label: string; time: string; days: string; prompt: string; enabled: boolean };

const { t, locale } = useI18n();
const tx = useLocalized();
const router = useRouter();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const step = ref(1);
const templates = ref<TemplateDto[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const template = ref<TemplateDto | null>(null);
const values = reactive<Record<string, string>>({});
const canAskMain = ref(true);
/** The agent's own folder in the shared files folder; empty name = none. */
const useFolder = ref(false);
const folderName = ref("");
const filesHostPath = ref<string | null>(null);
const folderOk = computed(() => !useFolder.value || FolderName.safeParse(folderName.value).success);
const schedules = ref<ScheduleRow[]>([]);
const aiMode = ref<"inherit" | "own" | "free">("inherit");
const freeReady = ref(false);
const mainModel = ref<string | null>(null);
const mainConnected = ref(false);
const sandboxEnabled = ref(true);
const telegramReady = ref(false);
const deliverToTelegram = ref(false);
const creating = ref(false);
const createError = ref<string | null>(null);
const created = ref<CreateAgentResultDto | null>(null);
const aiDone = ref(false);

const missingRequired = computed(() => template.value?.fields.filter((f) => f.required && !values[f.key]?.trim()).map((f) => tx(f.label)) ?? []);
const enabledSchedules = computed(() => schedules.value.filter((s) => s.enabled && s.time && s.prompt.trim()));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [list, agents, ai] = await Promise.all([api.templates("personal"), api.agents(), api.ai.status("main")]);
    templates.value = list;
    mainModel.value = agents.agents.find((a) => a.role === "main")?.model ?? null;
    sandboxEnabled.value = agents.sandboxEnabled;
    mainConnected.value = ai.connected;
    if (!ai.connected) aiMode.value = "own";
    freeReady.value = (await api.freeModels.status().catch(() => null))?.ready ?? false;
    filesHostPath.value = (await api.sources.status().catch(() => null))?.folder.hostPath ?? null;
    const tg = await api.telegram.status().catch(() => null);
    telegramReady.value = !!tg?.connected && !!tg.owner;
    deliverToTelegram.value = telegramReady.value;
  } catch (error) {
    loadError.value = errorText(error);
  } finally {
    loading.value = false;
  }
}

function pick(tpl: TemplateDto): void {
  template.value = tpl;
  for (const key of Object.keys(values)) delete values[key];
  for (const field of tpl.fields) values[field.key] = field.default ?? "";
  canAskMain.value = tpl.canAskMain;
  useFolder.value = !!tpl.folder;
  folderName.value = tpl.folder ? tx(tpl.folder) : "";
  // Preset labels start with their time ("06:30 тренировка дня"); keep only the words so editing the time cannot contradict them.
  schedules.value = tpl.cronPresets.map((p) => ({ presetId: p.id, label: tx(p.label).replace(/^(\S+\s)?\d{1,2}:\d{2}\s*/, ""), ...parseCron(p.cron), prompt: p.prompt, enabled: true }));
  step.value = 2;
}

function addSchedule(): void {
  schedules.value.push({ presetId: null, label: "", time: "09:00", days: "*", prompt: "", enabled: true });
}

async function create(): Promise<void> {
  if (!template.value) return;
  creating.value = true;
  createError.value = null;
  const payload: ScheduleInput[] = enabledSchedules.value.map((s) => ({
    presetId: s.presetId,
    label: `${s.time} ${s.label.trim() || daysText(s.days)}`,
    cron: toCron(s.time, s.days),
    prompt: s.prompt.trim(),
  }));
  try {
    created.value = await api.createAgent({
      templateId: template.value.id,
      mode: template.value.mode,
      values: { ...values },
      canAskMain: canAskMain.value,
      ai: aiMode.value,
      schedules: payload,
      timezone,
      deliverToTelegram: telegramReady.value && deliverToTelegram.value,
      folder: useFolder.value ? folderName.value.trim() : null,
    });
    step.value = 6;
  } catch (error) {
    createError.value = errorText(error);
  } finally {
    creating.value = false;
  }
}

function parseCron(cron: string): { time: string; days: string } {
  const [m = "0", h = "9", , , d = "*"] = cron.split(" ");
  return { time: `${h.padStart(2, "0")}:${m.padStart(2, "0")}`, days: d };
}

function toCron(time: string, days: string): string {
  const [h = "9", m = "0"] = time.split(":");
  return `${Number(m)} ${Number(h)} * * ${days}`;
}

function daysText(days: string): string {
  if (days === "*") return t("builder.everyDay");
  const fmt = new Intl.DateTimeFormat(locale.value, { weekday: "short" });
  // 2023-01-01 was a Sunday, matching cron day 0.
  return days
    .split(",")
    .map((d) => fmt.format(new Date(2023, 0, 1 + Number(d))))
    .join(", ");
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.body.details as { rolledBack?: boolean } | undefined;
    return details?.rolledBack ? `${error.body.message}. ${t("builder.rolledBack")}` : error.body.message;
  }
  return String(error);
}

onMounted(load);
</script>

<template>
  <div>
    <page-header :title="t('builder.title')">
      <n-button quaternary @click="router.push('/agents')">{{ t("builder.backToList") }}</n-button>
    </page-header>
    <n-space vertical size="large">
      <n-steps :current="Math.min(step, 5)" size="small">
        <n-step :title="t('builder.stepTemplate')" />
        <n-step :title="t('builder.stepAbout')" />
        <n-step :title="t('builder.stepData')" />
        <n-step :title="t('builder.stepSchedule')" />
        <n-step :title="t('builder.stepAi')" />
      </n-steps>

      <n-alert v-if="loadError" type="error">{{ loadError }}</n-alert>

      <n-spin :show="loading">
        <!-- 1. template -->
        <n-grid v-if="step === 1" cols="1 s:2 m:3" responsive="screen" :x-gap="12" :y-gap="12">
          <n-gi v-for="tpl in templates" :key="tpl.id">
            <button class="tpl" type="button" @click="pick(tpl)">
              <span class="emoji">{{ tpl.emoji ?? "🤖" }}</span>
              <strong>{{ tx(tpl.title) }}</strong>
              <n-text depth="3" class="desc">{{ tx(tpl.description) }}</n-text>
            </button>
          </n-gi>
        </n-grid>

        <!-- 2. about -->
        <n-card v-else-if="step === 2 && template" :title="`${template.emoji ?? ''} ${tx(template.title)}`">
          <n-form label-placement="top">
            <n-form-item v-for="field in template.fields" :key="field.key" :label="tx(field.label)" :required="field.required">
              <n-input
                v-model:value="values[field.key]"
                :type="field.type === 'textarea' ? 'textarea' : 'text'"
                :autosize="field.type === 'textarea' ? { minRows: 2, maxRows: 6 } : undefined"
                placeholder=""
              />
            </n-form-item>
          </n-form>
          <n-space>
            <n-button @click="step = 1">{{ t("builder.back") }}</n-button>
            <n-button type="primary" :disabled="missingRequired.length > 0" @click="step = 3">{{ t("builder.next") }}</n-button>
          </n-space>
          <n-text v-if="missingRequired.length" depth="3" class="hint">{{ t("builder.fillRequired", { fields: missingRequired.join(", ") }) }}</n-text>
        </n-card>

        <!-- 3. data: the agent's own folder, and whether it may ask the main agent for the rest -->
        <n-card v-else-if="step === 3 && template" :title="t('builder.stepData')">
          <p class="hint">{{ t("builder.dataLead") }}</p>
          <n-space vertical size="large">
            <div>
              <n-space align="center">
                <n-switch v-model:value="useFolder" />
                <n-text>{{ t("builder.ownFolder") }}</n-text>
              </n-space>
              <template v-if="useFolder">
                <n-input v-model:value="folderName" :placeholder="t('builder.folderName')" class="mt-s folder" :status="folderOk ? undefined : 'error'" />
                <n-text depth="3" class="hint block-s">
                  {{ folderOk ? t("builder.folderHint", { path: `${filesHostPath ?? "ClawDesk"}/${folderName.trim()}` }) : t("builder.folderInvalid") }}
                </n-text>
              </template>
            </div>
            <div>
              <n-space align="center">
                <n-switch v-model:value="canAskMain" />
                <n-text>{{ t("builder.canAskMain") }}</n-text>
              </n-space>
              <n-text depth="3" class="hint block-s">{{ canAskMain ? t("builder.canAskMainOn") : t("builder.canAskMainOff") }}</n-text>
            </div>
            <n-alert v-if="!sandboxEnabled" type="warning" :show-icon="false">{{ t("builder.folderNoSandbox") }}</n-alert>
          </n-space>
          <n-space class="mt">
            <n-button @click="step = 2">{{ t("builder.back") }}</n-button>
            <n-button type="primary" :disabled="!folderOk" @click="step = 4">{{ t("builder.next") }}</n-button>
          </n-space>
        </n-card>

        <!-- 4. schedule -->
        <n-card v-else-if="step === 4" :title="t('builder.stepSchedule')">
          <p class="hint">{{ t("builder.scheduleHint", { tz: timezone }) }}</p>
          <n-space vertical size="large">
            <div v-for="(s, i) in schedules" :key="i" class="schedule">
              <n-space align="center">
                <n-switch v-model:value="s.enabled" />
                <n-time-picker v-model:formatted-value="s.time" value-format="HH:mm" format="HH:mm" :minutes="5" :disabled="!s.enabled" style="width: 110px" />
                <n-text>{{ daysText(s.days) }}</n-text>
                <n-input v-if="!s.presetId" v-model:value="s.label" :placeholder="t('builder.scheduleLabel')" size="small" style="width: 200px" />
                <n-text v-else depth="3">{{ s.label }}</n-text>
              </n-space>
              <n-input v-model:value="s.prompt" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" :placeholder="t('builder.schedulePrompt')" :disabled="!s.enabled" class="mt-s" />
            </div>
            <n-text v-if="!schedules.length" depth="3">{{ t("builder.noSchedules") }}</n-text>
            <n-button dashed @click="addSchedule">+ {{ t("builder.addSchedule") }}</n-button>
            <n-space v-if="telegramReady" align="center">
              <n-switch v-model:value="deliverToTelegram" />
              <n-text>{{ t("builder.deliverToTelegram") }}</n-text>
            </n-space>
            <n-text v-else depth="3">{{ t("builder.telegramLater") }}</n-text>
          </n-space>
          <n-space class="mt">
            <n-button @click="step = 3">{{ t("builder.back") }}</n-button>
            <n-button type="primary" @click="step = 5">{{ t("builder.next") }}</n-button>
          </n-space>
        </n-card>

        <!-- 5. AI access + create -->
        <n-card v-else-if="step === 5" :title="t('builder.stepAi')">
          <n-radio-group v-model:value="aiMode" class="block">
            <n-space vertical>
              <n-radio value="inherit" :disabled="!mainConnected">
                {{ t("builder.aiInherit") }}
                <n-text depth="3"> — {{ mainConnected ? (mainModel ?? "") : t("builder.mainNotConnected") }}</n-text>
              </n-radio>
              <n-radio value="own">{{ t("builder.aiOwn") }}</n-radio>
              <!-- Free models: personal-mode juniors only (never the main agent or company teams). -->
              <n-radio v-if="template?.mode === 'personal'" value="free" :disabled="!freeReady">
                {{ t("builder.aiFree") }}
                <n-text depth="3"> — {{ freeReady ? t("builder.aiFreeHint") : "" }}</n-text>
                <router-link v-if="!freeReady" to="/free-models" target="_blank">{{ t("builder.aiFreeSetup") }}</router-link>
              </n-radio>
            </n-space>
          </n-radio-group>
          <n-alert v-if="!sandboxEnabled" type="warning" :show-icon="false" class="block">{{ t("agents.noSandbox") }}</n-alert>
          <n-alert v-if="createError" type="error" class="block">{{ createError }}</n-alert>
          <n-space>
            <n-button :disabled="creating" @click="step = 4">{{ t("builder.back") }}</n-button>
            <n-button type="primary" :loading="creating" @click="create">{{ t("builder.create") }}</n-button>
          </n-space>
        </n-card>

        <!-- 6. created; connect own AI if chosen -->
        <n-card v-else-if="step === 6 && created">
          <n-alert type="success" :title="t('builder.created', { name: created.displayName })" class="block">
            {{ t(deliverToTelegram && telegramReady ? "builder.createdDetailTelegram" : "builder.createdDetail", { n: created.cronJobIds.length }) }}
          </n-alert>
          <template v-if="aiMode === 'own' && !aiDone">
            <h3>{{ t("builder.connectOwn", { name: created.displayName }) }}</h3>
            <AiConnect :agent-id="created.agentId" @connected="aiDone = true" />
          </template>
          <n-space class="mt">
            <n-button type="primary" @click="router.push('/agents')">{{ t("builder.toList") }}</n-button>
          </n-space>
        </n-card>
      </n-spin>
    </n-space>
  </div>
</template>

<style scoped>
.tpl {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 16px;
  border: 1px solid rgba(128, 128, 128, 0.3);
  border-radius: 12px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tpl:hover,
.tpl:focus-visible {
  border-color: #18a058;
  outline: none;
}
.emoji {
  font-size: 28px;
}
.desc {
  font-size: 13px;
}
.schedule {
  padding: 12px;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 10px;
}
.block {
  display: block;
  margin-bottom: 16px;
}
.hint {
  font-size: 13px;
  opacity: 0.8;
}
.mt {
  margin-top: 16px;
}
.mt-s {
  margin-top: 8px;
}
.block-s {
  display: block;
  margin-top: 6px;
}
.folder {
  max-width: 320px;
}
</style>
