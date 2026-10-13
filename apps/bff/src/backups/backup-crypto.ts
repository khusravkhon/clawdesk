import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// A downloaded backup holds every token of the install, so it leaves the server encrypted with a
// password the owner types at download time. AES-256-GCM, key from scrypt.
//
//   MAGIC | salt (16) | iv (12) | ciphertext | GCM tag (16)
//
// deploy/scripts/restore.sh decrypts it with cli/backup-decrypt.

export const MAGIC = Buffer.from("CLAWDESK-BACKUP-ENC-1\n");
const SALT = 16;
const IV = 12;
const TAG = 16;
const HEADER = MAGIC.length + SALT + IV;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const N = 2 ** 15;
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function encryptStream(input: Readable, password: string): Promise<Readable> {
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", await deriveKey(password, salt), iv);
  return Readable.from(
    (async function* () {
      yield Buffer.concat([MAGIC, salt, iv]);
      for await (const chunk of input) {
        const out = cipher.update(chunk as Buffer);
        if (out.length) yield out;
      }
      const last = cipher.final();
      if (last.length) yield last;
      yield cipher.getAuthTag();
    })(),
  );
}

export class WrongBackupPassword extends Error {}

export function isEncryptedBackup(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, head, 0, MAGIC.length, 0);
    return head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/** Decrypts to `outFile`; a wrong password or a damaged file leaves nothing behind. */
export async function decryptFile(inFile: string, outFile: string, password: string): Promise<void> {
  const size = fs.statSync(inFile).size;
  if (size < HEADER + TAG || !isEncryptedBackup(inFile)) throw new Error("not an encrypted ClawDesk backup");
  const fd = fs.openSync(inFile, "r");
  const header = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  try {
    fs.readSync(fd, header, 0, HEADER, 0);
    fs.readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    fs.closeSync(fd);
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT);
  const iv = header.subarray(MAGIC.length + SALT);
  const decipher = createDecipheriv("aes-256-gcm", await deriveKey(password, salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(inFile, { start: HEADER, end: size - TAG - 1 }), decipher, fs.createWriteStream(outFile, { mode: 0o600 }));
  } catch (error) {
    fs.rmSync(outFile, { force: true });
    if (/authenticate/i.test((error as Error).message)) throw new WrongBackupPassword("wrong password or damaged file");
    throw error;
  }
}
