<script setup lang="ts">
// Sidebar body: brand, sections, theme and language. Shared by the desktop sidebar and the phone drawer.
import type { Locale } from "@clawdesk/shared";
import { Activity, Bot, Database, LayoutDashboard, Moon, PanelLeftClose, PanelLeftOpen, Send, Sparkles, Sun } from "@lucide/vue";
import { NButton, NMenu, NSelect, NTooltip, type MenuOption } from "naive-ui";
import { computed, h, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import { setLocale, supportedLocales } from "../i18n";
import { themeMode, toggleTheme } from "../theme";

const props = defineProps<{ collapsed?: boolean; collapsible?: boolean }>();
const emit = defineEmits<{ toggle: []; navigate: [] }>();

const { t, locale } = useI18n();
const route = useRoute();

const icon = (c: Component) => () => h(c, { size: 18, strokeWidth: 1.75 });
const link = (to: string, label: string) => () => h(RouterLink, { to, onClick: () => emit("navigate") }, { default: () => label });

const menu = computed<MenuOption[]>(() => [
  { key: "/", label: link("/", t("nav.overview")), icon: icon(LayoutDashboard) },
  { key: "/agents", label: link("/agents", t("nav.agents")), icon: icon(Bot) },
  { key: "/sources", label: link("/sources", t("nav.sources")), icon: icon(Database) },
  { key: "/telegram", label: link("/telegram", "Telegram"), icon: icon(Send) },
  { key: "/free-models", label: link("/free-models", t("nav.freeModels")), icon: icon(Sparkles) },
  { key: "/status", label: link("/status", t("nav.status")), icon: icon(Activity) },
]);

// Nested pages (e.g. /agents/new) light up their section.
const activeKey = computed(() => {
  if (route.path === "/") return "/";
  return menu.value.map((m) => m.key as string).find((k) => k !== "/" && route.path.startsWith(k)) ?? null;
});

const localeOptions = computed(() => supportedLocales.map((value) => ({ value, label: t(`lang.${value}`) })));
const collapsed = computed(() => !!props.collapsed);
</script>

<template>
  <div class="nav">
    <div class="brand" :class="{ collapsed }">
      <div class="logo">C</div>
      <span v-if="!collapsed" class="brand-name">{{ t("app.title") }}</span>
    </div>

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
  padding: 12px 8px;
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
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 15px;
  color: #fff;
  background: linear-gradient(135deg, #8f85f3, #5b4fd9);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12) inset;
  flex: none;
}
.brand-name {
  font-weight: 600;
  font-size: 15px;
  letter-spacing: -0.01em;
}
.foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 6px 2px;
  border-top: 1px solid var(--border);
}
.foot.collapsed {
  flex-direction: column;
}
.lang {
  flex: 1;
  min-width: 0;
}
</style>
