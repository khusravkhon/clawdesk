import { CronExpr } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { listTemplates, loadTemplate, renderTemplateFiles, renderTemplateText, TEAM_VALUES } from "../src/index.js";

describe("templates", () => {
  it("every bundled template parses and renders with its defaults plus required fields", () => {
    const templates = listTemplates();
    expect(templates.map((t) => `${t.mode}/${t.id}`).sort()).toEqual([
      "company/analyst",
      "company/custom",
      "company/department-head",
      "company/developer",
      "company/hr",
      "company/main",
      "company/marketing",
      "company/operations",
      "company/pm",
      "company/project-developer",
      "company/project-qa",
      "company/project-reviewer",
      "company/reviewer",
      "company/sales",
      "company/support",
      "company/team-lead",
      "personal/accountant",
      "personal/custom",
      "personal/dietitian",
      "personal/finance",
      "personal/main",
      "personal/social",
      "personal/trainer",
      "personal/youtube",
    ]);
    for (const template of templates) {
      const required = Object.fromEntries(template.fields.filter((f) => f.required && f.default === undefined).map((f) => [f.key, `value-${f.key}`]));
      // Team roles also get the project's values from their team.
      if (template.role === "team_member") for (const key of TEAM_VALUES) required[key] = `value-${key}`;
      const files = renderTemplateFiles(template, required);
      for (const content of Object.values(files)) expect(content).not.toMatch(/\{\{/);
    }
  });

  it("every preset schedule is one the builder accepts", () => {
    for (const template of listTemplates()) {
      for (const preset of template.cronPresets) expect(CronExpr.safeParse(preset.cron).success, `${template.id}/${preset.id}: ${preset.cron}`).toBe(true);
    }
  });

  it("offers a team lead that starts without sources, schedules or extra access", () => {
    const lead = listTemplates().find((t) => t.id === "team-lead")!;
    expect(lead).toMatchObject({ mode: "company", role: "specialist", sandbox: true, canAskMain: true, sources: [], cronPresets: [] });
    const files = renderTemplateFiles(lead, { teamPurpose: "Магазин" });
    expect(files["SOUL.md"]).toContain("Магазин");
    expect(files["AGENTS.md"]).toContain("доступ выдаёт владелец");
  });

  it("offers business specialists without team-only fields or connected service assumptions", () => {
    const specialists = listTemplates().filter((t) => t.mode === "company" && t.role === "specialist" && !["custom", "department-head", "team-lead"].includes(t.id));
    expect(specialists.map((t) => t.id).sort()).toEqual(["analyst", "hr", "marketing", "operations", "sales", "support"]);
    for (const template of specialists) {
      expect(template.fields.some((f) => f.key === "agentName" && f.default)).toBe(true);
      expect(template.sources).toContain("folder");
      expect(template.folder?.ru).toBeTruthy();
      expect(template.sandbox).toBe(true);
      expect(template.canAskMain).toBe(true);
      expect(template.cronPresets.length).toBeGreaterThan(0);
      const values = Object.fromEntries(template.fields.filter((f) => f.default === undefined).map((f) => [f.key, `Company ${f.key}`]));
      expect(() => renderTemplateFiles(template, values)).not.toThrow();
    }
  });

  it("fails on a required field without value", () => {
    expect(() => renderTemplateFiles(loadTemplate("personal", "dietitian"), {})).toThrow(/goal/);
  });

  it("prepares a department manager without automatic schedules or source access", () => {
    const template = loadTemplate("company", "department-head");
    expect(template.role).toBe("specialist");
    expect(template.sources).toEqual([]);
    expect(template.cronPresets).toEqual([]);
    expect(() => renderTemplateFiles(template, {})).toThrow(/departmentPurpose/);
    const files = renderTemplateFiles(template, { departmentPurpose: "IT", limits: "Do not publish", responsibilities: "Review deliverables" });
    expect(files["SOUL.md"]).toContain("Do not publish");
    expect(files["SOUL.md"]).toContain("Review deliverables");
  });

  it("fails on unknown placeholders instead of shipping them", () => {
    expect(() => renderTemplateText("Hi {{name}} {{ other }}", { name: "A" })).toThrow(/other/);
    expect(renderTemplateText("Hi {{ name }}", { name: "A" })).toBe("Hi A");
  });
});
