<script setup lang="ts">
import type { Locale } from "@clawdesk/shared";
import { darkTheme, NConfigProvider, NGlobalStyle, NLayout, NLayoutContent, NLayoutHeader, NMessageProvider, NSelect, NSpace, useOsTheme } from "naive-ui";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { setLocale, supportedLocales } from "./i18n";

const { t, locale } = useI18n();
const osTheme = useOsTheme();
const theme = computed(() => (osTheme.value === "dark" ? darkTheme : null));
const localeOptions = computed(() => supportedLocales.map((value) => ({ value, label: t(`lang.${value}`) })));
</script>

<template>
  <n-config-provider :theme="theme">
    <n-global-style />
    <n-message-provider>
      <n-layout class="shell">
        <n-layout-header bordered class="header">
          <n-space justify="space-between" align="center">
            <strong>{{ t("app.title") }}</strong>
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
.lang {
  width: 140px;
}
:deep(.content) {
  padding: 24px;
  max-width: 960px;
  margin: 0 auto;
}
</style>
