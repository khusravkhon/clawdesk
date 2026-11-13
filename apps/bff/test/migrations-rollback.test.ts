import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

// After an update the panel may have to go back to the previous version with the database the new one already
// migrated (the "before-update" archive restores data, but a quick rollback of the image keeps the file).
// That only works while every migration is additive for the old code: nothing it reads disappears, and
// nothing it inserts without becomes required. These checks keep each new migration that way.

const DIR = path.join(import.meta.dirname, "..", "drizzle");
const journal = JSON.parse(fs.readFileSync(path.join(DIR, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };

type Column = { name: string; notnull: number; dflt_value: string | null; pk: number };
type Shape = Map<string, Map<string, Column>>;

function shapeOf(db: Database.Database): Shape {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all() as { name: string }[];
  return new Map(tables.map(({ name }) => [name, new Map((db.prepare(`PRAGMA table_info(\`${name}\`)`).all() as Column[]).map((c) => [c.name, c]))]));
}

function migrationsSteps(): { tag: string; before: Shape; after: Shape }[] {
  const db = new Database(":memory:");
  const steps: { tag: string; before: Shape; after: Shape }[] = [];
  for (const { tag } of journal.entries) {
    const before = shapeOf(db);
    db.exec(fs.readFileSync(path.join(DIR, `${tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
    steps.push({ tag, before, after: shapeOf(db) });
  }
  db.close();
  return steps;
}

describe("migrations stay safe to roll back from", () => {
  const steps = migrationsSteps();

  it("apply in order on an empty database", () => {
    expect(steps).toHaveLength(journal.entries.length);
    expect(steps.at(-1)!.after.get("work_requests")?.size).toBeGreaterThan(5);
  });

  it("never remove a table or a column the previous version uses", () => {
    const problems: string[] = [];
    for (const { tag, before, after } of steps) {
      for (const [table, columns] of before) {
        if (!after.has(table)) { problems.push(`${tag}: table ${table} removed`); continue; }
        for (const column of columns.keys()) if (!after.get(table)!.has(column)) problems.push(`${tag}: column ${table}.${column} removed`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("only add columns the previous version can leave out of its inserts", () => {
    const problems: string[] = [];
    for (const { tag, before, after } of steps) {
      for (const [table, columns] of after) {
        const old = before.get(table);
        if (!old) continue; // a new table: the old code never writes it
        for (const [name, column] of columns) {
          if (old.has(name) || column.pk) continue;
          if (column.notnull && column.dflt_value === null) problems.push(`${tag}: ${table}.${name} is NOT NULL without a default`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
