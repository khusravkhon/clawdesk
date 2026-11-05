import type { ProjectChecksRunResult, ProjectCheckTestDto } from "@clawdesk/shared";
import { describe, expect, it } from "vitest";
import { changesBetween, judgeDev, judgeQa, lineDiff, ruleTestsOf, separateCapable } from "../src/company/project-task-rules.js";
import { changedByReviewer, parseReview } from "../src/company/project-tasks-service.js";

const test = (name: string, status: ProjectCheckTestDto["status"] = "passed"): ProjectCheckTestDto => ({ id: `checks.test.mjs::${name}`, file: "checks.test.mjs", name, status, message: status === "failed" ? "201 !== 400" : "", fileHash: "h" });
const run = (tests: ProjectCheckTestDto[], status: ProjectChecksRunResult["status"] = "completed"): ProjectChecksRunResult => ({ status, reason: status === "blocked" ? "runner_failed" : null, tests, durationMs: 1, filesFingerprint: "f" });
const PRELUDE = `import { test } from "node:test";\nconst call = () => 1;\n`;
const t = (name: string, body = "call()") => `test(${JSON.stringify(name)}, () => { ${body}; });\n`;
const app = { "server.mjs": "code v1", "checks.test.mjs": PRELUDE + t("TB-001 a") };

describe("stage rules", () => {
  it("finds the rule's tests by code without matching a longer code", () => {
    expect(ruleTestsOf([test("BR-001 a"), test("BR-0010 b"), test("BR-001: c"), test("TB-001 d")], "BR-001").map(t => t.name)).toEqual(["BR-001 a", "BR-001: c"]);
  });

  it("finds the rule's tests also by scenario links, unless another rule's current scenario or code claims them", () => {
    const scope = { code: "BR-001", linked: ["checks.test.mjs::TB-002 empty", "checks.test.mjs::TB-003 shared"], otherLinked: ["checks.test.mjs::TB-003 shared"] };
    expect(ruleTestsOf([test("TB-002 empty"), test("TB-003 shared"), test("BR-002 x"), test("BR-001 y"), test("TB-004 z")], scope).map(t => t.name)).toEqual(["TB-002 empty", "BR-001 y"]);
  });

  it("accepts QA's work only as test-only changes with a rule test failing on the current code", () => {
    const next = { ...app, "checks.test.mjs": app["checks.test.mjs"] + t("BR-001 rejects empty") };
    const ok = judgeQa({ base: app, next, ignored: [], run: run([test("TB-001 a"), test("BR-001 rejects empty", "failed"), test("BR-001 accepts text")]), scope: "BR-001" });
    expect(ok).toMatchObject({ ok: true, reasons: [], warnings: [] });
    expect(ok.changes.map(c => [c.name, c.change])).toEqual([["checks.test.mjs", "modified"]]);
    expect(ok.testChanges).toEqual([{ id: "checks.test.mjs::BR-001 rejects empty", file: "checks.test.mjs", name: "BR-001 rejects empty", change: "added", rule: true }]);
    expect(judgeQa({ base: app, next, ignored: [], run: run([test("BR-001 x")]), scope: "BR-001" }).reasons).toEqual(["tests_not_failing"]);
    expect(judgeQa({ base: app, next, ignored: [], run: run([test("TB-001 x", "failed")]), scope: "BR-001" }).reasons).toEqual(["tests_missing", "existing_failing"]);
    expect(judgeQa({ base: app, next, ignored: [], run: run([test("BR-001 x", "flaky")]), scope: "BR-001" }).reasons).toEqual(["tests_flaky"]);
    expect(judgeQa({ base: app, next, ignored: [], run: run([], "blocked"), scope: "BR-001" }).reasons).toEqual(["run_blocked"]);
    expect(judgeQa({ base: app, next: { ...next, "server.mjs": "code v2" }, ignored: ["lib"], run: run([test("BR-001 x", "failed")]), scope: "BR-001" }).reasons).toEqual(["layout", "changed_code"]);
    expect(judgeQa({ base: app, next: { "checks.test.mjs": next["checks.test.mjs"] }, ignored: [], run: run([test("BR-001 x", "failed")]), scope: "BR-001" }).reasons).toEqual(["removed_files", "changed_code"]);
    expect(judgeQa({ base: app, next: app, ignored: [], run: run([test("BR-001 x", "failed")]), scope: "BR-001" }).reasons).toEqual(["no_changes"]);
  });

  it("keeps every other test and the existing shared test code exactly as it was", () => {
    const failing = run([test("TB-001 a"), test("BR-001 new", "failed")]);
    const weakened = { ...app, "checks.test.mjs": PRELUDE + t("TB-001 a", "return") + t("BR-001 new") };
    expect(judgeQa({ base: app, next: weakened, ignored: [], run: failing, scope: "BR-001" })).toMatchObject({ ok: false, reasons: ["protected_tests_changed"] });
    const removed = { ...app, "checks.test.mjs": PRELUDE + t("BR-001 new") };
    expect(judgeQa({ base: app, next: removed, ignored: [], run: failing, scope: "BR-001" }).testChanges.map(c => [c.name, c.change, c.rule])).toEqual([["BR-001 new", "added", true], ["TB-001 a", "removed", false]]);
    const helper = { ...app, "checks.test.mjs": PRELUDE.replace("() => 1", "() => 2") + t("TB-001 a") + t("BR-001 new") };
    expect(judgeQa({ base: app, next: helper, ignored: [], run: failing, scope: "BR-001" }).reasons).toEqual(["shared_test_code_changed"]);
    // A new helper is allowed, with a warning for the review.
    const added = { ...app, "checks.test.mjs": PRELUDE + "const extra = () => 3;\n" + t("TB-001 a") + t("BR-001 new") };
    expect(judgeQa({ base: app, next: added, ignored: [], run: failing, scope: "BR-001" })).toMatchObject({ ok: true, warnings: ["shared_test_code_added"] });
    expect(judgeQa({ base: app, next: { ...app, "checks.test.mjs": "test(" }, ignored: [], run: failing, scope: "BR-001" }).reasons).toContain("tests_unreadable");
  });

  it("lets a rule change rewrite the template test linked to the rule's scenario, but not another rule's", () => {
    const base = { ...app, "checks.test.mjs": PRELUDE + t("TB-001 a") + t("TB-002 empty rejected") + t("BR-002 unique") };
    const scope = { code: "BR-001", linked: ["checks.test.mjs::TB-002 empty rejected"], otherLinked: ["checks.test.mjs::TB-001 a"] };
    const next = { ...base, "checks.test.mjs": PRELUDE + t("TB-001 a") + t("BR-001 empty becomes untitled", "call(2)") + t("BR-002 unique") };
    const verdict = judgeQa({ base, next, ignored: [], run: run([test("TB-001 a"), test("BR-001 empty becomes untitled", "failed"), test("BR-002 unique")]), scope });
    expect(verdict).toMatchObject({ ok: true });
    expect(verdict.testChanges.map(c => [c.name, c.change, c.rule])).toEqual([["BR-001 empty becomes untitled", "added", true], ["TB-002 empty rejected", "removed", true]]);
    const otherRule = { ...next, "checks.test.mjs": next["checks.test.mjs"].replace(t("BR-002 unique"), t("BR-002 unique", "return")) };
    expect(judgeQa({ base, next: otherRule, ignored: [], run: run([test("BR-001 empty becomes untitled", "failed")]), scope }).reasons).toEqual(["protected_tests_changed"]);
  });

  it("accepts the developer's work only with test files untouched and every test passing", () => {
    const base = { ...app, "checks.test.mjs": app["checks.test.mjs"] + t("BR-001 x") };
    const next = { ...base, "server.mjs": "code v2" };
    expect(judgeDev({ base, next, ignored: [], run: run([test("TB-001 a"), test("BR-001 x")]), scope: "BR-001" })).toMatchObject({ ok: true, testChanges: [] });
    expect(judgeDev({ base, next: { ...next, "checks.test.mjs": "weakened" }, ignored: [], run: run([test("BR-001 x")]), scope: "BR-001" }).reasons).toEqual(["changed_tests"]);
    expect(judgeDev({ base, next: { ...next, "extra.test.mjs": "new" }, ignored: [], run: run([test("BR-001 x")]), scope: "BR-001" }).reasons).toEqual(["changed_tests"]);
    expect(judgeDev({ base, next, ignored: [], run: run([test("BR-001 x", "failed")]), scope: "BR-001" }).reasons).toEqual(["tests_failing"]);
    expect(judgeDev({ base, next, ignored: [], run: run([test("BR-001 x", "skipped")]), scope: "BR-001" }).reasons).toEqual(["tests_failing"]);
    expect(judgeDev({ base, next, ignored: [], run: run([test("BR-001 x"), test("TB-002 y", "flaky")]), scope: "BR-001" }).reasons).toEqual(["tests_failing"]);
    expect(judgeDev({ base, next: base, ignored: [], run: run([test("BR-001 x")]), scope: "BR-001" }).reasons).toEqual(["no_changes"]);
    expect(judgeDev({ base, next: { "checks.test.mjs": base["checks.test.mjs"] }, ignored: [], run: run([test("BR-001 x")]), scope: "BR-001" }).reasons).toEqual(["removed_files"]);
  });

  it("shows changes as a line diff with context", () => {
    expect(lineDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nX\ne\nf\ng")).toBe("  b\n  c\n- d\n+ X\n  e\n  f");
    expect(lineDiff("1\n2\n3\n4\n5\n6\n7\n8\n9", "0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10")).toBe("+ 0\n  1\n  2\n…\n  8\n  9\n+ 10");
    expect(changesBetween({ a: "x", b: "y" }, { a: "x", c: "z" }).map(c => [c.name, c.change, c.diff])).toEqual([["b", "removed", null], ["c", "added", "+ z"]]);
  });

  it("refuses QA tests that would make the app run next to the tests again", () => {
    const aware = { "server.mjs": "code v1", "checks.test.mjs": PRELUDE + "const base = process.env.CLAWDESK_APP_URL;\n" + t("TB-001 a") };
    expect(separateCapable(aware)).toBe(true);
    expect(separateCapable(app)).toBe(false);
    const next = { ...aware, "rules.test.mjs": PRELUDE + t("BR-001 rejects empty") };
    const shared = { ...run([test("TB-001 a"), test("BR-001 rejects empty", "failed")]), isolation: "shared" as const };
    expect(judgeQa({ base: aware, next, ignored: [], run: shared, scope: "BR-001" }).reasons).toEqual(["tests_not_separate"]);
    // A project that never ran apart keeps working as before.
    expect(judgeQa({ base: app, next: { ...app, "rules.test.mjs": PRELUDE + t("BR-001 rejects empty") }, ignored: [], run: shared, scope: "BR-001" }).ok).toBe(true);
  });

  it("reads the reviewer's verdict from the first line and lists the files it touched", () => {
    expect(parseReview("\n# ОДОБРЕНО.\nПроверил границы", [])).toMatchObject({ verdict: "approve", comment: "Проверил границы" });
    expect(parseReview("Changes requested\n- x", [])).toMatchObject({ verdict: "changes", comment: "- x" });
    expect(parseReview("Вроде нормально, но не уверен", ["server.mjs"])).toMatchObject({ verdict: "unclear", comment: "Вроде нормально, но не уверен", changedFiles: ["server.mjs"] });
    expect(changedByReviewer({ a: "1", b: "2" }, { a: "1", c: "3", "REVIEW.md": "ok", "REVIEW-REQUEST.md": "r" })).toEqual(["b", "c"]);
  });
});
