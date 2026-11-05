import type { FastifyInstance } from "fastify";
import type { ActivityService } from "../company/activity-service.js";

/**
 * Stage 9: the activity snapshot, and a stream that sends a fresh snapshot whenever something shown changed
 * (each carries a sequence; a client keeps the highest). After a broken stream the client fetches the snapshot.
 */
export function registerActivityRoutes(app: FastifyInstance, deps: { activity?: ActivityService; onActivity?: (listener: () => void) => () => void }): void {
  const activity = deps.activity;
  if (!activity) return;
  app.get("/api/company/activity", () => activity.snapshot());
  app.get("/api/company/activity/events", async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    let sent = -1, timer: ReturnType<typeof setTimeout> | null = null, closed = false;
    const push = async () => {
      timer = null;
      if (closed) return;
      const snapshot = await activity.snapshot().catch(() => null);
      if (snapshot && snapshot.sequence !== sent && !closed) { sent = snapshot.sequence; res.write(`data: ${JSON.stringify(snapshot)}\n\n`); }
    };
    // Events come in bursts (deltas of a run): one snapshot per short window is enough.
    const soon = () => { if (!timer) timer = setTimeout(() => void push(), 300); };
    const unsubscribe = deps.onActivity?.(soon) ?? (() => undefined);
    // Tasks and requests change in the database without a Gateway event; a slow check catches them.
    const poll = setInterval(soon, 2_000);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    await push();
    request.raw.on("close", () => { closed = true; clearInterval(poll); clearInterval(ping); if (timer) clearTimeout(timer); unsubscribe(); });
  });
}
