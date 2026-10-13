import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Fastify from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { AuthService } from "../src/auth/auth-service.js";
import { decryptFile, encryptStream, isEncryptedBackup, WrongBackupPassword } from "../src/backups/backup-crypto.js";
import { BackupService } from "../src/backups/backup-service.js";
import { openDb } from "../src/db/client.js";
import type { BridgeBackup, BridgeClient } from "../src/gateway/bridge-client.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerSystemRoutes } from "../src/routes/system.js";

const PASSWORD = "backup passphrase 1";

// scrypt is slow on purpose; under a parallel run these tests need more than the default 5 s.
describe("backups", { timeout: 30_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-backups-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function fakeBridge() {
    const calls: string[] = [];
    const bridge = {
      backupCreate: async (kind: BridgeBackup["kind"]) => {
        calls.push(`create:${kind}`);
        const name = `clawdesk-2026-10-13T03-30-00Z-${kind}.tar`;
        fs.writeFileSync(path.join(dir, name), "archive");
        return { name, kind, createdAt: "2026-10-13T03:30:00Z", size: 7 };
      },
      factoryReset: async (code: string) => {
        calls.push(`reset:${code}`);
        return { started: true as const };
      },
    } as unknown as BridgeClient;
    return { bridge, calls };
  }

  /** `backupDir: null`: host development, no backups folder. */
  const service = (bridge: BridgeClient, now = new Date(2026, 9, 13, 3, 10), backupDir: string | null = dir) =>
    new BackupService({ bridge, dir: backupDir ?? undefined, logger: pino({ level: "silent" }), now: () => now });

  it("encrypts a copy that only the password opens", async () => {
    const plain = Buffer.concat([Buffer.from("tar archive "), fs.readFileSync(process.execPath).subarray(0, 300_000)]);
    const enc = path.join(dir, "b.tar.enc");
    await pipeline(await encryptStream(Readable.from([plain.subarray(0, 1000), plain.subarray(1000)]), PASSWORD), fs.createWriteStream(enc));
    expect(isEncryptedBackup(enc)).toBe(true);
    expect(fs.readFileSync(enc).includes(Buffer.from("tar archive"))).toBe(false);

    const out = path.join(dir, "b.tar");
    await decryptFile(enc, out, PASSWORD);
    expect(fs.readFileSync(out).equals(plain)).toBe(true);

    fs.rmSync(out);
    await expect(decryptFile(enc, out, "another password")).rejects.toBeInstanceOf(WrongBackupPassword);
    expect(fs.existsSync(out)).toBe(false);

    const bytes = fs.readFileSync(enc);
    bytes[bytes.length - 40]! ^= 1; // a flipped bit is caught too
    fs.writeFileSync(enc, bytes);
    await expect(decryptFile(enc, out, PASSWORD)).rejects.toBeInstanceOf(WrongBackupPassword);
  });

  it("lists the backups folder, newest first, ignoring other files", () => {
    for (const n of ["clawdesk-2026-10-11T03-30-00Z-daily.tar", "clawdesk-2026-10-12T10-00-05Z-manual.tar", ".staging-x", "notes.txt"]) fs.writeFileSync(path.join(dir, n), "x");
    const list = service(fakeBridge().bridge).list();
    expect(list.map((b) => [b.kind, b.createdAt])).toEqual([
      ["manual", "2026-10-12T10:00:05Z"],
      ["daily", "2026-10-11T03:30:00Z"],
    ]);
  });

  it("makes the nightly backup once a night, and catches up when one was missed", async () => {
    const { bridge, calls } = fakeBridge();
    // Last night's backup at 03:10 local time (the window is in the panel's time zone).
    const last = new Date(2026, 9, 12, 3, 10);
    const stamp = last.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
    fs.writeFileSync(path.join(dir, `clawdesk-${stamp}-daily.tar`), "x");
    const tick = (now: Date) => service(bridge, now).tick();

    expect(await tick(new Date(2026, 9, 12, 4, 10))).toBe(false); // same night, already done
    expect(await tick(new Date(2026, 9, 12, 14, 0))).toBe(false); // daytime
    expect(await tick(new Date(2026, 9, 13, 3, 5))).toBe(true); // next night
    fs.rmSync(path.join(dir, "clawdesk-2026-10-13T03-30-00Z-daily.tar"));
    expect(await tick(new Date(2026, 9, 13, 17, 0))).toBe(true); // a missed night: overdue, any hour
    expect(calls).toEqual(["create:daily", "create:daily"]);
  });

  it("does nothing in host development (no backups folder)", async () => {
    const { bridge, calls } = fakeBridge();
    const svc = service(bridge, new Date(), null);
    expect(svc.status()).toMatchObject({ available: false, backups: [] });
    expect(await svc.tick()).toBe(false);
    await expect(svc.create("manual")).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  describe("routes", () => {
    let close: () => void;

    afterEach(() => close?.());

    async function setup(backupDir: string | null = dir) {
      const opened = openDb(path.join(dir, "panel.sqlite"));
      close = opened.close;
      const auth = new AuthService({ db: opened.db, dataDir: path.join(dir, "data"), logger: pino({ level: "silent" }) });
      const { token } = await auth.setOwnerPassword(auth.ownerCodeForFirstRun()!, "owner password 1", "ip", "ua");
      const { bridge, calls } = fakeBridge();
      const backups = service(bridge, new Date(), backupDir);
      const app = Fastify();
      // As in app.ts: invalid requests are 400.
      app.setErrorHandler((error, _req, reply) => reply.status(error instanceof ZodError ? 400 : 500).send({ error: String(error) }));
      registerAuthRoutes(app, { auth });
      registerSystemRoutes(app, { backups, auth });
      await app.ready();
      return { app, calls, cookie: `clawdesk_session=${token}` };
    }

    it("factory reset needs the password, backs up first, and hands back the new owner code", async () => {
      const { app, calls, cookie } = await setup();
      expect((await app.inject({ method: "POST", url: "/api/system/reset", payload: { password: "owner password 1", confirm: true } })).statusCode).toBe(401);
      const wrong = await app.inject({ method: "POST", url: "/api/system/reset", headers: { cookie }, payload: { password: "nope", confirm: true } });
      expect(wrong.statusCode).toBe(401);
      expect(calls).toEqual([]);
      const unconfirmed = await app.inject({ method: "POST", url: "/api/system/reset", headers: { cookie }, payload: { password: "owner password 1" } });
      expect(unconfirmed.statusCode).toBe(400);

      const ok = await app.inject({ method: "POST", url: "/api/system/reset", headers: { cookie }, payload: { password: "owner password 1", confirm: true } });
      expect(ok.statusCode).toBe(200);
      const { ownerCode, backup } = ok.json() as { ownerCode: string; backup: string };
      expect(ownerCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(backup).toContain("before-reset");
      expect(calls).toEqual(["create:before-reset", `reset:${ownerCode}`]);
      await app.close();
    });

    it("refuses a reset where backups cannot be made", async () => {
      const { app, calls, cookie } = await setup(null);
      const res = await app.inject({ method: "POST", url: "/api/system/reset", headers: { cookie }, payload: { password: "owner password 1", confirm: true } });
      expect(res.statusCode).toBe(409);
      expect(calls).toEqual([]);
      await app.close();
    });

    it("downloads only existing backups, encrypted", async () => {
      const { app, cookie } = await setup();
      fs.writeFileSync(path.join(dir, "clawdesk-2026-10-13T03-30-00Z-daily.tar"), "secret tokens");
      const bad = await app.inject({ method: "POST", url: "/api/system/backups/..%2Fpanel.sqlite/download", headers: { cookie }, payload: { password: PASSWORD } });
      expect(bad.statusCode).toBe(404);
      const weak = await app.inject({ method: "POST", url: "/api/system/backups/clawdesk-2026-10-13T03-30-00Z-daily.tar/download", headers: { cookie }, payload: { password: "short" } });
      expect(weak.statusCode).toBe(400);
      const res = await app.inject({ method: "POST", url: "/api/system/backups/clawdesk-2026-10-13T03-30-00Z-daily.tar/download", headers: { cookie }, payload: { password: PASSWORD } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-disposition"]).toBe('attachment; filename="clawdesk-2026-10-13T03-30-00Z-daily.tar.enc"');
      expect(res.rawPayload.includes(Buffer.from("secret tokens"))).toBe(false);
      await app.close();
    });
  });
});
