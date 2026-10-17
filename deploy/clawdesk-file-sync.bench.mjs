import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SyncMetadataCache, syncFolders } from "./clawdesk-file-sync.mjs";

// Fixed deterministic data, fresh isolated trees, no user workspaces or persisted cache.
const FILES = 128, BYTES = 64 * 1024, ROUNDS = 5;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdesk-sync-benchmark-"));
try {
  const host = path.join(root, "host"), agent = path.join(root, "agent");
  await fs.mkdir(host); await fs.mkdir(agent);
  for (let index = 0; index < FILES; index++) {
    const data = Buffer.alloc(BYTES, index);
    await fs.writeFile(path.join(host, `${index}.bin`), data);
    await fs.writeFile(path.join(agent, `${index}.bin`), data);
  }
  let baseline = (await syncFolders(host, agent)).hashes;
  const results = [];
  for (const cached of [false, true]) {
    let clock = 0;
    const cache = cached ? new SyncMetadataCache({ now: () => clock }) : undefined;
    await syncFolders(host, agent, baseline, { cache });
    const totals = { bytesRead: 0, bytesHashed: 0, cacheHits: 0 };
    const started = performance.now();
    for (let round = 0; round < ROUNDS; round++) {
      const result = await syncFolders(host, agent, baseline, { cache });
      for (const key of Object.keys(totals)) totals[key] += result.metrics[key];
    }
    const unchangedMs = performance.now() - started;
    const changed = path.join(host, "0.bin");
    await fs.writeFile(changed, Buffer.alloc(BYTES, 255));
    const edit = await syncFolders(host, agent, baseline, { cache });
    if (edit.skipped || edit.conflicts || !(await fs.readFile(path.join(agent, "0.bin"))).equals(Buffer.alloc(BYTES, 255))) throw new Error("benchmark edit failed");
    clock = 300000;
    const full = await syncFolders(host, agent, edit.hashes, { cache });
    results.push({ cached, unchanged: { rounds: ROUNDS, ...totals, durationMs: Math.round(unchangedMs * 100) / 100 }, edit: edit.metrics, periodicFullCheck: full.metrics });
    await fs.writeFile(changed, Buffer.alloc(BYTES, 0));
    await fs.writeFile(path.join(agent, "0.bin"), Buffer.alloc(BYTES, 0));
    baseline = (await syncFolders(host, agent)).hashes;
  }
  process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, filesPerTree: FILES, bytesPerFile: BYTES, results }, null, 2)}\n`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
