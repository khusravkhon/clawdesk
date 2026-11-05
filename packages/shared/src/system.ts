import { z } from "zod";
import { PASSWORD_MIN } from "./auth.js";

// System screen (14): backups and factory reset.

export const BackupKind = z.enum(["daily", "manual", "before-reset", "before-update"]);
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

// System → OpenClaw: a newer OpenClaw verified for this ClawDesk, installed only when the owner asks.

export const OpenClawUpdateState = z.enum(["backup", "building", "switching", "checking", "rolling_back", "done", "rolled_back", "failed"]);
export type OpenClawUpdateState = z.infer<typeof OpenClawUpdateState>;

export const OpenClawUpdateDto = z.object({
  /** Works in the installed panel (Docker), not in host development. */
  available: z.boolean(),
  /** The OpenClaw the Gateway image runs. */
  running: z.string().nullable(),
  /** The newest verified version above it; `newLine` when it is another OpenClaw line (2026.8 → 2026.11). */
  offer: z.object({ version: z.string(), newLine: z.boolean() }).nullable(),
  /** The last update from the panel, while it runs and after. */
  status: z.object({
    version: z.string(),
    from: z.string().nullish(),
    state: OpenClawUpdateState,
    backup: z.string().nullish(),
    reason: z.string().nullish(),
    message: z.string().nullish(),
    startedAt: z.string().nullish(),
    finishedAt: z.string().nullish(),
  }).nullable(),
});
export type OpenClawUpdateDto = z.infer<typeof OpenClawUpdateDto>;

export const StartOpenClawUpdateRequest = z.object({
  version: z.string().regex(/^\d{4}\.\d{1,2}\.\d{1,4}$/),
  confirm: z.literal(true),
}).strict();
export type StartOpenClawUpdateRequest = z.infer<typeof StartOpenClawUpdateRequest>;
