import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { type SourcesError, SourcesService } from "../src/sources/sources-service.js";

type Json = Record<string, unknown>;

describe("GitHub and Figma sources", () => {
  let dir: string;
  let close: () => void;
  let db: ReturnType<typeof openDb>["db"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-src2-"));
    ({ db, close } = openDb(path.join(dir, "panel.sqlite")));
  });
  afterEach(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function gateway(github: Json) {
    const calls: { method: string; params: Json }[] = [];
    let config: Json = { skills: { load: { extraDirs: ["/other/skills"] } } };
    const gw = {
      request: async (method: string, params: Json) => {
        calls.push({ method, params });
        if (method === "config.get") return { hash: "h", config };
        if (method === "config.patch") {
          const patch = JSON.parse(params.raw as string) as Json;
          config = { ...config, skills: { ...(config.skills as Json), ...(patch.skills as Json), entries: { ...((patch.skills as Json).entries as Json) } } };
        }
        if (method === "tools.github.status") return github;
        return { ok: true };
      },
    } as unknown as GatewayService;
    return { gw, calls };
  }

  const service = (gw: GatewayService, figmaStatus = 200) =>
    new SourcesService({
      gateway: gw,
      db,
      logger: pino({ level: "silent" }),
      files: { dir: undefined, hostPath: undefined },
      fetchImpl: (async () => new Response(JSON.stringify({ handle: "khusrav" }), { status: figmaStatus })) as typeof fetch,
    });

  it("Figma: the token is checked with Figma, stored as a secret, and the read-only skill gets a reference to it", async () => {
    const { gw, calls } = gateway({});
    const dto = await service(gw).connectFigmaToken("figd_" + "x".repeat(30));
    expect(dto.figma).toEqual({ connected: true, handle: "khusrav", error: null });
    expect(calls.find((c) => c.method === "secrets.store.set")!.params).toMatchObject({ name: "clawdesk.figma.token", allowedHosts: ["api.figma.com"] });
    const patch = JSON.parse(calls.find((c) => c.method === "config.patch")!.params.raw as string);
    expect(patch.skills.load.extraDirs).toEqual(["/other/skills", "/usr/local/share/clawdesk/skills"]);
    expect(patch.skills.entries.figma).toEqual({ enabled: true, apiKey: { source: "store", provider: "default", id: "clawdesk.figma.token" } });
    expect(JSON.stringify(patch)).not.toContain("figd_");

    const rejected = await service(gateway({}).gw, 403).connectFigmaToken("figd_" + "x".repeat(30)).then(() => null, (e: unknown) => e);
    expect((rejected as SourcesError).code).toBe("figma_token_rejected");
  });

  it("GitHub: connected only with an available identity of the main agent's own", async () => {
    const yes = await service(gateway({ selected: { configured: true, identity: { credentialState: "available", account: { login: "khusravkhon" } } } }).gw).status();
    expect(yes.github).toEqual({ connected: true, account: "khusravkhon", error: null });
    const inherited = await service(gateway({ selected: { configured: false, identity: null } }).gw).status();
    expect(inherited.github.connected).toBe(false);
  });

  it("GitHub sign-in keeps polling on slow_down and network_error, and names why it failed", async () => {
    const answer = (poll: Json) => service({ request: async (method: string) => (method === "tools.github.authorize.poll" ? poll : {}) } as unknown as GatewayService);
    expect(await answer({ status: "slow_down", retryAfterMs: 10_000 }).pollGitHubSignIn("r")).toEqual({ status: "pending", retryAfterMs: 10_000, reason: null });
    expect(await answer({ status: "network_error", retryAfterMs: 7000 }).pollGitHubSignIn("r")).toEqual({ status: "pending", retryAfterMs: 7000, reason: null });
    expect(await answer({ status: "pending", retryAfterMs: 5000 }).pollGitHubSignIn("r")).toMatchObject({ status: "pending" });
    expect(await answer({ status: "success", githubStatus: {} }).pollGitHubSignIn("r")).toMatchObject({ status: "success", reason: null });
    expect(await answer({ status: "expired" }).pollGitHubSignIn("r")).toMatchObject({ status: "expired", reason: null });
    expect(await answer({ status: "failed", reason: "setup_failed" }).pollGitHubSignIn("r")).toMatchObject({ status: "failed", reason: "setup_failed" });
    expect(await answer({ status: "incorrect_device_code" }).pollGitHubSignIn("r")).toMatchObject({ status: "failed", reason: "incorrect_device_code" });
  });
});
