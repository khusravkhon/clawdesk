import { createHash, randomUUID } from "node:crypto";
import type { LibraryHitDto, LibraryItemKind, LibrarySearchDto } from "@clawdesk/shared";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { libraryContents, libraryItems } from "../db/schema.js";

// What the panel has already read for an agent: documents from the chat and video transcripts.
// A search answers "which material said this" and points back at the source, and it only ever
// looks at the materials of the agent in question — the panel never widens an agent's access.

/** Characters kept per material; the text was already bounded when it was read. */
const MAX_ITEM_CHARS = 60_000;
/** Candidate materials one search reads. Beyond this it says it stopped, instead of quietly missing some. */
const MAX_SEARCHED = 500;
const MAX_HITS = 20;
const MAX_SNIPPETS = 3;
const SNIPPET_BEFORE = 90;
const SNIPPET_AFTER = 150;

export type NewLibraryItem = { agentId: string; kind: LibraryItemKind; title: string; source: string; locator?: string | null; text: string };

export class LibraryService {
  constructor(private readonly db: Db) {}

  /** Keeps one material for later. Empty text is not stored: there would be nothing to find. */
  add(item: NewLibraryItem): string | null {
    const text = item.text.trim().slice(0, MAX_ITEM_CHARS);
    if (!text) return null;
    const id = randomUUID();
    this.db.transaction((tx) => {
      const hash = createHash("sha256").update(text).digest("hex");
      // Hash narrows the lookup without a second full-text B-tree; compare text for collisions.
      let content = tx.select({ id: libraryContents.id }).from(libraryContents).where(and(eq(libraryContents.hash, hash), eq(libraryContents.text, text))).get();
      content ??= tx.insert(libraryContents).values({ text, hash, folded: text.toLocaleLowerCase("ru") }).returning({ id: libraryContents.id }).get();
      tx.insert(libraryItems)
        .values({ id, agentId: item.agentId, kind: item.kind, title: item.title.slice(0, 300), source: item.source.slice(0, 2000), locator: item.locator ?? null, text: "", contentId: content.id, chars: text.length })
        .run();
    });
    return id;
  }

  /** Recent materials, newest first; of one agent, or of all of them for the owner's own view. */
  recent(agentId?: string, limit = 20): LibraryHitDto[] {
    const rows = agentId
      ? this.db.select().from(libraryItems).where(eq(libraryItems.agentId, agentId)).orderBy(desc(libraryItems.createdAt)).limit(limit).all()
      : this.db.select().from(libraryItems).orderBy(desc(libraryItems.createdAt)).limit(limit).all();
    return rows.map((row) => toHit(row, []));
  }

  /**
   * Finds the materials whose text contains `query`, case-insensitively, in the agent's own
   * materials. Exact matching runs here because SQLite's own case folding covers ASCII only,
   * and these materials are mostly Russian. Trigrams narrow candidates using the same JS fold.
   */
  search(query: string, agentId?: string): LibrarySearchDto {
    const needle = query.trim().toLocaleLowerCase("ru");
    if (!needle) return { query: query.trim(), agentId: agentId ?? null, hits: [], searched: 0, partial: false };
    // FTS5 trigrams require three Unicode codepoints and do not index NUL. Short queries
    // retain a bounded exact scan, with partial=true when older materials remain unchecked.
    const indexed = Array.from(needle).length >= 3 && !needle.includes("\0");
    const match = `"${needle.replaceAll('"', '""')}"`;
    const rows = this.db.select({ ...getTableColumns(libraryItems), text: sql<string>`coalesce(${libraryContents.text}, ${libraryItems.text})` })
      .from(libraryItems).leftJoin(libraryContents, eq(libraryItems.contentId, libraryContents.id))
      .where(and(agentId ? eq(libraryItems.agentId, agentId) : undefined,
        indexed ? sql`${libraryItems.contentId} IN (SELECT rowid FROM library_search WHERE library_search MATCH ${match})` : undefined))
      .orderBy(desc(libraryItems.createdAt), desc(libraryItems.id)).limit(MAX_SEARCHED + 1).all();
    let partial = rows.length > MAX_SEARCHED;
    let searched = 0;
    const hits: LibraryHitDto[] = [];
    for (const row of rows.slice(0, MAX_SEARCHED)) {
      searched++;
      const snippets = findSnippets(row.text, needle);
      if (snippets.length) hits.push(toHit(row, snippets));
      if (hits.length > MAX_HITS) { partial = true; break; }
    }
    return { query: query.trim(), agentId: agentId ?? null, hits: hits.slice(0, MAX_HITS), searched, partial };
  }

  /** Removes one material: the owner's library is theirs to prune. */
  remove(id: string): boolean {
    return this.db.delete(libraryItems).where(eq(libraryItems.id, id)).run().changes > 0;
  }
}

type Row = typeof libraryItems.$inferSelect;

const toHit = (row: Row, snippets: { text: string; from: number }[]): LibraryHitDto => ({
  id: row.id,
  agentId: row.agentId,
  kind: row.kind,
  title: row.title,
  source: row.source,
  locator: row.locator,
  chars: row.chars,
  at: row.createdAt.getTime(),
  snippets,
});

/**
 * Up to three pieces of the text around the match, each starting at a word boundary where one is
 * near, with the offset so the panel can say where in the material the match sits.
 */
export function findSnippets(text: string, needle: string, limit = MAX_SNIPPETS): { text: string; from: number }[] {
  const haystack = text.toLocaleLowerCase("ru");
  const out: { text: string; from: number }[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1 && out.length < limit) {
    const rawStart = Math.max(0, at - SNIPPET_BEFORE);
    // Start at a word boundary when one is near, but never past the match itself.
    const space = text.lastIndexOf(" ", Math.min(rawStart + 20, at));
    const start = space > rawStart && space < at ? space + 1 : rawStart;
    const end = Math.min(text.length, at + needle.length + SNIPPET_AFTER);
    const piece = `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
    out.push({ text: piece, from: at });
    // Continue past the end of this piece, so the snippets never overlap.
    at = haystack.indexOf(needle, end);
  }
  return out;
}
