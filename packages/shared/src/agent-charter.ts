import { z } from "zod";

// Stage 4: an agent's charter — what it answers for, must, may and must not do, when it asks and whom it
// hands questions to, how its result is checked. Owner-set, versioned; the panel writes it into the agent's
// AGENTS.md as a block it restores whenever the file no longer matches, so the agent cannot loosen it.
// The text describes; it grants nothing: "may send e-mail" gives no mail access and skips no approval.

const Text = z.string().trim().max(2000).default("");
export const AgentCharterFields = z.object({
  responsibleFor: Text,
  mustDo: Text,
  mayDo: Text,
  forbidden: Text,
  askPermission: Text,
  escalateTo: Text,
  verifyBy: Text,
});
export type AgentCharterFields = z.infer<typeof AgentCharterFields>;
export const CHARTER_FIELDS = ["responsibleFor", "mustDo", "mayDo", "forbidden", "askPermission", "escalateTo", "verifyBy"] as const satisfies readonly (keyof AgentCharterFields)[];

/** "default" — nothing saved yet, the safe defaults apply; "restore" — a copy of an earlier version. */
export type AgentCharterSource = "default" | "owner" | "restore";
/** The AGENTS.md block against the current version: "changed"/"missing" — someone edited the file. */
export type AgentCharterFileState = "ok" | "missing" | "changed" | "unavailable";
export type AgentCharterVersionDto = { version: number; source: AgentCharterSource; note: string; createdAt: number; fields: AgentCharterFields };
/** What the agent can technically do, from the panel's records: the charter text does not change any of it. */
export type AgentPowersDto = {
  sandbox: boolean;
  canAskMain: boolean;
  folder: string | null;
  grants: { resource: string; access: "read" | "write" }[];
  team: string | null;
  lead: boolean;
  manager: boolean;
};
export type AgentCharterDto = {
  agentId: string;
  name: string;
  /** 0 while nothing is saved (the defaults below are what applies). */
  version: number;
  source: AgentCharterSource;
  fields: AgentCharterFields;
  history: AgentCharterVersionDto[];
  file: AgentCharterFileState;
  powers: AgentPowersDto;
};
export const SaveAgentCharterRequest = z.object({
  requestId: z.uuid(),
  /** The version the owner edited; a newer one means someone else saved in between. */
  baseVersion: z.number().int().min(0),
  fields: AgentCharterFields,
  note: z.string().trim().max(300).default(""),
  /** Needed when the change widens what the agent may do (see charterExpands). */
  confirmExpansion: z.boolean().optional(),
});
export type SaveAgentCharterRequest = z.infer<typeof SaveAgentCharterRequest>;
export const RestoreAgentCharterRequest = z.object({
  requestId: z.uuid(),
  baseVersion: z.number().int().min(0),
  version: z.number().int().min(1),
  confirmExpansion: z.boolean().optional(),
});
export type RestoreAgentCharterRequest = z.infer<typeof RestoreAgentCharterRequest>;
export const RepairAgentCharterRequest = z.object({ requestId: z.uuid() });
export type RepairAgentCharterRequest = z.infer<typeof RepairAgentCharterRequest>;

const lines = (text: string) => new Set(text.split("\n").map((line) => line.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean));
/**
 * Whether `next` widens the agent's freedom against `current`: a line added to "may do", or a line taken
 * from "forbidden" or "ask permission". Tightening applies at once; widening needs the owner's explicit word.
 */
export function charterExpands(current: AgentCharterFields, next: AgentCharterFields): boolean {
  const added = (field: keyof AgentCharterFields) => [...lines(next[field])].some((line) => !lines(current[field]).has(line));
  const removed = (field: keyof AgentCharterFields) => [...lines(current[field])].some((line) => !lines(next[field]).has(line));
  return added("mayDo") || removed("forbidden") || removed("askPermission");
}
