import { CronExpr } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { listTemplates, loadTemplate, renderTemplateFiles, renderTemplateText, TEAM_VALUES } from "../src/index.js";

describe("templates", () => {
  it("every bundled template parses and renders with its defaults plus required fields", () => {
    const templates = listTemplates();
    expect(templates.map((t) => `${t.mode}/${t.id}`).sort()).toEqual([
      "company/custom",
      "company/developer",
      "company/main",
      "company/pm",
      "company/reviewer",
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

  it("fails on a required field without value", () => {
    expect(() => renderTemplateFiles(loadTemplate("personal", "dietitian"), {})).toThrow(/goal/);
  });

  it("fails on unknown placeholders instead of shipping them", () => {
    expect(() => renderTemplateText("Hi {{name}} {{ other }}", { name: "A" })).toThrow(/other/);
    expect(renderTemplateText("Hi {{ name }}", { name: "A" })).toBe("Hi A");
  });
});
