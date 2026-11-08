import { z } from "zod";
import { ChatAttachmentState } from "./chat.js";

// The owner's library and their agents' notes (screen 9 and 4), plus the spending limits that keep
// automatic work from running up a bill. Everything here is per agent: a search finds only what
// that agent was given, and a note is written only into that agent's own files.

export const LibraryItemKind = z.enum(["document", "video"]);
export type LibraryItemKind = z.infer<typeof LibraryItemKind>;
export const LibraryProcessing = z.enum([...ChatAttachmentState.options, "subtitles", "subtitles_partial", "video_frames", "video_file", "video_speech"]);
export type LibraryProcessing = z.infer<typeof LibraryProcessing>;

export const LibraryHitDto = z.object({
  id: z.string(),
  agentId: z.string(),
  kind: LibraryItemKind,
  title: z.string(),
  /** The file name or the video link the text came from. */
  source: z.string(),
  /** What a page/sheet/timecode is called in this material, when it has one. */
  locator: z.string().nullable(),
  chars: z.number().int().nonnegative(),
  at: z.number(),
  processing: LibraryProcessing.nullable().optional(),
  /** Pieces of the text around the match, with the match itself marked by the panel, not by HTML. */
  snippets: z.array(z.object({ text: z.string(), from: z.number().int().nonnegative() })),
});
export type LibraryHitDto = z.infer<typeof LibraryHitDto>;

export type LibraryCursor = { at: number; id: string };
export type LibraryPageDto = { items: LibraryHitDto[]; next: LibraryCursor | null };
export type LibraryMaterialDto = { item: LibraryHitDto; text: string };

export const LibrarySearchDto = z.object({
  query: z.string(),
  /** Which agent's materials were searched; null means every agent's (the owner's own view). */
  agentId: z.string().nullable(),
  hits: z.array(LibraryHitDto),
  /** Materials searched, so "nothing found" can be told apart from "nothing stored yet". */
  searched: z.number().int().nonnegative(),
  /** True when the search stopped at its limit and more materials were left unread. */
  partial: z.boolean(),
});
export type LibrarySearchDto = z.infer<typeof LibrarySearchDto>;

export const MemoryNoteDto = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  source: z.string().nullable(),
  /** The day the fact is about (YYYY-MM-DD), which is not always the day it was written. */
  happenedOn: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number().nullable(),
});
export type MemoryNoteDto = z.infer<typeof MemoryNoteDto>;

export const MemoryNotesDto = z.object({
  agentId: z.string(),
  notes: z.array(MemoryNoteDto),
  /** The panel successfully wrote the current notes into the agent's USER.md. */
  applied: z.boolean(),
});
export type MemoryNotesDto = z.infer<typeof MemoryNotesDto>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const SaveMemoryNoteRequest = z.object({
  text: z.string().trim().min(1).max(2000),
  source: z.string().trim().max(300).optional(),
  happenedOn: z.string().regex(DAY).optional(),
});
export type SaveMemoryNoteRequest = z.infer<typeof SaveMemoryNoteRequest>;

/** How many notes one agent may carry: they all go into its USER.md, which the model reads every turn. */
export const MAX_MEMORY_NOTES = 100;

export const BudgetDto = z.object({
  /** Limits in US dollars; 0 means no limit. */
  dailyUsd: z.number().nonnegative(),
  monthlyUsd: z.number().nonnegative(),
  /** What has been spent so far, as the Gateway reports it. */
  spentTodayUsd: z.number().nonnegative(),
  spentMonthUsd: z.number().nonnegative(),
  /** A limit is reached, so the panel holds back automatic work. */
  exceeded: z.boolean(),
  /** Which limit it is, for the sentence the panel shows. */
  reason: z.enum(["daily", "monthly", "none"]),
  /** Schedules the panel paused because of the limit, and will resume once spending allows. */
  pausedSchedules: z.number().int().nonnegative(),
  /** The Gateway reported usage without cost for some entries, so the spend is a lower bound. */
  costIncomplete: z.boolean(),
  /** False when the latest usage request failed; cached values are not a current report. */
  usageAvailable: z.boolean(),
  lastUsageAt: z.number().nullable(),
});
export type BudgetDto = z.infer<typeof BudgetDto>;

export const SaveBudgetRequest = z.object({
  dailyUsd: z.coerce.number().nonnegative().max(100_000),
  monthlyUsd: z.coerce.number().nonnegative().max(1_000_000),
});
export type SaveBudgetRequest = z.infer<typeof SaveBudgetRequest>;
