// Build-time download of a pinned file: node fetch-verified.mjs <url> <sha256> <target>
// GitHub release downloads sometimes answer with an error page (a 504 of 92 bytes) instead of the file.
// Docker's ADD --checksum then fails the whole build on one bad answer. This retries, and accepts only
// bytes whose SHA-256 is the pinned one: an error page is retried, never written, and a changed release
// still fails the build after the last attempt.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export async function fetchVerified(url, sha256, target, { attempts = 6, delayMs = 5000, fetchImpl = fetch, log = console.error } = {}) {
  if (!/^https:\/\//.test(url) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("usage: fetch-verified.mjs <https url> <sha256> <target>");
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      const data = Buffer.from(await response.arrayBuffer());
      const digest = createHash("sha256").update(data).digest("hex");
      if (response.ok && digest === sha256) {
        await fs.writeFile(target, data, { mode: 0o644 });
        return { attempt, size: data.length };
      }
      last = `HTTP ${response.status}, ${data.length} bytes, sha256 ${digest}`;
    } catch (error) {
      last = String(error?.message ?? error);
    }
    log(`fetch-verified: attempt ${attempt}/${attempts} failed (${last})`);
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
  }
  throw new Error(`fetch-verified: no file with sha256 ${sha256} from ${url} after ${attempts} attempts (last: ${last})`);
}

if (process.argv[1]?.endsWith("fetch-verified.mjs")) {
  const [url, sha256, target] = process.argv.slice(2);
  fetchVerified(url, sha256, target).then(
    ({ attempt, size }) => console.error(`fetch-verified: ${size} bytes on attempt ${attempt}`),
    (error) => { console.error(error.message); process.exit(1); },
  );
}
