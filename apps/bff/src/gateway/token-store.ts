import path from "node:path";
import type { DeviceAuthTokenRecord } from "@openclaw/gateway-client";
import { z } from "zod";
import { readJsonIfExists, writeSecureJson } from "../lib/secure-file.js";

// Device tokens issued by the Gateway in hello-ok, keyed by deviceId + role.
// GatewayClient calls these synchronously during connect, so this is a small
// file-backed map rather than an async store.

const TokenFile = z.object({
  version: z.literal(1),
  tokens: z.record(z.string(), z.object({ token: z.string(), scopes: z.array(z.string()), storedAtMs: z.number() })),
});
type TokenFile = z.infer<typeof TokenFile>;

export class DeviceTokenStore {
  readonly #file: string;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, "gateway", "device-tokens.json");
  }

  load(params: { deviceId: string; role: string }): DeviceAuthTokenRecord | null {
    const entry = this.#read().tokens[key(params)];
    return entry ? { token: entry.token, scopes: entry.scopes } : null;
  }

  store(params: { deviceId: string; role: string; token: string; scopes: string[] }): void {
    const data = this.#read();
    data.tokens[key(params)] = { token: params.token, scopes: params.scopes, storedAtMs: Date.now() };
    writeSecureJson(this.#file, data);
  }

  clear(params: { deviceId: string; role: string }): void {
    const data = this.#read();
    if (!(key(params) in data.tokens)) return;
    delete data.tokens[key(params)];
    writeSecureJson(this.#file, data);
  }

  has(params: { deviceId: string; role: string }): boolean {
    return this.load(params) !== null;
  }

  #read(): TokenFile {
    const raw = readJsonIfExists(this.#file);
    return raw === undefined ? { version: 1, tokens: {} } : TokenFile.parse(raw);
  }
}

function key(params: { deviceId: string; role: string }): string {
  return `${params.deviceId}:${params.role}`;
}
