import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { settings } from "./schema.js";

export function getSetting<T>(db: Db, key: string): T | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return (row?.value as T | undefined) ?? null;
}

export function putSetting(db: Db, key: string, value: unknown): void {
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } }).run();
}
