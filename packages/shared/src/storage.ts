import { z } from "zod";

export const StorageCategory = z.enum(["videos", "history"]);
export type StorageCategory = z.infer<typeof StorageCategory>;
const CategoryUsage = z.object({ bytes: z.number().nonnegative(), files: z.number().int().nonnegative(), available: z.boolean(), retainedFiles: z.number().int().nonnegative(), retainedNames: z.array(z.string().max(2048)).max(20).default([]) });
export const StorageStatusDto = z.object({
  videos: CategoryUsage, history: CategoryUsage,
  videoQuotaBytes: z.number().int().positive().nullable(),
  reservedBytes: z.number().nonnegative(), activeDownloads: z.number().int().nonnegative(),
  freeBytes: z.number().nonnegative().nullable(),
});
export type StorageStatusDto = z.infer<typeof StorageStatusDto>;
export const StorageQuotaRequest = z.object({ videoQuotaBytes: z.number().int().min(1024 * 1024).max(100 * 1024 ** 4).nullable() });
export const StoragePreviewRequest = z.object({ category: StorageCategory });
export const StorageCleanupRequest = z.object({ token: z.string().uuid(), confirm: z.literal(true) });
export const StoragePreviewDto = z.object({
  token: z.string().uuid(), category: StorageCategory, expiresAt: z.number(), files: z.number().int().nonnegative(), bytes: z.number().nonnegative(), more: z.boolean(),
  entries: z.array(z.object({ name: z.string().max(2048), bytes: z.number().nonnegative() })).max(500),
});
export type StoragePreviewDto = z.infer<typeof StoragePreviewDto>;
export const StorageCleanupDto = z.object({ deleted: z.number().int().nonnegative(), bytes: z.number().nonnegative(), skipped: z.number().int().nonnegative(), retainedCount: z.number().int().nonnegative(), retained: z.array(z.object({ name: z.string().max(2048), originalName: z.string().max(2048) })).max(20) });
export type StorageCleanupDto = z.infer<typeof StorageCleanupDto>;
