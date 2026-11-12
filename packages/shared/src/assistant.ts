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
 * none = keyword search only (always works, no key); local = the llama.cpp model on the server, offered once
 * "Install and enable" has set it up.
 */
export const MemoryProvider = z.enum(["local", "gemini", "openai", "none"]);
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

export const LocalMemoryStatusDto = z.object({
  job: z.object({
    state: z.enum(["idle", "installing", "downloading", "configuring", "indexing", "checking", "ready", "error"]),
    percent: z.number().min(0).max(100).nullable(),
    error: z.string().nullable(),
    updatedAt: z.number().nullable(),
  }),
  checkedAt: z.number().nullable(),
  error: z.string().nullable(),
  agents: z.array(z.object({
    agentId: z.string(), provider: z.string().nullable(), files: z.number().nullable(), chunks: z.number().nullable(),
    index: z.enum(["ready", "pending"]), embeddings: z.enum(["ready", "error", "unchecked"]),
  })),
});
export type LocalMemoryStatusDto = z.infer<typeof LocalMemoryStatusDto>;
export const LocalMemoryActionRequest = z.object({ action: z.enum(["setup", "reindex", "check"]), consent: z.boolean().default(false) });
export const LocalMemorySearchRequest = z.object({ agentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), query: z.string().trim().min(1).max(500) });
export const LocalMemorySearchDto = z.object({ stale: z.boolean(), results: z.array(z.object({ path: z.string().max(500), snippet: z.string().max(2000) })).max(3) });
export type LocalMemorySearchDto = z.infer<typeof LocalMemorySearchDto>;
