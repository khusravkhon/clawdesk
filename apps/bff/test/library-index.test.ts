import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { libraryContents } from "../src/db/schema.js";
import { findSnippets, LibraryService } from "../src/library/library-service.js";
import { registerLibraryRoutes } from "../src/routes/library.js";

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "library-index-"));
  const dbPath = path.join(dir, "panel.sqlite");
  const opened = openDb(dbPath);
  return { ...opened, dir, dbPath, library: new LibraryService(opened.db), cleanup: () => { opened.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const item = (text: string, agentId = "main", source = "first.txt", locator = "страница 2") => ({ agentId, kind: "document" as const, title: source, source, locator, text });

describe("indexed owner library", () => {
  it("pages filtered owner materials, returns extracted text and deletes an entry idempotently", async () => {
    const h = harness();
    const app = Fastify();
    registerLibraryRoutes(app, { library: h.library } as Parameters<typeof registerLibraryRoutes>[1]);
    try {
      for (let i = 0; i < 23; i++) h.library.add({ ...item("Русский маркер"), processing: "partial" });
      h.library.add(item("Русский маркер", "other"));
      h.library.add({ ...item("Русский маркер"), kind: "video", processing: "subtitles" });
      const encrypted = h.library.add({ ...item(""), processing: "encrypted" });
      const url = "/api/library?agentId=main&kind=document&q=" + encodeURIComponent("МАРКЕР");
      const first = (await app.inject(url)).json();
      expect(first.items).toHaveLength(20);
      expect(first.items.every((entry: { processing: string }) => entry.processing === "partial")).toBe(true);
      const second = (await app.inject(`${url}&beforeAt=${first.next.at}&beforeId=${first.next.id}`)).json();
      expect(second.items).toHaveLength(3);
      expect(second.next).toBeNull();
      expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(23);
      expect((await app.inject(`/api/library/${encrypted}`)).json()).toMatchObject({ item: { processing: "encrypted" }, text: "" });
      const detail = `/api/library/${first.items[0].id}`;
      expect((await app.inject(detail)).json()).toMatchObject({ text: "Русский маркер" });
      for (let i = 0; i < 2; i++) expect((await app.inject({ method: "DELETE", url: detail })).statusCode).toBe(204);
      expect((await app.inject(detail)).statusCode).toBe(404);
      expect(h.library.search("маркер", "other").hits).toHaveLength(1);
    } finally { await app.close(); h.cleanup(); }
  });

  it("finds older materials beyond the previous 500 row scan", () => {
    const h = harness();
    try {
      const id = h.library.add(item("старый уникальныймаркер"));
      for (let i = 0; i < 600; i++) h.library.add(item(`свежий материал ${i}`));
      expect(h.library.search("УНИКАЛЬНЫЙМАРКЕР", "main")).toMatchObject({ hits: [{ id }], searched: 1, partial: false });
    } finally { h.cleanup(); }
  });

  it("shares content while retaining every source, locator, ID and agent boundary", () => {
    const h = harness();
    try {
      const first = h.library.add(item("одинаковое содержимое"));
      const second = h.library.add(item("одинаковое содержимое", "main", "second.txt", "лист 3"));
      const other = h.library.add(item("одинаковое содержимое", "trainer", "secret.txt", "таймкод"));
      expect(h.db.select().from(libraryContents).all()).toHaveLength(1);
      const hits = h.library.search("содержимое", "main").hits;
      expect(hits.map(r => r.id).sort()).toEqual([first, second].sort());
      expect(hits.find(r => r.id === second)).toMatchObject({ source: "second.txt", locator: "лист 3" });
      h.library.remove(first!);
      expect(h.library.search("содержимое", "trainer").hits.map(r => r.id)).toEqual([other]);
      h.library.remove(second!);
      expect(h.db.select().from(libraryContents).all()).toHaveLength(1);
      h.library.remove(other!);
      expect(h.db.select().from(libraryContents).all()).toHaveLength(0);
      expect(h.library.search("содержимое").hits).toEqual([]);
      h.library.add(item("одинаковое содержимое"));
      expect(h.library.search("содержимое").hits).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("agrees with exact matching for Russian, Tajik, English, punctuation and Unicode", () => {
    const h = harness();
    const text = '😀 ҶӢҲАТҲОИ ӮЗБАКӢ РусСКИЙ English "quotes" a_b % literal\0посленуля İSTANBUL';
    try {
      h.library.add(item(text));
      for (const query of ["ҷиҳат", "ӮЗБАКӢ", "русский", "ENGL", '"quotes"', "a_b", "% literal", "посленуля", "😀 ҷ", "İST"]) {
        const expected = findSnippets(text, query.toLocaleLowerCase("ru"));
        const found = h.library.search(query);
        expect(found.hits.length, query).toBe(expected.length ? 1 : 0);
        if (expected.length) expect(found.hits[0]!.snippets, query).toEqual(expected);
      }
      expect(h.library.search("ENG OR missing").hits).toEqual([]);
    } finally { h.cleanup(); }
  });

  it("bounds short queries and marks omitted matches and candidates honestly", () => {
    const h = harness();
    try {
      for (let i = 0; i < 520; i++) h.library.add(item(`общий маркер ${i}`));
      const found = h.library.search("маркер", "main");
      expect(found.hits).toHaveLength(20);
      expect(found).toMatchObject({ partial: true, searched: 21 });
      const short = h.library.search("zz", "main");
      expect(short).toMatchObject({ partial: true, searched: 500, hits: [] });
      expect(h.library.search("zz", "trainer")).toMatchObject({ partial: false, searched: 0, hits: [] });
      expect(h.library.search(" ")).toMatchObject({ partial: false, searched: 0, hits: [] });
    } finally { h.cleanup(); }
  });

  it("migrates old duplicate materials, survives reopening, and supports explicit old-binary restoration", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "library-legacy-"));
    const dbPath = path.join(dir, "panel.sqlite");
    const rollbackPath = path.join(dir, "rollback.sqlite");
    const oldMigrations = path.join(dir, "migrations");
    fs.mkdirSync(path.join(oldMigrations, "meta"), { recursive: true });
    const source = fileURLToPath(new URL("../drizzle", import.meta.url));
    const journal = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((r: { idx: number }) => r.idx < 8);
    fs.writeFileSync(path.join(oldMigrations, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) fs.copyFileSync(path.join(source, `${entry.tag}.sql`), path.join(oldMigrations, `${entry.tag}.sql`));
    const legacy = new Database(dbPath);
    migrate(drizzle(legacy), { migrationsFolder: oldMigrations });
    for (let i = 0; i < 2; i++) legacy.prepare("INSERT INTO library_items(id,agent_id,kind,title,source,locator,text,chars,created_at) VALUES(?,?,'document',?,?,?,?,?,?)").run(`old-${i}`, i ? "trainer" : "main", `title-${i}`, `source-${i}`, `page-${i}`, "СТАРАЯ ПАМЯТЬ", 13, 123000 + i);
    for (let i = 0; i < 205; i++) legacy.prepare("INSERT INTO library_items(id,agent_id,kind,title,source,text,chars) VALUES(?,'main','document','old','old',?,?)").run(`batch-${i}`, `УНИКАЛЬНЫЙ БАТЧ ${i}`, `УНИКАЛЬНЫЙ БАТЧ ${i}`.length);
    const oldRows = legacy.prepare("SELECT * FROM library_items ORDER BY id").all();
    legacy.close();
    fs.copyFileSync(dbPath, rollbackPath);
    const handles: { close: () => void }[] = [];
    try {
      const migrated = openDb(dbPath);
      handles.push(migrated);
      const library = new LibraryService(migrated.db);
      expect(library.search("старая", "main").hits).toMatchObject([{ id: "old-0", source: "source-0", locator: "page-0", at: 123000 }]);
      expect(migrated.db.select().from(libraryContents).all()).toHaveLength(206);
      expect(migrated.db.select().from(libraryContents).all().every(row => row.folded !== null && row.hash !== null)).toBe(true);
      expect(library.search("батч 204").hits.map(hit => hit.id)).toEqual(["batch-204"]);
      migrated.close();
      const reopened = openDb(dbPath);
      handles.push(reopened);
      expect(new LibraryService(reopened.db).search("память", "trainer").hits).toHaveLength(1);
      reopened.close();
      // Reproduce a deployment where 0008 is still the latest applied migration.
      const rollbackJournal = { ...journal, entries: [...journal.entries, { idx: 8, version: "6", when: 1792230000000, tag: "0008_library_search", breakpoints: true }] };
      fs.writeFileSync(path.join(oldMigrations, "meta/_journal.json"), JSON.stringify(rollbackJournal));
      fs.copyFileSync(path.join(source, "0008_library_search.sql"), path.join(oldMigrations, "0008_library_search.sql"));
      const restored = new Database(rollbackPath);
      handles.push(restored);
      migrate(drizzle(restored), { migrationsFolder: oldMigrations });
      const plan = restored.prepare("EXPLAIN QUERY PLAN SELECT id, text FROM library_contents WHERE folded IS NULL LIMIT 100").all() as { detail: string }[];
      expect(plan.some(row => row.detail.includes("library_contents_pending_idx"))).toBe(true);
      expect(restored.prepare("SELECT count(*) AS n FROM library_contents WHERE folded IS NULL").get()).toEqual({ n: 206 });
      restored.exec(fs.readFileSync(path.join(source, "rollback-library-search.sql"), "utf8"));
      expect(restored.prepare("SELECT id,agent_id,kind,title,source,locator,text,chars,created_at FROM library_items ORDER BY id").all()).toEqual(oldRows);
      restored.prepare("INSERT INTO library_items(id,agent_id,kind,title,source,text,chars) VALUES('after-rollback','main','document','new','new','новая память',12)").run();
      restored.close();
      const upgradedAgain = openDb(rollbackPath);
      handles.push(upgradedAgain);
      expect(new LibraryService(upgradedAgain.db).search("новая").hits.map(hit => hit.id)).toEqual(["after-rollback"]);
      const check = new Database(rollbackPath);
      handles.push(check);
      expect(check.prepare("SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at IN (1792230000000, 1792231000000)").get()).toEqual({ n: 2 });
      expect(check.prepare("SELECT count(*) AS n FROM personal_reminders").get()).toEqual({ n: 0 });
    } finally {
      for (const handle of handles) { try { handle.close(); } catch { /* Already closed. */ } }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Every migration runs several times here; under a full parallel run that can pass the default 5 s.
  }, 30_000);

  it("refuses rollback of 0008 before changing data when newer migrations are applied", () => {
    const h = harness();
    try {
      h.library.add(item("сохранить материал"));
      const sqlite = new Database(h.dbPath);
      try {
        sqlite.prepare("INSERT INTO personal_reminders(id,request_id,text,due_at,expires_at,time_zone) VALUES('reminder','request','keep reminder',1,2,'UTC')").run();
        const snapshot = () => ({
          schema: sqlite.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),
          journal: sqlite.prepare("SELECT * FROM __drizzle_migrations ORDER BY id").all(),
          items: sqlite.prepare("SELECT * FROM library_items ORDER BY id").all(),
          contents: sqlite.prepare("SELECT * FROM library_contents ORDER BY id").all(),
          reminders: sqlite.prepare("SELECT * FROM personal_reminders ORDER BY id").all(),
        });
        const before = snapshot();
        const script = fs.readFileSync(fileURLToPath(new URL("../drizzle/rollback-library-search.sql", import.meta.url)), "utf8");
        expect(() => sqlite.exec(script)).toThrow("newer migrations are applied");
        expect(sqlite.inTransaction).toBe(false);
        expect(snapshot()).toEqual(before);
        expect(sqlite.prepare("SELECT name FROM sqlite_temp_master").all()).toEqual([]);
        expect(h.library.search("сохранить").hits).toHaveLength(1);
      } finally { sqlite.close(); }
    } finally { h.cleanup(); }
  });
});
