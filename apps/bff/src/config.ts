import path from "node:path";
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  // 8787 for host development; the container sets PORT=8080.
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Gateway WebSocket. The BFF shares the gateway's network namespace, so this stays loopback. */
  GATEWAY_URL: z.string().default("ws://127.0.0.1:18789"),
  /** Shared gateway token, used only until the device is paired and has its own device token. */
  OPENCLAW_GATEWAY_TOKEN: z.string().optional(),
  /** Panel state: SQLite DB, gateway device identity, issued device tokens. */
  DATA_DIR: z.string().default("./data"),
  /** Built apps/web to serve as static files; unset in dev (Vite serves the UI). */
  WEB_DIST: z.string().optional(),
});

export type AppConfig = {
  env: z.infer<typeof Env>["NODE_ENV"];
  host: string;
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  gateway: { url: string; sharedToken: string | undefined };
  dataDir: string;
  dbPath: string;
  webDist: string | undefined;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = Env.parse(source);
  const dataDir = path.resolve(env.DATA_DIR);
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    gateway: { url: env.GATEWAY_URL, sharedToken: env.OPENCLAW_GATEWAY_TOKEN || undefined },
    dataDir,
    dbPath: path.join(dataDir, "panel.sqlite"),
    webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : undefined,
  };
}
