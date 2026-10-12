import { z } from "zod";

// Main assistant (screen 4): name, emoji, character, what to know about the owner, and memory.

export const AssistantProfile = z.object({
  name: z.string().trim().min(1).max(60),
  emoji: z.string().trim().min(1).max(8),
  character: z.string().trim().max(2000),
  aboutUser: z.string().trim().max(6000),
  /** Longest reply to a junior agent, in lines. */
  summaryMaxLines: z.coerce.number().int().min(3).max(50),
});
export type AssistantProfile = z.infer<typeof AssistantProfile>;

/**
 * Embeddings for the assistant's memory search: gemini / openai use the AI already connected,
 * none = keyword search only (always works, no key).
 */
export const MemoryProvider = z.enum(["gemini", "openai", "none"]);
export type MemoryProvider = z.infer<typeof MemoryProvider>;

export const AssistantDto = z.object({
  profile: AssistantProfile,
  /** The panel has written this profile into the assistant's files at least once. */
  applied: z.boolean(),
  model: z.string().nullable(),
  memory: z.object({
    /** What OpenClaw uses now; null = its default (OpenAI). */
    provider: z.string().nullable(),
    /** Choices that work with the AI the assistant has. */
    options: z.array(MemoryProvider),
    recommended: MemoryProvider,
    /** Memory currently points at a provider without a key, so it fails. */
    broken: z.boolean(),
  }),
});
export type AssistantDto = z.infer<typeof AssistantDto>;

export const SetMemoryRequest = z.object({ provider: MemoryProvider });
export type SetMemoryRequest = z.infer<typeof SetMemoryRequest>;
