import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { extractSafe, prepareRestore, preparePayload, applyPayload, clearRestoredPluginLeases } from './restore-safe.mjs';
import { DatabaseSync } from 'node:sqlite';

test('prepared restore clears source startup/plugin locks and preserves delivery leases and user data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawdesk-restore-leases-'));
  try {
    const file = path.join(dir, 'state.sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE state_leases(scope TEXT, lease_key TEXT, owner TEXT); CREATE TABLE notes(text TEXT); INSERT INTO notes VALUES (\'keep\')');
    const add = db.prepare('INSERT INTO state_leases VALUES (?, ?, ?)');
    for (const scope of ['startup-migrations', 'core:plugin-lifecycle', 'delivery']) add.run(scope, 'global', 'source');
    db.close();
    clearRestoredPluginLeases(file);
    const read = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(read.prepare('SELECT scope FROM state_leases').all().map(r => r.scope), ['delivery']);
    assert.equal(read.prepare('SELECT text FROM notes').get().text, 'keep');
    read.close();
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('clawdesk-restore-leases-'));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function tar(entries) {
  const parts = [];
  for (const { name, body = '', type = '0', link = '' } of entries) {
    const value = Buffer.from(body);
    const header = Buffer.alloc(512);
    const field = (at, length, text) => header.write(text, at, length, 'utf8');
    field(0, 100, name); field(100, 8, '0000600\0'); field(108, 8, '0000000\0'); field(116, 8, '0000000\0');
    field(124, 12, `${value.length.toString(8).padStart(11, '0')}\0`); field(136, 12, '00000000000\0');
    field(148, 8, '        '); field(156, 1, type); field(157, 100, link); field(257, 6, 'ustar\0');
    field(148, 8, `${[...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `);
    parts.push(header, value, Buffer.alloc((512 - value.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

function paxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  while (Buffer.byteLength(`${length} ${payload}`) !== length) length = Buffer.byteLength(`${length} ${payload}`);
  return `${length} ${payload}`;
}

test('native tar PAX size metadata accepts an exact ordinary-file size', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-pax-'));
  try {
    const archive = path.join(root, 'pax.tar');
    await fs.writeFile(archive, tar([{ name: 'PaxHeader', type: 'x', body: paxRecord('size', '3') }, { name: 'fixture.txt', body: 'abc' }]));
    await extractSafe(archive, path.join(root, 'out'));
    assert.equal(await fs.readFile(path.join(root, 'out', 'fixture.txt'), 'utf8'), 'abc');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const [key, value] of [
  ['size', '-1'], ['size', '1.5'], ['size', '1e2'], ['size', '2'], ['size', '9007199254740992'], ['size', '107374182401'],
  ['path', '../escape'], ['linkpath', '/etc/passwd'], ['GNU.sparse.size', '3'], ['SCHILY.filetype', 'symlink'], ['unknown', 'anything'],
]) test(`unsafe or conflicting PAX metadata is rejected: ${key}=${value}`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-pax-invalid-'));
  try {
    const archive = path.join(root, 'pax.tar');
    await fs.writeFile(archive, tar([{ name: 'PaxHeader', type: 'x', body: paxRecord(key, value) }, { name: 'fixture.txt', body: 'abc' }]));
    await assert.rejects(extractSafe(archive, path.join(root, 'out')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('malformed and chained PAX metadata is rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-pax-chain-'));
  try {
    for (const [index, entries] of [
      [{ name: 'PaxHeader', type: 'x', body: '99 size=3\n' }, { name: 'x', body: 'abc' }],
      [{ name: 'PaxHeader', type: 'x', body: paxRecord('size', '3') }, { name: 'LongName', type: 'L', body: 'x\0' }, { name: 'x', body: 'abc' }],
    ].entries()) {
      const archive = path.join(root, `${index}.tar`); await fs.writeFile(archive, tar(entries));
      await assert.rejects(extractSafe(archive, path.join(root, `out-${index}`)));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const entry of [
  { name: '../escape' }, { name: '/absolute' }, { name: 'a/../../escape' }, { name: 'C:/escape' },
  { name: 'a\\escape' }, { name: 'link', type: '2', link: '/etc' }, { name: 'hard', type: '1', link: 'secret' },
  { name: 'device', type: '3' },
]) test(`reject unsafe archive ${entry.name} type ${entry.type ?? '0'}`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-test-'));
  try {
    await fs.writeFile(path.join(root, 'archive.tar'), tar([entry]));
    await assert.rejects(extractSafe(path.join(root, 'archive.tar'), path.join(root, 'out')));
    assert.equal(await fs.stat(path.join(root, 'escape')).catch(() => null), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('duplicate entries and corrupted checksum are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-test-'));
  try {
    const archive = path.join(root, 'archive.tar');
    await fs.writeFile(archive, tar([{ name: 'x' }, { name: 'x' }]));
    await assert.rejects(extractSafe(archive, path.join(root, 'duplicates')), /duplicate/);
    const bytes = tar([{ name: 'x' }]); bytes[0] = 99;
    await fs.writeFile(archive, bytes);
    await assert.rejects(extractSafe(archive, path.join(root, 'checksum')), /checksum/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('unfinished earlier recovery is preserved and never classified safe to restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-unfinished-'));
  try {
    const from = path.join(root, 'from'), target = path.join(root, 'target');
    await fs.mkdir(from); await fs.mkdir(path.join(target, '.restore-rollback-earlier'), { recursive: true });
    await fs.writeFile(path.join(target, '.restore-rollback-earlier', 'original'), 'preserve');
    await assert.rejects(applyPayload([[from, target]], 'new'), (error) => error.code === 'recovery_unfinished');
    assert.equal(await fs.readFile(path.join(target, '.restore-rollback-earlier', 'original'), 'utf8'), 'preserve');
    assert.deepEqual(await fs.readdir(target), ['.restore-rollback-earlier']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const rollbackFails of [false, true]) test(`restore rolls back safely when replacement fails (rollback failure: ${rollbackFails})`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-rollback-'));
  try {
    const from = path.join(root, 'from'), target = path.join(root, 'target');
    await fs.mkdir(from); await fs.mkdir(target);
    await fs.writeFile(path.join(from, 'new'), 'new'); await fs.writeFile(path.join(target, 'old'), 'keep old');
    await assert.rejects(applyPayload([[from, target]], 'fixture', { ...fs, rename: async (source, destination) => {
      if (source.includes('.restore-next-') || (rollbackFails && source.includes('.restore-rollback-'))) throw new Error('injected rename failure');
      return fs.rename(source, destination);
    } }), rollbackFails ? /rollback incomplete/ : /injected/);
    const old = rollbackFails ? path.join(target, '.restore-rollback-fixture', 'old') : path.join(target, 'old');
    assert.equal(await fs.readFile(old, 'utf8'), 'keep old');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('official OpenClaw backup roundtrip in an isolated Linux fixture', { skip: process.env.CLAWDESK_RECOVERY_FIXTURE !== '1' }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clawdesk-recovery-e2e-'));
  const state = path.join(root, 'state');
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'), OPENCLAW_GATEWAY_TOKEN: 'fake-fixture-token', OPENCLAW_WORKSPACE_DIR: path.join(state, 'workspace') };
  const cli = (...args) => {
    const result = spawnSync('node', ['/app/dist/index.js', ...args], { env, cwd: '/app', encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, `fixture CLI command ${args[0]} ${args[1]} failed (output withheld)`);
    const out = result.stdout;
    return JSON.parse(out.slice(out.indexOf('{')));
  };
  try {
    await fs.mkdir(path.join(state, 'workspace'), { recursive: true });
    await fs.writeFile(path.join(state, 'openclaw.json'), JSON.stringify({ gateway: { mode: 'local', auth: { mode: 'token', token: 'fake-fixture-token' } }, agents: { defaults: { workspace: path.join(state, 'workspace') } }, channels: { telegram: { enabled: false, botToken: '123:fake-fixture-token' } } }));
    await fs.writeFile(path.join(state, 'workspace', 'USER.md'), '# Fixture owner\nRemember my local note.\n');
    await fs.mkdir(path.join(state, 'cron'), { recursive: true });
    await fs.writeFile(path.join(state, 'cron', 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'fixture-schedule', enabled: false, name: 'Fixture only' }] }));
    await fs.mkdir(path.join(state, 'models', 'llama.cpp'), { recursive: true });
    await fs.writeFile(path.join(state, 'models', 'llama.cpp', 'fixture.gguf'), 'FAKE MODEL — never inference');
    await fs.mkdir(path.join(state, 'npm', 'projects', 'fixture', 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(state, 'npm', 'projects', 'fixture', 'node_modules', 'fixture.js'), 'export default {}');
    await fs.symlink('../fixture.js', path.join(state, 'npm', 'projects', 'fixture', 'node_modules', '.bin', 'fixture'));
    // Company mode keeps its own files in the state folder: they must come back with it.
    await fs.mkdir(path.join(state, 'company-projects', 'Shop', 'app'), { recursive: true });
    await fs.writeFile(path.join(state, 'company-projects', 'Shop', 'app', 'server.mjs'), 'company project file');
    await fs.writeFile(path.join(state, 'clawdesk-project-folders.json'), JSON.stringify({ version: 1, bindings: [] }));
    await fs.mkdir(path.join(state, 'clawdesk', 'project-github', 'p1'), { recursive: true });
    await fs.writeFile(path.join(state, 'clawdesk', 'project-github', 'p1', 'token'), 'github_pat_fixture', { mode: 0o600 });
    await fs.mkdir(path.join(state, 'clawdesk', 'requests'), { recursive: true });
    await fs.writeFile(path.join(state, 'clawdesk', 'requests', 'a.json'), JSON.stringify({ type: 'up' }));
    await fs.mkdir(path.join(state, 'workspace', 'google'), { recursive: true });
    await fs.writeFile(path.join(state, 'workspace', 'google', 'doc.md'), 'granted doc copy');
    const result = cli('backup', 'create', '--verify', '--json', '--output', path.join(root, 'oc-output'));
    const staging = path.join(root, 'outer');
    await fs.mkdir(path.join(staging, 'panel'), { recursive: true });
    await fs.mkdir(path.join(staging, 'auth-secrets'), { recursive: true });
    const database = new DatabaseSync(path.join(staging, 'panel', 'panel.sqlite'));
    database.exec("CREATE TABLE notes(id TEXT, content TEXT); INSERT INTO notes VALUES('fixture','personal note from SQLite'); CREATE TABLE departments(id TEXT, name TEXT); INSERT INTO departments VALUES('it','IT');"); database.close();
    await fs.writeFile(path.join(staging, 'auth-secrets', 'fake.json'), JSON.stringify({ fakeSecret: 'fixture-only' }));
    await fs.copyFile(result.archivePath, path.join(staging, 'openclaw.tar.gz'));
    await fs.writeFile(path.join(staging, 'env'), 'OPENCLAW_GATEWAY_TOKEN=fake-fixture-token\n');
    const version = JSON.parse(await fs.readFile('/app/package.json', 'utf8')).version;
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ format: 1, kind: 'manual', createdAt: new Date().toISOString(), openclawVersion: version, stateDir: state }));
    const archive = path.join(root, 'backup.tar');
    assert.equal(spawnSync('tar', ['-cf', archive, '-C', staging, '.']).status, 0);
    const restored = path.join(root, 'restored');
    await assert.rejects(prepareRestore(archive, path.join(root, 'wrong-version'), '0.0.0'), /version/);
    await preparePayload(archive, restored, version);
    const oc = cli('backup', 'restore', path.join(restored, 'openclaw.tar.gz'), '--target', path.join(root, 'target'), '--json');
    // The SDK's returned target is not used to prove success: read the actual restored files.
    void oc;
    async function find(dir, name) {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) { const value = await find(full, name); if (value) return value; }
        else if (item.name === name) return full;
      }
      return null;
    }
    const config = await find(path.join(root, 'target'), 'openclaw.json');
    assert.ok(config);
    assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).channels.telegram.botToken, '123:fake-fixture-token');
    assert.match(await fs.readFile(await find(path.join(root, 'target'), 'USER.md'), 'utf8'), /Remember my local note/);
    assert.equal(JSON.parse(await fs.readFile(await find(path.join(root, 'target'), 'jobs.json'), 'utf8')).jobs[0].id, 'fixture-schedule');
    const reopened = new DatabaseSync(path.join(restored, 'panel', 'panel.sqlite'), { readOnly: true });
    assert.equal(reopened.prepare('SELECT content FROM notes WHERE id=?').get('fixture').content, 'personal note from SQLite');
    assert.equal(reopened.prepare('SELECT name FROM departments WHERE id=?').get('it').name, 'IT');
    assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); reopened.close();
    for (const [name, content] of [['server.mjs', 'company project file'], ['token', 'github_pat_fixture'], ['a.json', '{"type":"up"}'], ['doc.md', 'granted doc copy']]) assert.equal(await fs.readFile(await find(path.join(root, 'target'), name), 'utf8'), content, name);
    assert.ok(await find(path.join(root, 'target'), 'clawdesk-project-folders.json'));
    assert.equal(JSON.parse(await fs.readFile(path.join(restored, 'auth-secrets', 'fake.json'), 'utf8')).fakeSecret, 'fixture-only');
    const model = await find(path.join(root, 'target'), 'fixture.gguf');
    assert.ok(model); assert.equal(await fs.readFile(model, 'utf8'), 'FAKE MODEL — never inference');
    const mounted = path.join(root, 'fake-mounted-panel'); await fs.mkdir(mounted);
    await fs.writeFile(path.join(mounted, 'obsolete'), 'old');
    await applyPayload([[path.join(restored, 'panel'), mounted]], 'roundtrip');
    assert.equal(await fs.stat(path.join(mounted, 'obsolete')).catch(() => null), null);
    const live = new DatabaseSync(path.join(mounted, 'panel.sqlite'), { readOnly: true });
    assert.equal(live.prepare('SELECT content FROM notes WHERE id=?').get('fixture').content, 'personal note from SQLite'); live.close();
    console.log(JSON.stringify({ officialBackupRoundtrip: true, note: true, sqliteIntegrity: true, telegramConfigOnly: true, schedule: true, fakeSecrets: true, modelIncludedBySdk: Boolean(await find(path.join(root, 'target'), 'fixture.gguf')), embeddingInferenceChecked: false }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
