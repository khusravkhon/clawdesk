// Packs this version of ClawDesk's server code into the desktop app (src-tauri/resources/clawdesk-src.tar.gz).
// The "install on a server" wizard uploads it over SFTP and runs deploy/install.sh from it, so a server gets
// exactly the version of the app that installs it, with no access to the (private) repository needed.
//
// Only what the server builds from: the panel, shared packages, templates and deploy/. Not the desktop app,
// not docs, not local data.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const out = path.resolve(fileURLToPath(new URL("../src-tauri/resources/clawdesk-src.tar.gz", import.meta.url)));
const KEEP = /^(apps\/(bff|web)\/|packages\/|deploy\/|package\.json$|pnpm-workspace\.yaml$|pnpm-lock\.yaml$|\.npmrc$|tsconfig\.base\.json$|LICENSE$|README\.md$)/;

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: repo, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && KEEP.test(f) && fs.existsSync(path.join(repo, f)));
if (!files.includes("deploy/install.sh")) throw new Error("deploy/install.sh missing — run from the ClawDesk repository");

fs.mkdirSync(path.dirname(out), { recursive: true });
const list = path.join(path.dirname(out), "files.txt");
fs.writeFileSync(list, files.join("\n"));
try {
  // Relative paths from the repository: GNU tar reads "E:…" as a remote host; bsdtar and GNU tar both take -T.
  execFileSync("tar", ["-czf", path.relative(repo, out), "-T", path.relative(repo, list)], { cwd: repo, stdio: "inherit" });
} finally {
  fs.rmSync(list, { force: true });
}
console.log(`packed ${files.length} files → ${path.relative(repo, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
