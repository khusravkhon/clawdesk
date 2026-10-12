<script setup lang="ts">
import { dateEnUS, dateRuRU, enUS, ruRU, NConfigProvider, NGlobalStyle, NMessageProvider, NNotificationProvider } from "naive-ui";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import AppShell from "./components/AppShell.vue";
import { naiveTheme, themeOverrides } from "./theme";

const { locale } = useI18n();
const route = useRoute();
// Naive UI has no Tajik pack; Russian is the closest for its built-in texts (date pickers, empty states).
const uiLocale = computed(() => (locale.value === "en" ? enUS : ruRU));
const uiDateLocale = computed(() => (locale.value === "en" ? dateEnUS : dateRuRU));
</script>

<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="themeOverrides" :locale="uiLocale" :date-locale="uiDateLocale">
    <n-global-style />
    <n-notification-provider placement="bottom-right">
      <n-message-provider>
        <!-- The first-run window stands alone, without the sidebar. -->
        <div v-if="route.meta.bare" class="bare">
          <router-view />
        </div>
        <app-shell v-else />
      </n-message-provider>
    </n-notification-provider>
  </n-config-provider>
</template>

<style scoped>
.bare {
  max-width: 720px;
  margin: 0 auto;
  padding: 48px 20px;
}
</style>
