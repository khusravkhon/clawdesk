import http from "node:http";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeBus, topicsOfGatewayEvent, topicsOfRequest } from "../src/changes/change-bus.js";
import { registerChangeRoutes } from "../src/routes/changes.js";

describe("what changed", () => {
  it("maps change requests to areas, reads to nothing", () => {
    expect(topicsOfRequest("POST", "/api/reminders")).toEqual(["reminders"]);
    expect(topicsOfRequest("PATCH", "/api/company/work-items/w1?x=1")).toEqual(["workItems"]);
    expect(topicsOfRequest("POST", "/api/company/agents/a1")).toEqual(["agents"]);
    expect(topicsOfRequest("DELETE", "/api/schedules/s1")).toEqual(["schedules"]);
    expect(topicsOfRequest("GET", "/api/reminders")).toEqual([]);
    expect(topicsOfRequest("POST", "/api/reminders-extra")).toEqual([]);
    expect(topicsOfRequest("POST", "/api/chat/main")).toEqual([]);
    expect(topicsOfGatewayEvent({ event: "cron" })).toEqual(["schedules", "agents"]);
    expect(topicsOfGatewayEvent({ event: "chat" })).toEqual([]);
  });

  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("announces a successful change once per burst, and not a failed one", async () => {
    const app = Fastify();
    const bus = new ChangeBus();
    registerChangeRoutes(app, bus);
    app.post("/api/reminders", async () => ({ ok: true }));
    app.post("/api/schedules", async (_request, reply) => reply.status(409).send({ error: "conflict" }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    close = () => app.close();
    const { port } = app.server.address() as { port: number };

    const received: string[] = [];
    const stream = await new Promise<http.IncomingMessage>((resolve) => http.get({ port, host: "127.0.0.1", path: "/api/changes/events" }, resolve));
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { for (const line of chunk.split("\n")) if (line.startsWith("data: ")) received.push(line.slice(6)); });
    await new Promise((r) => setTimeout(r, 50));

    await app.inject({ method: "POST", url: "/api/schedules" });
    await app.inject({ method: "POST", url: "/api/reminders" });
    await app.inject({ method: "POST", url: "/api/reminders" });
    bus.emit(["agents"]);
    await new Promise((r) => setTimeout(r, 500));
    stream.destroy();

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!).topics.sort()).toEqual(["agents", "reminders"]);
  });
});
