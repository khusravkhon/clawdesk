<script setup lang="ts">
// Stages 10–11: the interactive office. Same source as the work list (the activity store); opening it starts
// no polling of agents and no model run — characters move locally in the browser. The demo mode shows test
// data and says so everywhere; it is never monitoring. Without a working canvas the list is shown instead.
import type { AgentActivityDto, AgentActivityState } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NSelect, NSpace, NSwitch, NTag } from "naive-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import OfficeScene from "../components/OfficeScene.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { useActivityStore } from "../stores/activity";

const CAPACITY = 30;
const { t, te } = useI18n();
const router = useRouter();
const store = useActivityStore();
const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** A remembered view setting; storage can be unavailable (private window), then the default applies. */
function stored(key: string, fallback: string): string { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
const motion = ref(!reduced && stored("clawdesk.office.motion", "on") === "on");
const zoom = ref(Number(stored("clawdesk.office.zoom", "2")) || 2);
const scope = ref<string>(stored("clawdesk.office.scope", "all"));
const demo = ref(false), failed = ref(false), selected = ref<string | null>(null);
const narrow = typeof window !== "undefined" && window.innerWidth < 640;
const opened = ref(!narrow);
let leave: (() => void) | null = null, demoTimer: ReturnType<typeof setInterval> | undefined;

/** Test data for the prototype: the states the office must show, changing over time. */
const demoAgents = ref<AgentActivityDto[]>([]);
function makeDemo(step: number): AgentActivityDto[] {
  const base = (agentId: string, name: string, position: string, state: AgentActivityState, detail: string, extra: Partial<AgentActivityDto> = {}): AgentActivityDto => ({ agentId, name, role: "team_member", position, team: { id: "demo", name: "Демо-команда" }, department: { id: "demo", name: "Демо-отдел" }, state, detail, action: null, runs: state === "working" ? 1 : 0, task: null, request: null, inbox: 0, lastActivityAt: Date.now(), ...extra });
  const busy = step % 4 < 2;
  return [
    base("demo-pm", "Анна (демо)", "pm", "working", "WI-101 «План релиза»", { action: "read" }),
    base("demo-dev", "Борис (демо)", "developer", busy ? "working" : "idle", busy ? "WI-102 «Форма входа»" : "свободен", busy ? { action: "exec", runs: 2 } : {}),
    base("demo-qa", "Вера (демо)", "qa", "waiting_for_owner", "ждёт решения владельца: REQ-201 «Нужен доступ к ТЗ»", { request: { code: "REQ-201", addressee: "владелец" } }),
    base("demo-rev", "Глеб (демо)", "reviewer", "waiting_for_agent", "ждёт ответа от Анна (демо): REQ-202", { request: { code: "REQ-202", addressee: "Анна (демо)" } }),
    base("demo-an", "Дина (демо)", "analyst", "blocked", "REQ-203: отказано; решение — за владельцем"),
    base("demo-op", "Егор (демо)", "ops", "error", "ошибка запуска: rate limited"),
    base("demo-wr", "Жанна (демо)", "writer", busy ? "idle" : "working", busy ? "свободен" : "WI-103 «Статья»", busy ? {} : { action: "write" }),
    base("demo-off", "Зоя (демо)", "support", "offline", "Gateway не знает этого агента"),
  ];
}

const all = computed(() => demo.value ? demoAgents.value : store.data?.agents ?? []);
const scopes = computed(() => {
  const teams = new Map<string, string>(), departments = new Map<string, string>();
  for (const agent of all.value) { if (agent.team) teams.set(agent.team.id, agent.team.name); if (agent.department) departments.set(agent.department.id, agent.department.name); }
  return [{ value: "all", label: t("office.scopeAll") }, ...[...departments].map(([id, name]) => ({ value: `d:${id}`, label: `${t("office.department")}: ${name}` })), ...[...teams].map(([id, name]) => ({ value: `t:${id}`, label: `${t("office.team")}: ${name}` }))];
});
const inScope = computed(() => all.value.filter((agent) => scope.value === "all" || (scope.value.startsWith("t:") ? agent.team?.id === scope.value.slice(2) : agent.department?.id === scope.value.slice(2))));
const shown = computed(() => inScope.value.slice(0, CAPACITY));
const current = computed(() => shown.value.find((agent) => agent.agentId === selected.value) ?? null);
const counts = computed(() => {
  const c = { working: 0, idle: 0, waiting: 0, problems: 0 };
  for (const agent of shown.value) {
    if (agent.state === "working") c.working++;
    else if (agent.state === "idle" || agent.state === "queued") c.idle++;
    else if (agent.state === "waiting_for_agent" || agent.state === "waiting_for_owner") c.waiting++;
    else c.problems++;
  }
  return c;
});
/** The label above a character: the confirmed action when there is one, else the state. */
function labelOf(agent: AgentActivityDto): string {
  if (agent.state === "working") return agent.action && te(`office.actions.${actionKey(agent.action)}`) ? t(`office.actions.${actionKey(agent.action)}`) : t("office.actions.task");
  return t(`office.short.${agent.state}`);
}
function actionKey(tool: string): string {
  if (/^(read|grep|glob|ls|cat|memory_search|memory_get)$/i.test(tool)) return "read";
  if (/^(write|edit|apply_patch|create_file)$/i.test(tool)) return "write";
  if (/^(exec|bash|shell|process)$/i.test(tool)) return "exec";
  if (/^(web_search|web_fetch|browser)/i.test(tool)) return "web";
  if (/^clawdesk_request_/i.test(tool)) return "request";
  if (/^clawdesk_task_report$/i.test(tool)) return "report";
  return "tool";
}
const labels = computed(() => Object.fromEntries(shown.value.map((agent) => [agent.agentId, labelOf(agent)])));
const tagType = (state: AgentActivityState) => ({ working: "info", idle: "default", queued: "default", waiting_for_agent: "warning", waiting_for_owner: "warning", blocked: "warning", error: "error", offline: "error", unknown: "default" } as const)[state];

watch(motion, (value) => { try { localStorage.setItem("clawdesk.office.motion", value ? "on" : "off"); } catch { /* storage may be unavailable */ } });
watch(zoom, (value) => { try { localStorage.setItem("clawdesk.office.zoom", String(value)); } catch { /* storage may be unavailable */ } });
watch(scope, (value) => { try { localStorage.setItem("clawdesk.office.scope", value); } catch { /* storage may be unavailable */ } });
// A remembered team or department that is not here (deleted, or the demo is on): show everyone, not a raw ID.
watch([scopes, all], () => { if (all.value.length && !scopes.value.some((option) => option.value === scope.value)) scope.value = "all"; }, { immediate: true });
watch(demo, (value) => {
  clearInterval(demoTimer);
  if (!value) return;
  let step = 0;
  demoAgents.value = makeDemo(step);
  demoTimer = setInterval(() => { demoAgents.value = makeDemo(++step); }, 4_000);
});
onMounted(() => { leave = store.use(); });
onBeforeUnmount(() => { leave?.(); clearInterval(demoTimer); });
</script>

<template>
  <div>
    <page-header
      :title="t('office.title')"
      :breadcrumbs="[
        { label: t('company.title'), to: '/company' },
        { label: t('activity.title'), to: '/company/activity' },
        { label: t('office.title') },
      ]"
      :back-to="'/company/activity'"
      :back-label="t('activity.title')"
    >
      <n-space>
        <n-button key="list" @click="router.push('/company/activity')">{{ t('office.toList') }}</n-button>
      </n-space>
    </page-header>
    <n-alert v-if="demo" type="warning" class="block" :title="t('office.demoTitle')">{{ t('office.demo') }}</n-alert>
    <n-alert v-else-if="store.data && !store.data.gatewayConnected" type="warning" class="block">{{ t('activity.noGateway') }}</n-alert>

    <n-space class="block" align="center" wrap>
      <n-tag type="info">{{ t('office.counts.working', { n: counts.working }) }}</n-tag>
      <n-tag>{{ t('office.counts.idle', { n: counts.idle }) }}</n-tag>
      <n-tag type="warning">{{ t('office.counts.waiting', { n: counts.waiting }) }}</n-tag>
      <n-tag type="error">{{ t('office.counts.problems', { n: counts.problems }) }}</n-tag>
    </n-space>
    <n-space class="block" align="center" wrap>
      <n-select v-model:value="scope" :options="scopes" style="min-width: 220px" :aria-label="t('office.scope')" />
      <n-space align="center" :size="6"><n-switch v-model:value="motion" :aria-label="t('office.motion')" /><span>{{ t('office.motion') }}</span></n-space>
      <n-space align="center" :size="6"><n-switch v-model:value="demo" :aria-label="t('office.demoSwitch')" /><span>{{ t('office.demoSwitch') }}</span></n-space>
      <n-button size="small" :aria-label="t('office.zoomOut')" :disabled="zoom <= 1" @click="zoom = Math.max(1, zoom - 0.5)">−</n-button>
      <n-button size="small" :aria-label="t('office.zoomIn')" :disabled="zoom >= 4" @click="zoom = Math.min(4, zoom + 0.5)">+</n-button>
    </n-space>
    <n-alert v-if="inScope.length > CAPACITY" type="info" class="block">{{ t('office.tooMany', { n: inScope.length, max: CAPACITY }) }}</n-alert>

    <n-alert v-if="failed" type="error" class="block">{{ t('office.failed') }} <n-button text type="primary" @click="router.push('/company/activity')">{{ t('office.toList') }}</n-button></n-alert>
    <template v-else-if="!opened">
      <n-alert type="info" class="block">{{ t('office.narrow') }}</n-alert>
      <n-space class="block"><n-button type="primary" @click="opened = true">{{ t('office.open') }}</n-button><n-button @click="router.push('/company/activity')">{{ t('office.toList') }}</n-button></n-space>
    </template>
    <div v-else-if="!shown.length" class="block"><n-alert type="info">{{ t('office.empty') }}</n-alert></div>
    <div v-else class="layout block">
      <div class="stage">
        <office-scene :agents="shown" :selected="selected" :motion="motion" :zoom="zoom" :labels="labels" @select="(id) => (selected = id)" @failed="failed = true" />
        <p class="meta">{{ t('office.hint') }}</p>
      </div>
      <div class="side">
        <n-card v-if="current" size="small" :title="current.name">
          <template #header-extra><n-button text :aria-label="t('office.close')" @click="selected = null">×</n-button></template>
          <p class="meta">{{ current.position ?? t(`activity.roles.${current.role}`) }}<template v-if="current.team"> · {{ current.team.name }}</template><template v-if="current.department"> · {{ current.department.name }}</template></p>
          <p><n-tag size="small" :type="tagType(current.state)">{{ t(`activity.state.${current.state}`) }}</n-tag><template v-if="current.runs > 1"> ×{{ current.runs }}</template></p>
          <p>{{ current.detail }}</p>
          <p v-if="current.action" class="meta">{{ t('activity.action', { tool: current.action }) }}</p>
          <p v-if="current.task" class="meta">{{ t('office.task') }}: {{ current.task.code }} «{{ current.task.title }}»</p>
          <p v-if="current.request" class="meta">{{ t('office.request') }}: {{ current.request.code }} → {{ current.request.addressee }}</p>
          <p v-if="current.inbox" class="meta">{{ t('activity.inbox', { n: current.inbox }) }}</p>
          <n-space v-if="!demo">
            <n-button size="small" @click="router.push(`/chat/${current.agentId}`)">{{ t('office.chat') }}</n-button>
            <n-button v-if="current.task" size="small" @click="router.push('/company/work-items')">{{ t('workItems.title') }}</n-button>
            <n-button v-if="current.request || current.inbox" size="small" @click="router.push('/company/requests')">{{ t('requests.title') }}</n-button>
          </n-space>
        </n-card>
        <nav :aria-label="t('office.people')" class="people">
          <button v-for="agent in shown" :key="agent.agentId" type="button" class="person" :class="{ active: agent.agentId === selected }" @click="selected = agent.agentId">
            <span>{{ agent.name }}</span>
            <span class="meta">{{ labels[agent.agentId] }}</span>
          </button>
        </nav>
      </div>
    </div>
    <p class="meta block">{{ t('office.limits') }}</p>
  </div>
</template>

<style scoped>
.block { margin-top: 12px; }
.meta { opacity: 0.75; font-size: 0.9em; overflow-wrap: anywhere; }
.layout { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.stage { flex: 1 1 480px; min-width: 0; overflow: auto; }
.side { flex: 0 1 280px; display: flex; flex-direction: column; gap: 12px; min-width: 220px; }
.people { display: flex; flex-direction: column; gap: 4px; }
.person { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.person.active, .person:focus-visible { border-color: #ffd84a; outline: none; }
</style>
