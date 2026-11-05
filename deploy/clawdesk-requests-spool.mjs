import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

// The spool the clawdesk-requests plugin files into (<state>/clawdesk/requests). The panel reads it and
// acknowledges what it has stored; only then are the files removed, so a panel restart loses nothing.
// The folder is the Gateway's own (never mounted into a sandbox); entries are still read without
// following links and bounded, since their content comes from agents.

const ENTRY = /^[a-f0-9]{32}\.json$/;
const MAX_ENTRY = 16_384;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const requestsSpoolDir = (stateDir) => path.join(stateDir, "clawdesk", "requests");

/** Up to `limit` entries, oldest first; unreadable or oversized files are reported by name only. */
export async function readRequestsSpool(dir, limit = 100) {
  let names;
  try { names = (await fs.readdir(dir)).filter((name) => ENTRY.test(name)); }
  catch (error) { if (error.code === "ENOENT") return { entries: [], rejected: [] }; throw error; }
  const entries = [], rejected = [];
  for (const name of names) {
    let handle;
    try {
      handle = await fs.open(path.join(dir, name), READ);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_ENTRY) { rejected.push(name.slice(0, 32)); continue; }
      const value = JSON.parse(await handle.readFile("utf8"));
      if (value?.id !== name.slice(0, 32)) { rejected.push(name.slice(0, 32)); continue; }
      entries.push(value);
    } catch { rejected.push(name.slice(0, 32)); }
    finally { await handle?.close(); }
  }
  entries.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0) || a.id.localeCompare(b.id));
  return { entries: entries.slice(0, limit), rejected };
}

/** Removes entries the panel has stored (or rejected). */
export async function ackRequestsSpool(dir, ids) {
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))) throw Object.assign(new Error("invalid ack"), { status: 400 });
  for (const id of ids) await fs.rm(path.join(dir, `${id}.json`), { force: true });
  return { removed: ids.length };
}
