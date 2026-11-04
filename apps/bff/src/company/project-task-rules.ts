import type { ProjectChecksRunResult, ProjectCheckTestDto, ProjectFileChange, ProjectTaskReason } from "@clawdesk/shared";

// What the panel requires of each executor stage (P6.2). Pure functions: the service feeds them the
// files a stage started from, the files the executor left and the checks run on those files.

export const isTestFile = (name: string) => /\.test\.mjs$/.test(name);
const MAX_DIFF_CELLS = 4_000_000;

/** Tests whose name starts with the rule's code (e.g. "BR-001 …"), the convention given to QA. */
export function ruleTestsOf(tests: ProjectCheckTestDto[], ruleCode: string): ProjectCheckTestDto[] {
  return tests.filter(test => test.name.startsWith(ruleCode) && !/[A-Za-z0-9]/.test(test.name.charAt(ruleCode.length)));
}

export function changesBetween(base: Record<string, string>, next: Record<string, string>): ProjectFileChange[] {
  const names = [...new Set([...Object.keys(base), ...Object.keys(next)])].sort();
  const changes: ProjectFileChange[] = [];
  for (const name of names) {
    if (!Object.hasOwn(next, name)) changes.push({ name, change: "removed", diff: null });
    else if (!Object.hasOwn(base, name)) changes.push({ name, change: "added", diff: lineDiff("", next[name]!) });
    else if (base[name] !== next[name]) changes.push({ name, change: "modified", diff: lineDiff(base[name]!, next[name]!) });
  }
  return changes;
}

/**
 * A readable line diff ("- " removed, "+ " added, "  " context), two lines of context around changes;
 * null when the files are too large to compare here.
 */
export function lineDiff(before: string, after: string): string | null {
  const a = before === "" ? [] : before.split("\n"), b = after.split("\n");
  if (a.length * b.length > MAX_DIFF_CELLS) return null;
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { kind: " " | "-" | "+"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ kind: " ", text: a[i]! }); i++; j++; }
    else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ kind: "-", text: a[i]! }); i++; }
    else { ops.push({ kind: "+", text: b[j]! }); j++; }
  }
  const keep = ops.map((op, index) => op.kind !== " " || ops.slice(Math.max(0, index - 2), index + 3).some(near => near.kind !== " "));
  const lines: string[] = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!keep[index]) { skipped = lines.length > 0; return; }
    if (skipped) lines.push("…");
    skipped = false;
    lines.push(`${op.kind} ${op.text}`);
  });
  return lines.join("\n");
}

type StageInput = { base: Record<string, string>; next: Record<string, string>; ignored: string[]; run: ProjectChecksRunResult; ruleCode: string };
export type StageVerdict = { ok: boolean; reasons: ProjectTaskReason[]; changes: ProjectFileChange[]; ruleTests: ProjectCheckTestDto[]; otherProblems: ProjectCheckTestDto[] };

/**
 * QA: only test files added or changed, nothing removed; tests named with the rule's code exist, and at
 * least one of them fails on the current code (an assertion failure in a completed run — a crash or a
 * blocked run is not "failing for the expected reason"); other tests still pass.
 */
export function judgeQa({ base, next, ignored, run, ruleCode }: StageInput): StageVerdict {
  const changes = changesBetween(base, next);
  const reasons = new Set<ProjectTaskReason>();
  if (ignored.length) reasons.add("layout");
  if (!changes.length) reasons.add("no_changes");
  if (changes.some(change => change.change === "removed")) reasons.add("removed_files");
  if (changes.some(change => !isTestFile(change.name))) reasons.add("changed_code");
  const ruleTests = run.status === "completed" ? ruleTestsOf(run.tests, ruleCode) : [];
  const otherProblems = run.status === "completed" ? run.tests.filter(test => !ruleTests.includes(test) && test.status !== "passed" && test.status !== "skipped") : [];
  if (run.status !== "completed") reasons.add("run_blocked");
  else {
    if (!ruleTests.length) reasons.add("tests_missing");
    else if (ruleTests.some(test => test.status === "flaky")) reasons.add("tests_flaky");
    else if (!ruleTests.some(test => test.status === "failed")) reasons.add("tests_not_failing");
    if (otherProblems.length) reasons.add("existing_failing");
  }
  return { ok: !reasons.size, reasons: [...reasons], changes, ruleTests, otherProblems };
}

/**
 * Developer: every test file exactly as QA left it (none changed, removed or added), no file removed,
 * something changed, and every test passes — a flaky or skipped rule test is not a pass.
 */
export function judgeDev({ base, next, ignored, run, ruleCode }: StageInput): StageVerdict {
  const changes = changesBetween(base, next);
  const reasons = new Set<ProjectTaskReason>();
  if (ignored.length) reasons.add("layout");
  if (changes.some(change => isTestFile(change.name))) reasons.add("changed_tests");
  if (changes.some(change => change.change === "removed")) reasons.add("removed_files");
  if (!changes.length) reasons.add("no_changes");
  const ruleTests = run.status === "completed" ? ruleTestsOf(run.tests, ruleCode) : [];
  const otherProblems = run.status === "completed" ? run.tests.filter(test => !ruleTests.includes(test) && test.status !== "passed" && test.status !== "skipped") : [];
  if (run.status !== "completed") reasons.add("run_blocked");
  else {
    if (!ruleTests.length) reasons.add("tests_missing");
    if (ruleTests.some(test => test.status !== "passed") || otherProblems.length) reasons.add("tests_failing");
  }
  return { ok: !reasons.size, reasons: [...reasons], changes, ruleTests, otherProblems };
}

/** The files a developer stage starts from: the app plus QA's accepted test files. */
export function developerBase(app: Record<string, string>, qaTests: Record<string, string>): Record<string, string> {
  return { ...app, ...qaTests };
}
