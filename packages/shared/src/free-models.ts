import { z } from "zod";

// "Free models" for junior agents in personal mode: FreeLLMAPI pools providers'
// free tiers behind one endpoint that OpenClaw uses as provider "freellmapi".
// Never offered for the main agent or in company mode.

export const FREE_MODEL_REF = "freellmapi/auto";

export const FreeProviderDto = z.object({
  /** FreeLLMAPI platform id, e.g. "google", "groq". */
  platform: z.string(),
  name: z.string(),
  configured: z.boolean(),
  keyCount: z.number().int(),
  /** Free key without a card, available worldwide; shown first. */
  recommended: z.boolean(),
  /** Page where the person creates the free key. */
  signupUrl: z.string().nullable(),
});
export type FreeProviderDto = z.infer<typeof FreeProviderDto>;

export const FreeModelsStatusDto = z.object({
  /** The FreeLLMAPI service is running and reachable. */
  available: z.boolean(),
  /** At least one provider key is added and OpenClaw knows the provider. */
  ready: z.boolean(),
  modelRef: z.string(),
  providers: z.array(FreeProviderDto),
  error: z.string().nullable(),
});
export type FreeModelsStatusDto = z.infer<typeof FreeModelsStatusDto>;

export const AddFreeKeyRequest = z.object({
  platform: z.string().regex(/^[a-z0-9-]{1,40}$/),
  key: z.string().trim().min(8).max(4096),
});
export type AddFreeKeyRequest = z.infer<typeof AddFreeKeyRequest>;
