import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { derivedPassword, FreeModelsService } from "../src/free-models/free-models-service.js";
import type { BridgeClient } from "../src/gateway/bridge-client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

// A FreeLLMAPI with one account: login / setup / change-password / reset (via the bridge).
function fakeFreellmapi(initial: string | null) {
  const state = { password: initial, calls: [] as string[] };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const route = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    state.calls.push(route);
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (route === "/api/auth/login") return body.password === state.password ? json(200, { token: "t" }) : json(401, { error: { message: "bad" } });
    if (route === "/api/auth/setup") {
      if (state.password !== null) return json(409, { error: { message: "Setup already completed. Use login instead." } });
      state.password = body.password;
      return json(200, { token: "t" });
    }
    if (route === "/api/auth/change-password") {
      if (body.currentPassword !== state.password) return json(403, {});
      state.password = body.newPassword;
      return json(200, { success: true });
    }
    return json(200, { providers: [] });
  });
  const bridge = {
    freellmapiReset: async (p: string) => {
      state.calls.push("bridge:reset");
      state.password = p;
      return { ok: true };
    },
  } as unknown as BridgeClient;
  return { state, fetchMock, bridge };
}

describe("FreeLLMAPI account", () => {
  const SECRET = "gateway-token";
  const DERIVED = derivedPassword(SECRET);
  let dir: string;
  const accountFile = () => path.join(dir, "freellmapi", "account.json");
  const make = (bridge?: BridgeClient) =>
    new FreeModelsService({} as GatewayService, pino({ level: "silent" }), { baseUrl: "http://free", dataDir: dir, setupCode: undefined, accountSecret: SECRET, bridge });
  const status = (s: FreeModelsService) => s.status();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-free-"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("derives the same password from the same Gateway token", () => {
    expect(derivedPassword(SECRET)).toBe(DERIVED);
    expect(derivedPassword("other")).not.toBe(DERIVED);
  });

  it("first run: creates the account with the derived password", async () => {
    const f = fakeFreellmapi(null);
    vi.stubGlobal("fetch", f.fetchMock);
    expect((await status(make())).available).toBe(true);
    expect(f.state.password).toBe(DERIVED);
  });

  it("an old random password is moved to the derived one", async () => {
    const f = fakeFreellmapi("old-random-password");
    vi.stubGlobal("fetch", f.fetchMock);
    fs.mkdirSync(path.dirname(accountFile()), { recursive: true });
    fs.writeFileSync(accountFile(), JSON.stringify({ email: "clawdesk@panel.local", password: "old-random-password" }));
    await status(make());
    expect(f.state.password).toBe(DERIVED);
    expect(JSON.parse(fs.readFileSync(accountFile(), "utf8")).password).toBe(DERIVED);
  });

  it("lost panel volume: signs in with the derived password", async () => {
    const f = fakeFreellmapi(DERIVED);
    vi.stubGlobal("fetch", f.fetchMock);
    expect((await status(make())).available).toBe(true);
    expect(f.state.calls).not.toContain("bridge:reset");
  });

  it("password unknown: resets it through the bridge", async () => {
    const f = fakeFreellmapi("nobody-knows");
    vi.stubGlobal("fetch", f.fetchMock);
    expect((await status(make(f.bridge))).available).toBe(true);
    expect(f.state.calls).toContain("bridge:reset");
    expect(f.state.password).toBe(DERIVED);
  });
});
