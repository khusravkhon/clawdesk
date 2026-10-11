import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  deviceIdentityPath,
  fingerprintPublicKey,
  generateDeviceIdentity,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64Url,
  signDevicePayload,
} from "../src/gateway/device-identity.js";
import { DeviceTokenStore } from "../src/gateway/token-store.js";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Mirrors the Gateway's verifier: raw key from base64url, SPKI-wrapped, Ed25519 verify.
function gatewayVerifies(publicKeyB64Url: string, payload: string, signatureB64Url: string): boolean {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyB64Url, "base64url")]);
  const key = crypto.createPublicKey({ key: spki, type: "spki", format: "der" });
  return crypto.verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signatureB64Url, "base64url"));
}

describe("device identity", () => {
  it("derives deviceId as sha256 of the raw 32-byte public key", () => {
    const id = generateDeviceIdentity();
    const raw = Buffer.from(publicKeyRawBase64Url(id.publicKeyPem), "base64url");
    expect(raw).toHaveLength(32);
    expect(id.deviceId).toBe(crypto.createHash("sha256").update(raw).digest("hex"));
    expect(id.deviceId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces signatures the gateway accepts for the v3 connect payload", () => {
    const id = generateDeviceIdentity();
    const payload = buildDeviceAuthPayloadV3({
      deviceId: id.deviceId,
      clientId: "gateway-client",
      clientMode: "backend",
      role: "operator",
      scopes: ["operator.admin"],
      signedAtMs: 1_700_000_000_000,
      token: "shared",
      nonce: "nonce-123",
      platform: "linux",
    });
    const signature = signDevicePayload(id.privateKeyPem, payload);
    expect(gatewayVerifies(publicKeyRawBase64Url(id.publicKeyPem), payload, signature)).toBe(true);
    expect(gatewayVerifies(publicKeyRawBase64Url(id.publicKeyPem), `${payload}x`, signature)).toBe(false);
  });

  it("persists the identity and reloads the same one", () => {
    const dir = tmpDir();
    const first = loadOrCreateDeviceIdentity(dir);
    const second = loadOrCreateDeviceIdentity(dir);
    expect(second).toEqual(first);
    if (process.platform !== "win32") {
      expect(fs.statSync(deviceIdentityPath(dir)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses an identity file whose deviceId does not match its key", () => {
    const dir = tmpDir();
    loadOrCreateDeviceIdentity(dir);
    const file = deviceIdentityPath(dir);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.deviceId = fingerprintPublicKey(generateDeviceIdentity().publicKeyPem);
    fs.writeFileSync(file, JSON.stringify(stored));
    expect(() => loadOrCreateDeviceIdentity(dir)).toThrow(/does not match/);
  });
});

describe("device token store", () => {
  it("stores, loads and clears tokens per device and role", () => {
    const store = new DeviceTokenStore(tmpDir());
    const key = { deviceId: "abc", role: "operator" };
    expect(store.load(key)).toBeNull();
    store.store({ ...key, token: "tok-1", scopes: ["operator.read"] });
    expect(store.load(key)).toEqual({ token: "tok-1", scopes: ["operator.read"] });
    expect(store.load({ deviceId: "abc", role: "node" })).toBeNull();
    store.clear(key);
    expect(store.has(key)).toBe(false);
  });
});
