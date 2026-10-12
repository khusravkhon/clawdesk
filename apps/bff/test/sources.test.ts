import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConnectNotionTokenRequest } from "@clawdesk/shared";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import type { BridgeClient } from "../src/gateway/bridge-client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { SourcesError, SourcesService } from "../src/sources/sources-service.js";

type Json = Record<string, unknown>;

/** JSON merge patch (RFC 7386), as config.patch applies it. */
function merge(target: Json, patch: Json): Json {
  const out: Json = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (typeof v === "object" && !Array.isArray(v)) out[k] = merge((out[k] as Json) ?? {}, v as Json);
    else out[k] = v;
  }
  return out;
}

function fakeGateway() {
  const state = { config: {} as Json, secrets: new Map<string, string>(), calls: [] as string[] };
  const gateway = {
    request: async (method: string, params: Json) => {
      state.calls.push(method);
      if (method === "config.get") return { hash: "h", config: state.config };
      if (method === "config.patch") state.config = merge(state.config, JSON.parse(params.raw as string) as Json);
      if (method === "secrets.store.set") state.secrets.set(params.name as string, params.value as string);
      if (method === "secrets.store.delete") state.secrets.delete(params.name as string);
      return { ok: true };
    },
  } as unknown as GatewayService;
  return { gateway, state };
}

const TOKEN = "ntn_FakeFakeFakeFakeFakeFakeFake123";

function notionApi(status: number) {
  return (async () =>
    new Response(JSON.stringify({ object: "user", type: "bot", name: "ClawDesk", bot: { workspace_name: "Khusrav's Notion" } }), { status })) as typeof fetch;
}

describe("sources", () => {
  let dir: string;
  let close: () => void;
  let db: ReturnType<typeof openDb>["db"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-sources-"));
    ({ db, close } = openDb(path.join(dir, "panel.sqlite")));
  });
  afterEach(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const service = (gateway: GatewayService, fetchImpl: typeof fetch, filesDir?: string, bridge?: BridgeClient) =>
    new SourcesService({ gateway, db, logger: pino({ level: "silent" }), files: { dir: filesDir, hostPath: filesDir ? "C:/Users/me/ClawDesk" : undefined }, fetchImpl, bridge });

  function fakeBridge() {
    const calls: string[] = [];
    let tokens = false;
    const bridge = {
      available: async () => true,
      mcpStatus: async () => ({ configured: true, hasTokens: tokens, state: null }),
      mcpLoginStart: async (server: string) => {
        calls.push(`start:${server}`);
        return { authorizationUrl: "https://mcp.notion.com/authorize?client_id=c&state=s3cr3t&redirect_uri=x" };
      },
      mcpLoginComplete: async (server: string, code: string) => {
        calls.push(`complete:${server}:${code}`);
        tokens = true;
        return { ok: true };
      },
      mcpLogout: async (server: string) => {
        calls.push(`logout:${server}`);
        tokens = false;
        return { ok: true };
      },
    } as unknown as BridgeClient;
    return { bridge, calls };
  }

  it("signs in through Notion: MCP server points back at the panel, only our state is accepted", async () => {
    const { gateway, state } = fakeGateway();
    const { bridge, calls } = fakeBridge();
    const s = service(gateway, notionApi(200), undefined, bridge);
    const started = await s.startNotionOAuth("http://localhost:5173");
    expect(started.authorizationUrl).toContain("mcp.notion.com/authorize");
    expect((state.config.mcp as Json).servers).toEqual({
      notion: { url: "https://mcp.notion.com/mcp", transport: "streamable-http", auth: "oauth", oauth: { redirectUrl: "http://localhost:5173/api/sources/notion/callback" } },
    });

    await expect(s.completeNotionOAuth("code-1", "forged")).rejects.toMatchObject({ code: "oauth_state_mismatch" });
    await s.completeNotionOAuth("code-1", "s3cr3t");
    expect(calls).toEqual(["start:notion", "complete:notion:code-1"]);
    expect((await s.status()).notion).toMatchObject({ connected: true, method: "oauth", oauthAvailable: true });
    // The same state cannot be used twice.
    await expect(s.completeNotionOAuth("code-2", "s3cr3t")).rejects.toMatchObject({ code: "oauth_state_mismatch" });

    const after = await s.disconnectNotion();
    expect(calls.at(-1)).toBe("logout:notion");
    expect(state.config.mcp).toEqual({ servers: {} });
    expect(after.notion.connected).toBe(false);
  });

  it("refuses sign-in when the bridge is missing", async () => {
    const { gateway } = fakeGateway();
    await expect(service(gateway, notionApi(200)).startNotionOAuth("http://x")).rejects.toMatchObject({ code: "oauth_unavailable" });
  });

  it("accepts Notion integration secrets only", () => {
    expect(ConnectNotionTokenRequest.safeParse({ token: ` ${TOKEN} ` }).success).toBe(true);
    for (const token of ["", "ntn_short", "sk-1234567890abcdefghijklmnop", "ntn_has spaces in it 1234567890"]) {
      expect(ConnectNotionTokenRequest.safeParse({ token }).success, token).toBe(false);
    }
  });

  it("stores a working secret and turns on the notion skill", async () => {
    const { gateway, state } = fakeGateway();
    const res = await service(gateway, notionApi(200)).connectNotionToken(TOKEN);
    expect(state.secrets.get("clawdesk.notion.token")).toBe(TOKEN);
    expect(state.config).toEqual({ skills: { entries: { notion: { enabled: true, apiKey: { source: "store", provider: "default", id: "clawdesk.notion.token" } } } } });
    expect(res.notion).toMatchObject({ connected: true, method: "token", workspace: "Khusrav's Notion", integration: "ClawDesk" });
  });

  it("stores nothing when Notion rejects the secret", async () => {
    const { gateway, state } = fakeGateway();
    await expect(service(gateway, notionApi(401)).connectNotionToken(TOKEN)).rejects.toBeInstanceOf(SourcesError);
    expect(state.secrets.size).toBe(0);
    expect(state.calls).not.toContain("config.patch");
  });

  it("disconnects: key removed from config, secret deleted", async () => {
    const { gateway, state } = fakeGateway();
    const s = service(gateway, notionApi(200));
    await s.connectNotionToken(TOKEN);
    const res = await s.disconnectNotion();
    expect(state.secrets.size).toBe(0);
    expect(state.config).toEqual({ skills: { entries: { notion: { enabled: true } } } });
    expect(res.notion.connected).toBe(false);
  });

  it("lists the shared folder, newest first, without hidden files", async () => {
    const files = path.join(dir, "files");
    fs.mkdirSync(path.join(files, "Документы"), { recursive: true });
    fs.writeFileSync(path.join(files, "old.txt"), "a");
    fs.utimesSync(path.join(files, "old.txt"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    fs.writeFileSync(path.join(files, "plan.pdf"), "pdf!");
    fs.writeFileSync(path.join(files, ".DS_Store"), "");
    const { gateway } = fakeGateway();
    const { folder } = await service(gateway, notionApi(200), files).status();
    expect(folder).toMatchObject({ available: true, hostPath: "C:/Users/me/ClawDesk", agentPath: "files/", total: 3 });
    expect(folder.files.at(-1)?.name).toBe("old.txt");
    expect(folder.files.find((f) => f.name === "Документы")?.isDir).toBe(true);
  });

  it("reports the folder as missing when it is not mounted", async () => {
    const { gateway } = fakeGateway();
    const { folder } = await service(gateway, notionApi(200), path.join(dir, "nope")).status();
    expect(folder.available).toBe(false);
  });
});
