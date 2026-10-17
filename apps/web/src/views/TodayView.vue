<script setup lang="ts">
import type { ReminderDto, ReminderPreferences, TodayDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NCheckbox, NEmpty, NInput, NSkeleton, NTag, useMessage } from "naive-ui";
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
const due = ref("");
const createId = ref(crypto.randomUUID());
const creating = ref(false);
const savingQuiet = ref(false);
const busy = ref(new Set<string>());
const actionIds = new Map<string, string>();
watch([text, due], () => { createId.value = crypto.randomUUID(); });

async function load(manual = false): Promise<void> {
  if (stopped || loading.value || document.hidden || (!manual && !online.value)) return;
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
const reminders = computed(() => (data.value?.reminders.data?.reminders ?? []).filter((r) => r.action === "open").sort((a, b) => a.dueAt - b.dueAt));
const history = computed(() => (data.value?.reminders.data?.reminders ?? []).filter((r) => r.action !== "open").sort((a, b) => b.dueAt - a.dueAt).slice(0, 5));
const schedules = computed(() => (data.value?.schedules.data?.schedules ?? []).filter((s) => s.enabled).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)).slice(0, 5));
const date = (at: number | null, timeZone = data.value?.timeZone ?? browserTimeZone()) => at === null ? t("today.neverChecked") : new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short", timeZone }).format(at);
const stale = (section: keyof Pick<TodayDto, "connection" | "approvals" | "notes" | "search" | "reminders" | "schedules">) => failed.value || data.value?.[section].state !== "available";
const searchHealth = computed(() => {
  if (stale("search")) return "unknown";
  const memory = data.value?.search.data;
  const main = memory?.agents.find((a) => a.agentId === "main");
  if (memory?.error || memory?.job.state === "error" || main?.embeddings === "error") return "error";
  if (!memory?.checkedAt || !main || main.embeddings === "unchecked") return "unchecked";
  return main.index === "ready" && main.embeddings === "ready" ? "ready" : "pending";
});
const next = computed(() => {
  if (stale("connection")) return { key: "connection", to: "/status" };
  if (stale("approvals")) return { key: "checkApprovals", to: "/approvals" };
  if (data.value?.approvals.data?.count) return { key: "approval", to: "/approvals" };
  if (data.value?.connection.data?.telegram.some((bot) => !bot.running)) return { key: "telegram", to: "/telegram" };
  if (reminders.value.some((reminder) => reminder.reason === "owner_not_connected")) return { key: "telegram", to: "/telegram" };
  if (data.value?.notes.data?.pendingAgents.length) return { key: "sync", to: "/assistant#memory-notes" };
  if (reminders.value.some((r) => r.dueAt <= Date.now())) return { key: "reminder", to: "#reminders" };
  return { key: "chat", to: "/chat" };
});

function setReminders(result: Awaited<ReturnType<typeof api.reminders.list>>): void {
  dataRevision++;
  if (data.value) data.value.reminders = { state: "available", checkedAt: Date.now(), data: result };
}
async function create(): Promise<void> {
  if (mutating.value || !mutable.value || !text.value.trim() || !due.value) return;
  const dueAt = new Date(due.value).getTime();
  if (!Number.isFinite(dueAt) || dueAt <= Date.now()) { message.warning(t("today.futureRequired")); return; }
  creating.value = true;
  dataRevision++;
  try {
    setReminders(await api.reminders.create({ requestId: createId.value, text: text.value.trim(), dueAt, timeZone: browserTimeZone() }));
    text.value = ""; due.value = "";
    message.success(t("today.saved"));
  } catch { message.error(t("today.actionFailed")); }
  finally { creating.value = false; }
}
async function act(reminder: ReminderDto, action: "done" | "skip" | "snooze"): Promise<void> {
  if (!mutable.value || mutating.value) return;
  busy.value.add(reminder.id);
  dataRevision++;
  const key = `${reminder.id}:${action}`;
  if (!actionIds.has(key)) actionIds.set(key, crypto.randomUUID());
  try { setReminders(await api.reminders.action(reminder.id, { requestId: actionIds.get(key)!, action, ...(action === "snooze" ? { snoozeMinutes: 30 } : {}) })); }
  catch { message.error(t("today.actionFailed")); }
  finally { busy.value.delete(reminder.id); }
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
        <n-empty v-if="!reminders.length && !stale('reminders')" :description="t('today.noReminders')" />
        <article v-for="item in reminders" :key="item.id" class="item">
          <strong class="wrap">{{ item.text }}</strong>
          <div class="muted">{{ date(item.dueAt, item.timeZone) }} · {{ item.timeZone }}</div>
          <n-tag size="small" :type="item.delivery === 'sent' ? 'success' : item.delivery === 'unknown' ? 'warning' : 'default'">{{ t(`today.delivery.${item.delivery}`) }}</n-tag>
          <p v-if="item.delivery === 'sent' && item.sentAt" class="muted">{{ t('today.sentAt', { time: date(item.sentAt, item.timeZone) }) }} · {{ item.timeZone }}</p>
          <div class="actions">
            <n-button size="small" :disabled="!mutable || busy.has(item.id)" @click="act(item, 'done')">{{ t('today.done') }}</n-button>
            <n-button size="small" :disabled="!mutable || busy.has(item.id)" @click="act(item, 'snooze')">{{ t('today.later') }}</n-button>
            <n-button size="small" :disabled="!mutable || busy.has(item.id)" @click="act(item, 'skip')">{{ t('today.skip') }}</n-button>
          </div>
        </article>
        <details v-if="history.length"><summary>{{ t('today.history') }}</summary><p v-for="item in history" :key="item.id" class="wrap">{{ item.text }} · {{ t(`today.action.${item.action}`) }}</p></details>
        <form class="form" @submit.prevent="create">
          <label for="reminder-text">{{ t('today.newReminder') }}</label>
          <n-input id="reminder-text" v-model:value="text" type="textarea" :maxlength="2000" :disabled="creating" :placeholder="t('today.reminderPlaceholder')" />
          <label for="reminder-due">{{ t('today.when', { zone: browserTimeZone() }) }}</label>
          <input id="reminder-due" v-model="due" type="datetime-local" required :disabled="creating" />
          <n-button attr-type="submit" :loading="creating" :disabled="!mutable || !text.trim() || !due">{{ t('today.add') }}</n-button>
        </form>
        <details class="quiet"><summary>{{ t('today.quietHours') }}</summary>
          <p class="muted">{{ t('today.quietNote') }}</p>
          <n-checkbox :checked="quiet.enabled" :disabled="savingQuiet" @update:checked="v => { quiet.enabled = v; quietDirty = true; }">{{ t('today.enabled') }}</n-checkbox>
          <div class="actions"><label>{{ t('today.from') }} <input v-model="quiet.start" type="time" :disabled="savingQuiet" @input="quietDirty = true" /></label><label>{{ t('today.until') }} <input v-model="quiet.end" type="time" :disabled="savingQuiet" @input="quietDirty = true" /></label></div>
          <p class="muted">{{ quiet.timeZone }}</p>
          <n-button :loading="savingQuiet" :disabled="!mutable || !quietDirty" @click="saveQuiet">{{ t('today.save') }}</n-button>
        </details>
      </n-card>
      <div class="stack">
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
          <div class="links"><router-link to="/assistant#memory-notes">{{ t('today.ownerFacts') }}</router-link><router-link to="/chat/main#library">{{ t('today.materials') }}</router-link><router-link to="/assistant#memory-search">{{ t('today.searchSetup') }}</router-link></div>
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
