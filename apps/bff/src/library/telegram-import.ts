import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { getSetting, putSetting } from "../db/settings.js";
import { DocumentWorkerError } from "../documents/office-worker-pool.js";
import { extractDocument } from "../documents/extract.js";
import type { BridgeClient } from "../gateway/bridge-client.js";
import type { LibraryService } from "./library-service.js";

// Documents the owner sends to the bot in Telegram reach the agent through OpenClaw, never through the panel's
// chat, so the library did not know them. This picks them up in the order they arrived: the panel reads the
// text the same way as for a file sent in its chat and files it under every agent that received it.

const STATE = "library.telegramImport";
/** OpenClaw may write the agent's turn a little after the file: until then the file waits, at most this long. */
const AGENT_WAIT_MS = 60 * 60_000;

type ImportState = { after: number; done: string[] };
type Bridge = Pick<BridgeClient, "libraryInbound" | "libraryInboundRead">;

export class TelegramLibraryImport {
  #running: Promise<number> | undefined;
  constructor(private readonly deps: { db: Db; bridge: Bridge; library: Pick<LibraryService, "add">; logger: Pick<Logger, "warn" | "info">; now?: () => number }) {}

  /** One pass; returns how many documents were filed. Overlapping calls share the pass. */
  tick(): Promise<number> {
    this.#running ??= this.#tick().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async #tick(): Promise<number> {
    const now = this.deps.now?.() ?? Date.now();
    const state = getSetting<ImportState>(this.deps.db, STATE) ?? { after: 0, done: [] };
    let filed = 0;
    for (let page = 0; page < 10; page++) {
      const { files, more } = await this.deps.bridge.libraryInbound(state.after);
      let progressed = false;
      for (const file of files) {
        if (file.modifiedAt === state.after && state.done.includes(file.id)) continue;
        // Not yet in any agent's data: wait for it; past the wait it is nobody's to file.
        if (!file.agentIds.length && now - file.modifiedAt < AGENT_WAIT_MS) return this.#save(state, filed);
        if (file.agentIds.length) {
          let read;
          try {
            const { base64 } = await this.deps.bridge.libraryInboundRead(file.id);
            read = await extractDocument({ fileName: file.name, mimeType: file.mimeType, bytes: Buffer.from(base64, "base64") });
          } catch (error) {
            // A busy reader is retried on the next pass; a file that vanished or cannot be read is skipped.
            if (error instanceof DocumentWorkerError && error.code === "document_queue_full") return this.#save(state, filed);
            this.deps.logger.warn({ err: error, file: file.id }, "could not read a Telegram document for the library");
            read = null;
          }
          if (read) {
            const r = read.read;
            const locator = r.pages !== null ? "страница" : r.sheets !== null ? "лист" : r.slides !== null ? "слайд" : null;
            for (const agentId of file.agentIds) {
              this.deps.library.add({ agentId, kind: "document", title: file.name, source: `Telegram: ${file.name}`, locator, text: read.text, processing: r.state, once: true });
            }
            filed++;
          }
        }
        if (file.modifiedAt > state.after) { state.after = file.modifiedAt; state.done = []; }
        state.done.push(file.id);
        progressed = true;
      }
      if (!more || !progressed) break;
    }
    return this.#save(state, filed);
  }

  #save(state: ImportState, filed: number): number {
    putSetting(this.deps.db, STATE, state);
    if (filed) this.deps.logger.info({ filed }, "Telegram documents added to the library");
    return filed;
  }
}
