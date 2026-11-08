<script setup lang="ts">
import type { ReminderPreferences, TodayDto } from "@clawdesk/shared";
import { wallMinuteToInstant, zonedMinute } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NCheckbox, NEmpty, NInput, NPopconfirm, NSkeleton, NTag, useMessage } from "naive-ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { api, browserTimeZone } from "../api/client";
import PageHeader from "../components/ui/PageHeader.vue";

const { t, locale } = useI18n();
const message = useMessage();
const data = ref<TodayDto | null>(null);
const loading = ref(false);
const failed = ref(false);
const online = ref(navigator.onLine);
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;
const quiet = ref<ReminderPreferences["quietHours"]>({ enabled: false, start: "22:00", end: "08:00", timeZone: browserTimeZone() });
const quietDirty = ref(false);
let quietInitialized = false;
let dataRevision = 0;
const text = ref("");
const reminderField = ref<InstanceType<typeof NInput> | null>(null);
const due = ref("");
const exactDue = ref<number | null>(null);
const repeatDays = ref<number[]>([]);
const snoozeMinutes = ref(30);
const timeZone = computed(() => data.value?.timeZone ?? browserTimeZone());
const weekdays = [1, 2, 3, 4, 5, 6, 0];
const weekday = (day: number) => new Intl.DateTimeFormat(locale.value, { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2026, 0, 4 + day));
const createId = ref(crypto.randomUUID());
const creating = ref(false);
const savingQuiet = ref(false);
const busy = ref(new Set<string>());
const actionIds = new Map<string, string>();
watch([text, due, repeatDays, timeZone], () => { createId.value = crypto.randomUUID(); }, { deep: true });
watch(timeZone, () => { exactDue.value = null; });

async function load(manual = false): Promise<void> {
  if (stopped || loading.value || document.hidden || (!manual && !online.value)) return;
  now.value = Date.now();
  loading.value = true;
  const revision = dataRevision;
  try {
    const result = await api.today();
    if (stopped || revision !== dataRevision) return;
    data.value = result;
    failed.value = false;
    if (!quietDirty.value && !quietInitialized && result.reminders.state === "available" && result.reminders.data) {
      quiet.value = { ...result.reminders.data.preferences.quietHours };
      quietInitialized = true;
    }
  } catch { if (!stopped) failed.value = true; }
  finally { loading.value = false; }
}
const wake = () => { online.value = navigator.onLine; if (online.value && !document.hidden) void load(); };
onMounted(() => {
  void load(true);
  timer = setInterval(() => void load(), 30_000);
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  document.addEventListener("visibilitychange", wake);
});
onUnmounted(() => {
  stopped = true;
  clearInterval(timer);
  window.removeEventListener("online", wake);
  window.removeEventListener("offline", wake);
  document.removeEventListener("visibilitychange", wake);
});

const mutable = computed(() => !failed.value && data.value?.reminders.state === "available");
const mutating = computed(() => creating.value || savingQuiet.value || busy.value.size > 0);
const observations = computed(() => data.value?.reminders.data?.reminders ?? []);
const latestSeries = computed(() => {
  const latest = new Map<string, number>();
  for (const row of observations.value) if (row.seriesId) latest.set(row.seriesId, Math.max(latest.get(row.seriesId) ?? 0, row.dueAt));
  return latest;
});
const previousDelivery = (r: (typeof observations.value)[number]) => !!r.seriesId && r.delivery === "sent" && r.dueAt < (latestSeries.value.get(r.seriesId) ?? 0);
const reminders = computed(() => observations.value.filter((r) => r.action === "open" && !previousDelivery(r)).sort((a, b) => a.dueAt - b.dueAt));
const now = ref(Date.now());
const overdue = computed(() => reminders.value.filter((r) => r.dueAt <= now.value).length);
const deliveryIssues = computed(() => reminders.value.filter((r) => r.delivery === "unknown" || r.delivery === "expired" || (r.dueAt <= now.value && r.reason === "owner_not_connected")).length);
const activity = computed(() => data.value?.activity.data);
const lastActivity = computed(() => {
  const chat = activity.value?.conversations[0];
  const material = activity.value?.material;
  const reminder = (data.value?.reminders.data?.reminders ?? []).filter((r) => r.sentAt !== null).sort((a, b) => b.sentAt! - a.sentAt!)[0];
  return [
    ...(chat ? [{ key: "chat", at: chat.at }] : []),
    ...(material ? [{ key: "material", at: material.at }] : []),
    ...(reminder?.sentAt ? [{ key: "reminder", at: reminder.sentAt }] : []),
  ].sort((a, b) => b.at - a.at)[0];
});
const history = computed(() => observations.value.filter((r) => r.action !== "open" || previousDelivery(r)).sort((a, b) => b.dueAt - a.dueAt).slice(0, 5));
const schedules = computed(() => (data.value?.schedules.data?.schedules ?? []).filter((s) => s.enabled).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)).slice(0, 5));
const date = (at: number | null, timeZone = data.value?.timeZone ?? browserTimeZone()) => at === null ? t("today.neverChecked") : new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short", timeZone }).format(at);
const focusReminder = () => reminderField.value?.focus();
function presetDue(preset: "hour" | "tomorrow"): void {
  if (preset === "hour") {
    exactDue.value = Math.floor((Date.now() + 3_600_000) / 60_000) * 60_000;
    due.value = zonedMinute(exactDue.value, timeZone.value);
  }
  else {
    exactDue.value = null;
    const date = new Date(zonedMinute(Date.now(), timeZone.value).slice(0, 10) + "T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + 1);
    due.value = date.toISOString().slice(0, 10) + "T09:00";
  }
}
const stale = (section: Exclude<keyof TodayDto, "generatedAt" | "timeZone">) => failed.value || data.value?.[section].state !== "available";
const searchHealth = computed(() => {
  if (stale("search")) return "unknown";
  const memory = data.value?.search.data;
  const main = memory?.agents.find((a) => a.agentId === "main");
  if (memory?.error || memory?.job.state === "error" || main?.embeddings === "error") return "error";
  if (!memory?.checkedAt || !main || main.embeddings === "unchecked") return "unchecked";
  return main.index === "ready" && main.embeddings === "ready" ? "ready" : "pending";
});
const next = computed(() => {
  if (data.value?.approvals.data?.count) return { key: "approval", to: "/approvals" };
  if (deliveryIssues.value) return { key: "deliveryIssue", to: "#reminders" };
  if (data.value?.backups.data?.failed) return { key: "backupIssue", to: "/system" };
  if (stale("connection")) return { key: "connection", to: "/status" };
  if (stale("approvals")) return { key: "checkApprovals", to: "/approvals" };
  if (data.value?.connection.data?.telegram.some((bot) => !bot.running)) return { key: "telegram", to: "/telegram" };
  if (reminders.value.some((reminder) => reminder.reason === "owner_not_connected")) return { key: "telegram", to: "/telegram" };
  if (data.value?.notes.data?.pendingAgents.length) return { key: "sync", to: "/assistant#memory-notes" };
  if (overdue.value) return { key: "reminder", to: "#reminders" };
  return { key: "chat", to: "/chat" };
});

function setReminders(result: Awaited<ReturnType<typeof api.reminders.list>>): void {
  dataRevision++;
  if (data.value) data.value.reminders = { state: "available", checkedAt: Date.now(), data: result };
}
async function create(): Promise<void> {
  if (mutating.value || !mutable.value || !text.value.trim() || !due.value) return;
  const dueAt = exactDue.value ?? wallMinuteToInstant(due.value, timeZone.value);
  if (dueAt === null) { message.warning(t("today.repeat.missingTime")); return; }
  if (dueAt <= Date.now()) { message.warning(t("today.futureRequired")); return; }
  if (repeatDays.value.length && !repeatDays.value.includes(new Date(due.value.slice(0, 10) + "T00:00:00Z").getUTCDay())) {
    message.warning(t("today.repeat.firstDay")); return;
  }
  creating.value = true;
  dataRevision++;
  try {
    setReminders(await api.reminders.create({ requestId: createId.value, text: text.value.trim(), dueAt, timeZone: timeZone.value,
      ...(repeatDays.value.length ? { repeatDays: [...repeatDays.value] } : {}) }));
    text.value = ""; due.value = ""; exactDue.value = null; repeatDays.value = [];
    message.success(t("today.saved"));
  } catch { message.error(t("today.actionFailed")); }
  finally { creating.value = false; }
}
async function act(id: string, action: "done" | "skip" | "snooze" | "stop_repeat"): Promise<void> {
  if (!mutable.value || mutating.value) return;
  busy.value.add(id);
  dataRevision++;
  const minutes = snoozeMinutes.value;
  const key = `${id}:${action}:${action === "snooze" ? minutes : ""}`;
  if (!actionIds.has(key)) actionIds.set(key, crypto.randomUUID());
  try { setReminders(await api.reminders.action(id, { requestId: actionIds.get(key)!, action, ...(action === "snooze" ? { snoozeMinutes: minutes } : {}) })); }
  catch { message.error(t("today.actionFailed")); }
  finally { busy.value.delete(id); }
}
async function saveQuiet(): Promise<void> {
  if (mutating.value || !mutable.value) return;
  savingQuiet.value = true;
  dataRevision++;
  try {
    const result = await api.reminders.preferences({ quietHours: { ...quiet.value } });
    setReminders(result);
    quiet.value = { ...result.preferences.quietHours };
    quietDirty.value = false;
    message.success(t("today.saved"));
  } catch { message.error(t("today.actionFailed")); }
  finally { savingQuiet.value = false; }
}
async function sync(agentId: string): Promise<void> {
  const key = `sync:${agentId}`;
  if (mutating.value || stale("notes")) return;
  busy.value.add(key);
  try {
    const result = await api.memory.sync(agentId);
    if (!result.applied) message.warning(t("today.syncPending"));
    await load(true);
  } catch { message.error(t("today.actionFailed")); }
  finally { busy.value.delete(key); }
}
</script>

<template>
  <page-header :title="t('today.title')" :subtitle="t('today.subtitle')">
    <n-button :loading="loading" @click="load(true)">{{ t('today.refresh') }}</n-button>
  </page-header>
  <n-alert v-if="!online || failed" type="warning" class="block" :title="t(!online ? 'today.offline' : 'today.loadFailed')">{{ t('today.kept') }}</n-alert>
  <n-skeleton v-if="!data && loading" height="180px" />
  <n-card class="block" :title="t('today.quick.title')">
    <div class="links">
      <router-link to="/chat">{{ t('today.quick.chat') }}</router-link>
      <router-link :to="{ name: 'chat', query: { compose: 'attachment' } }">{{ t('today.quick.document') }}</router-link>
      <a href="#reminder-text" @click="focusReminder">{{ t('today.newReminder') }}</a>
    </div>
  </n-card>
  <template v-if="data">
    <p class="muted">{{ t('today.updated', { time: date(data.generatedAt) }) }} · {{ data.timeZone }}</p>
    <n-card class="block next" :title="t('today.nextTitle')">
      <p>{{ t(`today.next.${next.key}`) }}</p>
      <a v-if="next.to.startsWith('#')" :href="next.to">{{ t('today.open') }}</a>
      <router-link v-else :to="next.to">{{ t('today.open') }}</router-link>
    </n-card>
    <div class="grid">
      <n-card id="reminders" :title="t('today.reminders')">
        <n-alert v-if="stale('reminders')" type="warning">{{ t('today.unknown') }} · {{ date(data.reminders.checkedAt) }}</n-alert>
        <n-alert v-if="data.reminders.data?.partial" type="info">{{ t('today.partial') }}</n-alert>
        <p class="muted">{{ t('today.fixedNote') }}</p>
        <p v-if="!stale('reminders')">{{ t(data.reminders.data?.telegramConfigured ? 'today.repeat.telegramOn' : 'today.repeat.telegramOff') }}</p>
        <n-empty v-if="!reminders.length && !stale('reminders')" :description="t('today.noReminders')" />
        <p v-if="overdue" class="muted">{{ t('today.quick.overdue', { count: overdue }) }}</p>
        <n-alert v-if="deliveryIssues" type="warning">{{ t('today.quick.undelivered', { count: deliveryIssues }) }}</n-alert>
        <article v-for="item in reminders" :key="item.id" class="item">
          <strong class="wrap">{{ item.text }}</strong>
          <div class="muted">{{ date(item.dueAt, item.timeZone) }} · {{ item.timeZone }}</div>
          <n-tag size="small" :type="item.delivery === 'sent' ? 'success' : item.delivery === 'unknown' ? 'warning' : 'default'">{{ t(`today.delivery.${item.delivery}`) }}</n-tag>
          <p v-if="item.delivery === 'sent' && item.sentAt" class="muted">{{ t('today.sentAt', { time: date(item.sentAt, item.timeZone) }) }} · {{ item.timeZone }}</p>
          <div class="actions">
            <n-button size="small" :disabled="!mutable || busy.has(item.id)" @click="act(item.id, 'done')">{{ t('today.done') }}</n-button>
            <label>{{ t('today.repeat.snooze') }}
              <select v-model.number="snoozeMinutes" :disabled="mutating">
                <option v-for="minutes in [15, 30, 60, 120, 1440]" :key="minutes" :value="minutes">{{ t('today.repeat.minutes', { minutes }) }}</option>
              </select>
            </label>
            <n-button size="small" :disabled="!mutable || busy.has(item.id)" @click="act(item.id, 'snooze')">{{ t('today.repeat.snooze') }}</n-button>
            <n-button size="small" :disabled="!mutable || busy.has(item.id)" @click="act(item.id, 'skip')">{{ t('today.skip') }}</n-button>
          </div>
        </article>
        <details v-if="history.length"><summary>{{ t('today.history') }}</summary><p v-for="item in history" :key="item.id" class="wrap">{{ item.text }} · {{ t(item.action === 'open' ? 'today.delivery.sent' : `today.action.${item.action}`) }}</p></details>
        <form class="form" @submit.prevent="create">
          <label for="reminder-text">{{ t('today.newReminder') }}</label>
          <n-input ref="reminderField" v-model:value="text" type="textarea" :input-props="{ id: 'reminder-text' }" :maxlength="2000" :disabled="creating" :placeholder="t('today.reminderPlaceholder')" />
          <label for="reminder-due">{{ t('today.when', { zone: timeZone }) }}</label>
          <input id="reminder-due" v-model="due" type="datetime-local" required :disabled="creating" @input="exactDue = null" />
          <p v-if="timeZone !== browserTimeZone()" class="muted">{{ t('today.repeat.deviceZone', { zone: browserTimeZone() }) }}</p>
          <div class="actions">
            <n-button size="small" :disabled="creating" @click="presetDue('hour')">{{ t('today.repeat.hour') }}</n-button>
            <n-button size="small" :disabled="creating" @click="presetDue('tomorrow')">{{ t('today.repeat.tomorrow') }}</n-button>
          </div>
          <fieldset :disabled="creating">
            <legend>{{ t('today.repeat.days') }}</legend>
            <div class="actions">
              <label v-for="day in weekdays" :key="day"><input v-model="repeatDays" type="checkbox" :value="day" /> {{ weekday(day) }}</label>
            </div>
          </fieldset>
          <n-button attr-type="submit" :loading="creating" :disabled="!mutable || !text.trim() || !due">{{ t('today.add') }}</n-button>
        </form>
        <div v-if="data.reminders.data?.series?.length">
          <h3>{{ t('today.repeat.series') }}</h3>
          <article v-for="series in data.reminders.data.series" :key="series.id" class="item">
            <strong class="wrap">{{ series.text }}</strong>
            <p>{{ series.days.map(weekday).join(', ') }} · {{ t('today.repeat.next', { at: date(series.nextAt, series.timeZone) }) }} · {{ series.timeZone }}</p>
            <n-popconfirm @positive-click="act(series.id, 'stop_repeat')">
              <template #trigger><n-button size="small" :disabled="!mutable || mutating">{{ t('today.repeat.stop') }}</n-button></template>
              {{ t('today.repeat.stopConfirm') }}
            </n-popconfirm>
          </article>
        </div>
        <details class="quiet"><summary>{{ t('today.quietHours') }}</summary>
          <p class="muted">{{ t('today.quietNote') }}</p>
          <n-checkbox :checked="quiet.enabled" :disabled="savingQuiet" @update:checked="v => { quiet.enabled = v; quietDirty = true; }">{{ t('today.enabled') }}</n-checkbox>
          <div class="actions"><label>{{ t('today.from') }} <input v-model="quiet.start" type="time" :disabled="savingQuiet" @input="quietDirty = true" /></label><label>{{ t('today.until') }} <input v-model="quiet.end" type="time" :disabled="savingQuiet" @input="quietDirty = true" /></label></div>
          <p class="muted">{{ quiet.timeZone }}</p>
          <n-button :loading="savingQuiet" :disabled="!mutable || !quietDirty" @click="saveQuiet">{{ t('today.save') }}</n-button>
        </details>
      </n-card>
      <div class="stack">
        <n-card :title="t('today.quick.recent')">
          <p v-if="stale('activity')">{{ t('today.unknown') }} · {{ date(data.activity.checkedAt) }}</p>
          <p v-else-if="!lastActivity" class="muted">{{ t('today.quick.firstSteps') }}</p>
          <p v-if="lastActivity">{{ t(`today.quick.last.${lastActivity.key}`) }} · {{ date(lastActivity.at) }}</p>
          <router-link v-if="activity?.material" :to="{ name: 'library', query: { material: activity.material.id } }">{{ activity.material.title }}</router-link>
          <ul v-if="activity?.conversations.length">
            <li v-for="item in activity.conversations" :key="item.id ?? item.agentId">
              <router-link :to="{ name: 'chat', params: { agentId: item.agentId }, query: item.id ? { conversation: item.id } : {} }">
                {{ item.title ?? t('chat.conversations.main') }} · {{ item.agentId }}
              </router-link>
            </li>
          </ul>
        </n-card>
        <n-card :title="t('today.quick.budget')">
          <p v-if="data.budget.data?.spentTodayUsd != null && !data.budget.data.incomplete && !stale('budget')">{{ t('today.quick.spend', { value: data.budget.data.spentTodayUsd.toFixed(2) }) }}</p>
          <p v-else>{{ t('today.unknown') }}</p>
          <p v-if="data.budget.data" class="muted">{{ t('today.quick.limits', { daily: data.budget.data.dailyUsd || '—', monthly: data.budget.data.monthlyUsd || '—' }) }}</p>
          <p class="muted">{{ t('today.checked', { time: date(data.budget.checkedAt) }) }}</p>
          <router-link to="/usage">{{ t('today.open') }}</router-link>
        </n-card>
        <n-card :title="t('today.quick.backups')">
          <p v-if="stale('backups')">{{ t('today.unknown') }} · {{ date(data.backups.checkedAt) }}</p>
          <p v-else-if="data.backups.data?.lastAt">{{ t('today.quick.lastBackup', { date: date(data.backups.data.lastAt) }) }}</p>
          <p v-else>{{ t(data.backups.data?.available ? 'today.quick.noBackup' : 'today.quick.backupUnavailable') }}</p>
          <n-alert v-if="data.backups.data?.failed" type="warning">{{ t('today.next.backupIssue') }}</n-alert>
          <router-link to="/system">{{ t('today.open') }}</router-link>
        </n-card>
        <n-card :title="t('today.approvals')">
          <p v-if="stale('approvals')">{{ t('today.unknown') }} · {{ date(data.approvals.checkedAt) }}</p>
          <p v-else>{{ t('today.approvalCount', { count: data.approvals.data?.count ?? 0 }) }}</p>
          <router-link to="/approvals">{{ t('today.reviewApprovals') }}</router-link>
        </n-card>
        <n-card :title="t('today.connection')">
          <p>{{ t('today.gateway') }}: {{ t(stale('connection') ? 'today.unknown' : 'today.connected') }}</p>
          <p v-for="bot in data.connection.data?.telegram ?? []" :key="bot.accountId" class="wrap">Telegram · {{ bot.accountId }}: {{ t(stale('connection') ? 'today.unknown' : bot.running ? 'today.running' : 'today.stopped') }}</p>
          <p class="muted">{{ date(data.connection.checkedAt) }}</p>
          <router-link to="/status">{{ t('today.diagnostics') }}</router-link> · <router-link to="/telegram">Telegram</router-link>
        </n-card>
        <n-card :title="t('today.memory')">
          <p>{{ t('today.facts', { count: stale('notes') ? '—' : data.notes.data?.count ?? 0 }) }}</p>
          <p class="muted">{{ t('today.compactNote') }}</p>
          <p v-if="stale('notes')">{{ t('today.unknown') }} · {{ date(data.notes.checkedAt) }}</p>
          <div v-for="agentId in data.notes.data?.pendingAgents ?? []" :key="agentId" class="item">
            <p class="wrap">{{ t('today.pending', { agent: agentId }) }}</p>
            <n-button size="small" :disabled="stale('notes')" :loading="busy.has(`sync:${agentId}`)" @click="sync(agentId)">{{ t('today.sync') }}</n-button>
          </div>
          <p>{{ t('today.search') }}: {{ t(`today.searchHealth.${searchHealth}`) }}</p>
          <p class="muted">{{ t('today.checked', { time: date(data.search.checkedAt) }) }}</p>
          <div class="links"><router-link to="/assistant#memory-notes">{{ t('today.ownerFacts') }}</router-link><router-link to="/library">{{ t('today.materials') }}</router-link><router-link to="/assistant#memory-search">{{ t('today.searchSetup') }}</router-link></div>
        </n-card>
      </div>
    </div>
    <n-card class="block" :title="t('today.agentSchedules')">
      <p class="muted">{{ t('today.agentSchedulesNote') }}</p>
      <p v-if="stale('schedules')">{{ t('today.unknown') }} · {{ date(data.schedules.checkedAt) }}</p>
      <p v-for="schedule in schedules" :key="schedule.id" class="wrap">{{ schedule.label }} · {{ schedule.agentId }} · {{ date(schedule.nextRunAt) }}</p>
      <router-link to="/schedules">{{ t('today.manageSchedules') }}</router-link>
    </n-card>
  </template>
  <n-alert v-else-if="!loading" type="warning">{{ t('today.noSnapshot') }} <n-button size="small" @click="load(true)">{{ t('today.refresh') }}</n-button></n-alert>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.stack { display: grid; gap: 16px; min-width: 0; }
.block { margin-bottom: 20px; }
.next { border-left: 3px solid var(--primary, #8f85f3); }
.item { padding: 14px 0; border-bottom: 1px solid var(--border); }
.wrap { overflow-wrap: anywhere; white-space: pre-wrap; }
.muted { color: var(--text-2); font-size: 13px; }
.actions, .links { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.form { display: grid; gap: 8px; margin-top: 20px; }
.quiet { margin-top: 20px; }
summary { cursor: pointer; }
input { box-sizing: border-box; max-width: 100%; min-width: 0; padding: 8px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 5px; font: inherit; }
@media (max-width: 850px) { .grid { grid-template-columns: minmax(0, 1fr); } }
</style>
