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
  /** "on" once the gateway can run Docker sandboxes (decision 2); until then junior agents run unsandboxed and the UI says so. */
  CLAWDESK_SANDBOX: z.enum(["on", "off"]).default("off"),
  /** Bundled FreeLLMAPI ("free models" for junior agents); unset disables the feature. */
  FREELLMAPI_URL: z.string().url().optional(),
  /** Host development only: FreeLLMAPI first-run code from its logs (the BFF is not on its loopback). */
  FREELLMAPI_SETUP_CODE: z.string().optional(),
  /** Shared folder as the BFF sees it (read-only in the panel container, the host path in dev). */
  FILES_DIR: z.string().optional(),
  /** The same folder as the person sees it on their computer, shown in the UI. */
  FILES_HOST_PATH: z.string().optional(),
  /** ClawDesk bridge in the Gateway container (deploy/clawdesk-bridge.mjs); shares the Gateway's loopback. */
  CLAWDESK_BRIDGE_URL: z.string().url().default("http://127.0.0.1:18790"),
  /**
   * Proxies whose X-Forwarded-For/-Proto/-Host the panel believes (Fastify trustProxy), e.g. "loopback,uniquelocal"
   * for Caddy on the compose network. Empty: no proxy, the socket address is the client.
   */
  TRUST_PROXY: z.string().default(""),
  /** Backups folder, read-only for the panel (the bridge writes it). Unset: no backups (host development). */
  BACKUP_DIR: z.string().optional(),
  VIDEO_DIR: z.string().optional(),
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
  sandboxEnabled: boolean;
  freeModels: { baseUrl: string | undefined; setupCode: string | undefined };
  files: { dir: string | undefined; hostPath: string | undefined };
  bridgeUrl: string;
  trustProxy: string | false;
  backupDir: string | undefined;
  /** Kept video originals, read-only for the panel; absent when this install keeps none. */
  videoDir: string | undefined;
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
    sandboxEnabled: env.CLAWDESK_SANDBOX === "on",
    freeModels: { baseUrl: env.FREELLMAPI_URL?.replace(/\/$/, ""), setupCode: env.FREELLMAPI_SETUP_CODE || undefined },
    files: { dir: env.FILES_DIR ? path.resolve(env.FILES_DIR) : undefined, hostPath: env.FILES_HOST_PATH || env.FILES_DIR || undefined },
    bridgeUrl: env.CLAWDESK_BRIDGE_URL.replace(/\/$/, ""),
    trustProxy: env.TRUST_PROXY.trim() || false,
    backupDir: env.BACKUP_DIR ? path.resolve(env.BACKUP_DIR) : undefined,
    videoDir: env.VIDEO_DIR ? path.resolve(env.VIDEO_DIR) : undefined,
  };
}
