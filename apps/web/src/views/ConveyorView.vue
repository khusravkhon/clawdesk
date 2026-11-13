<script setup lang="ts">
// The Conveyor: one live map of the install — the assistant in the centre, agents around it, and on each
// of them its materials, schedules, reminders and tasks. Built from the same data the other pages show
// (conveyor.ts); nothing here starts a model run. The map can be dragged, zoomed and searched; a node opens
// a card with its facts and a way to its page. The demo switch shows sample data and says so.
import { ArrowUpRight, Maximize, Minus, Plus, RefreshCw, Search, X } from "@lucide/vue";
import { NAlert, NButton, NInput, NSwitch } from "naive-ui";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import ConveyorCore from "../components/ConveyorCore.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { buildFlow, demoSources, FLOW_KINDS, layoutFlow, sizeOf, type FlowKind, type FlowNode, type FlowSources } from "../conveyor";
import { formatRelative, intlLocale } from "../format";
import { useSpaceStore } from "../stores/space";
import { FALLBACK_REFRESH_MS, onChanges } from "../changes";

type ItemKind = Exclude<FlowKind, "core">;
type Part = ItemKind | "states";

const { t, locale } = useI18n();
const space = useSpaceStore();
const personal = computed(() => space.mode === "personal");

// --- data
const sources = ref<FlowSources | null>(null);
const failedParts = ref<Part[]>([]);
const offline = ref(false);
const loading = ref(false);
const loadedAt = ref<number | null>(null);
const demo = ref(false);
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
  if (stopped || document.hidden || loading.value) return;
  loading.value = true;
  const [agents, states, library, schedules, reminders, tasks] = await Promise.allSettled([
    api.agents(),
    api.dashboard("7d"),
    api.library.page({}),
    api.schedules.list(),
    personal.value ? api.reminders.list() : Promise.resolve(null),
    personal.value ? Promise.resolve(null) : api.company.workItems(),
  ]);
  loading.value = false;
  if (stopped) return;
  const value = <T,>(result: PromiseSettledResult<T>): T | null => (result.status === "fulfilled" ? result.value : null);
  const failed: Part[] = [];
  if (agents.status === "rejected") failed.push("agent");
  if (states.status === "rejected" || (states.status === "fulfilled" && !states.value.agents)) failed.push("states");
  if (library.status === "rejected") failed.push("material");
  if (schedules.status === "rejected") failed.push("schedule");
  if (reminders.status === "rejected") failed.push("reminder");
  if (tasks.status === "rejected") failed.push("task");
  failedParts.value = failed;
  offline.value = agents.status === "rejected" && library.status === "rejected" && schedules.status === "rejected";
  sources.value = {
    agents: value(agents)?.agents ?? null,
    states: value(states)?.agents ?? null,
    materials: value(library)?.items ?? null,
    moreMaterials: !!value(library)?.next,
    schedules: value(schedules)?.schedules ?? null,
    reminders: value(reminders)?.reminders ?? null,
    tasks: value(tasks)?.items ?? null,
  };
  loadedAt.value = Date.now();
}
const visibilityChanged = () => { if (!document.hidden) void load(); };

// --- the map
const nodes = ref<FlowNode[]>([]);
const counts = ref<Record<ItemKind, number>>({ agent: 0, material: 0, schedule: 0, reminder: 0, task: 0 });
const hiddenKinds = reactive(new Set<ItemKind>());
const moved = new Map<string, { x: number; y: number }>();
const query = ref("");
const selectedId = ref<string | null>(null);
const hoverId = ref<string | null>(null);
let signature = "";

function rebuild(): void {
  const source = demo.value ? demoSources() : sources.value;
  if (!source) { nodes.value = []; return; }
  const all = buildFlow(source, {
    t: (key, named) => (named ? t(key, named) : t(key)),
    relative: (at) => formatRelative(at, locale.value),
    date: (at) => new Intl.DateTimeFormat(intlLocale(locale.value), { dateStyle: "medium", timeStyle: "short" }).format(at),
    personal: personal.value,
  });
  const count: Record<ItemKind, number> = { agent: 0, material: 0, schedule: 0, reminder: 0, task: 0 };
  for (const node of all) if (node.kind !== "core") count[node.kind]++;
  counts.value = count;
  const shown = all.filter((node) => node.kind === "core" || !hiddenKinds.has(node.kind));
  // With agents hidden, their things hang on the centre.
  const ids = new Set(shown.map((node) => node.id));
  for (const node of shown) if (node.parent && !ids.has(node.parent)) node.parent = "core";
  layoutFlow(shown);
  for (const node of shown) { const place = moved.get(node.id); if (place) { node.x = place.x; node.y = place.y; } }
  nodes.value = shown;
  if (selectedId.value && !ids.has(selectedId.value)) selectedId.value = null;
  const next = shown.map((node) => node.id).join("|");
  if (next !== signature) { signature = next; void nextTick(() => fit()); }
}
watch([sources, demo, locale, () => [...hiddenKinds].join()], rebuild);
watch(demo, () => { moved.clear(); selectedId.value = null; });

function toggle(kind: ItemKind): void {
  if (hiddenKinds.has(kind)) hiddenKinds.delete(kind);
  else hiddenKinds.add(kind);
}
const kinds = computed(() => FLOW_KINDS.filter((kind) => counts.value[kind] > 0 || (kind === "task" ? !personal.value : kind === "reminder" ? personal.value : true)));

const byId = computed(() => new Map(nodes.value.map((node) => [node.id, node])));
const selected = computed(() => (selectedId.value ? byId.value.get(selectedId.value) ?? null : null));
const round = (value: number) => Math.round(value * 10) / 10;
const edges = computed(() => nodes.value.flatMap((node) => {
  const parent = node.parent ? byId.value.get(node.parent) : undefined;
  if (!parent) return [];
  // From the item towards its owner, slightly bent: what moves on the line moves to the centre.
  const dx = parent.x - node.x, dy = parent.y - node.y;
  const cx = (node.x + parent.x) / 2 - dy * 0.1, cy = (node.y + parent.y) / 2 + dx * 0.1;
  return [{ id: node.id, parent: parent.id, live: node.state === "live", d: `M${round(node.x)} ${round(node.y)} Q${round(cx)} ${round(cy)} ${round(parent.x)} ${round(parent.y)}` }];
}));

// Pointing at a node (or choosing it) lights its line to the centre and its own things; the rest steps back.
const related = computed(() => {
  const id = hoverId.value ?? selectedId.value;
  if (!id || !byId.value.has(id)) return null;
  const set = new Set([id]);
  for (let node = byId.value.get(id); node?.parent; node = byId.value.get(node.parent)) set.add(node.parent);
  for (const node of nodes.value) if (node.parent === id) set.add(node.id);
  return set;
});
const matches = computed(() => {
  const text = query.value.trim().toLowerCase();
  if (!text) return null;
  return new Set(nodes.value.filter((node) => `${node.title} ${node.meta}`.toLowerCase().includes(text)).map((node) => node.id));
});
const dimmed = (id: string) => (matches.value ? !matches.value.has(id) : !!related.value && !related.value.has(id));
const edgeLit = (edge: { id: string; parent: string }) => !!related.value && related.value.has(edge.id) && related.value.has(edge.parent);

const liveCount = computed(() => nodes.value.filter((node) => node.state === "live").length);
const attention = computed(() => nodes.value.filter((node) => node.state === "waiting" || node.state === "error").length);
const updated = computed(() => (loadedAt.value ? new Intl.DateTimeFormat(intlLocale(locale.value), { timeStyle: "short" }).format(loadedAt.value) : null));

// --- view: drag the map, drag a node, zoom
const stage = ref<HTMLElement | null>(null);
const view = reactive({ x: 0, y: 0, k: 1 });
const draggingId = ref<string | null>(null);
const panning = ref(false);
const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
let drag: { node: FlowNode | null; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function fit(): void {
  const el = stage.value;
  if (!el || !nodes.value.length) return;
  const rect = el.getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes.value) {
    const size = sizeOf(node.kind);
    minX = Math.min(minX, node.x - size.w / 2); maxX = Math.max(maxX, node.x + size.w / 2);
    minY = Math.min(minY, node.y - size.h / 2); maxY = Math.max(maxY, node.y + size.h / 2);
  }
  const pad = rect.width < 640 ? 16 : 40;
  view.k = clamp(Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2 - 44) / (maxY - minY)), 0.25, 1.1);
  view.x = rect.width / 2 - ((minX + maxX) / 2) * view.k;
  view.y = (rect.height - 44) / 2 - ((minY + maxY) / 2) * view.k;
}
function zoomAt(factor: number, cx: number, cy: number): void {
  const k = clamp(view.k * factor, 0.25, 2.2), ratio = k / view.k;
  view.x = cx - (cx - view.x) * ratio; view.y = cy - (cy - view.y) * ratio; view.k = k;
}
function zoomBy(factor: number): void {
  const rect = stage.value?.getBoundingClientRect();
  if (rect) zoomAt(factor, rect.width / 2, rect.height / 2);
}
function wheel(event: WheelEvent): void {
  const rect = stage.value!.getBoundingClientRect();
  zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
}
function down(event: PointerEvent): void {
  const target = event.target as HTMLElement;
  if (event.button !== 0 || target.closest("[data-nopan]")) return;
  const id = target.closest<HTMLElement>("[data-node]")?.dataset.node;
  const node = id ? byId.value.get(id) ?? null : null;
  drag = { node, sx: event.clientX, sy: event.clientY, ox: node ? node.x : view.x, oy: node ? node.y : view.y, moved: false };
  stage.value?.setPointerCapture(event.pointerId);
}
function move(event: PointerEvent): void {
  if (!drag) return;
  const dx = event.clientX - drag.sx, dy = event.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  if (drag.node && drag.node.kind !== "core") {
    draggingId.value = drag.node.id;
    drag.node.x = drag.ox + dx / view.k; drag.node.y = drag.oy + dy / view.k;
    moved.set(drag.node.id, { x: drag.node.x, y: drag.node.y });
  } else if (!drag.node) {
    panning.value = true;
    view.x = drag.ox + dx; view.y = drag.oy + dy;
  }
}
function up(): void {
  if (!drag) return;
  const { node, moved: wasMoved } = drag;
  drag = null; draggingId.value = null; panning.value = false;
  // A press without a drag chooses the node; on empty space it lets go of the choice.
  if (!wasMoved) selectedId.value = node && node.id !== selectedId.value ? node.id : null;
}
function choose(id: string): void { selectedId.value = selectedId.value === id ? null : id; }

let leaveChanges: (() => void) | undefined;
onMounted(() => {
  void load();
  leaveChanges = onChanges(["agents", "schedules", "reminders", "library", "workItems"], () => void load());
  timer = setInterval(() => void load(), FALLBACK_REFRESH_MS);
  document.addEventListener("visibilitychange", visibilityChanged);
});
onBeforeUnmount(() => { stopped = true; clearInterval(timer); leaveChanges?.(); document.removeEventListener("visibilitychange", visibilityChanged); });
</script>

<template>
  <div class="conveyor">
    <page-header :title="t('conveyor.title')" :subtitle="t('conveyor.subtitle')">
      <n-button size="small" secondary :loading="loading" @click="load">
        <template #icon><refresh-cw :size="14" /></template>
        {{ t("status.refresh") }}
      </n-button>
    </page-header>

    <n-alert v-if="demo" type="warning" class="note" :title="t('conveyor.demoTitle')">{{ t("conveyor.demoNote") }}</n-alert>
    <n-alert v-else-if="offline" type="warning" class="note">
      {{ t("conveyor.offline") }}
      <n-button size="tiny" type="primary" class="note-action" @click="demo = true">{{ t("conveyor.demoOn") }}</n-button>
    </n-alert>
    <n-alert v-else-if="failedParts.length" type="info" class="note">
      {{ t("conveyor.failed", { parts: failedParts.map((part) => t(`conveyor.parts.${part}`)).join(", ") }) }}
    </n-alert>

    <div class="toolbar">
      <div class="chips" role="group" :aria-label="t('conveyor.filter')">
        <button v-for="kind in kinds" :key="kind" type="button" class="chip" :class="{ on: !hiddenKinds.has(kind) }" :aria-pressed="!hiddenKinds.has(kind)" @click="toggle(kind)">
          {{ t(`conveyor.kinds.${kind}`) }}<span class="chip-count">{{ counts[kind] }}</span>
        </button>
      </div>
      <n-input v-model:value="query" round clearable size="small" class="search" :placeholder="t('conveyor.search')" :aria-label="t('conveyor.search')">
        <template #prefix><search :size="14" /></template>
      </n-input>
      <label class="demo"><n-switch v-model:value="demo" size="small" :aria-label="t('conveyor.demo')" />{{ t("conveyor.demo") }}</label>
    </div>

    <div
      ref="stage"
      class="stage"
      :class="{ panning }"
      :style="{ backgroundSize: `${26 * view.k}px ${26 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
      @wheel.prevent="wheel"
    >
      <div class="world" :class="{ smooth: !panning && !draggingId }" :style="{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }">
        <svg class="edges" width="1" height="1" aria-hidden="true">
          <g v-for="edge in edges" :key="edge.id" :class="{ live: edge.live, lit: edgeLit(edge), dim: dimmed(edge.id) }">
            <path :d="edge.d" class="edge" />
            <circle v-if="edge.live && !reduced" r="4" class="packet">
              <animateMotion :path="edge.d" dur="2.4s" repeatCount="indefinite" />
            </circle>
          </g>
        </svg>

        <div
          v-for="(node, index) in nodes"
          :key="node.id"
          class="node"
          :class="[node.kind, `is-${node.state}`, { dim: dimmed(node.id), selected: node.id === selectedId, hit: matches?.has(node.id), moving: node.id === draggingId }]"
          :data-node="node.id"
          :style="{ left: `${node.x}px`, top: `${node.y}px` }"
          role="button"
          tabindex="0"
          :aria-label="`${t(`conveyor.kind.${node.kind}`)}: ${node.title}. ${t(`conveyor.state.${node.state}`)}`"
          :aria-pressed="node.id === selectedId"
          @pointerenter="hoverId = node.id"
          @pointerleave="hoverId = null"
          @keydown.enter.prevent="choose(node.id)"
          @keydown.space.prevent="choose(node.id)"
        >
          <div class="node-card" :style="{ animationDelay: `${Math.min(index, 30) * 26}ms` }">
            <template v-if="node.kind === 'core'">
              <div class="halo" />
              <conveyor-core :live="node.state === 'live'" :size="150" />
              <div class="core-name">{{ node.emoji ?? "🧭" }} {{ node.title }}</div>
              <div class="core-state"><span v-if="node.state === 'live'" class="live-dot" />{{ t(`conveyor.state.${node.state}`) }}</div>
            </template>
            <template v-else>
              <span class="glyph">{{ node.emoji ?? "🤖" }}</span>
              <span class="text">
                <span class="title">{{ node.title }}</span>
                <span class="meta">{{ node.meta }}</span>
              </span>
              <span v-if="node.state !== 'ok'" class="state-dot" :title="t(`conveyor.state.${node.state}`)" />
            </template>
          </div>
        </div>
      </div>

      <p v-if="!demo && !offline && sources && nodes.length <= 1" class="empty" data-nopan>{{ t("conveyor.empty") }}</p>

      <div class="controls" data-nopan>
        <button type="button" class="pressable" :aria-label="t('conveyor.zoomIn')" :title="t('conveyor.zoomIn')" @click="zoomBy(1.25)"><plus :size="16" /></button>
        <button type="button" class="pressable" :aria-label="t('conveyor.zoomOut')" :title="t('conveyor.zoomOut')" @click="zoomBy(0.8)"><minus :size="16" /></button>
        <button type="button" class="pressable" :aria-label="t('conveyor.fit')" :title="t('conveyor.fit')" @click="fit"><maximize :size="15" /></button>
      </div>

      <div class="status" data-nopan>
        <span v-if="liveCount" class="status-item"><span class="live-dot" />{{ t("conveyor.status.live", { n: liveCount }) }}</span>
        <span v-if="attention" class="status-item warn">{{ t("conveyor.status.attention", { n: attention }) }}</span>
        <span class="status-item">{{ t("conveyor.status.nodes", { n: Math.max(0, nodes.length - 1) }) }}</span>
        <span v-if="updated && !demo" class="status-item quiet">{{ t("conveyor.status.updated", { time: updated }) }}</span>
        <span class="status-item quiet hint">{{ t("conveyor.hint") }}</span>
      </div>

      <transition name="panel">
        <aside v-if="selected" :key="selected.id" class="detail" data-nopan>
          <header>
            <span class="kind-chip">{{ t(`conveyor.kind.${selected.kind}`) }}</span>
            <button type="button" class="close pressable" :aria-label="t('conveyor.close')" @click="selectedId = null"><x :size="15" /></button>
          </header>
          <h3>{{ selected.emoji }} {{ selected.title }}</h3>
          <span class="state-pill" :class="`is-${selected.state}`"><span class="state-dot" />{{ t(`conveyor.state.${selected.state}`) }}</span>
          <dl v-if="selected.details.length">
            <template v-for="row in selected.details" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </template>
          </dl>
          <router-link v-if="selected.to && !demo" :to="selected.to" class="pill-link strong open">
            {{ t(selected.kind === "core" || selected.kind === "agent" ? "conveyor.chat" : "conveyor.open") }}
            <arrow-up-right :size="15" />
          </router-link>
        </aside>
      </transition>
    </div>
  </div>
</template>

<style scoped>
.note {
  margin-bottom: 14px;
}
.note-action {
  margin-left: 8px;
}
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 14px;
  margin-bottom: 14px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1 1 auto;
}
.search {
  flex: 0 1 240px;
  min-width: 160px;
}
.search {
  --n-color: var(--surface) !important;
}
.demo {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}

/* --- the stage */
.stage {
  position: relative;
  height: calc(100dvh - 232px);
  min-height: 460px;
  overflow: hidden;
  border-radius: 24px;
  background-color: var(--surface);
  background-image: radial-gradient(circle, var(--border-hover) 1px, transparent 1.4px);
  box-shadow: var(--card-shadow);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.stage.panning {
  cursor: grabbing;
}
.world {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.world.smooth {
  transition: transform 0.45s var(--ease-out);
}
.edges {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
  pointer-events: none;
}
.edge {
  fill: none;
  stroke: var(--border-hover);
  stroke-width: 1.5;
  transition:
    stroke 0.25s ease,
    opacity 0.25s ease,
    stroke-width 0.25s ease;
}
.live .edge {
  stroke: var(--accent-bright);
  stroke-dasharray: 6 8;
  animation: flow 0.9s linear infinite;
}
.lit .edge {
  stroke: var(--text);
  stroke-width: 2;
}
.live.lit .edge {
  stroke: var(--accent-bright);
}
.edges .dim {
  opacity: 0.25;
}
.packet {
  fill: var(--accent-bright);
  filter: drop-shadow(0 0 4px var(--accent-bright));
}
@keyframes flow {
  to {
    stroke-dashoffset: -14;
  }
}

/* --- nodes */
.node {
  position: absolute;
  transform: translate(-50%, -50%);
  cursor: pointer;
  outline: none;
  transition:
    left 0.5s var(--ease-out),
    top 0.5s var(--ease-out),
    opacity 0.25s ease;
}
.node.moving {
  transition: opacity 0.25s ease;
  z-index: 5;
  cursor: grabbing;
}
.node.dim {
  opacity: 0.28;
}
.node:hover,
.node.selected {
  z-index: 4;
}
.node-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 188px;
  height: 54px;
  padding: 0 12px 0 9px;
  border-radius: 18px;
  background: var(--surface-solid);
  border: 1px solid var(--border);
  box-shadow: var(--pop-shadow);
  animation: pop-in 0.5s var(--ease-spring) backwards;
  transition:
    transform 0.22s var(--ease-spring),
    box-shadow 0.22s ease,
    border-color 0.22s ease;
}
.node:hover .node-card {
  transform: translateY(-2px) scale(1.04);
  box-shadow: var(--card-shadow-hover);
}
.node:active .node-card {
  transform: scale(0.97);
}
.node.selected .node-card,
.node:focus-visible .node-card {
  border-color: var(--accent-bright);
  box-shadow:
    0 0 0 4px var(--accent-soft),
    var(--card-shadow-hover);
}
.node.hit .node-card {
  border-color: var(--accent-bright);
}
.glyph {
  width: 36px;
  height: 36px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 12px;
  font-size: 18px;
  background: var(--tint, var(--surface-2));
}
.material {
  --tint: rgba(59, 130, 246, 0.13);
}
.schedule {
  --tint: rgba(245, 158, 11, 0.16);
}
.reminder {
  --tint: rgba(236, 72, 153, 0.13);
}
.task {
  --tint: var(--accent-soft);
}
.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  line-height: 1.25;
}
.title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.state-dot {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 50%;
  background: var(--muted);
}
.is-live .state-dot {
  background: var(--accent-bright);
  animation: live-pulse 1.6s ease-out infinite;
}
.is-ok .state-dot {
  background: var(--accent-bright);
}
.is-waiting .state-dot {
  background: var(--warning);
}
.is-error .state-dot {
  background: var(--critical);
}
.is-off .node-card {
  border-style: dashed;
}
.is-off .title {
  color: var(--text-2);
}

/* Agents are the ink cards: the people of the map stand out from their things. */
.agent .node-card {
  width: 196px;
  height: 60px;
  border-radius: 20px;
  background: var(--ink);
  border-color: var(--ink);
  color: var(--ink-text);
}
.agent .glyph {
  background: color-mix(in srgb, var(--ink-text) 14%, transparent);
}
.agent .meta {
  color: color-mix(in srgb, var(--ink-text) 62%, transparent);
}
.agent.is-live .node-card {
  box-shadow:
    0 0 0 3px var(--accent-bright),
    var(--card-shadow-hover);
}

/* The centre: no card, just the globe with its name. */
.core .node-card {
  flex-direction: column;
  gap: 2px;
  width: 210px;
  height: 220px;
  padding: 0;
  background: none;
  border: 0;
  box-shadow: none;
  justify-content: center;
}
.node.core:hover .node-card,
.node.core.selected .node-card,
.node.core:focus-visible .node-card {
  box-shadow: none;
  transform: scale(1.03);
}
.halo {
  position: absolute;
  top: 8px;
  left: 50%;
  width: 170px;
  height: 170px;
  margin-left: -85px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-soft) 0%, transparent 68%);
  transition: transform 0.6s var(--ease-out);
}
.core.is-live .halo {
  animation: breathe 2.4s ease-in-out infinite;
}
.core.selected .halo {
  transform: scale(1.25);
}
@keyframes breathe {
  50% {
    transform: scale(1.22);
  }
}
.core-name {
  position: relative;
  max-width: 200px;
  padding: 5px 14px;
  border-radius: 999px;
  background: var(--ink);
  color: var(--ink-text);
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.core-state {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 5px;
  font-size: 12px;
  color: var(--text-2);
}

/* --- overlays */
.controls {
  position: absolute;
  left: 14px;
  bottom: 58px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border-radius: 14px;
  background: var(--surface-solid);
  border: 1px solid var(--border);
  box-shadow: var(--pop-shadow);
  cursor: default;
}
.controls button,
.close {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.controls button:hover,
.close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.status {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 16px;
  min-height: 34px;
  padding: 4px 14px;
  box-sizing: border-box;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-solid) 82%, transparent);
  backdrop-filter: blur(10px);
  border: 1px solid var(--border);
  font-size: 12.5px;
  cursor: default;
}
.status-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 500;
  white-space: nowrap;
}
.status-item.warn {
  color: var(--warning-text);
}
.status-item.quiet {
  color: var(--muted);
  font-weight: 400;
}
.hint {
  margin-left: auto;
}
.empty {
  position: absolute;
  left: 50%;
  top: 20px;
  transform: translateX(-50%);
  max-width: min(460px, calc(100% - 32px));
  margin: 0;
  padding: 10px 16px;
  border-radius: 14px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 13px;
  text-align: center;
  cursor: default;
}

.detail {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 300px;
  max-height: calc(100% - 76px);
  overflow: auto;
  box-sizing: border-box;
  padding: 16px 18px 18px;
  border-radius: 20px;
  background: var(--surface-solid);
  border: 1px solid var(--border);
  box-shadow: var(--card-shadow-hover);
  cursor: default;
  user-select: text;
}
.detail header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.kind-chip {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.detail h3 {
  margin: 0 0 10px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.state-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 3px 10px 3px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 12px;
  font-weight: 500;
}
.detail dl {
  margin: 14px 0 0;
  display: grid;
  gap: 10px;
}
.detail dt {
  font-size: 11.5px;
  color: var(--muted);
  margin-bottom: 1px;
}
.detail dd {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.open {
  margin-top: 16px;
  width: 100%;
  justify-content: center;
  box-sizing: border-box;
  padding: 9px 14px;
}
.panel-enter-active,
.panel-leave-active {
  transition:
    transform 0.32s var(--ease-spring),
    opacity 0.2s ease;
}
.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translateX(18px) scale(0.96);
}

@media (max-width: 768px) {
  .stage {
    height: calc(100dvh - 300px);
    min-height: 420px;
    border-radius: 20px;
  }
  .detail {
    top: auto;
    left: 10px;
    right: 10px;
    bottom: 56px;
    width: auto;
    max-height: 55%;
  }
  .panel-enter-from,
  .panel-leave-to {
    transform: translateY(18px) scale(0.96);
  }
  .hint {
    display: none;
  }
  .search {
    flex: 1 1 100%;
  }
}
</style>
