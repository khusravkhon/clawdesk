import type { DashboardRange, UsageAgentDto, UsageDto } from "@clawdesk/shared";
import type { Db } from "../db/client.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { listAgents } from "../routes/agents.js";
import { buildUsage, rangeDays, type RawSessionsUsage } from "./dashboard-service.js";

// Usage screen (13). The totals are the overview's; per agent the Gateway is asked once per agent
// (sessions.usage with agentId), which gives each agent its own days.

export class UsageService {
  readonly #checked = new Map<string, number>();
  constructor(private readonly deps: { gateway: GatewayService; db: Db; sandboxEnabled: boolean }) {}

  async get(range: DashboardRange, timeZone: string, now = Date.now()): Promise<UsageDto> {
    const days = rangeDays(range, now, timeZone);
    const ask = async (agentId?: string) => {
      const key = JSON.stringify([range, timeZone, agentId]);
      try {
        const raw = await this.deps.gateway.request<RawSessionsUsage>("sessions.usage", {
        ...(agentId ? { agentId } : { agentScope: "all" }),
        startDate: days[0],
        endDate: days[days.length - 1],
        mode: "specific",
        timeZone,
        limit: 500,
        });
        if (!Array.isArray(raw.aggregates?.daily)) throw new Error("usage report has no daily totals");
        const usage = buildUsage(raw, days);
        if (usage.totals.tokens > 0 && !Number.isFinite(raw.totals?.totalCost)) usage.costIncomplete = true;
        if (!usage.costIncomplete) {
          this.#checked.delete(key);
          this.#checked.set(key, now);
          if (this.#checked.size > 512) this.#checked.delete(this.#checked.keys().next().value!);
        }
        return { usage, checkedAt: this.#checked.get(key) ?? null };
      } catch {
        return { usage: null, checkedAt: this.#checked.get(key) ?? null };
      }
    };
    const [all, list] = await Promise.all([ask(), listAgents(this.deps).catch(() => ({ agents: [] }))]);
    const agents = await Promise.all(
      list.agents.map(async (a): Promise<UsageAgentDto> => {
        const mine = await ask(a.id);
        return { agentId: a.id, name: a.name, emoji: a.emoji, role: a.role,
          tokens: mine.usage?.totals.tokens ?? null, cost: mine.usage && !mine.usage.costIncomplete ? mine.usage.totals.cost : null,
          daily: mine.usage?.daily.map((d) => d.tokens) ?? [], checkedAt: mine.checkedAt, available: mine.usage !== null };
      }),
    );
    agents.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name));
    return { range, days, ...all, agents };
  }
}
