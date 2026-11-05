import type { CompanyActivityDto } from "@clawdesk/shared";
import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../api/client";

// Stage 9: the company's activity, one source for the work list and the office. The stream sends a fresh
// snapshot when something changes; the highest sequence wins, so a late or repeated message never rolls the
// view back. After a reconnect the snapshot is fetched again (messages sent meanwhile are lost).
// Only one stream, however many views use it; it stops when the last view lets go.
export const useActivityStore = defineStore("activity", () => {
  const data = ref<CompanyActivityDto | null>(null);
  const live = ref(false);
  const error = ref(false);
  let events: EventSource | null = null, users = 0;

  function accept(snapshot: CompanyActivityDto): void {
    if (!data.value || snapshot.sequence >= data.value.sequence || snapshot.generatedAt > data.value.generatedAt + 60_000) data.value = snapshot;
  }

  async function refresh(): Promise<void> {
    try { accept(await api.company.activity()); error.value = false; }
    catch { error.value = true; }
  }

  /** Starts (or joins) the stream; the returned function leaves it. */
  function use(): () => void {
    users++;
    if (!events) {
      void refresh();
      events = new EventSource(api.company.activityEventsUrl);
      events.onmessage = (message) => { try { accept(JSON.parse(message.data) as CompanyActivityDto); error.value = false; } catch { /* a malformed message is ignored */ } };
      events.onopen = () => { live.value = true; void refresh(); };
      events.onerror = () => { live.value = false; };
    }
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (--users === 0) { events?.close(); events = null; live.value = false; }
    };
  }

  return { data, live, error, refresh, use };
});
