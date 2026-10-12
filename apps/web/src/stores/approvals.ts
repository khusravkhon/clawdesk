import type { ApprovalDecision, ApprovalsDto, PendingApprovalDto } from "@clawdesk/shared";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "../api/client";

// Approvals queue shared by the sidebar badge, the approvals screen and the chat.
export const useApprovalsStore = defineStore("approvals", () => {
  const data = ref<ApprovalsDto | null>(null);
  const pending = computed<PendingApprovalDto[]>(() => data.value?.pending ?? []);
  const count = computed(() => pending.value.length);
  /** Called when a new request arrives (e.g. to show a toast). */
  let onRequested: ((p: PendingApprovalDto) => void) | null = null;
  let events: EventSource | null = null;

  async function refresh(): Promise<void> {
    const first = data.value === null;
    const before = new Set(pending.value.map((p) => p.id));
    try {
      data.value = await api.approvals.list();
    } catch {
      return; // the badge simply keeps its last state
    }
    if (!first) for (const p of pending.value) if (!before.has(p.id)) onRequested?.(p);
  }

  function watch(handler: (p: PendingApprovalDto) => void): void {
    onRequested = handler;
    if (events) return;
    events = new EventSource(api.approvals.eventsUrl);
    events.onmessage = () => void refresh();
    // Also after a reconnect (BFF restart): events sent meanwhile are lost.
    events.onopen = () => void refresh();
  }

  async function resolve(p: PendingApprovalDto, decision: ApprovalDecision): Promise<void> {
    await api.approvals.resolve(p.id, p.kind, decision);
    await refresh();
  }

  return { data, pending, count, refresh, watch, resolve };
});
