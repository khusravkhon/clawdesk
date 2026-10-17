import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

// apps/bff/drizzle, reachable from both src/db (tsx) and dist/db (node).
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function openDb(dbPath: string): { db: Db; close: () => void } {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    // SQLite's lower() only folds ASCII. Backfill old materials using the same Unicode folding
    // as exact substring matching; triggers keep the trigram index in the same transaction.
    sqlite.transaction(() => {
      const write = sqlite.prepare("UPDATE library_contents SET folded = ?, hash = ? WHERE id = ?");
      // Materialize bounded batches: better-sqlite3 cannot update while its iterator is active.
      const pending = sqlite.prepare("SELECT id, text FROM library_contents WHERE folded IS NULL LIMIT 100");
      let rows;
      while ((rows = pending.all() as { id: number; text: string }[]).length) {
        for (const row of rows) write.run(row.text.toLocaleLowerCase("ru"), createHash("sha256").update(row.text).digest("hex"), row.id);
      }
    })();
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return { db, close: () => sqlite.close() };
}
