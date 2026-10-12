import type { AssistantDto, AssistantProfile, MemoryProvider } from "@clawdesk/shared";
import { loadTemplate, renderTemplateFiles } from "@clawdesk/templates";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { getSetting, putSetting } from "../db/settings.js";
import { getConfig, patchConfig } from "../gateway/config-patch.js";
import type { GatewayService } from "../gateway/gateway-service.js";

// Main assistant (screen 4). The panel template (personal/main) gives the assistant its persona
// (SOUL.md) and what to know about the owner (USER.md). OpenClaw's own working instructions in
// AGENTS.md stay; the panel adds its part between markers, and keeps what the assistant itself
// learned about the owner in USER.md.

const MAIN = "main";
const PROFILE_SETTING = "assistant.profile";
const START = "<!-- clawdesk:start — edited in the ClawDesk panel -->";
const END = "<!-- clawdesk:end -->";

/** Puts `block` between the panel's markers: replaces the old block, or adds it (top or bottom). */
export function upsertBlock(current: string, block: string, where: "top" | "bottom"): string {
  const wrapped = `${START}\n${block.trim()}\n${END}`;
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start >= 0 && end > start) return `${current.slice(0, start)}${wrapped}${current.slice(end + END.length)}`;
  const rest = current.trim();
  if (!rest) return `${wrapped}\n`;
  return where === "top" ? `${wrapped}\n\n${rest}\n` : `${rest}\n\n${wrapped}\n`;
}

/** OpenClaw's untouched starter USER.md: nothing the assistant learned yet, safe to replace. */
const isStarterUserFile = (text: string) => text.includes("# USER.md - User Model") && text.includes("- Prefer ...");

type AgentsList = { agents: { id: string; name?: string; identity?: { name?: string; emoji?: string }; model?: { primary?: string } }[] };
type MemoryConfig = { memory?: { search?: { provider?: string } } };

/** Which embedding providers work with the AI the assistant is connected to. */
export function memoryChoices(providers: string[]): { options: MemoryProvider[]; recommended: MemoryProvider } {
  const options: MemoryProvider[] = [];
  if (providers.includes("google")) options.push("gemini");
  if (providers.includes("openai")) options.push("openai");
  options.push("none");
  return { options, recommended: options[0]! };
}

/** OpenClaw defaults to OpenAI embeddings; that only works when OpenAI is connected. */
export function memoryBroken(current: string | null, providers: string[]): boolean {
  const effective = current ?? "openai";
  if (effective === "none" || effective === "auto" || effective === "local") return false;
  if (effective === "gemini") return !providers.includes("google");
  return !providers.includes(effective);
}

export class AssistantService {
  constructor(private readonly deps: { gateway: GatewayService; db: Db; logger: Logger }) {}

  async get(): Promise<AssistantDto> {
    const [list, auth, { config }] = await Promise.all([
      this.deps.gateway.request<AgentsList>("agents.list", {}),
      this.#providers(),
      getConfig<MemoryConfig>(this.deps.gateway),
    ]);
    const main = list.agents.find((a) => a.id === MAIN);
    const saved = getSetting<AssistantProfile>(this.deps.db, PROFILE_SETTING);
    const current = config.memory?.search?.provider ?? null;
    return {
      profile: saved ?? this.#defaults(main?.identity?.name ?? main?.name, main?.identity?.emoji),
      applied: !!saved,
      model: main?.model?.primary ?? null,
      memory: { provider: current, ...memoryChoices(auth), broken: memoryBroken(current, auth) },
    };
  }

  async save(profile: AssistantProfile): Promise<AssistantDto> {
    const template = loadTemplate("personal", "main");
    const files = renderTemplateFiles(template, {
      agentName: profile.name,
      character: profile.character,
      aboutUser: profile.aboutUser || "—",
      summaryMaxLines: String(profile.summaryMaxLines),
    });
    const { gateway } = this.deps;
    const read = async (name: string) =>
      (await gateway.request<{ file?: { content?: string; missing?: boolean } }>("agents.files.get", { agentId: MAIN, name })).file?.content ?? "";

    const [agentsMd, userMd] = await Promise.all([read("AGENTS.md"), read("USER.md")]);
    await gateway.request("agents.files.set", { agentId: MAIN, name: "SOUL.md", content: files["SOUL.md"] });
    await gateway.request("agents.files.set", {
      agentId: MAIN,
      name: "USER.md",
      content: upsertBlock(isStarterUserFile(userMd) ? "" : userMd, files["USER.md"], "top"),
    });
    await gateway.request("agents.files.set", { agentId: MAIN, name: "AGENTS.md", content: upsertBlock(agentsMd, files["AGENTS.md"], "bottom") });
    await gateway.request("agents.update", { agentId: MAIN, name: profile.name, emoji: profile.emoji });
    putSetting(this.deps.db, PROFILE_SETTING, profile);
    this.deps.logger.info({ name: profile.name }, "main assistant profile saved");
    return this.get();
  }

  /** Memory search needs embeddings; changing the provider restarts the Gateway. */
  async setMemory(provider: MemoryProvider): Promise<AssistantDto> {
    const generation = this.deps.gateway.generation;
    try {
      await patchConfig(this.deps.gateway, { memory: { search: { provider } } }, { note: "clawdesk: memory provider" });
    } catch (error) {
      const code = (error as { gatewayCode?: string }).gatewayCode;
      if (code !== "UNAVAILABLE" && this.deps.gateway.status.state === "connected") throw error;
    }
    // "restart" reload kind: if the Gateway goes down to apply it, answer once it is back.
    for (let i = 0; i < 20 && this.deps.gateway.generation === generation && this.deps.gateway.status.state === "connected"; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.deps.gateway.generation !== generation || this.deps.gateway.status.state !== "connected") {
      await this.deps.gateway.waitForReconnect(generation, 90_000).catch(() => undefined);
    }
    this.deps.logger.info({ provider }, "memory provider set");
    return this.get();
  }

  /**
   * Fix the default once: OpenClaw starts on OpenAI embeddings even without an OpenAI key,
   * so memory search fails. Pick what works with the connected AI.
   */
  async ensureMemoryWorks(): Promise<void> {
    const dto = await this.get();
    if (dto.memory.broken) await this.setMemory(dto.memory.recommended);
  }

  async #providers(): Promise<string[]> {
    const res = await this.deps.gateway.request<{ providers?: { provider?: string; status?: string }[] }>("models.authStatus", { agentId: MAIN });
    return (res.providers ?? []).filter((p) => p.status !== "missing").map((p) => p.provider ?? "");
  }

  #defaults(name: string | undefined, emoji: string | undefined): AssistantProfile {
    const template = loadTemplate("personal", "main");
    const field = (key: string) => template.fields.find((f) => f.key === key)?.default ?? "";
    return {
      name: name && name !== MAIN ? name : field("agentName") || "Ассистент",
      emoji: emoji ?? template.emoji ?? "🧭",
      character: field("character"),
      aboutUser: "",
      summaryMaxLines: Number(field("summaryMaxLines")) || 10,
    };
  }
}
