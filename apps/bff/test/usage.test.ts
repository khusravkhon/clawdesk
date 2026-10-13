import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UsageService } from "../src/dashboard/usage-service.js";
import { openDb } from "../src/db/client.js";
import type { GatewayService } from "../src/gateway/gateway-service.js";

describe("usage screen", () => {
  it("gives every agent its own tokens per day on the same days, zeros included, biggest first", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-usage-"));
    const { db, close } = openDb(path.join(dir, "panel.sqlite"));
    const asked: Record<string, unknown>[] = [];
    const gateway = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "agents.list") return { defaultId: "main", agents: [{ id: "main" }, { id: "dietitian" }] };
        asked.push(params);
        const daily =
          params.agentId === "dietitian"
            ? [{ date: "2026-10-12", tokens: 900, cost: 0.01 }]
            : params.agentId === "main"
              ? [{ date: "2026-10-13", tokens: 300 }]
              : [{ date: "2026-10-12", tokens: 900 }, { date: "2026-10-13", tokens: 300 }];
        const total = daily.reduce((s, d) => s + d.tokens, 0);
        return { totals: { totalTokens: total, totalCost: 0 }, aggregates: { daily } };
      },
    } as unknown as GatewayService;
    try {
      const res = await new UsageService({ gateway, db, sandboxEnabled: true }).get("7d", "UTC", Date.UTC(2026, 9, 13, 12));
      expect(res.days).toHaveLength(7);
      expect(res.usage.totals.tokens).toBe(1200);
      expect(res.agents.map((a) => [a.agentId, a.tokens, a.daily.slice(-2)])).toEqual([
        ["dietitian", 900, [900, 0]],
        ["main", 300, [0, 300]],
      ]);
      expect(asked.filter((p) => p.agentId).map((p) => p.agentId).sort()).toEqual(["dietitian", "main"]);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
