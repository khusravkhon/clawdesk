import crypto from "node:crypto";
import path from "node:path";
import type { DeviceIdentity } from "@openclaw/gateway-client";
import { z } from "zod";
import { readJsonIfExists, writeSecureJson } from "../lib/secure-file.js";

// Ed25519 device identity in the exact shape OpenClaw 2026.8.1 verifies:
// deviceId = sha256(raw 32-byte public key) as hex, publicKey sent as
// base64url(raw), signature = base64url(ed25519(payload utf8)).

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const StoredIdentity = z.object({
  version: z.literal(1),
  deviceId: z.string().regex(/^[a-f0-9]{64}$/),
  publicKeyPem: z.string(),
  privateKeyPem: z.string(),
  createdAtMs: z.number().int(),
});

export function rawPublicKey(publicKeyPem: string): Buffer {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (der.length !== SPKI_ED25519_PREFIX.length + 32 || !der.subarray(0, SPKI_ED25519_PREFIX.length).equals(SPKI_ED25519_PREFIX)) {
    throw new Error("device public key is not a canonical Ed25519 SPKI key");
  }
  return der.subarray(SPKI_ED25519_PREFIX.length);
}

export function publicKeyRawBase64Url(publicKeyPem: string): string {
  return rawPublicKey(publicKeyPem).toString("base64url");
}

export function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(rawPublicKey(publicKeyPem)).digest("hex");
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  return crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privateKeyPem)).toString("base64url");
}

export function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { deviceId: fingerprintPublicKey(publicKeyPem), publicKeyPem, privateKeyPem };
}

export function deviceIdentityPath(dataDir: string): string {
  return path.join(dataDir, "gateway", "device-identity.json");
}

/** Loads the panel's device identity, creating it on first start. Fails loudly on a corrupted file. */
export function loadOrCreateDeviceIdentity(dataDir: string): DeviceIdentity {
  const file = deviceIdentityPath(dataDir);
  const raw = readJsonIfExists(file);
  if (raw !== undefined) {
    const stored = StoredIdentity.parse(raw);
    if (fingerprintPublicKey(stored.publicKeyPem) !== stored.deviceId) {
      throw new Error(`device identity at ${file} does not match its public key; restore it from backup or delete it to re-pair`);
    }
    return { deviceId: stored.deviceId, publicKeyPem: stored.publicKeyPem, privateKeyPem: stored.privateKeyPem };
  }
  const identity = generateDeviceIdentity();
  writeSecureJson(file, { version: 1, ...identity, createdAtMs: Date.now() });
  return identity;
}
