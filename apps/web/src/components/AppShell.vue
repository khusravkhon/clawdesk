<script setup lang="ts">
// Panel frame. Desktop: left sidebar that folds to icons. Phone: top bar, menu slides in from the left.
import { Menu as MenuIcon } from "@lucide/vue";
import { NButton, NDrawer, NLayout, NLayoutContent, NLayoutSider, useNotification } from "naive-ui";
import { h, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useApprovalsStore } from "../stores/approvals";
import { desktopNotify } from "../desktop";
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
  <n-layout v-if="!isPhone" has-sider class="shell">
    <n-layout-sider bordered collapse-mode="width" :collapsed="collapsed" :collapsed-width="64" :width="232" :native-scrollbar="false">
      <sidebar-nav :collapsed="collapsed" collapsible @toggle="collapsed = !collapsed" />
    </n-layout-sider>
    <n-layout-content>
      <div class="page"><router-view /></div>
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
      <sidebar-nav @navigate="drawerOpen = false" />
    </n-drawer>
    <main class="page"><router-view /></main>
  </div>
</template>

<style scoped>
.shell {
  height: 100vh;
}
.page {
  max-width: 1200px;
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
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}
.logo {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 13px;
  color: #fff;
  background: linear-gradient(135deg, #8f85f3, #5b4fd9);
}
.brand-name {
  font-weight: 600;
  font-size: 15px;
}
.phone .page {
  padding: 20px 16px 40px;
}
</style>
