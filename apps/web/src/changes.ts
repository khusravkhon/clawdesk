// One "what changed" stream for every screen (see packages/shared/src/changes.ts). A screen names the areas it
// shows and gets called when one of them changes; its own slow timer stays as a safety net.
import type { ChangeEventDto, ChangeTopic } from "@clawdesk/shared";

/** The safety-net timer for a screen that listens to the stream. */
export const FALLBACK_REFRESH_MS = 120_000;

type Handler = { topics: Set<ChangeTopic>; run: () => void };
const handlers = new Set<Handler>();
/** Called while the tab was hidden: run once it is visible again, not in the background. */
const deferred = new Set<Handler>();
let source: EventSource | null = null;
let lost = false;

function call(handler: Handler): void {
  if (document.hidden) deferred.add(handler);
  else handler.run();
}

function onVisible(): void {
  if (document.hidden) return;
  const due = [...deferred];
  deferred.clear();
  for (const handler of due) if (handlers.has(handler)) handler.run();
}

function start(): void {
  source = new EventSource("/api/changes/events");
  source.onmessage = (message) => {
    let topics: ChangeTopic[];
    try {
      topics = (JSON.parse(message.data) as ChangeEventDto).topics;
    } catch {
      return; // a malformed message is ignored
    }
    for (const handler of handlers) if (topics.some((topic) => handler.topics.has(topic))) call(handler);
  };
  // Changes made while the stream was down were not announced: everyone reloads once it is back.
  source.onerror = () => { lost = true; };
  source.onopen = () => {
    if (!lost) return;
    lost = false;
    for (const handler of handlers) call(handler);
  };
  document.addEventListener("visibilitychange", onVisible);
}

/** Calls `run` when one of `topics` changes; the returned function stops it. The stream closes with the last listener. */
export function onChanges(topics: ChangeTopic[], run: () => void): () => void {
  const handler: Handler = { topics: new Set(topics), run };
  handlers.add(handler);
  if (!source) start();
  return () => {
    handlers.delete(handler);
    deferred.delete(handler);
    if (handlers.size) return;
    source?.close();
    source = null;
    lost = false;
    document.removeEventListener("visibilitychange", onVisible);
  };
}
