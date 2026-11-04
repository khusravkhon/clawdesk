import { createHash } from "node:crypto";
import { parse } from "acorn";

// P6.3: a project's test files split into units, so one test can change without touching the others.
// A unit is a `test("name", …)` / `it(…)` call with a literal name (inside `describe`/`suite` its key is
// the joined path "suite › name", the way the checks reporter names it). Every other top-level statement
// (imports, helpers, hooks, tests with computed names) is shared code: it can affect every test, so the
// task stages treat changing it as touching protected tests and adding to it as a warning.

type Node = { type: string; start: number; end: number; [key: string]: unknown };
export type TestUnit = { key: string; text: string };
export type TestFileUnits = { tests: TestUnit[]; shared: string[] };
export type TestChange = { id: string; file: string; name: string; change: "added" | "modified" | "removed" };
export type TestComparison = { tests: TestChange[]; sharedChanged: string[]; sharedAdded: string[]; unreadable: string[] };

export const isTestFile = (name: string) => /\.test\.mjs$/.test(name);
const TESTS = new Set(["test", "it"]), SUITES = new Set(["describe", "suite"]), MODIFIERS = new Set(["skip", "only", "todo"]);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function literalName(node: Node | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  const quasis = node?.quasis as { value: { cooked: string | null } }[] | undefined;
  if (node?.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0 && quasis?.[0]?.value.cooked != null) return quasis[0].value.cooked;
  return null;
}

/** `test("name", fn)`, `it.skip(…)`, `await describe(…)` → its kind, name and the function body of a suite. */
function callOf(statement: Node): { kind: "test" | "suite"; name: string; body: Node[] | null } | null {
  if (statement.type !== "ExpressionStatement") return null;
  let expression = statement.expression as Node;
  if (expression.type === "AwaitExpression") expression = expression.argument as Node;
  if (expression.type !== "CallExpression") return null;
  let callee = expression.callee as Node;
  if (callee.type === "MemberExpression" && !callee.computed && MODIFIERS.has((callee.property as Node & { name?: string }).name ?? "")) callee = callee.object as Node;
  if (callee.type !== "Identifier") return null;
  const id = callee.name as string;
  const kind = TESTS.has(id) ? "test" : SUITES.has(id) ? "suite" : null;
  const args = expression.arguments as Node[];
  const name = literalName(args[0]);
  if (!kind || name === null) return null;
  const fn = args.find(arg => arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression");
  const body = fn?.body as Node | undefined;
  return { kind, name, body: body?.type === "BlockStatement" ? body.body as Node[] : null };
}

/** The file's test units and shared statements, or null when it does not parse as a module. */
export function testUnits(source: string): TestFileUnits | null {
  let program: Node;
  try { program = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }) as unknown as Node; }
  catch { return null; }
  const result: TestFileUnits = { tests: [], shared: [] };
  const seen = new Map<string, number>();
  const walk = (statements: Node[], prefix: string) => {
    for (const statement of statements) {
      const call = callOf(statement);
      const text = source.slice(statement.start, statement.end);
      if (call?.kind === "test") {
        const base = prefix + call.name, count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        result.tests.push({ key: count > 1 ? `${base} #${count}` : base, text });
      } else if (call?.kind === "suite" && call.body) walk(call.body, `${prefix}${call.name} › `);
      else result.shared.push(`${prefix}\u0000${text}`);
    }
  };
  walk(program.body as Node[], "");
  return result;
}

/** The unit a reported test belongs to: its own key, or the test it is a subtest of. */
export function unitOf(units: TestFileUnits, name: string): TestUnit | null {
  let best: TestUnit | null = null;
  for (const unit of units.tests)
    if ((unit.key === name || name.startsWith(`${unit.key} › `)) && unit.key.length > (best?.key.length ?? -1)) best = unit;
  return best;
}

/**
 * Per reported test (id "<file>::<name>"), a hash of its own unit; null when the file is missing or does
 * not parse, or the test has no literal-named unit. A scenario linked to this hash stays valid while
 * other tests in the same file change.
 */
export function testHashes(files: Record<string, string>, tests: { id: string; file: string; name: string }[]): Map<string, string | null> {
  const parsed = new Map<string, TestFileUnits | null>();
  const hashes = new Map<string, string | null>();
  for (const test of tests) {
    if (!Object.hasOwn(files, test.file)) { hashes.set(test.id, null); continue; }
    if (!parsed.has(test.file)) parsed.set(test.file, testUnits(files[test.file]!));
    const units = parsed.get(test.file);
    // The reporter numbers repeated names in the ID ("<file>::<name> #2"), as testUnits does in the key.
    const key = test.id.startsWith(`${test.file}::`) ? test.id.slice(test.file.length + 2) : test.name;
    const unit = units ? unitOf(units, key) ?? unitOf(units, test.name) : null;
    hashes.set(test.id, unit ? sha(`${test.file}\u0000${unit.text}`) : null);
  }
  return hashes;
}

function counts(values: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}

/** Test units added, modified and removed between two sets of files; shared code changed or added per file. */
export function compareTests(base: Record<string, string>, next: Record<string, string>): TestComparison {
  const result: TestComparison = { tests: [], sharedChanged: [], sharedAdded: [], unreadable: [] };
  const names = [...new Set([...Object.keys(base), ...Object.keys(next)])].filter(isTestFile).sort();
  for (const file of names) {
    if (base[file] === next[file]) continue;
    const before = Object.hasOwn(base, file) ? testUnits(base[file]!) : { tests: [], shared: [] };
    const after = Object.hasOwn(next, file) ? testUnits(next[file]!) : { tests: [], shared: [] };
    if (!before || !after) { result.unreadable.push(file); continue; }
    const old = new Map(before.tests.map(unit => [unit.key, unit.text])), now = new Map(after.tests.map(unit => [unit.key, unit.text]));
    for (const key of [...new Set([...old.keys(), ...now.keys()])].sort()) {
      const change = !now.has(key) ? "removed" : !old.has(key) ? "added" : old.get(key) !== now.get(key) ? "modified" : null;
      if (change) result.tests.push({ id: `${file}::${key}`, file, name: key, change });
    }
    const left = counts(before.shared), right = counts(after.shared);
    if ([...left].some(([text, n]) => (right.get(text) ?? 0) < n)) result.sharedChanged.push(file);
    if ([...right].some(([text, n]) => (left.get(text) ?? 0) < n)) result.sharedAdded.push(file);
  }
  return result;
}

/**
 * Which tests a task on one rule may change: tests named with the rule's code, or linked to one of its
 * acceptance scenarios (any version: that is how a template test protecting the old behaviour is found).
 * A test named with another rule's code or linked to another rule's current scenario stays protected.
 */
export type RuleScope = { code: string; linked: string[]; otherLinked: string[] };
const CODE = /^BR-\d+(?![A-Za-z0-9])/;
const startsWithCode = (name: string, code: string) => name.startsWith(code) && !/[A-Za-z0-9]/.test(name.charAt(code.length));
const linkedTo = (id: string, links: string[]) => links.some(link => link === id || link.startsWith(`${id} › `) || id.startsWith(`${link} › `));

export function inRuleScope(scope: RuleScope, id: string, name: string): boolean {
  const otherCode = CODE.exec(name)?.[0];
  if (otherCode && otherCode !== scope.code) return false;
  if (linkedTo(id, scope.otherLinked)) return false;
  return startsWithCode(name, scope.code) || linkedTo(id, scope.linked);
}
