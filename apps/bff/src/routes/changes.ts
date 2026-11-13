import type { ChangeEventDto, ChangeTopic } from "@clawdesk/shared";
import type { FastifyInstance } from "fastify";
import { type ChangeBus, topicsOfRequest } from "../changes/change-bus.js";

/**
 * The "what changed" stream (see packages/shared/src/changes.ts). Changes made through the panel's own API
 * are announced after a successful answer; the Gateway's events are fed in by app.ts. Bursts are merged into
 * one event per short window.
 */
export function registerChangeRoutes(app: FastifyInstance, bus: ChangeBus): void {
  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < 400) bus.emit(topicsOfRequest(request.method, request.url));
  });

  app.get("/api/changes/events", async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    const pending = new Set<ChangeTopic>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const event: ChangeEventDto = { topics: [...pending] };
      pending.clear();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = bus.on((topics) => {
      for (const topic of topics) pending.add(topic);
      timer ??= setTimeout(flush, 300);
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    res.write(": open\n\n");
    request.raw.on("close", () => {
      clearInterval(ping);
      if (timer) clearTimeout(timer);
      unsubscribe();
    });
  });
}
