import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function assertFixtureOwner(runId, label) {
  assert.match(runId, /^clawdesk-lifecycle-[a-f0-9]{32}$/);
  assert.equal(label, runId, 'fixture cleanup ownership mismatch');
}

export function assertFixtureDataRoot(root, volume, runId) {
  assertFixtureOwner(runId, runId);
  assert.equal(volume, `${runId}-data`);
  assert.match(root, /^\/[a-zA-Z0-9_./-]+$/);
  assert.ok(!root.split('/').includes('..') && root.endsWith(`/${volume}/_data`), 'unsafe fixture data root');
}

export async function treeHash(root) {
  const hash = createHash('sha256');
  async function visit(directory, relative = '') {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full, name);
      else {
        assert.ok(entry.isFile(), 'fixture artifacts must contain only regular files');
        hash.update(name).update('\0').update(await fs.readFile(full)).update('\0');
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}
