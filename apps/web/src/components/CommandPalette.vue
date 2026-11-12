<script setup lang="ts">
// Command palette (Ctrl+K / ⌘K): jump to a section, an agent's chat or a saved material, or run a quick
// action, without the menu. Agents and materials are read when the palette opens; if that fails the
// sections and actions still work. Arrow keys move, Enter opens, Esc closes.
import type { AgentListItemDto, LibraryHitDto } from "@clawdesk/shared";
import { Bot, CornerDownLeft, FileText, LayoutGrid, Search, Sparkles } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter, type RouteLocationRaw } from "vue-router";
import { api } from "../api/client";
import { palettePages } from "../page-labels";
import { useSpaceStore } from "../stores/space";
import { themeMode, toggleTheme } from "../theme";

type Item = { id: string; group: "sections" | "agents" | "materials" | "actions"; label: string; hint?: string; glyph?: string; run: () => void };

const { t } = useI18n();
const router = useRouter();
const space = useSpaceStore();
const open = ref(false);
const query = ref("");
const active = ref(0);
const field = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const agents = ref<AgentListItemDto[]>([]);
const materials = ref<LibraryHitDto[]>([]);
const icons: Record<Item["group"], Component> = { sections: LayoutGrid, agents: Bot, materials: FileText, actions: Sparkles };

function go(to: RouteLocationRaw): void {
  close();
  void router.push(to);
}

const items = computed<Item[]>(() => {
  const personal = space.mode === "personal";
  return [
    ...palettePages(space.mode).map(([path, key]) => ({ id: `page:${path}`, group: "sections" as const, label: t(key), run: () => go(path) })),
    ...agents.value.map((agent) => ({
      id: `agent:${agent.id}`, group: "agents" as const, glyph: agent.emoji ?? (agent.role === "main" ? "🧭" : "🤖"),
      label: agent.role === "main" && agent.name === agent.id ? t("agents.main") : agent.name, hint: t("palette.chatWith"),
      run: () => go(agent.role === "main" ? "/chat" : `/chat/${agent.id}`),
    })),
    ...(personal ? materials.value.map((material) => ({
      id: `material:${material.id}`, group: "materials" as const, glyph: material.kind === "video" ? "🎬" : "📄",
      label: material.title, hint: t(`library.kind.${material.kind}`), run: () => go({ name: "library", query: { material: material.id } }),
    })) : []),
    { id: "action:theme", group: "actions" as const, label: themeMode.value === "dark" ? t("shell.light") : t("shell.dark"), run: () => { toggleTheme(); close(); } },
    ...(personal ? [{ id: "action:reminder", group: "actions" as const, label: t("today.newReminder"), run: () => go({ path: "/today", hash: "#reminder-text" }) }] : []),
    { id: "action:agent", group: "actions" as const, label: t("agents.create"), run: () => go("/agents/new") },
  ];
});

// Every typed word has to be in the label; sections first, then the rest in their groups.
const found = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean);
  // Nothing typed: the latest five materials are enough; typing searches all that were read.
  let shownMaterials = 0;
  if (!words.length) return items.value.filter((item) => item.group !== "materials" || shownMaterials++ < 5);
  return items.value.filter((item) => words.every((word) => `${item.label} ${item.hint ?? ""}`.toLowerCase().includes(word)));
});
const groups = computed(() => (["sections", "agents", "materials", "actions"] as const)
  .map((group) => ({ group, items: found.value.filter((item) => item.group === group) }))
  .filter((entry) => entry.items.length));
const flat = computed(() => groups.value.flatMap((entry) => entry.items));

watch(query, () => { active.value = 0; });
watch(active, () => void nextTick(() => list.value?.querySelector(".row.active")?.scrollIntoView({ block: "nearest" })));

function show(): void {
  open.value = true;
  query.value = "";
  active.value = 0;
  void nextTick(() => field.value?.focus());
  // Fresh names each time it opens; a failed read leaves the sections and actions.
  void api.agents().then((result) => { agents.value = result.agents; }).catch(() => undefined);
  if (space.mode === "personal") void api.library.page({}).then((page) => { materials.value = page.items; }).catch(() => undefined);
}
function close(): void { open.value = false; }

function onKey(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (open.value) close(); else show();
    return;
  }
  if (!open.value) return;
  if (event.key === "Escape") { event.preventDefault(); close(); }
  else if (event.key === "ArrowDown") { event.preventDefault(); active.value = flat.value.length ? (active.value + 1) % flat.value.length : 0; }
  else if (event.key === "ArrowUp") { event.preventDefault(); active.value = flat.value.length ? (active.value - 1 + flat.value.length) % flat.value.length : 0; }
  else if (event.key === "Enter") { event.preventDefault(); flat.value[active.value]?.run(); }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
defineExpose({ show });
</script>

<template>
  <teleport to="body">
    <transition name="palette">
      <div v-if="open" class="veil" @pointerdown.self="close">
        <div class="palette" role="dialog" aria-modal="true" :aria-label="t('palette.title')">
          <div class="search">
            <search :size="18" />
            <input
              ref="field"
              v-model="query"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              :aria-activedescendant="flat[active] ? `palette-${flat[active]!.id}` : undefined"
              :placeholder="t('palette.placeholder')"
              :aria-label="t('palette.placeholder')"
              maxlength="80"
              autocomplete="off"
              spellcheck="false"
            />
            <kbd>Esc</kbd>
          </div>
          <div id="palette-list" ref="list" class="results" role="listbox">
            <p v-if="!flat.length" class="none">{{ t("palette.empty") }}</p>
            <section v-for="entry in groups" :key="entry.group">
              <h3>{{ t(`palette.groups.${entry.group}`) }}</h3>
              <button
                v-for="item in entry.items"
                :id="`palette-${item.id}`"
                :key="item.id"
                type="button"
                role="option"
                class="row"
                :class="{ active: flat[active]?.id === item.id }"
                :aria-selected="flat[active]?.id === item.id"
                @pointermove="active = flat.indexOf(item)"
                @click="item.run()"
              >
                <span class="glyph"><template v-if="item.glyph">{{ item.glyph }}</template><component :is="icons[item.group]" v-else :size="15" :stroke-width="1.75" /></span>
                <span class="label">{{ item.label }}</span>
                <span v-if="item.hint" class="hint">{{ item.hint }}</span>
                <corner-down-left :size="14" class="enter" />
              </button>
            </section>
          </div>
          <footer>{{ t("palette.keys") }}</footer>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<style scoped>
.veil {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 12vh 16px 16px;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  backdrop-filter: blur(10px);
}
.palette {
  width: min(580px, 100%);
  max-height: min(560px, 76vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 24px;
  background: var(--surface-solid);
  border: 1px solid var(--border);
  box-shadow: 0 30px 80px -20px rgba(16, 24, 40, 0.35);
  color: var(--text);
  font-family: "Inter Variable", Inter, system-ui, sans-serif;
}
.search {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 16px;
}
.search input::placeholder {
  color: var(--muted);
}
kbd {
  padding: 2px 7px;
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--text-2);
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
}
.results {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px 10px;
}
h3 {
  margin: 10px 10px 4px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.row {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 13px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease;
}
.row.active {
  background: var(--accent-soft);
}
.glyph {
  width: 30px;
  height: 30px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 15px;
  transition: transform 0.2s var(--ease-spring);
}
.row.active .glyph {
  background: var(--surface);
  transform: scale(1.08);
}
.label {
  flex: 1;
  min-width: 0;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hint {
  flex: none;
  font-size: 12px;
  color: var(--muted);
}
.enter {
  flex: none;
  color: var(--accent);
  opacity: 0;
}
.row.active .enter {
  opacity: 1;
}
.none {
  margin: 28px 0;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
}
footer {
  padding: 9px 18px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted);
}
.palette-enter-active,
.palette-leave-active {
  transition: opacity 0.18s ease;
}
.palette-enter-active .palette,
.palette-leave-active .palette {
  transition: transform 0.28s var(--ease-spring);
}
.palette-enter-from,
.palette-leave-to {
  opacity: 0;
}
.palette-enter-from .palette,
.palette-leave-to .palette {
  transform: translateY(-12px) scale(0.96);
}
</style>
