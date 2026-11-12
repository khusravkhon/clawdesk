<script setup lang="ts">
// Approvals (screen 12): commands waiting for the owner, how the main agent's commands are handled,
// what is always allowed, and recent decisions.
import type { ExecMode } from "@clawdesk/shared";
import { Ban, CheckCircle2, Clock, ShieldCheck, ShieldOff, ShieldQuestion, Trash2, XCircle } from "@lucide/vue";
import { NButton, NEmpty, NPopconfirm, NSkeleton, useMessage } from "naive-ui";
import { computed, onMounted, ref, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import ApprovalCard from "../components/ApprovalCard.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { formatRelative } from "../format";
import { useApprovalsStore } from "../stores/approvals";

const { t, locale } = useI18n();
const message = useMessage();
const store = useApprovalsStore();
const saving = ref<ExecMode | null>(null);

const data = computed(() => store.data);
const modes: { mode: ExecMode; icon: Component }[] = [
  { mode: "ask", icon: ShieldQuestion },
  { mode: "full", icon: ShieldOff },
  { mode: "deny", icon: Ban },
];

async function setMode(mode: ExecMode): Promise<void> {
  if (data.value?.mainMode === mode) return;
  saving.value = mode;
  try {
    store.data = await api.approvals.setMode(mode);
    message.success(t("approvals.modeSaved"));
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  } finally {
    saving.value = null;
  }
}

async function removeAllowed(pattern: string): Promise<void> {
  try {
    store.data = await api.approvals.removeAllowed(pattern);
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  }
}

const statusIcon: Record<string, Component> = { allowed: CheckCircle2, denied: XCircle, expired: Clock, cancelled: XCircle };

onMounted(() => void store.refresh());
</script>

<template>
  <div>
    <page-header :title="t('approvals.title')" :subtitle="t('approvals.subtitle')" />

    <section class="block">
      <h2 class="section">{{ t("approvals.modeTitle") }}</h2>
      <div class="modes">
        <button
          v-for="m in modes"
          :key="m.mode"
          type="button"
          class="mode"
          :class="{ active: data?.mainMode === m.mode, risky: m.mode === 'full' }"
          :disabled="!data || !!saving"
          @click="setMode(m.mode)"
        >
          <component :is="m.icon" :size="18" class="mode-icon" />
          <span class="mode-name">{{ t(`approvals.mode.${m.mode}`) }}</span>
          <span class="mode-desc">{{ t(`approvals.modeDesc.${m.mode}`) }}</span>
          <span v-if="m.mode === 'ask'" class="tag">{{ t("approvals.recommended") }}</span>
        </button>
      </div>
    </section>

    <section class="block">
      <h2 class="section">{{ t("approvals.pendingTitle") }}</h2>
      <n-skeleton v-if="!data" height="120px" :sharp="false" />
      <div v-else-if="store.pending.length" class="pending">
        <approval-card v-for="a in store.pending" :key="a.id" :approval="a" />
      </div>
      <div v-else class="empty-line"><shield-check :size="16" /> {{ t("approvals.nothingPending") }}</div>
    </section>

    <div class="grid">
      <section class="panel">
        <h2 class="section">{{ t("approvals.allowedTitle") }}</h2>
        <p class="hint">{{ t("approvals.allowedHint") }}</p>
        <ul v-if="data?.allowed.length" class="list">
          <li v-for="a in data.allowed" :key="a.pattern">
            <code class="pattern">{{ a.pattern }}</code>
            <span v-if="a.lastUsedAt" class="muted small">{{ formatRelative(a.lastUsedAt, locale) }}</span>
            <n-popconfirm @positive-click="removeAllowed(a.pattern)">
              <template #trigger>
                <n-button quaternary circle size="tiny" :aria-label="t('approvals.remove')"><trash-2 :size="13" /></n-button>
              </template>
              {{ t("approvals.confirmRemove") }}
            </n-popconfirm>
          </li>
        </ul>
        <n-empty v-else size="small" :description="t('approvals.noneAllowed')" class="empty" />
      </section>

      <section class="panel">
        <h2 class="section">{{ t("approvals.historyTitle") }}</h2>
        <ul v-if="data?.history.length" class="list">
          <li v-for="h in data.history" :key="h.id">
            <component :is="statusIcon[h.status]" :size="14" :class="['status', h.status]" />
            <code class="pattern">{{ h.command }}</code>
            <span class="muted small">{{ t(`approvals.status.${h.status}`) }}<template v-if="h.resolvedAt"> · {{ formatRelative(h.resolvedAt, locale) }}</template></span>
          </li>
        </ul>
        <n-empty v-else size="small" :description="t('approvals.noHistory')" class="empty" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 24px;
}
.section {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.modes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.mode {
  position: relative;
  text-align: left;
  font: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--card-shadow);
  padding: 14px 16px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mode:hover:not(:disabled) {
  background: var(--surface-2);
}
.mode.active {
  border-color: var(--accent-bright);
  box-shadow: 0 0 0 4px var(--accent-soft);
}
.mode.active.risky {
  border-color: var(--warning);
  box-shadow: 0 0 0 1px var(--warning) inset;
}
.mode-icon {
  color: var(--accent);
}
.mode.risky .mode-icon {
  color: var(--warning);
}
.mode-name {
  font-weight: 600;
  font-size: 14px;
}
.mode-desc {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.5;
}
.tag {
  position: absolute;
  top: 12px;
  right: 12px;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}
.pending {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.empty-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  color: var(--muted);
  font-size: 13px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--card-shadow);
  padding: 16px 18px;
  min-width: 0;
}
.hint {
  margin: -4px 0 12px;
  font-size: 12px;
  color: var(--muted);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.list li:first-child {
  border-top: 0;
}
.pattern {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.small {
  font-size: 12px;
  flex: none;
}
.status.allowed {
  color: var(--good-text);
}
.status.denied,
.status.cancelled {
  color: var(--critical);
}
.status.expired {
  color: var(--muted);
}
.empty {
  padding: 16px 0;
}
@media (max-width: 900px) {
  .modes,
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
