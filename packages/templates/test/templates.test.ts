import { describe, expect, it } from "vitest";
import { listTemplates, loadTemplate, renderTemplateFiles, renderTemplateText } from "../src/index.js";

describe("templates", () => {
  it("every bundled template parses and renders with its defaults plus required fields", () => {
    const templates = listTemplates();
    expect(templates.map((t) => `${t.mode}/${t.id}`).sort()).toEqual([
      "personal/custom",
      "personal/dietitian",
      "personal/finance",
      "personal/main",
      "personal/trainer",
      "personal/youtube",
    ]);
    for (const template of templates) {
      const required = Object.fromEntries(template.fields.filter((f) => f.required && f.default === undefined).map((f) => [f.key, `value-${f.key}`]));
      const files = renderTemplateFiles(template, required);
      for (const content of Object.values(files)) expect(content).not.toMatch(/\{\{/);
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
