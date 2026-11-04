import { createHash } from "node:crypto";

// Checks of a generated project: its own `node --test` suite, run in a throwaway container
// (see ProjectBuilder.checks). The container gets a copy of the project's files and this
// bootstrap; a reporter prints one line per test, prefixed by a per-run nonce so ordinary
// output of the project cannot be mistaken for a result by accident. The project code runs in
// the same sandbox as the runner: results are only as trustworthy as that code — a deliberately
// hostile project could forge them. Separating the runner from project code is a later step.

export const CHECK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const CHECK_PAYLOAD_LIMIT = 80_000;
/** Linux limits one argument to 128 KiB; the base64 payload travels as one. */
export const CHECK_ARGUMENT_LIMIT = 120_000;
const hash = value => createHash("sha256").update(value).digest("hex");

/** Node test reporter: one JSON line per finished test (suites are skipped), names joined with " › ". */
const REPORTER = `export default async function* reporter(source) {
  const nonce = process.env.CLAWDESK_CHECKS_NONCE, stacks = new Map(), root = process.env.CLAWDESK_CHECKS_ROOT + "/";
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === "test:start") { const stack = stacks.get(data.file) ?? []; stack[data.nesting] = data.name; stack.length = data.nesting + 1; stacks.set(data.file, stack); continue; }
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (data.details?.type === "suite") continue;
    const name = [...(stacks.get(data.file) ?? []).slice(0, data.nesting), data.name].join(" › ");
    const error = data.details?.error;
    const message = event.type === "test:fail" ? String(error?.cause?.message ?? error?.message ?? error ?? "").slice(0, 1000) : "";
    const file = data.file ? String(data.file).replace(/^file:\\/\\//, "").replace(root, "") : "";
    yield nonce + JSON.stringify({ file, name, status: event.type === "test:pass" ? (data.skip || data.todo ? "skipped" : "passed") : "failed", message }) + "\\n";
  }
}
`;

/**
 * Writes the files, runs `node --test` and, when anything failed, once more to tell a flaky test
 * from a failing one. Prints "<nonce>A<attempt> {json}" per attempt and "<nonce>DONE" at the end.
 * Directories come from the environment only so tests can run it outside a container.
 */
export const CHECKS_BOOTSTRAP = `import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
const [payload, nonce] = process.argv.slice(1);
const project = process.env.CLAWDESK_CHECKS_ROOT ?? "/project", runner = process.env.CLAWDESK_CHECKS_RUNNER ?? "/runner";
try {
  const files = JSON.parse(Buffer.from(payload, "base64"));
  for (const [name, data] of Object.entries(files)) await fs.writeFile(project + "/" + name, data, { mode: 0o444 });
  await fs.writeFile(runner + "/reporter.mjs", ${JSON.stringify(REPORTER)});
  // An inherited NODE_TEST_CONTEXT would make the inner runner report to a parent instead of this reporter.
  const env = { ...process.env, CLAWDESK_CHECKS_NONCE: nonce, CLAWDESK_CHECKS_ROOT: project };
  delete env.NODE_TEST_CONTEXT;
  for (const attempt of [1, 2]) {
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=" + runner + "/reporter.mjs", "--test-timeout=20000"], { cwd: project, encoding: "utf8", maxBuffer: 1 << 20, timeout: 45000, env });
    const results = (run.stdout ?? "").split("\\n").filter(line => line.startsWith(nonce)).map(line => JSON.parse(line.slice(nonce.length)));
    console.log(nonce + "A" + attempt + " " + JSON.stringify({ code: run.status, signal: run.signal, timedOut: run.error?.code === "ETIMEDOUT", results }));
    if (run.status === 0) break;
  }
} catch (error) {
  console.log(nonce + "E " + JSON.stringify(String(error?.message ?? error).slice(0, 500)));
}
console.log(nonce + "DONE");
`;

/** The flat set of project files a run copies: regular, small, no dotfiles or local databases. */
export function selectCheckFiles(entries) {
  return entries.filter(entry => entry.isFile() && CHECK_FILE.test(entry.name) && !/\.sqlite(?:-(?:wal|shm|journal))?$/.test(entry.name)).map(entry => entry.name).sort();
}

/**
 * Turns the container's output into a run: per test the final status (a test that failed once and
 * then passed is "flaky"), with the hash of the file that holds it so a linked scenario notices edits.
 */
export function parseCheckOutput(stdout, nonce, files) {
  const lines = String(stdout).split("\n").filter(line => line.startsWith(nonce)).map(line => line.slice(nonce.length));
  if (!lines.includes("DONE")) return { status: "blocked", reason: "runner_failed", tests: [] };
  const failure = lines.find(line => line.startsWith("E "));
  if (failure) return { status: "blocked", reason: "runner_failed", tests: [] };
  const attempts = lines.filter(line => /^A[12] /.test(line)).map(line => JSON.parse(line.slice(3)));
  if (!attempts.length) return { status: "blocked", reason: "runner_failed", tests: [] };
  if (attempts.some(attempt => attempt.timedOut)) return { status: "blocked", reason: "timeout", tests: [] };
  const byId = new Map();
  attempts.forEach((attempt, index) => {
    const seen = new Map();
    for (const result of attempt.results) {
      const base = `${result.file}::${result.name}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const id = count > 1 ? `${base} #${count}` : base;
      const previous = byId.get(id);
      if (!previous) byId.set(id, { id, file: result.file, name: result.name, status: result.status, message: result.message, attempts: [result.status] });
      else {
        previous.attempts[index] = result.status;
        if (previous.status !== result.status && [previous.status, result.status].includes("failed")) previous.status = "flaky";
        if (result.status === "failed") previous.message = result.message;
      }
    }
  });
  const tests = [...byId.values()].map(test => ({ id: test.id, file: test.file, name: test.name, status: test.status, message: test.status === "passed" || test.status === "skipped" ? "" : test.message, fileHash: Object.hasOwn(files, test.file) ? hash(files[test.file]) : null }));
  if (!tests.length) return { status: "blocked", reason: "no_tests", tests: [] };
  return { status: "completed", reason: null, tests };
}

export const filesFingerprint = files => hash(JSON.stringify(Object.keys(files).sort().map(name => [name, hash(files[name])])));
