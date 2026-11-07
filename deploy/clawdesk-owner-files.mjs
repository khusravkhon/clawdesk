import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { ProjectFolderError } from "./clawdesk-project-folders.mjs";
import { agentWorkspace } from "./clawdesk-project-work.mjs";
import { withChildDirectoryWithin, withDirectoryWithin } from "./clawdesk-file-sync.mjs";

// The owner's files for agents, without any Google or other connection: the owner sends a file to the bot in
// Telegram or to the chat (OpenClaw keeps it in media/inbound), or uploads it in the panel ("Документы"). It
// lands in the shared files folder (folder "Входящие"), the same folder the owner sees on the computer.
// One file is given to one agent as a read-only copy in its workspace, folder "inbox" (/workspace/inbox in its
// sandbox): the agent gets neither the folder nor other files. A grant is checked by the copy's hash, a
// revocation by the copy being gone (like the Google Doc copies of stage 7).

export const INBOX_DIR = "inbox";
export const INCOMING = "Входящие";
export const FILE_LIMIT = 20 * 1024 * 1024;
const FILES = "workspace/files";
const INBOUND = "media/inbound";
/** One path segment of a file in the shared folder; "·" is not allowed, so the copy's name splits back. */
export const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N} ._()+,'-]{0,119}$/u;
/** OpenClaw's saved media ID: "<original name>---<uuid><ext>" or "<uuid><ext>" (Unicode letters kept). */
const INBOUND_ID = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,240}$/u;

/** The name the file came with: "ТЗ_доски---<uuid>.pdf" → "ТЗ_доски.pdf"; a bare UUID name → null. */
export function inboundName(id) {
  const match = /^(.+)---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[\p{L}\p{N}]{1,10})?$/iu.exec(id);
  return match ? `${match[1]}${match[2] ?? ""}` : null;
}
const NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, status = 409) => { throw new ProjectFolderError(code, status); };

/** "Входящие/ТЗ.pdf" → ["Входящие", "ТЗ.pdf"]; one or two segments, each a safe name. */
export function fileSegments(rel) {
  if (typeof rel !== "string") return null;
  const parts = rel.split("/");
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => !SEGMENT.test(part) || part.endsWith(".") || part.trim() !== part)) return null;
  return parts;
}
/** The copy's file name in the agent's inbox: the path with " · " between folder and file. */
export const copyName = (rel) => rel.split("/").join(" · ");
export const copyPath = (rel) => `/workspace/${INBOX_DIR}/${copyName(rel)}`;

/** A name the owner gave or the file came with, made safe for the shared folder. */
export function safeName(name, fallback = "файл") {
  const base = String(name ?? "").replace(/^.*[\\/]/, "").replace(/[^\p{L}\p{N} ._()+,'-]/gu, "_").replace(/·/g, "_").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\.+$/, "").trim().slice(0, 120);
  return SEGMENT.test(base) ? base : fallback;
}

export class OwnerFiles {
  constructor({ stateDir, configPath, now = () => Date.now() }) {
    Object.assign(this, { stateDir, configPath, now });
  }

  /** The shared folder's files, one folder deep; hidden ones and folders themselves are left out. */
  async list() {
    return withDirectoryWithin(this.stateDir, FILES, async (root) => {
      const files = [];
      const add = async (dir, prefix) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (files.length >= 500 || !SEGMENT.test(entry.name)) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isFile()) {
            const stat = await fs.lstat(`${dir}/${entry.name}`);
            files.push({ path: rel, size: stat.size, modifiedAt: Math.round(stat.mtimeMs) });
          } else if (entry.isDirectory() && !prefix) await withChildDirectoryWithin(dir, entry.name, (child) => add(child, entry.name));
        }
      };
      await add(root, "");
      return { files: files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path)) };
    });
  }

  /** Writes bytes as a new file in "Входящие" (never over an existing one: "name (2).ext"). Returns its path. */
  async #write(bytes, name) {
    if (bytes.length > FILE_LIMIT) fail("file_too_large", 413);
    const base = safeName(name);
    return withDirectoryWithin(this.stateDir, `${FILES}/${INCOMING}`, async (dir) => {
      const dot = base.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
      for (let n = 1; n < 100; n++) {
        const candidate = n === 1 ? base : `${stem.slice(0, 110)} (${n})${ext}`;
        try {
          await fs.writeFile(`${dir}/${candidate}`, bytes, { flag: "wx", mode: 0o644 });
          return { path: `${INCOMING}/${candidate}`, size: bytes.length, sha: hash(bytes) };
        } catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      fail("file_name_taken");
    }, true);
  }

  /** A file the owner sent to the bot or the chat (media://inbound/<id>) into "Входящие". */
  async storeInbound(inboundId, name) {
    if (typeof inboundId !== "string" || !INBOUND_ID.test(inboundId)) fail("invalid_file_request", 400);
    let bytes;
    try { bytes = await withDirectoryWithin(this.stateDir, INBOUND, (dir) => readFile(dir, inboundId)); }
    catch (error) { if (error instanceof ProjectFolderError) throw error; fail("file_missing", 404); }
    const ext = /\.[\p{L}\p{N}]{1,10}$/u.exec(inboundId)?.[0] ?? "";
    const given = name ? safeName(name) : null;
    // The owner's or the agent's name keeps the file's real extension.
    return this.#write(bytes, given ? (given.includes(".") || !ext ? given : `${given}${ext}`) : inboundName(inboundId) ?? `файл${ext}`);
  }

  /** A file uploaded in the panel. */
  upload(name, base64) {
    if (typeof base64 !== "string" || base64.length > Math.ceil(FILE_LIMIT / 3) * 4 + 4) fail("file_too_large", 413);
    return this.#write(Buffer.from(base64, "base64"), name);
  }

  async #source(rel) {
    const parts = fileSegments(rel);
    if (!parts) fail("invalid_file_request", 400);
    try {
      return await withDirectoryWithin(this.stateDir, parts.length === 2 ? `${FILES}/${parts[0]}` : FILES, (dir) => readFile(dir, parts.at(-1)));
    } catch (error) {
      if (error instanceof ProjectFolderError) throw error;
      fail("file_missing", 404);
    }
  }

  async #inbox(agentId, run, create = false) {
    const workspace = await agentWorkspace(this.stateDir, this.configPath, agentId);
    try { return await withDirectoryWithin(this.stateDir, `${workspace}/${INBOX_DIR}`, run, create); }
    catch (error) {
      if (error.code === "ENOENT") { if (create) fail("work_missing"); return run(null); }
      if (error.code === "ELOOP" || error.code === "ENOTDIR" || error.message === "unsafe file path") fail("work_layout");
      throw error;
    }
  }

  /** Puts a read-only copy of the file into the agent's inbox (replacing an older copy of the same file). */
  async copy(agentId, rel) {
    const bytes = await this.#source(rel);
    const name = copyName(rel);
    return this.#inbox(agentId, async (dir) => {
      const part = `.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(`${dir}/${part}`, bytes, { flag: "wx", mode: 0o444 });
        await fs.rename(`${dir}/${part}`, `${dir}/${name}`);
      } finally { await fs.rm(`${dir}/${part}`, { force: true }); }
      return { path: copyPath(rel), size: bytes.length, sha: hash(bytes), copiedAt: this.now() };
    }, true);
  }

  remove(agentId, rel) {
    if (!fileSegments(rel)) fail("invalid_file_request", 400);
    return this.#inbox(agentId, async (dir) => {
      if (dir) await fs.rm(`${dir}/${copyName(rel)}`, { force: true });
      return { removed: true };
    });
  }

  /** The copies in the agent's inbox now, with their hashes: where a grant is checked. */
  copies(agentId) {
    return this.#inbox(agentId, async (dir) => {
      if (!dir) return { copies: [] };
      const copies = [];
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        const rel = entry.name.split(" · ").join("/");
        if (!fileSegments(rel)) continue;
        copies.push({ file: rel, sha: hash(await readFile(dir, entry.name)) });
      }
      return { copies: copies.sort((a, b) => a.file.localeCompare(b.file)) };
    });
  }
}

/** Reads a regular file in an open directory without following links, at most FILE_LIMIT bytes. */
async function readFile(dir, name) {
  if (!name || name === "." || name === ".." || /[\/\\\x00]/.test(name)) fail("invalid_file_request", 400);
  const handle = await fs.open(`${dir}/${name}`, NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("file_missing", 404);
    if (stat.size > FILE_LIMIT) fail("file_too_large", 413);
    return await handle.readFile();
  } finally { await handle.close(); }
}
