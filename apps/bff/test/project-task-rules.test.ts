import type { ProjectChecksRunResult, ProjectCheckTestDto } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { changesBetween, judgeDev, judgeQa, lineDiff, ruleTestsOf } from "../src/company/project-task-rules.js";

const test = (name: string, status: ProjectCheckTestDto["status"] = "passed"): ProjectCheckTestDto => ({ id: `checks.test.mjs::${name}`, file: "checks.test.mjs", name, status, message: status === "failed" ? "201 !== 400" : "", fileHash: "h" });
const run = (tests: ProjectCheckTestDto[], status: ProjectChecksRunResult["status"] = "completed"): ProjectChecksRunResult => ({ status, reason: status === "blocked" ? "runner_failed" : null, tests, durationMs: 1, filesFingerprint: "f" });
const app = { "server.mjs": "code v1", "checks.test.mjs": "tests v1" };

describe("stage rules", () => {
  it("finds the rule's tests by code without matching a longer code", () => {
    expect(ruleTestsOf([test("BR-001 a"), test("BR-0010 b"), test("BR-001: c"), test("TB-001 d")], "BR-001").map(t => t.name)).toEqual(["BR-001 a", "BR-001: c"]);
  });

  it("accepts QA's work only as test-only changes with a rule test failing on the current code", () => {
    const next = { ...app, "checks.test.mjs": "tests v1 + BR-001" };
    const ok = judgeQa({ base: app, next, ignored: [], run: run([test("TB-001 a"), test("BR-001 rejects empty", "failed"), test("BR-001 accepts text")]), ruleCode: "BR-001" });
    expect(ok).toMatchObject({ ok: true, reasons: [] });
    expect(ok.changes.map(c => [c.name, c.change])).toEqual([["checks.test.mjs", "modified"]]);
    expect(judgeQa({ base: app, next, ignored: [], run: run([test("BR-001 x")]), ruleCode: "BR-001" }).reasons).toEqual(["tests_not_failing"]);
    expect(judgeQa({ base: app, next, ignored: [], run: run([test("TB-001 x", "failed")]), ruleCode: "BR-001" }).reasons).toEqual(["tests_missing", "existing_failing"]);
    expect(judgeQa({ base: app, next, ignored: [], run: run([test("BR-001 x", "flaky")]), ruleCode: "BR-001" }).reasons).toEqual(["tests_flaky"]);
    expect(judgeQa({ base: app, next, ignored: [], run: run([], "blocked"), ruleCode: "BR-001" }).reasons).toEqual(["run_blocked"]);
    expect(judgeQa({ base: app, next: { ...next, "server.mjs": "code v2" }, ignored: ["lib"], run: run([test("BR-001 x", "failed")]), ruleCode: "BR-001" }).reasons).toEqual(["layout", "changed_code"]);
    expect(judgeQa({ base: app, next: { "checks.test.mjs": "x" }, ignored: [], run: run([test("BR-001 x", "failed")]), ruleCode: "BR-001" }).reasons).toEqual(["removed_files", "changed_code"]);
    expect(judgeQa({ base: app, next: app, ignored: [], run: run([test("BR-001 x", "failed")]), ruleCode: "BR-001" }).reasons).toEqual(["no_changes"]);
  });

  it("accepts the developer's work only with test files untouched and every test passing", () => {
    const base = { ...app, "checks.test.mjs": "tests v1 + BR-001" };
    const next = { ...base, "server.mjs": "code v2" };
    expect(judgeDev({ base, next, ignored: [], run: run([test("TB-001 a"), test("BR-001 x")]), ruleCode: "BR-001" })).toMatchObject({ ok: true });
    expect(judgeDev({ base, next: { ...next, "checks.test.mjs": "weakened" }, ignored: [], run: run([test("BR-001 x")]), ruleCode: "BR-001" }).reasons).toEqual(["changed_tests"]);
    expect(judgeDev({ base, next: { ...next, "extra.test.mjs": "new" }, ignored: [], run: run([test("BR-001 x")]), ruleCode: "BR-001" }).reasons).toEqual(["changed_tests"]);
    expect(judgeDev({ base, next, ignored: [], run: run([test("BR-001 x", "failed")]), ruleCode: "BR-001" }).reasons).toEqual(["tests_failing"]);
    expect(judgeDev({ base, next, ignored: [], run: run([test("BR-001 x", "skipped")]), ruleCode: "BR-001" }).reasons).toEqual(["tests_failing"]);
    expect(judgeDev({ base, next, ignored: [], run: run([test("BR-001 x"), test("TB-002 y", "flaky")]), ruleCode: "BR-001" }).reasons).toEqual(["tests_failing"]);
    expect(judgeDev({ base, next: base, ignored: [], run: run([test("BR-001 x")]), ruleCode: "BR-001" }).reasons).toEqual(["no_changes"]);
    expect(judgeDev({ base, next: { "checks.test.mjs": base["checks.test.mjs"] }, ignored: [], run: run([test("BR-001 x")]), ruleCode: "BR-001" }).reasons).toEqual(["removed_files"]);
  });

  it("shows changes as a line diff with context", () => {
    expect(lineDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nX\ne\nf\ng")).toBe("  b\n  c\n- d\n+ X\n  e\n  f");
    expect(lineDiff("1\n2\n3\n4\n5\n6\n7\n8\n9", "0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10")).toBe("+ 0\n  1\n  2\n…\n  8\n  9\n+ 10");
    expect(changesBetween({ a: "x", b: "y" }, { a: "x", c: "z" }).map(c => [c.name, c.change, c.diff])).toEqual([["b", "removed", null], ["c", "added", "+ z"]]);
  });
});
