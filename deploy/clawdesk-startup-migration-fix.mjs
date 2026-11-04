import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// openclaw-bump-review: remove when upstream no longer reconciles failed startup stores.
export const SUPPORTED_VERSION = "2026.8.1";
export const UPSTREAM_FILE = "dist/startup-migration-LqDYqbTK.js";
export const UPSTREAM_SHA256 = "ce1fc1088ccd4f2f889d4b703a9781bbef1c662fef4d0bd5db0076e7749fae3f";
const BEFORE = '\t\t} catch (error) {\n\t\t\tparams.log.warn(`session: SQLite startup maintenance failed for ${target.agentId}; continuing: ${String(error)}`);';
const AFTER = BEFORE.replace("\t\t\tparams.log.warn", "\t\t\tdatabases.delete(databasePath);\n\t\t\tparams.log.warn");

export function patchMigrationSource(source) {
  if (source.split(BEFORE).length !== 2 || source.includes(AFTER)) {
    throw new Error("Unsupported OpenClaw startup migration source; review compatibility fix before building.");
  }
  return source.replace(BEFORE, AFTER);
}

export function applyStartupMigrationFix({ appDir = "/app", versionFile = "/usr/local/lib/openclaw.version" } = {}) {
  const pinnedVersion = fs.readFileSync(versionFile, "utf8").trim();
  const installedVersion = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version;
  if (pinnedVersion !== SUPPORTED_VERSION || installedVersion !== SUPPORTED_VERSION) {
    throw new Error("Unsupported OpenClaw version; review startup migration compatibility fix before building.");
  }
  const target = path.join(appDir, UPSTREAM_FILE);
  const source = fs.readFileSync(target, "utf8");
  if (createHash("sha256").update(source).digest("hex") !== UPSTREAM_SHA256) {
    throw new Error("Unexpected OpenClaw startup migration digest; refusing to patch unknown source.");
  }
  fs.writeFileSync(target, patchMigrationSource(source));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyStartupMigrationFix();
}
