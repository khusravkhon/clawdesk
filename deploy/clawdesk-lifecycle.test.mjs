import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertFixtureOwner, assertFixtureDataRoot, treeHash } from './scripts/lifecycle-safety.mjs';

const id = `clawdesk-lifecycle-${'a'.repeat(32)}`;
test('lifecycle cleanup rejects missing, foreign and non-fixture ownership', () => {
  assertFixtureOwner(id, id);
  for (const label of ['', undefined, `${id}-other`]) assert.throws(() => assertFixtureOwner(id, label));
  assert.throws(() => assertFixtureOwner('clawdesk-local', 'clawdesk-local'));
});
test('lifecycle fixture root must be exact self-owned volume mountpoint', () => {
  const volume = `${id}-data`;
  assertFixtureDataRoot(`/var/lib/docker/volumes/${volume}/_data`, volume, id);
  for (const root of ['/', '/var/lib/clawdesk-local', `/var/lib/../${volume}/_data`, `/var/lib/${volume}/_data/child`]) assert.throws(() => assertFixtureDataRoot(root, volume, id));
  assert.throws(() => assertFixtureDataRoot(`/var/lib/${volume}/_data`, 'foreign-data', id));
});
test('recursive artifact digest detects nested changes, addition and renamed files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-hash-'));
  try {
    await fs.mkdir(path.join(root, 'nested')); await fs.writeFile(path.join(root, 'nested', 'module.js'), 'one');
    const first = await treeHash(root); assert.equal(await treeHash(root), first);
    await fs.writeFile(path.join(root, 'nested', 'module.js'), 'two'); const second = await treeHash(root); assert.notEqual(first, second);
    await fs.rename(path.join(root, 'nested', 'module.js'), path.join(root, 'nested', 'renamed.js')); assert.notEqual(await treeHash(root), second);
    const renamed = await treeHash(root); await fs.writeFile(path.join(root, 'additional.js'), 'new'); assert.notEqual(await treeHash(root), renamed);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('restore helpers explicitly disable network egress', async () => {
  const script = await fs.readFile(new URL('./scripts/restore.sh', import.meta.url), 'utf8');
  const runs = script.split('\n').filter((line) => line.includes('docker run '));
  assert.ok(runs.length >= 4);
  for (const run of runs) assert.match(run, /docker run --rm --network none/);
});
