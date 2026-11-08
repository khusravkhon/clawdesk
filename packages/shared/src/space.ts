import { z } from "zod";
import { Locale, SpaceMode } from "./domain.js";

// Screen 2: what this install is for. Chosen once on the first run; changed only by a factory reset.

export const SpaceDto = z.object({
  mode: SpaceMode,
  name: z.string(),
  locale: Locale,
  timezone: z.string(),
});
export type SpaceDto = z.infer<typeof SpaceDto>;

export const CreateSpaceRequest = z.object({
  mode: SpaceMode,
  name: z.string().trim().min(1).max(80),
  locale: Locale,
  /** IANA time zone, e.g. Asia/Dushanbe. */
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "unknown time zone"),
});
export type CreateSpaceRequest = z.infer<typeof CreateSpaceRequest>;

export const UpdateSpaceRequest = CreateSpaceRequest.pick({ name: true, timezone: true }).strict();
export type UpdateSpaceRequest = z.infer<typeof UpdateSpaceRequest>;
