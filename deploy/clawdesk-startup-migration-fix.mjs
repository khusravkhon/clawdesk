import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// openclaw-bump-review: review both the startup reconciliation and agent cleanup fixes.
// One entry per verified OpenClaw version (deploy/openclaw.supported), with exact source digests.
// List only the fixes the version needs. Use null when neither is needed.
export const FIXES = {
  "2026.8.35": {
    migration: { file: "dist/startup-migration-DkIFHb-U.js", sha256: "dad962a2880e9f7f8d883a72a0807c8b36c5a2a68e3ce491bd2ce2e7ec96518f" },
    deletion: { file: "dist/agents-CoSQ0Hk8.js", sha256: "762baf9cf961ba775e53c0e60abd2fbbe678993a5695ae00db716ed5599123e1" },
  },
};
// biome-ignore lint/suspicious/noTemplateCurlyInString: the exact OpenClaw source text this fix looks for
const BEFORE = '\t\t} catch (error) {\n\t\t\tparams.log.warn(`session: SQLite startup maintenance failed for ${target.agentId}; continuing: ${String(error)}`);';
const AFTER = BEFORE.replace("\t\t\tparams.log.warn", "\t\t\tdatabases.delete(databasePath);\n\t\t\tparams.log.warn");

export function patchMigrationSource(source) {
  if (source.split(BEFORE).length !== 2 || source.includes(AFTER)) {
    throw new Error("Unsupported OpenClaw startup migration source; review compatibility fix before building.");
  }
  return source.replace(BEFORE, AFTER);
}

export function patchAgentDeletionSource(source) {
  const pathImport = 'import path from "node:path";';
  const move = "\t\tawait movePathToTrash(trashPath);";
  if (source.split(pathImport).length !== 2 || source.split(move).length !== 2) {
    throw new Error("Unsupported OpenClaw agent deletion source; review compatibility fix before building.");
  }
  return source.replace(pathImport, `${pathImport}\nimport os from "node:os";`).replace(move, [
    '\t\tconst stateDir = process.env.OPENCLAW_STATE_DIR;',
    '\t\tconst root = stateDir && path.resolve(stateDir);',
    '\t\tconst allowedRoots = stateDir && path.isAbsolute(stateDir) && root !== path.parse(root).root',
    '\t\t\t? [os.homedir(), os.tmpdir(), root] : void 0;',
    '\t\tawait movePathToTrash(trashPath, { allowedRoots });',
  ].join("\n"));
}

const patchSource = { migration: patchMigrationSource, deletion: patchAgentDeletionSource };

function preparePatch(appDir, version, name, fix) {
  if (!fix || typeof fix.file !== "string" || !fix.file || typeof fix.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(fix.sha256)) {
    throw new Error(`Invalid OpenClaw ${name} fix for ${version}; expected a file and its SHA-256 digest.`);
  }
  const target = path.join(appDir, fix.file);
  let source;
  try {
    source = fs.readFileSync(target, "utf8");
  } catch (error) {
    throw new Error(`Cannot read OpenClaw ${name} source at ${target}: ${error.message}`, { cause: error });
  }
  if (createHash("sha256").update(source).digest("hex") !== fix.sha256) {
    throw new Error(`Unexpected OpenClaw source digest for ${fix.file}; refusing to patch unknown source.`);
  }
  return { name, target, patched: patchSource[name](source) };
}

export function applyStartupMigrationFix({ appDir = "/app", versionFile = "/usr/local/lib/openclaw.version" } = {}) {
  const pinnedVersion = fs.readFileSync(versionFile, "utf8").trim();
  const installedVersion = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version;
  if (pinnedVersion !== installedVersion || !Object.hasOwn(FIXES, installedVersion)) {
    throw new Error("Unsupported OpenClaw version; review startup migration compatibility fix before building.");
  }
  const fix = FIXES[installedVersion];
  if (fix === null) return false;
  if (!fix || typeof fix !== "object" || !Object.keys(fix).length || Object.keys(fix).some((name) => !Object.hasOwn(patchSource, name))) {
    throw new Error(`Invalid OpenClaw fix entry for ${installedVersion}; list the migration and/or deletion fixes, or use null.`);
  }
  const patches = Object.entries(fix).map(([name, descriptor]) => preparePatch(appDir, installedVersion, name, descriptor));
  for (const { name, target, patched } of patches) {
    try {
      fs.writeFileSync(target, patched);
    } catch (error) {
      throw new Error(`Cannot write patched OpenClaw ${name} source at ${target}: ${error.message}`, { cause: error });
    }
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    applyStartupMigrationFix();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
