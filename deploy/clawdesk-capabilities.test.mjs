import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { capabilities, probe } from "./clawdesk-capabilities.mjs";

test("reports versions of the tools that answer and null for the missing ones", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-cap-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "openclaw.version"), "2026.8.1\n");
  const run = async (command) => command === "git" ? "git version 2.39.5" : command.endsWith("docker") ? "29.0.1" : null;
  assert.deepEqual(await capabilities({ versionFile: path.join(dir, "openclaw.version"), run }), { openclaw: "2026.8.1", docker: "29.0.1", git: "git version 2.39.5", gog: null });
  assert.deepEqual(await capabilities({ versionFile: path.join(dir, "missing"), run: async () => null }), { openclaw: null, docker: null, git: null, gog: null });
});

test("a probe answers with the first line, and null for a failing, missing or hanging command", async () => {
  assert.equal(await probe(process.execPath, ["-e", "console.log(String.fromCharCode(10) + 'v1' + String.fromCharCode(10) + 'v2')"]), "v1");
  assert.equal(await probe(process.execPath, ["-e", "process.exit(3)"]), null);
  assert.equal(await probe("/no/such/command", []), null);
  assert.equal(await probe(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100 }), null);
});
