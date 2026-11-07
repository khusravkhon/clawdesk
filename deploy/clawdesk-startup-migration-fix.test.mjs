import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyStartupMigrationFix, FIXES, patchAgentDeletionSource, patchMigrationSource } from "./clawdesk-startup-migration-fix.mjs";

const deletionFixture = 'import path from "node:path";\nasync function remove(trashPath) {\n\t\tawait movePathToTrash(trashPath);\n}';

// Mirrors the upstream loop: failed maintenance is deliberately logged and continued.
const fixture = `async function run(params) {
	const databases = new Map();
	for (const target of params.targets) {
		const options = target;
		const databasePath = target.path;
		if (databases.has(databasePath)) continue;
		databases.set(databasePath, options);
		try {
			params.open(options);
		} catch (error) {
			params.log.warn(\`session: SQLite startup maintenance failed for \${target.agentId}; continuing: \${String(error)}\`);
		} finally {
			params.close(options);
		}
	}
	return [...databases.values()];
}`;

test("failed or deleted agent stores are not returned for reconciliation; healthy stores still are", async () => {
  const targets = Object.freeze([
    Object.freeze({ agentId: "deleted-agent", path: "/deleted.sqlite" }),
    Object.freeze({ agentId: "healthy-agent", path: "/healthy.sqlite" }),
  ]);
  const original = JSON.stringify(targets);
  const deletionFence = (target) => {
    if (target.agentId === "deleted-agent") throw new Error("Agent is deleted");
  };
  const logs = [];
  const closed = [];
  const params = { targets, open: deletionFence, close: (target) => closed.push(target.agentId), log: { warn: (message) => logs.push(message) } };
  const compile = (source) => new Function(`${source}; return run;`)();
  assert.deepEqual(await compile(fixture)(params), targets);
  const result = await compile(patchMigrationSource(fixture))(params);
  assert.deepEqual(result, [targets[1]]);
  assert.throws(() => deletionFence(targets[0]), /deleted/);
  assert.equal(JSON.stringify(targets), original);
  assert.equal(closed.length, 4);
  assert.equal(logs.length, 2);
});

test("unexpected, duplicated, or already patched source fails closed", () => {
  assert.throws(() => patchMigrationSource("unknown source"), /Unsupported/);
  assert.throws(() => patchMigrationSource(fixture + fixture), /Unsupported/);
  assert.throws(() => patchMigrationSource(patchMigrationSource(fixture)), /Unsupported/);
});

test("agent deletion allows the configured state directory outside home and tmp", async () => {
  const stateDir = path.resolve("/var/lib/clawdesk/openclaw");
  const home = path.resolve("/home/node");
  const tmp = path.resolve("/tmp");
  const defaults = [home, tmp];
  const moveToTrash = (file, { allowedRoots = defaults } = {}) => {
    if (!allowedRoots.some(root => file.startsWith(root + path.sep))) throw new Error("outside allowed roots");
  };
  const compile = (source, root) => new Function("path", "os", "process", "movePathToTrash", source.replace(/^import .+;$/gm, "") + "\nreturn remove;")(
    path, { homedir: () => home, tmpdir: () => tmp }, { env: { OPENCLAW_STATE_DIR: root } }, moveToTrash,
  );
  const file = path.join(stateDir, "agents", "test", "agent", "openclaw-agent.sqlite");
  await assert.rejects(compile(deletionFixture, stateDir)(file), /outside allowed roots/);
  const patched = patchAgentDeletionSource(deletionFixture);
  await assert.doesNotReject(compile(patched, stateDir)(file));
  await assert.rejects(compile(patched, stateDir)(path.join(path.dirname(stateDir), "outside.sqlite")), /outside allowed roots/);
  await assert.rejects(compile(patched, path.parse(stateDir).root)(file), /outside allowed roots/);
});

test("build patch rejects unexpected source bytes without changing the file", (t) => {
  const { target, apply } = setupSinglePatch(t, "migration", fixture);
  const changed = `${fixture}\n`;
  fs.writeFileSync(target, changed);
  assert.throws(apply, /digest/);
  assert.equal(fs.readFileSync(target, "utf8"), changed);
});

test("every verified OpenClaw version has a reviewed fix entry", () => {
  const supported = fs.readFileSync(new URL("./openclaw.supported", import.meta.url), "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
  for (const version of supported) assert.ok(Object.hasOwn(FIXES, version), `${version}: add it to FIXES (file and SHA-256 for each required patch, or null)`);
});

function setupSinglePatch(t, name, source) {
  const version = "2099.2.1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-startup-fix-"));
  t.after(() => {
    delete FIXES[version];
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = `${name}.js`;
  const target = path.join(root, file);
  const versionFile = path.join(root, "openclaw.version");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(versionFile, version);
  fs.writeFileSync(target, source);
  FIXES[version] = { [name]: { file, sha256: createHash("sha256").update(source).digest("hex") } };
  return { target, entry: FIXES[version], apply: () => applyStartupMigrationFix({ appDir: root, versionFile }) };
}

for (const [name, source, patch] of [["migration", fixture, patchMigrationSource], ["deletion", deletionFixture, patchAgentDeletionSource]]) {
  test(`a version can require only the ${name} fix`, (t) => {
    const { target, apply } = setupSinglePatch(t, name, source);
    assert.equal(apply(), true);
    assert.equal(fs.readFileSync(target, "utf8"), patch(source));
  });
}

test("an invalid descriptor fails with context before writing a valid patch", (t) => {
  const { target, entry, apply } = setupSinglePatch(t, "migration", fixture);
  entry.deletion = {};
  assert.throws(apply, /Invalid OpenClaw deletion fix for 2099\.2\.1; expected a file and its SHA-256 digest/);
  assert.equal(fs.readFileSync(target, "utf8"), fixture);
});

test("a failed patch write reports the patch, target and filesystem error", (t) => {
  const { target, apply } = setupSinglePatch(t, "deletion", deletionFixture);
  const failure = new Error("read-only file system");
  t.mock.method(fs, "writeFileSync", (filename) => {
    assert.equal(filename, target);
    throw failure;
  });
  assert.throws(apply, (error) => error.message === `Cannot write patched OpenClaw deletion source at ${target}: ${failure.message}` && error.cause === failure);
});

test("a version reviewed as not needing the fix builds without patching; the image version must match", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-startup-fix-"));
  FIXES["2099.1.1"] = null;
  try {
    const versionFile = path.join(root, "openclaw.version");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2099.1.1" }));
    fs.writeFileSync(versionFile, "2099.1.1");
    assert.equal(applyStartupMigrationFix({ appDir: root, versionFile }), false);
    fs.writeFileSync(versionFile, "2099.1.2");
    assert.throws(() => applyStartupMigrationFix({ appDir: root, versionFile }), /Unsupported OpenClaw version/);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2099.1.2" }));
    assert.throws(() => applyStartupMigrationFix({ appDir: root, versionFile }), /Unsupported OpenClaw version/);
  } finally {
    delete FIXES["2099.1.1"];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
