import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { LibraryService } from "../src/library/library-service.js";
import { TelegramLibraryImport } from "../src/library/telegram-import.js";

type File = { id: string; name: string; mimeType: string; size: number; modifiedAt: number; agentIds: string[] };
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function setup(files: File[], bodies: Record<string, string>, now = 10_000_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-tg-library-"));
  const opened = openDb(path.join(dir, "panel.sqlite"));
  cleanups.push(() => { opened.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const library = new LibraryService(opened.db);
  const reads: string[] = [];
  const bridge = {
    libraryInbound: async (after: number) => ({ files: files.filter((f) => f.modifiedAt >= after), more: false }),
    libraryInboundRead: async (id: string) => {
      reads.push(id);
      if (!(id in bodies)) throw new Error("file_missing");
      return { id, mimeType: "text/plain", base64: Buffer.from(bodies[id]!).toString("base64") };
    },
  };
  const state = { now };
  const importer = new TelegramLibraryImport({ db: opened.db, bridge, library, logger: { warn: () => {}, info: () => {} }, now: () => state.now });
  return { importer, library, reads, state };
}
const txt = (id: string, at: number, agentIds: string[]): File => ({ id, name: `${id}.txt`, mimeType: "text/plain", size: 10, modifiedAt: at, agentIds });

describe("Telegram documents in the library", () => {
  it("files each document once under every agent that received it, with its text searchable", async () => {
    const t = setup([txt("a", 1000, ["dietitian"]), txt("b", 2000, ["main", "trainer"])], { a: "Лимонный манник: манка, творог", b: "План тренировок" });
    expect(await t.importer.tick()).toBe(2);
    expect(t.library.search("манник", "dietitian").hits.map((h) => h.source)).toEqual(["Telegram: a.txt"]);
    expect(t.library.recent("trainer").map((h) => h.title)).toEqual(["b.txt"]);
    expect(t.library.recent("main")).toHaveLength(1);
    // The next pass reads nothing again.
    expect(await t.importer.tick()).toBe(0);
    expect(t.reads).toEqual(["a", "b"]);
  });

  it("waits for a file whose agent is not known yet, and gives up on it after an hour", async () => {
    const t = setup([txt("young", 9_000_000, []), txt("later", 9_500_000, ["main"])], { later: "текст" });
    expect(await t.importer.tick()).toBe(0);
    expect(t.reads).toEqual([]);
    t.state.now = 9_000_000 + 61 * 60_000;
    expect(await t.importer.tick()).toBe(1);
    expect(t.reads).toEqual(["later"]);
  });

  it("does not add a second entry when the agent already has the same text, and skips files that are gone", async () => {
    const t = setup([txt("gone", 1000, ["main"]), txt("copy", 2000, ["main"])], { copy: "Тот же документ" });
    t.library.add({ agentId: "main", kind: "document", title: "из чата.txt", source: "из чата.txt", text: "Тот же документ" });
    await t.importer.tick();
    expect(t.library.recent("main").map((h) => h.title)).toEqual(["из чата.txt"]);
    expect(t.reads).toEqual(["gone", "copy"]);
  });
});
