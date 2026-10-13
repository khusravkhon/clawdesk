import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { agents } from "../src/db/schema.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";
import { TelegramError, TelegramService } from "../src/telegram/telegram-service.js";

describe("Telegram approvals", () => {
  let dir: string;
  let close: () => void;
  let db: ReturnType<typeof openDb>["db"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-tg-"));
    ({ db, close } = openDb(path.join(dir, "panel.sqlite")));
    db.insert(agents).values({ id: "main", role: "main", displayName: "Main" }).run();
  });
  afterEach(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeGateway() {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let config: Record<string, unknown> = { channels: { telegram: { enabled: true, botToken: { source: "store" } } } };
    const gw = {
      generation: 1,
      status: { state: "connected" },
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "config.get") return { hash: "h", config };
        if (method === "config.patch") config = { ...config, patched: JSON.parse(params.raw as string) };
        if (method === "channels.pairing.list") return { requests: [{ requestId: "r1", accountId: "default", channel: "telegram", senderId: "4242", senderLabel: "Khusrav", createdAt: "", expiresAt: "" }] };
        if (method === "channels.pairing.approve") return { senderId: "4242" };
        if (method === "gateway.restart.request") gw.generation++;
        return { ok: true };
      },
      waitForReconnect: async () => undefined,
    };
    return { gateway: gw as unknown as GatewayService, calls };
  }

  it("approving the owner sends approval requests to their private chat, with them as the only approver", async () => {
    const { gateway, calls } = fakeGateway();
    const tg = new TelegramService(gateway, db, pino({ level: "silent" }));
    await tg.approve("r1", "default");
    const patch = calls.filter((c) => c.method === "config.patch").map((c) => JSON.parse(c.params.raw as string)).at(-1);
    expect(patch).toEqual({ channels: { telegram: { execApprovals: { enabled: true, approvers: ["4242"], target: "dm" } } } });
    // The setting needs a restart; the panel asks for one when the Gateway did not restart by itself.
    expect(calls.some((c) => c.method === "gateway.restart.request")).toBe(true);
  });

  it("turns them off, and refuses to turn them on before there is an owner", async () => {
    const { gateway, calls } = fakeGateway();
    const tg = new TelegramService(gateway, db, pino({ level: "silent" }));
    await expect(tg.setApprovals(true)).rejects.toBeInstanceOf(TelegramError);
    await tg.setApprovals(false);
    const patch = JSON.parse(calls.find((c) => c.method === "config.patch")!.params.raw as string);
    expect(patch).toEqual({ channels: { telegram: { execApprovals: { enabled: false } } } });
  });
});
