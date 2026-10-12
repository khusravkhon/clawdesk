import { randomInt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Owner code: lets whoever has the server set the owner's password — on the first run (so a stranger
// who finds the address first cannot claim the panel) and when the password is forgotten.
// Kept in the panel's data folder next to the Gateway device key; the running panel reads the file on
// every check, so the CLI (scripts/owner-code.ts) can issue a new code without a restart.

const FILE = "owner-code";
// No 0/O, 1/I/L: the code is read off a terminal and typed by hand.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** XXXX-XXXX-XXXX from a 31-letter alphabet, about 59 bits. */
export function randomCode(groups = 3): string {
  return Array.from({ length: groups }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")).join("-");
}

/** Codes are compared without dashes and case, as people type them. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function sameCode(given: string, expected: string): boolean {
  const a = Buffer.from(normalizeCode(given));
  const b = Buffer.from(normalizeCode(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class OwnerCodeFile {
  readonly #file: string;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, FILE);
  }

  read(): string | null {
    try {
      return fs.readFileSync(this.#file, "utf8").trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Replaces any earlier code. */
  issue(): string {
    const code = randomCode();
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${code}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
    return code;
  }

  existingOrNew(): string {
    return this.read() ?? this.issue();
  }

  matches(given: string): boolean {
    const code = this.read();
    return !!code && sameCode(given, code);
  }

  /** A code works once. */
  consume(): void {
    fs.rmSync(this.#file, { force: true });
  }
}
