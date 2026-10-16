import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeWorkspaceSkill, SkillRemoveError } from "./clawdesk-skills.mjs";

async function workspace() {
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-skills-")));
  const ws = path.join(state, "workspace-finance");
  await fs.mkdir(path.join(ws, "skills", "budget"), { recursive: true });
  await fs.writeFile(path.join(ws, "skills", "budget", "SKILL.md"), "---\nname: budget\n---\n");
  await fs.mkdir(path.join(ws, "skills", "other"), { recursive: true });
  await fs.mkdir(path.join(ws, ".clawhub"));
  await fs.writeFile(path.join(ws, ".clawhub", "lock.json"), JSON.stringify({ version: 1, skills: { budget: { version: "1.0.0" }, other: { version: "2.0.0" } } }));
  return { state, ws };
}

test("removes the folder and only its ClawHub lockfile entry", async () => {
  const { state, ws } = await workspace();
  assert.deepEqual(await removeWorkspaceSkill(path.join(ws, "skills", "budget"), state), { removed: true });
  assert.deepEqual(await fs.readdir(path.join(ws, "skills")), ["other"]);
  const lock = JSON.parse(await fs.readFile(path.join(ws, ".clawhub", "lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock.skills), ["other"]);
});

test("a folder that is already gone is fine", async () => {
  const { state, ws } = await workspace();
  assert.deepEqual(await removeWorkspaceSkill(path.join(ws, "skills", "gone"), state), { removed: false });
});

test("never touches anything but <state>/…/skills/<slug>", async () => {
  const { state, ws } = await workspace();
  const bad = [
    path.join(ws, "skills"),
    path.join(ws, "files", "budget"),
    path.join(ws, "skills", "budget", ".."),
    path.join(os.tmpdir(), "skills", "budget"),
    "skills/budget",
    path.join(ws, "skills", "bad name"),
    42,
  ];
  for (const dir of bad) await assert.rejects(removeWorkspaceSkill(dir, state), SkillRemoveError, String(dir));
  assert.ok(await fs.stat(path.join(ws, "skills", "budget", "SKILL.md")));
});

test("refuses a symlinked skill folder", { skip: process.platform === "win32" }, async () => {
  const { state, ws } = await workspace();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
  await fs.symlink(outside, path.join(ws, "skills", "linked"));
  await assert.rejects(removeWorkspaceSkill(path.join(ws, "skills", "linked"), state), SkillRemoveError);
  assert.ok(await fs.stat(outside));
});
