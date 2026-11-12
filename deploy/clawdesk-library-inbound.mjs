import fs from "node:fs/promises";
import path from "node:path";
import { FILE_LIMIT, inboundName, readInbound } from "./clawdesk-owner-files.mjs";

// Documents the owner sent to the bot in Telegram, for the panel's library. OpenClaw keeps each one in
// media/inbound under "<name>---<uuid>.<ext>" without saying which agent got it; the agent is the one whose
// own data (its transcripts and session store) mentions that uuid — seen live: only the receiving agent's
// openclaw-agent.sqlite named the file. The panel reads the text itself, as for files sent in its chat.

export const DOCUMENT_TYPES = new Map([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
]);
const AGENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Agent files that can mention a received file; larger ones are skipped rather than read into memory. */
const AGENT_DATA = /\.(sqlite|sqlite-wal|jsonl)$/;
const MAX_AGENT_FILE = 512 * 1024 * 1024;
const MAX_PAGE = 50;

export function documentType(id) {
  const ext = /\.[\p{L}\p{N}]{1,10}$/u.exec(id)?.[0].toLowerCase();
  return ext ? DOCUMENT_TYPES.get(ext) ?? null : null;
}

/** Which agents' own data mentions each uuid. Every file is read once for the whole page. */
export async function agentsMentioning(stateDir, uuids) {
  const found = new Map(uuids.map((uuid) => [uuid, new Set()]));
  if (!uuids.length) return found;
  const root = path.join(stateDir, "agents");
  for (const agent of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!agent.isDirectory() || !AGENT.test(agent.name)) continue;
    const files = [];
    const walk = async (dir, depth) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) await walk(full, depth + 1);
        else if (entry.isFile() && AGENT_DATA.test(entry.name)) files.push(full);
      }
    };
    await walk(path.join(root, agent.name), 0);
    for (const file of files) {
      const missing = uuids.filter((uuid) => !found.get(uuid).has(agent.name));
      if (!missing.length) break;
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_AGENT_FILE) continue;
      const bytes = await fs.readFile(file).catch(() => null);
      if (!bytes) continue;
      for (const uuid of missing) if (bytes.includes(uuid)) found.get(uuid).add(agent.name);
    }
  }
  return found;
}

/** Documents received at or after `after` (ms), oldest first, each with the agents that got it. */
export async function listInboundDocuments(stateDir, { after = 0, limit = 20 } = {}) {
  const dir = path.join(stateDir, "media", "inbound");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const candidates = [];
  for (const entry of entries) {
    const mimeType = entry.isFile() ? documentType(entry.name) : null;
    const uuid = UUID.exec(entry.name)?.[0].toLowerCase();
    if (!mimeType || !uuid) continue;
    const stat = await fs.lstat(path.join(dir, entry.name)).catch(() => null);
    if (!stat?.isFile() || stat.size === 0 || stat.size > FILE_LIMIT) continue;
    const modifiedAt = Math.floor(stat.mtimeMs);
    if (modifiedAt >= after) candidates.push({ id: entry.name, uuid, mimeType, size: stat.size, modifiedAt });
  }
  candidates.sort((a, b) => a.modifiedAt - b.modifiedAt || a.id.localeCompare(b.id));
  const page = candidates.slice(0, Math.min(Math.max(1, limit), MAX_PAGE));
  const agents = await agentsMentioning(stateDir, page.map((file) => file.uuid));
  return {
    files: page.map(({ id, uuid, mimeType, size, modifiedAt }) => ({
      id, name: inboundName(id) ?? `документ${/\.[\p{L}\p{N}]{1,10}$/u.exec(id)?.[0] ?? ""}`, mimeType, size, modifiedAt,
      agentIds: [...agents.get(uuid)].sort(),
    })),
    more: candidates.length > page.length,
  };
}

/** One listed document's bytes, as base64; only document types, never other media. */
export async function readInboundDocument(stateDir, id) {
  const mimeType = typeof id === "string" ? documentType(id) : null;
  if (!mimeType) return { status: 400, body: { error: "invalid_file_request", message: "invalid_file_request" } };
  const bytes = await readInbound(stateDir, id);
  return { status: 200, body: { id, mimeType, base64: Buffer.from(bytes).toString("base64") } };
}
