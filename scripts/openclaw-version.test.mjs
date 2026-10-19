import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { candidates, check, COPIES, compare, pinnedVersion, reviewNotes, setVersion, VERSION_FILE } from "./openclaw-version.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

/** A copy of just the files the script touches. */
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of new Set([VERSION_FILE, ...COPIES.map((c) => c.file)])) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  return dir;
}

test("the repository agrees with deploy/openclaw.version", () => {
  assert.deepEqual(check(), []);
});

test("set rewrites every copy but the lock, which check then reports", (t) => {
  const dir = fixture(t);
  setVersion("2026.9.33", dir);
  assert.equal(pinnedVersion(dir), "2026.9.33");
  const problems = check(dir);
  assert.equal(problems.length, 2);
  assert.ok(problems.every((p) => p.startsWith("pnpm-lock.yaml:")));
  assert.match(fs.readFileSync(path.join(dir, "deploy/docker-compose.yml"), "utf8"), /OPENCLAW_VERSION:-2026\.9\.33\}/);
  assert.match(fs.readFileSync(path.join(dir, "deploy/gateway.Dockerfile"), "utf8"), /^ARG OPENCLAW_VERSION=2026\.9\.33$/m);
});

test("set refuses pre-releases", (t) => {
  assert.throws(() => setVersion("2026.10.5-beta.1", fixture(t)), /stable/);
});

test("check notices a copy left behind", (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "deploy/gateway.Dockerfile");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^ARG OPENCLAW_VERSION=.*$/m, "ARG OPENCLAW_VERSION=2026.7.35"));
  assert.deepEqual(check(dir), [`deploy/gateway.Dockerfile: 2026.7.35 (expected ${pinnedVersion(dir)})`]);
});

test("versions compare numerically", () => {
  assert.ok(compare("2026.10.1", "2026.9.33") > 0);
  assert.ok(compare("2026.8.33", "2026.8.4") > 0);
  assert.equal(compare("2026.8.1", "2026.8.1"), 0);
});

test("candidates: newest patch of the line and newest newer line, no betas", () => {
  const published = ["2026.8.1-beta.1", "2026.8.1", "2026.8.2", "2026.8.35", "2026.9.1", "2026.9.33", "2026.10.1-beta.1", "2026.10.4", "2026.10.10-beta.1"];
  assert.deepEqual(candidates("2026.8.1", published), [
    { version: "2026.8.35", kind: "patch", labels: ["openclaw", "patch"] },
    { version: "2026.10.4", kind: "minor-line", labels: ["openclaw", "minor-line", "manual review"] },
  ]);
  assert.deepEqual(candidates("2026.10.4", published), []);
  assert.deepEqual(candidates("2026.9.33", published).map((c) => c.kind), ["minor-line"]);
  assert.deepEqual(candidates("2026.8.35", ["2026.8.35", "2026.8.36"]).map((c) => c.version), ["2026.8.36"]);
});

test("review notes point at version-specific workarounds", () => {
  const notes = reviewNotes();
  assert.ok(notes.some((n) => n.file === "deploy/docker-compose.yml" && /Gemini/.test(n.note)));
  assert.ok(notes.every((n) => n.note.length > 0 && n.line > 0));
});
