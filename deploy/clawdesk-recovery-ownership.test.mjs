import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ownsSandbox, stopOwnedSandboxesAtRuntime } from './clawdesk-backup.mjs';

test('sandbox ownership follows actual host mounts and exact directory boundaries', () => {
  const roots = ['/host/alternate/state', '/var/lib/docker/volumes/fixture_files/_data'];
  assert.equal(ownsSandbox([{ Source: '/host/alternate/state/workspaces/agent' }], roots), true);
  assert.equal(ownsSandbox([{ Source: '/host/alternate/state' }], roots), true);
  assert.equal(ownsSandbox([{ Source: '/var/lib/docker/volumes/fixture_files/_data/project' }], roots), true);
  assert.equal(ownsSandbox([{ Source: '/host/alternate/state-other/workspace' }], roots), false);
  assert.equal(ownsSandbox([{ Source: '/var/lib/clawdesk-local/openclaw/workspace' }], roots), false);
  assert.equal(ownsSandbox([{ Source: '/var/lib/clawdesk-verify/openclaw/workspace' }], roots), false);
  assert.equal(ownsSandbox([{ Source: '/anything' }], ['/']), false);
});

for (const failure of ['ps', 'inspect', 'stop']) test(`sandbox ${failure} failure prevents the wipe step`, { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-fixture-'));
  try {
    const docker = path.join(root, 'docker');
    await fs.writeFile(docker, `#!/bin/sh\n[ "$1" = "${failure}" ] && exit 17\ncase "$1" in\nps) echo fixture-container;;\ninspect) printf '[{"Source":"/host/fixture/workspace"}]';;\nesac\nexit 0\n`, { mode: 0o700 });
    const modulePath = new URL('./clawdesk-backup.mjs', import.meta.url).href;
    const result = spawnSync('sh', ['-c', `set -e\n${stopOwnedSandboxesAtRuntime(['/host/fixture'], modulePath)}\nprintf wipe`], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
