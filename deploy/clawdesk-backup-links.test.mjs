// Links OpenClaw's archive refuses (clawdesk-backup.mjs): found only where agents write, set aside for the
// time of the archive under a name OpenClaw skips, and put back — also after a backup that was cut short.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";

const tempRoot = await fs.realpath(os.tmpdir());
const root = await fs.mkdtemp(path.join(tempRoot, "clawdesk-backup-links-"));
const state = path.join(root, "openclaw");
const previousState = process.env.OPENCLAW_STATE_DIR;
let backup;
try {
  process.env.OPENCLAW_STATE_DIR = state;
  backup = await import("./clawdesk-backup.mjs?links-fixture");
} finally {
  if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previousState;
}
after(async () => {
  assert.equal(path.dirname(root), tempRoot);
  await fs.rm(root, { recursive: true, force: true });
});

const journal = path.join(root, "journal.json");
const venv = path.join(state, "workspace", ".tools", "venv", "bin");
const outside = path.join(root, "usr-bin-python3");
const link = (target, at) => fs.symlink(target, at);
const isLink = async (at) => Boolean((await fs.lstat(at).catch(() => null))?.isSymbolicLink());

/** A state folder with one link of every kind; false when this machine cannot make links. */
async function fixture(t) {
  await fs.rm(state, { recursive: true, force: true });
  await fs.rm(journal, { force: true });
  await fs.mkdir(venv, { recursive: true });
  await fs.mkdir(path.join(state, "workspace-trainer"), { recursive: true });
  await fs.mkdir(path.join(state, "company-projects", "Shop"), { recursive: true });
  await fs.mkdir(path.join(state, "plugin-skills"), { recursive: true });
  await fs.writeFile(outside, "system python");
  await fs.writeFile(path.join(venv, "python3.11"), "binary");
  try { await link("python3.11", path.join(venv, "python")); } // relative, inside: OpenClaw takes it
  catch (error) { if (error.code === "EPERM" && process.platform === "win32") { t.skip("Windows symlink permission unavailable"); return false; } throw error; }
  await link(outside, path.join(venv, "python3"));                                            // absolute
  await link(path.join("..", "..", "usr-bin-python3"), path.join(state, "workspace-trainer", "py")); // relative, leaves the state folder
  await link(outside, path.join(state, "company-projects", "Shop", "tool"));                  // absolute, in a company project
  await link(outside, path.join(state, "plugin-skills", "index"));                            // OpenClaw's own: not ours to touch
  return true;
}

test("finds only the links OpenClaw would refuse, only where agents write", async (t) => {
  if (!(await fixture(t))) return;
  const found = await backup.findOutsideLinks(state);
  assert.deepEqual(found.map((entry) => path.relative(state, entry.path).split(path.sep).join("/")).sort(), [
    "company-projects/Shop/tool",
    "workspace-trainer/py",
    "workspace/.tools/venv/bin/python3",
  ]);
  assert.equal(await isLink(path.join(state, "plugin-skills", "index")), true);
});

test("sets the links aside under a name OpenClaw skips and puts them back", async (t) => {
  if (!(await fixture(t))) return;
  const found = await backup.findOutsideLinks(state);
  await backup.displaceLinks(found, journal);
  for (const entry of found) {
    assert.equal(await isLink(entry.path), false);
    assert.equal(await isLink(`${entry.path}.clawdesk-backup.tmp`), true);
  }
  assert.equal(await isLink(path.join(venv, "python")), true, "a link OpenClaw accepts stays");
  // While set aside, nothing is found: a second backup would not journal them twice.
  assert.deepEqual(await backup.findOutsideLinks(state), []);

  assert.equal(await backup.restoreDisplacedLinks(journal, state), 3);
  for (const entry of found) {
    assert.equal(await fs.readlink(entry.path), entry.target);
    assert.equal(await isLink(`${entry.path}.clawdesk-backup.tmp`), false);
  }
  assert.equal(await fs.stat(journal).catch(() => null), null);
  assert.equal(await backup.restoreDisplacedLinks(journal, state), 0, "nothing to do without a journal");
});

test("after a backup that was cut short, a link made again meanwhile is kept and the spare one removed", async (t) => {
  if (!(await fixture(t))) return;
  const found = await backup.findOutsideLinks(state);
  await backup.displaceLinks(found, journal);
  const python3 = path.join(venv, "python3");
  await fs.writeFile(python3, "reinstalled by the agent");
  assert.equal(await backup.restoreDisplacedLinks(journal, state), 2);
  assert.equal(await fs.readFile(python3, "utf8"), "reinstalled by the agent");
  assert.equal(await isLink(`${python3}.clawdesk-backup.tmp`), false);
});

test("a journal naming paths outside the state folder moves nothing", async (t) => {
  if (!(await fixture(t))) return;
  const stray = path.join(root, "stray");
  await link(outside, `${stray}.clawdesk-backup.tmp`);
  await fs.writeFile(journal, JSON.stringify([{ path: stray, target: outside }, { path: 7 }, null]));
  assert.equal(await backup.restoreDisplacedLinks(journal, state), 0);
  assert.equal(await isLink(`${stray}.clawdesk-backup.tmp`), true);
  assert.equal(await fs.lstat(stray).catch(() => null), null);
  await fs.unlink(`${stray}.clawdesk-backup.tmp`);
});

test("no links to set aside: no journal is written", async (t) => {
  if (!(await fixture(t))) return;
  await backup.displaceLinks([], journal);
  assert.equal(await fs.stat(journal).catch(() => null), null);
});
