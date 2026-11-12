<script setup lang="ts">
import { ArrowLeft, ChevronRight } from "@lucide/vue";
import { NButton } from "naive-ui";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { pageLabelKey, previousPagePath } from "../../page-labels";
import { PERSONAL_SETTINGS_PATHS } from "../../personal-settings";
import { useSpaceStore } from "../../stores/space";

const props = defineProps<{
  title: string;
  subtitle?: string;
  breadcrumbs?: Array<{ label: string; to?: string }>;
  backTo?: string;
  backLabel?: string;
  badge?: string;
}>();

const router = useRouter();
const route = useRoute();
const space = useSpaceStore();
const { t } = useI18n();

// Where the person came from inside the panel: "back" returns there, not to a fixed parent page.
const previous = computed(() => {
  void route.fullPath; // re-read on every navigation
  const path = previousPagePath();
  return path && path !== route.path ? path : null;
});
const previousLabel = computed(() => {
  const key = previous.value ? pageLabelKey(previous.value) : null;
  return key ? t(key) : t("nav.back");
});

type Crumb = { label: string; to?: string; back?: boolean };
// In personal mode these pages live under Settings; opened from another page, the first crumb leads back to it.
const crumbs = computed<Crumb[]>(() => {
  if (props.breadcrumbs?.length) return props.breadcrumbs;
  if (space.mode !== "personal" || !PERSONAL_SETTINGS_PATHS.has(route.path)) return [];
  if (previous.value && previous.value !== "/settings") return [{ label: previousLabel.value, back: true }, { label: props.title }];
  return [{ label: t("personalSettings.title"), to: "/settings" }, { label: props.title }];
});

const backText = computed(() => previous.value && previous.value !== props.backTo
  ? previousLabel.value
  : props.backLabel || t("nav.back"));

function goBack() {
  if (previous.value) router.back();
  else if (props.backTo) void router.push(props.backTo);
  else router.back();
}
</script>

<template>
  <header class="page-header">
    <!-- Breadcrumbs Navigation -->
    <nav v-if="crumbs.length" class="breadcrumbs" aria-label="Breadcrumbs">
      <template v-for="(crumb, idx) in crumbs" :key="idx">
        <a v-if="crumb.back" href="#" class="crumb-link" @click.prevent="router.back()">{{ crumb.label }}</a>
        <router-link v-else-if="crumb.to" :to="crumb.to" class="crumb-link">
          {{ crumb.label }}
        </router-link>
        <span v-else class="crumb-current">{{ crumb.label }}</span>
        <chevron-right v-if="idx < crumbs.length - 1" :size="13" class="crumb-sep" />
      </template>
    </nav>

    <!-- Main Header Bar -->
    <div class="header-main">
      <div class="title-cluster">
        <!-- Prominent Back Button if backTo is set -->
        <n-button
          v-if="backTo"
          quaternary
          size="small"
          class="back-btn"
          @click="goBack"
        >
          <template #icon><arrow-left :size="15" /></template>
          <span class="back-text">{{ backText }}</span>
        </n-button>

        <div class="title-row">
          <h1>{{ title }}</h1>
          <span v-if="badge" class="header-badge">{{ badge }}</span>
          <slot name="badge" />
        </div>

        <p v-if="subtitle" class="subtitle">
          <span class="workspace-pill">{{ subtitle }}</span>
        </p>
      </div>

      <div v-if="$slots.default" class="actions">
        <slot />
      </div>
    </div>
  </header>
</template>

<style scoped>
.page-header {
  margin-bottom: 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.breadcrumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
}

.crumb-link {
  color: var(--text-2);
  text-decoration: none;
  transition: all 0.15s ease;
  border-radius: 4px;
  padding: 2px 6px;
  margin: -2px -2px;
}

.crumb-link:hover {
  color: var(--accent-hover, var(--accent));
  background: var(--surface-2);
}

.crumb-sep {
  color: var(--muted);
  opacity: 0.5;
  flex-shrink: 0;
}

.crumb-current {
  color: var(--text);
  font-weight: 500;
  padding: 2px 4px;
}

.header-main {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.title-cluster {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.back-btn {
  align-self: flex-start;
  margin-bottom: 2px;
  padding: 0 10px 0 8px;
  color: var(--text-2);
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 6px;
  transition: all 0.15s ease;
}

.back-btn:hover {
  color: var(--text);
  background: var(--surface-2);
  border-color: var(--border-hover, var(--accent));
}

.back-text {
  font-size: 12.5px;
  font-weight: 500;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.2;
  color: var(--text);
}

.header-badge {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
}

.subtitle {
  margin: 0;
  line-height: 1.4;
}

.workspace-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 2px 8px;
  border-radius: 6px;
}

.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
</style>
