<script setup lang="ts">
// Schedules (screen 10): tasks agents do at set times — turn on/off, change time, run now.
import type { AgentListItemDto, ScheduleDto, ScheduleListDto, ScheduleRunDto } from "@clawdesk/shared";
import { AlertCircle, CalendarClock, CheckCircle2, CircleSlash, History, Pencil, Play, Plus, Send, Trash2 } from "@lucide/vue";
import { NButton, NEmpty, NPopconfirm, NSkeleton, NSwitch, NTooltip, useMessage } from "naive-ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError, browserTimeZone } from "../api/client";
import ScheduleForm from "../components/ScheduleForm.vue";
import AutomaticWorkNotice from "../components/AutomaticWorkNotice.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { describeSchedule } from "../cron";
import { formatRelative, intlLocale } from "../format";
import { modelErrorHint } from "../model-errors";
import { useSpaceStore } from "../stores/space";

const { t, locale } = useI18n();
const message = useMessage();
const space = useSpaceStore();
const timeZone = computed(() => space.mode === "personal" ? space.space?.timezone ?? browserTimeZone() : browserTimeZone());
const data = ref<ScheduleListDto | null>(null);
const agents = ref<AgentListItemDto[]>([]);
const creating = ref(false);
const editing = ref<string | null>(null);
const saving = ref(false);
const busy = ref<string | null>(null);
const runsFor = ref<string | null>(null);
const runs = ref<ScheduleRunDto[]>([]);

function errText(e: unknown): string {
  if (!(e instanceof ApiError)) return String(e);
  if (e.body.error === "budget_usage_unavailable") return t("budget.unavailable");
  if (e.body.error === "budget_exceeded") return t("budget.exceeded." + e.body.message);
  return e.body.message;
}
const agentName = (id: string) => {
  const a = agents.value.find((x) => x.id === id);
  if (!a) return id;
  return a.role === "main" && a.name === a.id ? t("agents.main") : a.name;
};
const agentEmoji = (id: string) => agents.value.find((x) => x.id === id)?.emoji ?? (id === "main" ? "🧭" : "🤖");

// Grouped by agent, main first.
const groups = computed(() => {
  const by = new Map<string, ScheduleDto[]>();
  for (const s of data.value?.schedules ?? []) by.set(s.agentId, [...(by.get(s.agentId) ?? []), s]);
  return [...by.entries()].sort(([a], [b]) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));
});

let loading = false;
async function load(silent = false): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const [list, ag] = await Promise.all([api.schedules.list(), api.agents()]);
    data.value = list;
    agents.value = ag.agents;
  } catch (e) {
    if (!silent) message.error(errText(e));
  } finally {
    loading = false;
  }
}

async function create(v: { agentId: string; label: string; prompt: string; cron: string }): Promise<void> {
  saving.value = true;
  try {
    data.value = await api.schedules.create({ ...v, tz: timeZone.value });
    creating.value = false;
    message.success(t("schedules.created"));
  } catch (e) {
    message.error(errText(e));
  } finally {
    saving.value = false;
  }
}

async function update(id: string, v: { label: string; prompt: string; cron: string }): Promise<void> {
  saving.value = true;
  try {
    const tz = data.value?.schedules.find((schedule) => schedule.id === id)?.tz ?? browserTimeZone();
    data.value = await api.schedules.update(id, { label: v.label, prompt: v.prompt, cron: v.cron, tz });
    editing.value = null;
    message.success(t("schedules.saved"));
  } catch (e) {
    message.error(errText(e));
  } finally {
    saving.value = false;
  }
}

async function setEnabled(s: ScheduleDto, enabled: boolean): Promise<void> {
  busy.value = s.id;
  try {
    data.value = await api.schedules.update(s.id, { enabled });
  } catch (e) {
    message.error(errText(e));
  } finally {
    busy.value = null;
  }
}

async function runNow(s: ScheduleDto): Promise<void> {
  busy.value = s.id;
  try {
    await api.schedules.run(s.id);
    message.success(t("schedules.started", { name: s.label }));
  } catch (e) {
    message.error(errText(e));
  } finally {
    busy.value = null;
  }
}

async function remove(s: ScheduleDto): Promise<void> {
  try {
    data.value = await api.schedules.remove(s.id);
    message.success(t("schedules.removed"));
  } catch (e) {
    message.error(errText(e));
  }
}

async function toggleRuns(s: ScheduleDto): Promise<void> {
  if (runsFor.value === s.id) {
    runsFor.value = null;
    return;
  }
  runsFor.value = s.id;
  runs.value = [];
  try {
    runs.value = await api.schedules.runs(s.id);
  } catch (e) {
    message.error(errText(e));
  }
}

function refresh(): void {
  if (!document.hidden && !creating.value && !editing.value && !saving.value && !busy.value) void load(true);
}

function scheduledAt(s: ScheduleDto): string {
  return new Intl.DateTimeFormat(intlLocale(locale.value), {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: s.tz ?? browserTimeZone(),
  }).format(new Date(s.at!));
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(refresh, 15_000);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
});
onUnmounted(() => {
  clearInterval(timer);
  window.removeEventListener("focus", refresh);
  document.removeEventListener("visibilitychange", refresh);
});
</script>

<template>
  <div>
    <page-header :title="t('schedules.title')" :subtitle="t('schedules.subtitle', { tz: timeZone })">
      <n-button v-if="!creating" type="primary" :disabled="!agents.length" @click="creating = true">
        <template #icon><plus :size="16" /></template>
        {{ t("schedules.new") }}
      </n-button>
    </page-header>

    <section v-if="creating" class="card form-card">
      <h2 class="card-title">{{ t("schedules.new") }}</h2>
      <AutomaticWorkNotice v-if="space.mode === 'personal'" kind="schedule" />
      <schedule-form :agents="agents" :saving="saving" @save="create" @cancel="creating = false" />
    </section>

    <n-skeleton v-if="!data" height="160px" :sharp="false" />
    <n-empty v-else-if="!data.schedules.length && !creating" :description="t('schedules.empty')" class="empty">
      <template #extra>
        <n-button size="small" @click="creating = true">{{ t("schedules.new") }}</n-button>
      </template>
    </n-empty>

    <section v-for="[agentId, list] in groups" :key="agentId" class="group">
      <h2 class="group-title"><span class="emoji">{{ agentEmoji(agentId) }}</span> {{ agentName(agentId) }}</h2>
      <div class="list">
        <article v-for="s in list" :key="s.id" class="card job" :class="{ off: !s.enabled }">
          <template v-if="editing === s.id">
            <schedule-form :agents="agents" :schedule="s" :saving="saving" @save="(v) => update(s.id, v)" @cancel="editing = null" />
          </template>
          <template v-else>
            <div class="job-head">
              <calendar-clock :size="18" class="job-icon" />
              <div class="job-main">
                <div class="job-name">{{ s.label }}</div>
                <div class="job-when">
                  {{ s.at ? scheduledAt(s) : describeSchedule(t, s.cron, s.everyMs, locale) }}
                  <template v-if="s.tz && s.tz !== browserTimeZone()"> · {{ s.tz }}</template>
                  <template v-if="s.enabled && s.nextRunAt"> · {{ t("schedules.next", { when: formatRelative(s.nextRunAt, locale) }) }}</template>
                  <template v-if="!s.enabled"> · {{ t("schedules.paused") }}</template>
                </div>
              </div>
              <n-tooltip>
                <template #trigger>
                  <n-switch :value="s.enabled" :loading="busy === s.id" @update:value="(v: boolean) => setEnabled(s, v)" />
                </template>
                {{ s.enabled ? t("schedules.turnOff") : t("schedules.turnOn") }}
              </n-tooltip>
            </div>
            <p class="prompt">{{ s.prompt }}</p>
            <div class="job-foot">
              <span v-if="s.lastStatus" class="last" :data-status="s.lastStatus" :title="s.lastError ? modelErrorHint(t, s.lastError) : undefined">
                <component :is="s.lastStatus === 'ok' ? CheckCircle2 : s.lastStatus === 'error' ? AlertCircle : CircleSlash" :size="13" />
                {{ t(`dash.run.${s.lastStatus}`) }}<template v-if="s.lastRunAt"> · {{ formatRelative(s.lastRunAt, locale) }}</template>
              </span>
              <span v-else class="last muted">{{ t("schedules.neverRan") }}</span>
              <span v-if="s.deliversToTelegram" class="tg"><send :size="12" /> Telegram</span>
              <div class="job-actions">
                <n-button size="tiny" secondary :loading="busy === s.id" @click="runNow(s)">
                  <template #icon><play :size="12" /></template>
                  {{ t("schedules.runNow") }}
                </n-button>
                <n-button size="tiny" quaternary :aria-label="t('schedules.history')" @click="toggleRuns(s)"><history :size="13" /></n-button>
                <n-button v-if="s.cron" size="tiny" quaternary :aria-label="t('schedules.edit')" @click="editing = s.id"><pencil :size="13" /></n-button>
                <n-popconfirm @positive-click="remove(s)">
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error" :aria-label="t('schedules.remove')"><trash-2 :size="13" /></n-button>
                  </template>
                  {{ t("schedules.confirmRemove", { name: s.label }) }}
                </n-popconfirm>
              </div>
            </div>
            <ul v-if="runsFor === s.id" class="runs">
              <li v-if="!runs.length" class="muted">{{ t("schedules.noRuns") }}</li>
              <li v-for="r in runs" :key="r.at">
                <component :is="r.status === 'ok' ? CheckCircle2 : r.status === 'error' ? AlertCircle : CircleSlash" :size="13" :class="['st', r.status]" />
                <span>{{ formatRelative(r.at, locale) }}</span>
                <span class="muted">{{ r.status === "error" ? modelErrorHint(t, r.error) : (r.summary ?? "") }}</span>
              </li>
            </ul>
          </template>
        </article>
      </div>
    </section>

    <p v-if="data?.systemJobs" class="foot-note">{{ t("dash.schedules.system", { n: data.systemJobs }) }}</p>
  </div>
</template>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
}
.form-card {
  margin-bottom: 20px;
}
.card-title {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
}
.empty {
  padding: 40px 0;
}
.group {
  margin-bottom: 24px;
}
.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}
.list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.job.off {
  opacity: 0.7;
}
.job-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.job-icon {
  color: var(--accent);
  margin-top: 2px;
  flex: none;
}
.job-main {
  flex: 1;
  min-width: 0;
}
.job-name {
  font-weight: 600;
  font-size: 14px;
}
.job-when {
  font-size: 12.5px;
  color: var(--text-2);
  margin-top: 2px;
}
.prompt {
  margin: 10px 0 12px;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.job-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.last {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.last[data-status="ok"] {
  color: var(--good-text);
}
.last[data-status="error"] {
  color: var(--critical);
}
.tg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.job-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
  align-items: center;
}
.runs {
  list-style: none;
  margin: 12px 0 0;
  padding: 10px 0 0;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.runs li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.st.ok {
  color: var(--good-text);
}
.st.error {
  color: var(--critical);
}
.foot-note {
  font-size: 12px;
  color: var(--muted);
}
@media (max-width: 900px) {
  .list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
