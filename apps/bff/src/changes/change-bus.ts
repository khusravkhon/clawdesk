import type { ChangeTopic } from "@clawdesk/shared";

type Listener = (topics: ChangeTopic[]) => void;

/** Who heard what changed: the change stream of each open panel tab. */
export class ChangeBus {
  #listeners = new Set<Listener>();

  emit(topics: ChangeTopic[]): void {
    if (!topics.length) return;
    for (const listener of this.#listeners) {
      try {
        listener(topics);
      } catch {
        // one broken stream must not stop the others
      }
    }
  }

  on(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

// Longest prefix first: /api/company/agents is an agent change, /api/company/requests is not.
const BY_PREFIX: [string, ChangeTopic[]][] = [
  ["/api/company/requests", ["requests"]],
  ["/api/company/work-items", ["workItems"]],
  ["/api/company/teams", ["teams"]],
  ["/api/company/projects", ["projects"]],
  ["/api/company/agents", ["agents"]],
  ["/api/company/departments", ["agents"]],
  ["/api/agents", ["agents"]],
  ["/api/assistant", ["agents"]],
  ["/api/ai", ["agents"]],
  ["/api/schedules", ["schedules"]],
  ["/api/reminders", ["reminders"]],
  ["/api/today", ["reminders"]],
  ["/api/library", ["library"]],
  ["/api/memory", ["library"]],
  ["/api/video", ["library"]],
  ["/api/teams", ["teams"]],
];

/** The areas a successful change request touched. Reads change nothing. */
export function topicsOfRequest(method: string, url: string): ChangeTopic[] {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return [];
  const path = url.split("?")[0]!;
  return BY_PREFIX.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] ?? [];
}

/** Gateway events that change what the panel shows: agent runs and scheduled runs. */
export function topicsOfGatewayEvent(event: { event: string }): ChangeTopic[] {
  if (event.event === "agent") return ["agents"];
  if (event.event === "cron") return ["schedules", "agents"];
  return [];
}
