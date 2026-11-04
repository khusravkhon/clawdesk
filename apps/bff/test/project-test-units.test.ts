import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareTests, inRuleScope, testHashes, testUnits } from "../src/company/project-test-units.js";

const template = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../deploy/project-templates/task-board-v1/checks.test.mjs"), "utf8");

describe("test units", () => {
  it("splits the task-board template into its six tests and shared code", () => {
    const units = testUnits(template)!;
    expect(units.tests.map(unit => unit.key.slice(0, 6))).toEqual(["TB-001", "TB-002", "TB-003", "TB-004", "TB-005", "TB-006"]);
    expect(units.tests[1]!.text).toMatch(/^test\("TB-002 .*\n.*\n\}\);$/);
    expect(units.shared.some(text => text.includes("before(async"))).toBe(true);
    expect(units.shared.some(text => text.includes("const call ="))).toBe(true);
  });

  it("names suite members by path, numbers repeated names, and leaves computed names to shared code", () => {
    const source = [
      `import { describe, it, test } from "node:test";`,
      `describe("BR-001 titles", () => { const x = 1; it("empty", () => {}); it.skip(\`long\`, () => {}); });`,
      `test("same", () => {}); test("same", () => {});`,
      `for (const n of [1, 2]) test("n" + n, () => {});`,
      `await test.only("awaited", async (t) => { await t.test("sub", () => {}); });`,
    ].join("\n");
    const units = testUnits(source)!;
    expect(units.tests.map(unit => unit.key)).toEqual(["BR-001 titles › empty", "BR-001 titles › long", "same", "same #2", "awaited"]);
    expect(units.shared.map(text => text.split("\u0000")[0])).toEqual(["", "BR-001 titles › ", ""]);
    expect(testUnits("test(")).toBeNull();
  });

  it("hashes each reported test by its own block, so editing one test leaves the others' hashes", () => {
    const files = { "checks.test.mjs": template };
    const tests = testUnits(template)!.tests.slice(0, 2).map(unit => ({ id: `checks.test.mjs::${unit.key}`, file: "checks.test.mjs", name: unit.key }));
    const before = testHashes(files, tests);
    const edited = template.replace('"   "]) assert.equal', '"   ", "\\t"]) assert.equal');
    expect(edited).not.toBe(template);
    const after = testHashes({ "checks.test.mjs": edited }, tests);
    expect(after.get(tests[0]!.id)).toBe(before.get(tests[0]!.id));
    expect(after.get(tests[1]!.id)).not.toBe(before.get(tests[1]!.id));
    expect(testHashes({}, tests).get(tests[0]!.id)).toBeNull();
    expect(testHashes({ "checks.test.mjs": "test(" }, tests).get(tests[0]!.id)).toBeNull();
    // A subtest belongs to its parent's block.
    expect(testHashes({ "a.test.mjs": `test("p", async t => { await t.test("s", () => {}); });` }, [{ id: "a.test.mjs::p › s", file: "a.test.mjs", name: "p › s" }]).get("a.test.mjs::p › s")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("compares test by test, with shared code changes per file", () => {
    const a = `import { test } from "node:test";\nconst h = 1;\ntest("A", () => {});\ntest("B", () => {});\n`;
    const b = `import { test } from "node:test";\nconst h = 1;\nconst g = 2;\ntest("A", () => { h; });\ntest("C", () => {});\n`;
    expect(compareTests({ "x.test.mjs": a, "server.mjs": "1" }, { "x.test.mjs": b, "server.mjs": "2" })).toEqual({
      tests: [{ id: "x.test.mjs::A", file: "x.test.mjs", name: "A", change: "modified" }, { id: "x.test.mjs::B", file: "x.test.mjs", name: "B", change: "removed" }, { id: "x.test.mjs::C", file: "x.test.mjs", name: "C", change: "added" }],
      sharedChanged: [], sharedAdded: ["x.test.mjs"], unreadable: [],
    });
    expect(compareTests({ "x.test.mjs": a }, { "x.test.mjs": a.replace("h = 1", "h = 0") })).toMatchObject({ tests: [], sharedChanged: ["x.test.mjs"] });
    expect(compareTests({}, { "y.test.mjs": a }).tests.map(c => c.change)).toEqual(["added", "added"]);
    expect(compareTests({ "y.test.mjs": "test(" }, { "y.test.mjs": a }).unreadable).toEqual(["y.test.mjs"]);
  });

  it("decides which tests a rule's task may change", () => {
    const scope = { code: "BR-001", linked: ["f::TB-002 x", "f::P › sub"], otherLinked: ["f::TB-009 y"] };
    expect(inRuleScope(scope, "f::BR-001 a", "BR-001 a")).toBe(true);
    expect(inRuleScope(scope, "f::BR-0012 a", "BR-0012 a")).toBe(false);
    expect(inRuleScope(scope, "f::BR-002 a", "BR-002 a")).toBe(false);
    expect(inRuleScope(scope, "f::TB-002 x", "TB-002 x")).toBe(true);
    expect(inRuleScope(scope, "f::P", "P")).toBe(true);
    expect(inRuleScope({ ...scope, otherLinked: ["f::TB-002 x"] }, "f::TB-002 x", "TB-002 x")).toBe(false);
    expect(inRuleScope(scope, "f::TB-001 z", "TB-001 z")).toBe(false);
  });
});
