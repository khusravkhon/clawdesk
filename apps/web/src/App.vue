<script setup lang="ts">
import type { Locale } from "@clawdesk/shared";
import { darkTheme, dateEnUS, dateRuRU, enUS, ruRU, NConfigProvider, NGlobalStyle, NLayout, NLayoutContent, NLayoutHeader, NMessageProvider, NSelect, NSpace, useOsTheme } from "naive-ui";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { setLocale, supportedLocales } from "./i18n";

const { t, locale } = useI18n();
const osTheme = useOsTheme();
const theme = computed(() => (osTheme.value === "dark" ? darkTheme : null));
// Naive UI has no Tajik pack; Russian is the closest for its built-in texts (date pickers, empty states).
const uiLocale = computed(() => (locale.value === "en" ? enUS : ruRU));
const uiDateLocale = computed(() => (locale.value === "en" ? dateEnUS : dateRuRU));
const localeOptions = computed(() => supportedLocales.map((value) => ({ value, label: t(`lang.${value}`) })));
</script>

<template>
  <n-config-provider :theme="theme" :locale="uiLocale" :date-locale="uiDateLocale">
    <n-global-style />
    <n-message-provider>
      <n-layout class="shell">
        <n-layout-header bordered class="header">
          <n-space justify="space-between" align="center">
            <n-space align="center" :size="20">
              <strong>{{ t("app.title") }}</strong>
              <router-link to="/agents" class="nav">{{ t("nav.agents") }}</router-link>
              <router-link to="/telegram" class="nav">Telegram</router-link>
              <router-link to="/status" class="nav">{{ t("nav.status") }}</router-link>
            </n-space>
            <n-select
              :value="locale"
              :options="localeOptions"
              size="small"
              class="lang"
              @update:value="(value: Locale) => setLocale(value)"
            />
          </n-space>
        </n-layout-header>
        <n-layout-content content-class="content">
          <router-view />
        </n-layout-content>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.shell {
  min-height: 100vh;
}
.header {
  padding: 12px 24px;
}
.nav {
  color: inherit;
  text-decoration: none;
  opacity: 0.75;
}
.nav.router-link-active {
  opacity: 1;
  font-weight: 600;
}
.lang {
  width: 140px;
}
:deep(.content) {
  padding: 24px;
  max-width: 960px;
  margin: 0 auto;
}
</style>
