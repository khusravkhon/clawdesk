import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { BackupDto, BackupKind, BackupsDto, FactoryResetResultDto } from "@clawdesk/shared";
import type { Logger } from "pino";
import { randomCode } from "../auth/owner-code.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import { encryptStream } from "./backup-crypto.js";

// Backups (screen 14). The ClawDesk bridge makes them in the Gateway container
// (deploy/clawdesk-backup.mjs); the panel sees the backups folder read-only, lists it, makes one
// every night and hands a copy out encrypted with the owner's password.

const NAME = /^clawdesk-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z-(daily|manual|before-reset|before-update)\.tar$/;
const CHECK_EVERY_MS = 30 * 60_000;
/** Nightly window (panel time zone); a backup older than this is made outside the window too. */
const NIGHT = { from: 3, to: 6 };
const DAY_MS = 24 * 60 * 60_000;
const OVERDUE_MS = 36 * 60 * 60_000;

export class BackupUnavailableError extends Error {}

export type BackupDeps = {
  bridge: BridgeClient;
  /** The backups folder as the panel sees it; unset in host development. */
  dir: string | undefined;
  logger: Logger;
  now?: () => Date;
};

export class BackupService {
  readonly #now: () => Date;
  #running = false;
  #lastError: string | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: BackupDeps) {
    this.#now = deps.now ?? (() => new Date());
  }

  get available(): boolean {
    return !!this.deps.dir;
  }

  status(): BackupsDto {
    return { available: this.available, backups: this.list(), running: this.#running, lastError: this.#lastError };
  }

  list(): BackupDto[] {
    const dir = this.deps.dir;
    if (!dir) return [];
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .flatMap((name) => {
        const m = NAME.exec(name);
        if (!m) return [];
        try {
          const stat = fs.lstatSync(path.join(dir, name));
          if (!stat.isFile()) return [];
          return [{ name, kind: m[5] as BackupKind, createdAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`, size: stat.size }];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  async create(kind: BackupKind): Promise<BackupDto> {
    if (!this.available) throw new BackupUnavailableError("backups work in the installed panel");
    this.#running = true;
    try {
      const made = await this.deps.bridge.backupCreate(kind);
      this.#lastError = null;
      this.deps.logger.info({ name: made.name, size: made.size }, "backup made");
      return made;
    } catch (error) {
      this.#lastError = (error as Error).message;
      throw error;
    } finally {
      this.#running = false;
    }
  }

  /** The archive, encrypted with `password`, for the browser to save. */
  async download(name: string, password: string): Promise<{ stream: Readable; filename: string }> {
    const dir = this.deps.dir;
    if (!dir || !NAME.test(name)) throw new BackupUnavailableError("no such backup");
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new BackupUnavailableError("no such backup");
    return { stream: await encryptStream(fs.createReadStream(file), password), filename: `${name}.enc` };
  }

  async remove(name: string): Promise<{ deleted: true; name: string }> {
    if (!this.available || !NAME.test(name)) throw new BackupUnavailableError("no such backup");
    const result = await this.deps.bridge.backupDelete(name);
    this.deps.logger.info({ name }, "backup deleted");
    return result;
  }

  /**
   * Factory reset: a backup first, then the bridge wipes everything and restarts the stack. The new
   * owner code goes back to the person who asked (signed in and password-checked by the route), so
   * they can set a new password without the server's terminal.
   */
  async factoryReset(): Promise<FactoryResetResultDto> {
    const backup = await this.create("before-reset");
    const ownerCode = randomCode();
    await this.deps.bridge.factoryReset(ownerCode);
    this.deps.logger.warn({ backup: backup.name }, "factory reset started");
    return { ownerCode, backup: backup.name };
  }

  /** Nightly backup: checked every half hour, made between 03:00 and 06:00 once a day. */
  startSchedule(): void {
    if (!this.available || this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
    this.#timer.unref();
  }

  stopSchedule(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One scheduler step; exposed for tests. */
  async tick(): Promise<boolean> {
    if (!this.available || this.#running) return false;
    const now = this.#now();
    const last = this.list().find((b) => b.kind !== "before-reset");
    const age = last ? now.getTime() - Date.parse(last.createdAt) : Infinity;
    const night = now.getHours() >= NIGHT.from && now.getHours() < NIGHT.to;
    if (!(age > OVERDUE_MS || (night && age > DAY_MS - CHECK_EVERY_MS * 2))) return false;
    try {
      await this.create("daily");
    } catch (error) {
      this.deps.logger.error({ err: error }, "nightly backup failed");
    }
    return true;
  }
}
