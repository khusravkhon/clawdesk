import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyStartupMigrationFix, patchMigrationSource, SUPPORTED_VERSION, UPSTREAM_FILE } from "./clawdesk-startup-migration-fix.mjs";

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

test("build patch rejects unknown versions and source bytes without changing inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawdesk-startup-fix-"));
  try {
    const versionFile = path.join(root, "openclaw.version");
    const packageFile = path.join(root, "package.json");
    const sourceFile = path.join(root, UPSTREAM_FILE);
    fs.mkdirSync(path.dirname(sourceFile));
    fs.writeFileSync(versionFile, SUPPORTED_VERSION);
    fs.writeFileSync(packageFile, JSON.stringify({ version: "unreviewed" }));
    fs.writeFileSync(sourceFile, fixture);
    assert.throws(() => applyStartupMigrationFix({ appDir: root, versionFile }), /Unsupported OpenClaw version/);
    fs.writeFileSync(packageFile, JSON.stringify({ version: SUPPORTED_VERSION }));
    assert.throws(() => applyStartupMigrationFix({ appDir: root, versionFile }), /digest/);
    assert.equal(fs.readFileSync(sourceFile, "utf8"), fixture);
    assert.equal(fs.readFileSync(versionFile, "utf8"), SUPPORTED_VERSION);
    assert.deepEqual(JSON.parse(fs.readFileSync(packageFile, "utf8")), { version: SUPPORTED_VERSION });
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("clawdesk-startup-fix-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
