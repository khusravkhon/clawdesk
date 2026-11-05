import { createHash } from "node:crypto";

// Checks of a generated project: its own `node --test` suite, run in throwaway containers
// (see ProjectBuilder.checks). A reporter prints one line per test, prefixed by a per-run nonce so
// ordinary output cannot be mistaken for a result by accident.
//
// Two isolations (checkIsolation). "separate": the app runs alone in its own container (APP_BOOTSTRAP)
// and the tests in another that holds only the *.test.mjs files and shares nothing with the app but
// its loopback network; the tests reach it at CLAWDESK_APP_URL. App code never runs next to the
// runner, so it cannot patch assert, rewrite the reporter's output or read the nonce. Every test file
// gets a fresh app (as when the tests start the server themselves). "shared": older projects whose
// tests start server.mjs themselves; app code then runs in the runner's container and a deliberately
// hostile project could forge results, which the panel shows as a warning.

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
const [payload, nonce, attemptList = "1,2", only = ""] = process.argv.slice(1);
const project = process.env.CLAWDESK_CHECKS_ROOT ?? "/project", runner = process.env.CLAWDESK_CHECKS_RUNNER ?? "/runner";
try {
  const files = JSON.parse(Buffer.from(payload, "base64"));
  for (const [name, data] of Object.entries(files)) await fs.writeFile(project + "/" + name, data, { mode: 0o444 });
  await fs.writeFile(runner + "/reporter.mjs", ${JSON.stringify(REPORTER)});
  // An inherited NODE_TEST_CONTEXT would make the inner runner report to a parent instead of this reporter.
  const env = { ...process.env, CLAWDESK_CHECKS_NONCE: nonce, CLAWDESK_CHECKS_ROOT: project };
  delete env.NODE_TEST_CONTEXT;
  for (const attempt of attemptList.split(",").map(Number)) {
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=" + runner + "/reporter.mjs", "--test-timeout=20000", ...(only ? [only] : [])], { cwd: project, encoding: "utf8", maxBuffer: 1 << 20, timeout: 45000, env });
    const results = (run.stdout ?? "").split("\\n").filter(line => line.startsWith(nonce)).map(line => JSON.parse(line.slice(nonce.length)));
    console.log(nonce + "A" + attempt + " " + JSON.stringify({ code: run.status, signal: run.signal, timedOut: run.error?.code === "ETIMEDOUT", results }));
    if (run.status === 0) break;
  }
} catch (error) {
  console.log(nonce + "E " + JSON.stringify(String(error?.message ?? error).slice(0, 500)));
}
console.log(nonce + "DONE");
`;

/**
 * The app alone (separate isolation): writes its files read-only and imports server.mjs. A server that
 * throws on start keeps the container alive, so the tests report "the app did not start" as a failure
 * instead of the run looking like a broken environment.
 */
export const APP_BOOTSTRAP = `import fs from "node:fs/promises";
const root = process.env.CLAWDESK_CHECKS_ROOT ?? "/project";
setInterval(() => {}, 1 << 30);
process.on("uncaughtException", error => console.error(error));
process.on("unhandledRejection", error => console.error(error));
try {
  const files = JSON.parse(Buffer.from(process.argv[1], "base64"));
  for (const [name, data] of Object.entries(files)) await fs.writeFile(root + "/" + name, data, { mode: 0o444 });
  await fs.chmod(root, 0o555);
  await import("file://" + root + "/server.mjs");
} catch (error) { console.error(error); }
`;

export const isTestFile = name => name.endsWith(".test.mjs");
export const SEPARATE_TEST_FILES = 10;

/**
 * How a project's checks run: "separate" when it has server.mjs and every test file (at most
 * SEPARATE_TEST_FILES) can use an app started by the panel (mentions CLAWDESK_APP_URL); otherwise
 * "shared". `app` is every file but the tests, `tests` only the tests.
 */
export function checkIsolation(files) {
  const names = Object.keys(files).sort(), tests = names.filter(isTestFile);
  const separate = Object.hasOwn(files, "server.mjs") && tests.length > 0 && tests.length <= SEPARATE_TEST_FILES && tests.every(name => files[name].includes("CLAWDESK_APP_URL"));
  if (!separate) return { mode: "shared", testFiles: tests };
  return { mode: "separate", testFiles: tests, app: Object.fromEntries(names.filter(name => !isTestFile(name)).map(name => [name, files[name]])), tests: Object.fromEntries(tests.map(name => [name, files[name]])) };
}

/** One container's attempt line ("<nonce>A<n> {json}"), or null when it gave no complete, error-free result. */
export function attemptOf(stdout, nonce) {
  const lines = String(stdout).split("\n").filter(line => line.startsWith(nonce)).map(line => line.slice(nonce.length));
  if (!lines.includes("DONE") || lines.some(line => line.startsWith("E "))) return null;
  const line = lines.find(item => /^A[12] /.test(item));
  return line ? { attempt: Number(line[1]), ...JSON.parse(line.slice(3)) } : null;
}

/**
 * Joins per-file runs into the output of one run (see parseCheckOutput): per attempt the results of
 * all files, the worst exit code, any timeout. A file without a result makes the whole run blocked.
 */
export function joinRuns(runs, nonce) {
  const byAttempt = new Map();
  for (const { stdout } of runs) {
    const attempt = attemptOf(stdout, nonce);
    if (!attempt) return nonce + "E " + JSON.stringify("a test file gave no result") + "\n" + nonce + "DONE\n";
    const joined = byAttempt.get(attempt.attempt) ?? { code: 0, signal: null, timedOut: false, results: [] };
    joined.code = attempt.code === 0 && joined.code === 0 ? 0 : (attempt.code || joined.code || 1);
    joined.timedOut ||= attempt.timedOut;
    joined.results.push(...attempt.results);
    byAttempt.set(attempt.attempt, joined);
  }
  return [...byAttempt.entries()].sort(([a], [b]) => a - b).map(([attempt, joined]) => nonce + "A" + attempt + " " + JSON.stringify(joined)).join("\n") + "\n" + nonce + "DONE\n";
}

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
