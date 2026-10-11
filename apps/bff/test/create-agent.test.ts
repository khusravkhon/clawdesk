import { CreateAgentRequest } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { slugBase, uniqueSlug } from "../src/provision/create-agent.js";

describe("agent ids", () => {
  it("uses the template id, or a latin slug of the name for custom agents", () => {
    expect(slugBase({ id: "dietitian" }, "Диетолог")).toBe("dietitian");
    expect(slugBase({ id: "custom" }, "Sales Helper 2!")).toBe("sales-helper-2");
    expect(slugBase({ id: "custom" }, "Помощник по продажам")).toBe("agent");
  });

  it("never collides with existing agents or main", () => {
    expect(uniqueSlug("dietitian", new Set(["main"]))).toBe("dietitian");
    expect(uniqueSlug("dietitian", new Set(["dietitian", "dietitian-2"]))).toBe("dietitian-3");
    expect(uniqueSlug("main", new Set(["main"]))).toBe("main-2");
  });
});

describe("CreateAgentRequest", () => {
  const base = { templateId: "dietitian", mode: "personal", values: { goal: "x" }, canAskMain: true, ai: "inherit", timezone: "Asia/Dushanbe" } as const;

  it("accepts daily and weekday schedules", () => {
    const ok = CreateAgentRequest.safeParse({
      ...base,
      schedules: [
        { presetId: "daily-menu", label: "07:30", cron: "30 7 * * *", prompt: "menu" },
        { presetId: null, label: "Sun", cron: "0 20 * * 0", prompt: "sum" },
        { presetId: null, label: "Weekdays", cron: "5 9 * * 1,2,3,4,5", prompt: "plan" },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects schedules outside what the builder can express", () => {
    for (const cron of ["*/5 * * * *", "0 25 * * *", "0 8 1 * *", "0 8 * * 7", "rm -rf"]) {
      const res = CreateAgentRequest.safeParse({ ...base, schedules: [{ presetId: null, label: "x", cron, prompt: "p" }] });
      expect(res.success, cron).toBe(false);
    }
  });
});
