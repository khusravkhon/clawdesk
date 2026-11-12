<script setup lang="ts">
// Panel frame. Desktop: left sidebar that folds to icons. Phone: top bar, menu slides in from the left.
import { Menu as MenuIcon } from "@lucide/vue";
import { NButton, NDrawer, NLayout, NLayoutContent, NLayoutSider, useNotification } from "naive-ui";
import { h, onBeforeUnmount, onMounted, ref, type VNode } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useApprovalsStore } from "../stores/approvals";
import { desktopNotify } from "../desktop";
import CommandPalette from "./CommandPalette.vue";
import SidebarNav from "./SidebarNav.vue";

const { t } = useI18n();
const router = useRouter();
const notification = useNotification();
const approvals = useApprovalsStore();

// Anywhere in the panel: a command waiting for approval pops up a notice.
onMounted(() =>
  approvals.watch((p) => {
    void desktopNotify(t("approvals.toastTitle"), p.command.length > 160 ? `${p.command.slice(0, 160)}…` : p.command);
    const notice = notification.warning({
      title: t("approvals.toastTitle"),
      content: p.command.length > 120 ? `${p.command.slice(0, 120)}…` : p.command,
      duration: 20_000,
      action: () =>
        h(NButton, { size: "small", type: "warning", secondary: true, onClick: () => { notice.destroy(); void router.push("/approvals"); } }, { default: () => t("approvals.open") }),
    });
  }),
);

// A page rises into place when another section opens; the same page with other parameters stays as it is.
const pageIds = new WeakMap<object, number>();
let lastPageId = 0;
function pageKey(page: VNode | undefined): number {
  const type = page?.type;
  if (typeof type !== "object" || type === null) return 0;
  if (!pageIds.has(type)) pageIds.set(type, ++lastPageId);
  return pageIds.get(type)!;
}

const palette = ref<InstanceType<typeof CommandPalette> | null>(null);
const collapsed = ref(false);
const drawerOpen = ref(false);

const phoneQuery = window.matchMedia("(max-width: 768px)");
const isPhone = ref(phoneQuery.matches);
const onQuery = (e: MediaQueryListEvent) => {
  isPhone.value = e.matches;
  if (!e.matches) drawerOpen.value = false;
};
onMounted(() => phoneQuery.addEventListener("change", onQuery));
onBeforeUnmount(() => phoneQuery.removeEventListener("change", onQuery));
</script>

<template>
  <command-palette ref="palette" />
  <n-layout v-if="!isPhone" has-sider class="shell">
    <n-layout-sider collapse-mode="width" :collapsed="collapsed" :collapsed-width="68" :width="240" :native-scrollbar="false">
      <sidebar-nav :collapsed="collapsed" collapsible @toggle="collapsed = !collapsed" @search="palette?.show()" />
    </n-layout-sider>
    <n-layout-content>
      <div class="page">
        <router-view v-slot="{ Component }">
          <div :key="pageKey(Component)" class="page-in"><component :is="Component" /></div>
        </router-view>
      </div>
    </n-layout-content>
  </n-layout>

  <div v-else class="phone">
    <header class="topbar">
      <n-button quaternary circle :aria-label="t('shell.menu')" @click="drawerOpen = true">
        <menu-icon :size="20" />
      </n-button>
      <div class="logo">C</div>
      <span class="brand-name">{{ t("app.title") }}</span>
    </header>
    <n-drawer v-model:show="drawerOpen" placement="left" :width="260">
      <sidebar-nav @navigate="drawerOpen = false" @search="drawerOpen = false; palette?.show()" />
    </n-drawer>
    <main class="page">
      <router-view v-slot="{ Component }">
        <div :key="pageKey(Component)" class="page-in"><component :is="Component" /></div>
      </router-view>
    </main>
  </div>
</template>

<style scoped>
.shell {
  height: 100vh;
}
.page {
  max-width: 1240px;
  margin: 0 auto;
  padding: 28px 32px 48px;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 8px;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(12px);
}
.logo {
  width: 26px;
  height: 26px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 14px;
  color: var(--on-accent);
  background: var(--accent-gradient);
}
.brand-name {
  font-weight: 600;
  font-size: 15px;
}
.phone .page {
  padding: 20px 16px 40px;
}
</style>
