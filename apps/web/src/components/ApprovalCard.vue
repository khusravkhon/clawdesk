<script setup lang="ts">
// One command waiting for the owner: what, who, how long it may wait, and the three answers.
import type { ApprovalDecision, PendingApprovalDto } from "@clawdesk/shared";
import { AlertTriangle, ShieldAlert } from "@lucide/vue";
import { NButton, useMessage } from "naive-ui";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ApiError } from "../api/client";
import { formatRelative } from "../format";
import { useApprovalsStore } from "../stores/approvals";

const props = defineProps<{ approval: PendingApprovalDto; agentName?: string; compact?: boolean }>();
const { t, locale } = useI18n();
const message = useMessage();
const store = useApprovalsStore();
const busy = ref<ApprovalDecision | null>(null);

const expires = computed(() => formatRelative(props.approval.expiresAt, locale.value));

async function answer(decision: ApprovalDecision): Promise<void> {
  busy.value = decision;
  try {
    await store.resolve(props.approval, decision);
    message.success(t(`approvals.done.${decision}`));
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="card" :class="{ compact }">
    <div class="head">
      <shield-alert :size="16" class="icon" />
      <span class="title">{{ t("approvals.wants", { name: agentName ?? approval.agentId ?? t("agents.main") }) }}</span>
      <span class="expires">{{ t("approvals.expires", { when: expires }) }}</span>
    </div>
    <pre class="command">{{ approval.command }}</pre>
    <div v-if="approval.cwd && !compact" class="cwd">{{ t("approvals.cwd") }}: <code>{{ approval.cwd }}</code></div>
    <div v-if="approval.warning" class="warning"><alert-triangle :size="14" /> {{ approval.warning }}</div>
    <div class="actions">
      <n-button size="small" type="primary" :loading="busy === 'allow-once'" :disabled="!!busy" @click="answer('allow-once')">{{ t("approvals.allowOnce") }}</n-button>
      <n-button size="small" secondary :loading="busy === 'allow-always'" :disabled="!!busy" @click="answer('allow-always')">{{ t("approvals.allowAlways") }}</n-button>
      <n-button size="small" quaternary type="error" :loading="busy === 'deny'" :disabled="!!busy" @click="answer('deny')">{{ t("approvals.deny") }}</n-button>
    </div>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border));
  background: color-mix(in srgb, var(--warning) 6%, var(--surface));
  border-radius: 12px;
  padding: 14px 16px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.icon {
  color: var(--warning);
  flex: none;
}
.title {
  font-weight: 500;
  font-size: 14px;
}
.expires {
  margin-left: auto;
  font-size: 12px;
  color: var(--muted);
}
.command {
  margin: 10px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-family: "JetBrains Mono", ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 180px;
  overflow: auto;
}
.cwd {
  margin-top: 8px;
  font-size: 12px;
  color: var(--muted);
}
.warning {
  margin-top: 8px;
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 12px;
  color: var(--warning);
}
.actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
