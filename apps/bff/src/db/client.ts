import fs from "node:fs";
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
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, close: () => sqlite.close() };
}
