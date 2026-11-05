#!/usr/bin/env node
// The OpenClaw version ClawDesk runs on lives in ONE file: deploy/openclaw.version.
// Everything that cannot read that file at run time (package.json, compose default, Dockerfile ARG,
// pnpm-lock) is kept equal to it by this script.
//
//   node scripts/openclaw-version.mjs              print the pinned version
//   node scripts/openclaw-version.mjs check        fail if any copy disagrees with the file (CI runs this)
//   node scripts/openclaw-version.mjs set 2026.9.1 write the file and every copy (then: pnpm install)
//   node scripts/openclaw-version.mjs offer 2026.11.2  verified for installs that choose it in the panel; the default stays
//   node scripts/openclaw-version.mjs next         newer stable releases on npm, as JSON (the bump workflow)
//   node scripts/openclaw-version.mjs review       lines marked "openclaw-bump-review" (workarounds to recheck)
//
// Versions are YYYY.M.P. A "line" is YYYY.M: OpenClaw keeps shipping patches to older lines next to
// new ones, so a patch inside the current line and a move to a newer line are told apart.
//
// deploy/openclaw.supported lists every version this code builds: the default plus newer lines an install may
// move to from the panel (System → OpenClaw). One version per line of OpenClaw.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION_FILE = "deploy/openclaw.version";
export const SUPPORTED_FILE = "deploy/openclaw.supported";
const STABLE = /^\d{4}\.\d{1,2}\.\d{1,4}$/;
const REVIEW_MARKER = "openclaw-bump-review";

/** Every copy of the version: file, pattern with the version as group 2 (exactly one match), and how to write it. */
export const COPIES = [
  { file: "apps/bff/package.json", pattern: /("@openclaw\/gateway-client": ")([^"]+)(")/ },
  { file: "apps/bff/package.json", pattern: /("@openclaw\/gateway-protocol": ")([^"]+)(")/ },
  { file: "deploy/docker-compose.yml", pattern: /(OPENCLAW_VERSION: \$\{OPENCLAW_VERSION:-)([^}]+)(\})/ },
  { file: "deploy/gateway.Dockerfile", pattern: /(^ARG OPENCLAW_VERSION=)(\S+)()/m },
  // The lock is written by pnpm install, never by `set`; check only.
  { file: "pnpm-lock.yaml", pattern: /(\n {6}'@openclaw\/gateway-client':\n {8}specifier: )(\S+)()/, readOnly: true },
  { file: "pnpm-lock.yaml", pattern: /(\n {6}'@openclaw\/gateway-protocol':\n {8}specifier: )(\S+)()/, readOnly: true },
];

const read = (file, root = ROOT) => fs.readFileSync(path.join(root, file), "utf8");

export function pinnedVersion(root = ROOT) {
  const version = read(VERSION_FILE, root).trim();
  if (!STABLE.test(version)) throw new Error(`${VERSION_FILE}: "${version}" is not a stable YYYY.M.P version`);
  return version;
}

/** The verified versions as written (oldest first when written by this script). */
export function supportedVersions(root = ROOT) {
  return read(SUPPORTED_FILE, root).split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
}

/** Writes the list with `version` in place of any other version of its line; the comments stay. */
function writeSupported(version, root) {
  const comments = read(SUPPORTED_FILE, root).split("\n").filter((l) => l.trim().startsWith("#"));
  const versions = [...supportedVersions(root).filter((v) => lineOf(v) !== lineOf(version)), version].sort(compare);
  fs.writeFileSync(path.join(root, SUPPORTED_FILE), [...comments, ...versions, ""].join("\n"));
}

/** Disagreements between the file and its copies, as readable lines; empty when all agree. */
export function check(root = ROOT) {
  const version = pinnedVersion(root);
  const problems = [];
  const supported = supportedVersions(root);
  for (const v of supported) if (!STABLE.test(v)) problems.push(`${SUPPORTED_FILE}: "${v}" is not a stable YYYY.M.P version`);
  if (!supported.includes(version)) problems.push(`${SUPPORTED_FILE}: misses the default ${version}`);
  const lines = supported.filter((v) => STABLE.test(v)).map(lineOf);
  if (new Set(lines).size !== lines.length) problems.push(`${SUPPORTED_FILE}: more than one version of one line`);
  for (const { file, pattern } of COPIES) {
    const text = read(file, root);
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const matches = [...text.matchAll(new RegExp(pattern.source, flags))];
    if (matches.length !== 1) problems.push(`${file}: expected one match of ${pattern}, found ${matches.length}`);
    else if (matches[0][2] !== version) problems.push(`${file}: ${matches[0][2]} (expected ${version})`);
  }
  return problems;
}

export function setVersion(version, root = ROOT) {
  if (!STABLE.test(version)) throw new Error(`"${version}" is not a stable YYYY.M.P version`);
  for (const { file, pattern, readOnly } of COPIES) {
    if (readOnly) continue;
    const text = read(file, root);
    if (!pattern.test(text)) throw new Error(`${file}: ${pattern} not found`);
    fs.writeFileSync(path.join(root, file), text.replace(pattern, (_, before, _old, after) => `${before}${version}${after}`));
  }
  fs.writeFileSync(path.join(root, VERSION_FILE), `${version}\n`);
  writeSupported(version, root);
}

/** Verified for installs that choose it in the panel; new installs keep the default. */
export function offerVersion(version, root = ROOT) {
  if (!STABLE.test(version)) throw new Error(`"${version}" is not a stable YYYY.M.P version`);
  writeSupported(version, root);
}

const parts = (v) => v.split(".").map(Number);
export const lineOf = (v) => parts(v).slice(0, 2).join(".");
export function compare(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Newer stable releases worth a pull request: the newest patch of the current line ("patch") and the
 * newest release of a newer line ("minor-line"). Betas and other pre-releases never count.
 */
export function candidates(current, published) {
  const stable = published.filter((v) => STABLE.test(v) && compare(v, current) > 0).sort(compare);
  const patch = stable.filter((v) => lineOf(v) === lineOf(current)).at(-1) ?? null;
  const newest = stable.at(-1) ?? null;
  const line = newest && lineOf(newest) !== lineOf(current) ? newest : null;
  return [
    ...(patch ? [{ version: patch, kind: "patch", labels: ["openclaw", "patch"] }] : []),
    ...(line ? [{ version: line, kind: "minor-line", labels: ["openclaw", "minor-line", "manual review"] }] : []),
  ];
}

/** Lines that carry the review marker: version-specific workarounds a bump has to look at again. */
export function reviewNotes(root = ROOT) {
  const notes = [];
  const files = ["deploy/docker-compose.yml", "deploy/gateway.Dockerfile", "deploy/gateway-start.sh", ...fs.readdirSync(path.join(root, "deploy")).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")).map((f) => `deploy/${f}`)];
  for (const file of [...new Set(files)]) {
    read(file, root).split("\n").forEach((line, i) => {
      const at = line.indexOf(REVIEW_MARKER);
      if (at >= 0) notes.push({ file, line: i + 1, note: line.slice(at + REVIEW_MARKER.length).replace(/^[:\s]+/, "").trim() });
    });
  }
  return notes;
}

const npmJson = (args) => JSON.parse(execFileSync("npm", ["view", ...args, "--json"], { encoding: "utf8", shell: process.platform === "win32" }));

function main([command, arg]) {
  switch (command) {
    case undefined:
      console.log(pinnedVersion());
      return 0;
    case "check": {
      const problems = check();
      if (!problems.length) {
        console.log(`OpenClaw ${pinnedVersion()}: all copies agree with ${VERSION_FILE}`);
        return 0;
      }
      console.error(`OpenClaw version copies disagree with ${VERSION_FILE} (fix: node scripts/openclaw-version.mjs set <version> && pnpm install):`);
      for (const p of problems) console.error(`  ${p}`);
      return 1;
    }
    case "set":
      setVersion(arg ?? "");
      console.log(`OpenClaw ${arg}: written. Next: pnpm install (updates pnpm-lock.yaml), then the tests and the contract test.`);
      return 0;
    case "offer":
      offerVersion(arg ?? "");
      console.log(`OpenClaw ${arg}: offered to installs (${SUPPORTED_FILE}); the default stays ${pinnedVersion()}. Next: its entry in FIXES (deploy/clawdesk-startup-migration-fix.mjs), the tests, OPENCLAW_VERSION=${arg} bash deploy/scripts/contract.sh.`);
      return 0;
    case "next": {
      const current = pinnedVersion();
      // A release counts only once the panel's client packages exist in the same version.
      const clients = new Set(npmJson(["@openclaw/gateway-client", "versions"]));
      const protocols = new Set(npmJson(["@openclaw/gateway-protocol", "versions"]));
      const published = npmJson(["openclaw", "versions"]).filter((v) => clients.has(v) && protocols.has(v));
      console.log(JSON.stringify({ current, candidates: candidates(current, published) }));
      return 0;
    }
    case "review":
      for (const n of reviewNotes()) console.log(`${n.file}:${n.line}: ${n.note}`);
      return 0;
    default:
      console.error("usage: openclaw-version.mjs [check | set <version> | offer <version> | next | review]");
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
