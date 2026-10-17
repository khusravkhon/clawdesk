// Removing a skill from one agent's workspace. OpenClaw installs skills over RPC (ClawHub or an
// uploaded archive) into <workspace>/skills/<slug>, but has no RPC to remove one, so the bridge
// does what `clawhub uninstall` does: the folder goes, and so does its ClawHub lockfile entry.
// Only a real directory named skills/<slug> inside OpenClaw's state is ever touched.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

export class SkillRemoveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function checkedSkillDir(dir, stateDir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir) || path.resolve(dir) !== dir) throw new SkillRemoveError("invalid_path", "not an absolute skill folder");
  const root = path.resolve(stateDir) + path.sep;
  if (!dir.startsWith(root)) throw new SkillRemoveError("invalid_path", "outside OpenClaw's state");
  const slug = path.basename(dir);
  if (!SLUG.test(slug) || path.basename(path.dirname(dir)) !== "skills") throw new SkillRemoveError("invalid_path", "not a skills/<slug> folder");
  return { slug, workspaceDir: path.dirname(path.dirname(dir)) };
}

async function untrack(workspaceDir, slug) {
  for (const dot of [".clawhub", ".clawdhub"]) {
    const file = path.join(workspaceDir, dot, "lock.json");
    let lock;
    try {
      lock = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (!lock?.skills || typeof lock.skills !== "object" || !Object.hasOwn(lock.skills, slug)) continue;
    delete lock.skills[slug];
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, file);
  }
}

/** Removes <workspace>/skills/<slug>; a folder that is already gone is not an error. */
export async function removeWorkspaceSkill(dir, stateDir = process.env.OPENCLAW_STATE_DIR) {
  if (!stateDir) throw new SkillRemoveError("no_state_dir", "OPENCLAW_STATE_DIR is not set");
  const { slug, workspaceDir } = checkedSkillDir(dir, stateDir);
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await untrack(workspaceDir, slug);
    return { removed: false };
  }
  if (!stat.isDirectory() || (await fs.realpath(dir)) !== dir) throw new SkillRemoveError("invalid_path", "not a plain folder");
  // Out of the skills folder first, so OpenClaw never loads a half-deleted skill.
  const staged = path.join(path.dirname(dir), `.${slug}.removing-${randomUUID()}`);
  await fs.rename(dir, staged);
  await untrack(workspaceDir, slug);
  await fs.rm(staged, { recursive: true, force: true });
  return { removed: true };
}
