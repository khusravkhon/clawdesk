import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { GatewayClientRequestError, GatewayClientRequestTimeoutError } from "@openclaw/gateway-client";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { ZodError } from "zod";
import type { ApiErrorDto } from "@clawdesk/shared";
import type { Db } from "./db/client.js";
import { GatewayUnavailableError, type GatewayService } from "./gateway/gateway-service.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerHealthRoutes } from "./routes/health.js";

export type AppDeps = {
  logger: Logger;
  gateway: GatewayService;
  db: Db;
  webDist: string | undefined;
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.logger as FastifyBaseLogger });

  app.setErrorHandler((error, request, reply) => {
    const send = (status: number, body: ApiErrorDto) => reply.status(status).send(body);
    if (error instanceof ZodError) return send(400, { error: "invalid_request", message: "request validation failed", details: error.issues });
    if (error instanceof GatewayUnavailableError) {
      return send(503, { error: "gateway_unavailable", message: error.message, details: { state: error.status.state, hint: error.status.hint } });
    }
    if (error instanceof GatewayClientRequestTimeoutError) return send(504, { error: "gateway_timeout", message: `gateway did not answer ${error.method} in time` });
    if (error instanceof GatewayClientRequestError) {
      request.log.warn({ code: error.gatewayCode, msg: error.message }, "gateway rejected request");
      return send(502, { error: "gateway_error", message: error.message, details: { code: error.gatewayCode } });
    }
    const status = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, "unhandled error");
    return send(status, { error: status >= 500 ? "internal_error" : "request_error", message: status >= 500 ? "internal error" : (error as Error).message });
  });

  registerHealthRoutes(app, deps);
  registerAgentRoutes(app, deps);

  if (deps.webDist && fs.existsSync(path.join(deps.webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: deps.webDist, wildcard: false });
    // SPA fallback: any non-API GET serves index.html so client-side routes work on reload.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.status(404).send({ error: "not_found", message: `${request.method} ${request.url} not found` } satisfies ApiErrorDto);
    });
  }

  return app;
}
