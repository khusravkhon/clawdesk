import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { ProjectFolderError } from "./clawdesk-project-folders.mjs";
import { SECRET, SKIP_DIRS, SKIP_FILE } from "./clawdesk-project-github.mjs";

// P8: moving a project to another installation (a server, another computer) as an explicit step. A folder
// belongs to the machine the installation runs on: a server never reads a computer's folder, the owner
// carries the project over. The bridge reads the project's folder for a package and writes a package's
// files into a new folder; the panel adds the project's description and rules around them.
// What leaves is chosen like a first GitHub push: no version control, dependencies, local databases,
// secrets (by name and by content), links or large files; the package lists what was left out and why.

export const MAX_FILES = 2000, MAX_FILE = 5 * 1024 * 1024, MAX_TOTAL = 20 * 1024 * 1024, MAX_DEPTH = 12;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const SEGMENT = /^[^\0/\\]{1,255}$/;
const fail = (code, status = 409) => { throw new ProjectFolderError(code, status); };
const sha = (value) => createHash("sha256").update(value).digest("hex");

/** The builder's note in app/: not a secret, and without it the project is no longer "made by the builder" (no checks). */
export const BUILD_FILE = "app/.clawdesk-build.json";

/** A package path: relative, forward slashes, no "." or "..", nothing the export would have left out. */
export function safePath(value) {
  if (typeof value !== "string" || value.length > 1000 || value.startsWith("/")) return false;
  if (value === BUILD_FILE) return true;
  const parts = value.split("/");
  if (parts.length > MAX_DEPTH) return false;
  return parts.every((part, index) => SEGMENT.test(part) && part !== "." && part !== ".." && !(index < parts.length - 1 ? SKIP_DIRS.has(part) || part.startsWith(".clawdesk") : SKIP_FILE.test(part)));
}

export class ProjectTransfer {
  constructor({ folders }) { this.folders = folders; }

  /** The project's files for a package (base64), and what is left out and why. Links are never followed. */
  read(projectId) {
    return this.folders.withWorkspace(projectId, async (workspace) => {
      const files = [], excluded = [];
      let total = 0;
      const walk = async (relative, depth) => {
        const entries = await fs.readdir(relative ? `${workspace.directory}/${relative}` : workspace.directory, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) { excluded.push({ path: name, reason: "link" }); continue; }
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".clawdesk")) { excluded.push({ path: `${name}/`, reason: entry.name === ".git" ? "version_control" : "generated" }); continue; }
            if (depth + 1 >= MAX_DEPTH) { excluded.push({ path: `${name}/`, reason: "too_deep" }); continue; }
            await walk(name, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          if (SKIP_FILE.test(entry.name) && name !== BUILD_FILE) { excluded.push({ path: name, reason: "secret_or_local" }); continue; }
          const handle = await fs.open(`${workspace.directory}/${name}`, READ);
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) continue;
            if (stat.size > MAX_FILE) { excluded.push({ path: name, reason: "too_large" }); continue; }
            const data = await handle.readFile();
            if (SECRET.some((pattern) => pattern.test(data.toString("latin1")))) { excluded.push({ path: name, reason: "looks_like_secret" }); continue; }
            total += data.length;
            if (files.length >= MAX_FILES || total > MAX_TOTAL) fail("transfer_too_large", 413);
            files.push({ path: name, size: data.length, sha256: sha(data), data: data.toString("base64") });
          } finally { await handle.close(); }
        }
      };
      await walk("", 0);
      return { files, excluded, mode: workspace.mode };
    });
  }

  /**
   * A package's files into a project's new, empty folder (prepared by ProjectFolders): every path checked,
   * every file's hash checked before anything is written, files created exclusively; then read back.
   */
  async write(projectId, files) {
    if (!Array.isArray(files) || files.length > MAX_FILES) fail("invalid_transfer", 400);
    let total = 0;
    const decoded = files.map((file) => {
      if (!file || !safePath(file.path) || typeof file.data !== "string" || typeof file.sha256 !== "string") fail("invalid_transfer", 400);
      const data = Buffer.from(file.data, "base64");
      total += data.length;
      if (data.length > MAX_FILE || total > MAX_TOTAL) fail("transfer_too_large", 413);
      if (sha(data) !== file.sha256) fail("transfer_corrupt", 400);
      return { path: file.path, data };
    });
    if (new Set(decoded.map((file) => file.path)).size !== decoded.length) fail("invalid_transfer", 400);
    // A file and a folder of the same name cannot both exist.
    const folders = new Set(decoded.flatMap((file) => file.path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
    if (decoded.some((file) => folders.has(file.path))) fail("invalid_transfer", 400);
    return this.folders.withWorkspace(projectId, async (workspace) => {
      if (workspace.mode !== "new") fail("transfer_target_not_new");
      const present = await fs.readdir(workspace.directory);
      if (present.length) fail("transfer_target_not_empty");
      for (const file of decoded) {
        const parts = file.path.split("/");
        if (parts.length > 1) await fs.mkdir(`${workspace.directory}/${parts.slice(0, -1).join("/")}`, { recursive: true, mode: 0o700 });
        await fs.writeFile(`${workspace.directory}/${file.path}`, file.data, { flag: "wx", mode: 0o644 });
      }
      for (const file of decoded) {
        const handle = await fs.open(`${workspace.directory}/${file.path}`, READ);
        try { if (sha(await handle.readFile()) !== sha(file.data)) fail("transfer_corrupt", 500); }
        finally { await handle.close(); }
      }
      return { written: decoded.length, bytes: total };
    });
  }
}
