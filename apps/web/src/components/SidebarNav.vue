<script setup lang="ts">
// Sidebar body: brand, sections, theme and language. Shared by the desktop sidebar and the phone drawer.
import type { Locale } from "@clawdesk/shared";
import { Activity, Blocks, Bot, ChartColumn, FolderGit2, CalendarClock, CalendarDays, Database, HardDrive, LayoutDashboard, Library, LogOut, MessagesSquare, Settings, ShieldCheck, UserRound, Moon, PanelLeftClose, PanelLeftOpen, Search, Send, Sun, Workflow } from "@lucide/vue";
import { NButton, NMenu, NSelect, NTooltip, type MenuOption } from "naive-ui";
import { computed, h, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import { api } from "../api/client";
import { setLocale, supportedLocales } from "../i18n";
import { useApprovalsStore } from "../stores/approvals";
import { useSpaceStore } from "../stores/space";
import { themeMode, toggleTheme } from "../theme";

const props = defineProps<{ collapsed?: boolean; collapsible?: boolean }>();
const emit = defineEmits<{ toggle: []; navigate: []; search: [] }>();

const { t, locale } = useI18n();
const route = useRoute();
const approvals = useApprovalsStore();
const space = useSpaceStore();

const icon = (c: Component) => () => h(c, { size: 18, strokeWidth: 1.75 });
const link = (to: string, label: string, badge?: () => number) => () =>
  h(RouterLink, { to, onClick: () => emit("navigate"), class: "nav-link" }, {
    default: () => [label, badge && badge() > 0 ? h("span", { class: "nav-badge" }, String(badge())) : null],
  });

const menu = computed<MenuOption[]>(() => [
  { key: "/", label: link("/", t("nav.overview")), icon: icon(LayoutDashboard) },
  { key: "/conveyor", label: link("/conveyor", t("conveyor.title")), icon: icon(Workflow) },
  ...(space.mode === "personal" ? [{ key: "/today", label: link("/today", t("today.title")), icon: icon(CalendarDays) }] : []),
  { key: "/chat", label: link("/chat", t("nav.chat")), icon: icon(MessagesSquare) },
  ...(space.mode === "personal" ? [{ key: "/library", label: link("/library", t("nav.materials")), icon: icon(Library) }] : []),
  { key: "/assistant", label: link("/assistant", t("nav.assistant")), icon: icon(UserRound) },
  ...(space.mode === "personal" ? [
    { key: "/approvals", label: link("/approvals", t("nav.approvals"), () => approvals.count), icon: icon(ShieldCheck) },
    { key: "/settings", label: link("/settings", t("personalSettings.title")), icon: icon(Settings) },
  ] : [
    { key: "/agents", label: link("/agents", t("nav.agents")), icon: icon(Bot) },
    ...(space.space?.mode === "company" ? [
      { key: "/company", label: link("/company", t("company.title")), icon: icon(Blocks) },
      { key: "/teams", label: link("/teams", t("nav.teams")), icon: icon(FolderGit2) },
    ] : []),
    { key: "/schedules", label: link("/schedules", t("nav.schedules")), icon: icon(CalendarClock) },
    { key: "/sources", label: link("/sources", t("nav.sources")), icon: icon(Database) },
    { key: "/skills", label: link("/skills", t("nav.extensions")), icon: icon(Blocks) },
    { key: "/approvals", label: link("/approvals", t("nav.approvals"), () => approvals.count), icon: icon(ShieldCheck) },
    { key: "/telegram", label: link("/telegram", "Telegram"), icon: icon(Send) },
    { key: "/usage", label: link("/usage", t("nav.usage")), icon: icon(ChartColumn) },
    { key: "/status", label: link("/status", t("nav.status")), icon: icon(Activity) },
    { key: "/system", label: link("/system", t("nav.system")), icon: icon(HardDrive) },
  ]),
]);

// Nested pages (e.g. /agents/new) light up their section.
const activeKey = computed(() => {
  if (route.path === "/") return "/";
  return menu.value.map((m) => m.key as string).find((k) => k !== "/" && (route.path === k || route.path.startsWith(k + "/")))
    ?? (space.mode === "personal" ? "/settings" : null);
});

async function logout(): Promise<void> {
  await api.auth.logout().catch(() => undefined);
  // Full reload: nothing of the signed-in panel stays in memory.
  location.assign("/login");
}

const localeOptions = computed(() => supportedLocales.map((value) => ({ value, label: t(`lang.${value}`) })));
const collapsed = computed(() => !!props.collapsed);
</script>

<template>
  <div class="nav">
    <div class="brand" :class="{ collapsed }">
      <div class="logo">C</div>
      <span v-if="!collapsed" class="brand-name">{{ t("app.title") }}</span>
    </div>

    <button type="button" class="find pressable" :class="{ collapsed }" :aria-label="t('palette.title')" :title="collapsed ? t('palette.title') : undefined" @click="emit('search')">
      <search :size="16" />
      <template v-if="!collapsed">
        <span>{{ t("palette.title") }}</span>
        <kbd>Ctrl K</kbd>
      </template>
    </button>

    <n-menu :value="activeKey" :options="menu" :collapsed="collapsed" :collapsed-width="64" :collapsed-icon-size="18" :indent="14" />

    <div class="foot" :class="{ collapsed }">
      <n-select
        v-if="!collapsed"
        :value="locale"
        :options="localeOptions"
        size="small"
        class="lang"
        @update:value="(value: Locale) => setLocale(value)"
      />
      <n-tooltip placement="right">
        <template #trigger>
          <n-button quaternary circle size="small" :aria-label="t('shell.theme')" @click="toggleTheme">
            <component :is="themeMode === 'dark' ? Sun : Moon" :size="16" />
          </n-button>
        </template>
        {{ themeMode === "dark" ? t("shell.light") : t("shell.dark") }}
      </n-tooltip>
      <n-tooltip placement="right">
        <template #trigger>
          <n-button quaternary circle size="small" :aria-label="t('auth.logout')" @click="logout">
            <log-out :size="16" />
          </n-button>
        </template>
        {{ t("auth.logout") }}
      </n-tooltip>
      <n-button v-if="collapsible" quaternary circle size="small" :aria-label="t('shell.collapse')" @click="emit('toggle')">
        <component :is="collapsed ? PanelLeftOpen : PanelLeftClose" :size="16" />
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.nav {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* The scroll area around the menu takes its content's height: without this the footer rides up. */
  min-height: 100dvh;
  padding: 14px 10px;
  box-sizing: border-box;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px 18px;
}
.brand.collapsed {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}
.logo {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 16px;
  color: var(--on-accent);
  background: var(--accent-gradient);
  box-shadow: 0 6px 14px -6px rgba(62, 209, 95, 0.7);
  flex: none;
  transition: transform 0.3s var(--ease-spring);
}
.brand:hover .logo {
  transform: rotate(-8deg) scale(1.06);
}
.brand-name {
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.02em;
}
.find {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 4px 10px;
  height: 38px;
  padding: 0 12px;
  border: 0;
  border-radius: 12px;
  background: var(--surface);
  color: var(--muted);
  font: inherit;
  font-size: 13.5px;
  cursor: pointer;
  box-shadow: var(--pop-shadow);
}
.find:hover {
  color: var(--text);
}
.find.collapsed {
  justify-content: center;
  padding: 0;
}
.find span {
  flex: 1;
  text-align: left;
}
.find kbd {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--surface-2);
  font: inherit;
  font-size: 11px;
}
.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: auto 4px 0;
  padding: 6px;
  border-radius: 16px;
  background: var(--surface);
  box-shadow: var(--pop-shadow);
}
.foot.collapsed {
  flex-direction: column;
}
.lang {
  flex: 1;
  min-width: 0;
}
:deep(.nav-link) {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* The open section is a white pill lifted off the grey canvas. */
:deep(.n-menu-item-content) {
  transition: transform 0.18s var(--ease-spring);
}
:deep(.n-menu-item-content:active) {
  transform: scale(0.97);
}
:deep(.n-menu-item-content::before) {
  transition:
    background-color 0.2s ease,
    box-shadow 0.2s ease;
}
:deep(.n-menu-item-content--selected::before) {
  box-shadow: var(--pop-shadow);
}
:deep(.n-menu-item-content--selected .n-menu-item-content-header) {
  font-weight: 600;
}
:deep(.nav-badge) {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  box-sizing: border-box;
  border-radius: 999px;
  background: var(--ink);
  color: var(--ink-text);
  font-size: 11px;
  font-weight: 600;
  display: inline-grid;
  place-items: center;
}
</style>
