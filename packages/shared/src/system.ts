import { z } from "zod";
import { PASSWORD_MIN } from "./auth.js";

// System screen (14): backups and factory reset.

export const BackupKind = z.enum(["daily", "manual", "before-reset"]);
export type BackupKind = z.infer<typeof BackupKind>;

export const BackupDto = z.object({
  name: z.string(),
  kind: BackupKind,
  createdAt: z.string(),
  size: z.number(),
});
export type BackupDto = z.infer<typeof BackupDto>;

export const BackupsDto = z.object({
  /** Backups work in the installed panel (Docker), not in host development. */
  available: z.boolean(),
  backups: z.array(BackupDto),
  /** A backup is being made right now. */
  running: z.boolean(),
  /** The last automatic backup failed with this message. */
  lastError: z.string().nullable(),
});
export type BackupsDto = z.infer<typeof BackupsDto>;

/** The downloaded copy is encrypted with this password; restore asks for it. */
export const DownloadBackupRequest = z.object({ password: z.string().min(PASSWORD_MIN).max(200) });
export type DownloadBackupRequest = z.infer<typeof DownloadBackupRequest>;

export const DeleteBackupRequest = z.object({ confirm: z.literal(true) }).strict();
export type DeleteBackupRequest = z.infer<typeof DeleteBackupRequest>;

export const FactoryResetRequest = z.object({
  /** The panel password, again: a reset cannot be undone except from a backup. */
  password: z.string().min(1).max(200),
  confirm: z.literal(true),
});
export type FactoryResetRequest = z.infer<typeof FactoryResetRequest>;

export const FactoryResetResultDto = z.object({
  /** Opens /setup after the restart: the panel comes back without an owner. */
  ownerCode: z.string(),
  /** The backup made just before the reset. */
  backup: z.string(),
});
export type FactoryResetResultDto = z.infer<typeof FactoryResetResultDto>;
