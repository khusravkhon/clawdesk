import type { DashboardRange, UsageAgentDto, UsageDto } from "@clawdesk/shared";
import type { Db } from "../db/client.js";
import type { GatewayService } from "../gateway/gateway-service.js";
import { listAgents } from "../routes/agents.js";
import { buildUsage, rangeDays, type RawSessionsUsage } from "./dashboard-service.js";

// Usage screen (13). The totals are the overview's; per agent the Gateway is asked once per agent
// (sessions.usage with agentId), which gives each agent its own days.

export class UsageService {
  constructor(private readonly deps: { gateway: GatewayService; db: Db; sandboxEnabled: boolean }) {}

  async get(range: DashboardRange, timeZone: string, now = Date.now()): Promise<UsageDto> {
    const days = rangeDays(range, now, timeZone);
    const ask = (agentId?: string) =>
      this.deps.gateway.request<RawSessionsUsage>("sessions.usage", {
        ...(agentId ? { agentId } : { agentScope: "all" }),
        startDate: days[0],
        endDate: days[days.length - 1],
        mode: "specific",
        timeZone,
        limit: 500,
      });
    const [all, list] = await Promise.all([ask(), listAgents(this.deps)]);
    const usage = buildUsage(all, days);
    const agents = await Promise.all(
      list.agents.map(async (a): Promise<UsageAgentDto> => {
        const mine = buildUsage(await ask(a.id).catch(() => ({})), days);
        return { agentId: a.id, name: a.name, emoji: a.emoji, role: a.role, tokens: mine.totals.tokens, cost: mine.totals.cost, daily: mine.daily.map((d) => d.tokens) };
      }),
    );
    agents.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
    return { range, days, usage, agents };
  }
}
