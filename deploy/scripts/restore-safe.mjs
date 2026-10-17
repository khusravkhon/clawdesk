// Restore accepts only ordinary files/directories. Links, devices and paths outside the
// archive are rejected before the selected installation is stopped.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function safeName(name) {
  if (!name || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error('unsafe archive path');
  const parts = name.split('/');
  if (parts.includes('..')) throw new Error('unsafe archive path');
  return parts.filter((part) => part && part !== '.').join('/');
}

function pax(data) {
  let rest = data;
  const values = {};
  while (rest.length) {
    const space = rest.indexOf(32);
    const length = Number(rest.subarray(0, space).toString());
    if (space < 1 || !Number.isSafeInteger(length) || length <= space + 1 || length > rest.length || rest[length - 1] !== 10) throw new Error('invalid PAX header');
    const pair = rest.subarray(space + 1, length - 1).toString('utf8');
    const equals = pair.indexOf('=');
    if (equals < 1) throw new Error('invalid PAX property');
    const key = pair.slice(0, equals);
    if (!['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment'].includes(key)) throw new Error('unsupported PAX property');
    if (key === 'size') {
      const value = pair.slice(equals + 1);
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 100 * 1024 ** 3) throw new Error('invalid PAX size');
    }
    values[key] = pair.slice(equals + 1);
    rest = rest.subarray(length);
  }
  return values;
}

export async function extractSafe(archive, destination, gzip = false) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  if ((await fs.readdir(destination)).length) throw new Error('restore staging must be empty');
  const input = createReadStream(archive);
  const stream = gzip ? input.pipe(createGunzip()) : input;
  if (gzip) input.on('error', (error) => stream.destroy(error));
  const iterator = stream[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  async function read(size) {
    while (buffered.length < size) {
      const next = await iterator.next();
      if (next.done) throw new Error('truncated archive');
      buffered = Buffer.concat([buffered, next.value]);
    }
    const value = buffered.subarray(0, size);
    buffered = buffered.subarray(size);
    return value;
  }
  const names = new Set();
  let extension = {};
  let total = 0;
  try {
    while (true) {
      const header = await read(512);
      if (header.every((byte) => byte === 0)) {
        if (!(await read(512)).every((byte) => byte === 0)) throw new Error('invalid archive end');
        // Reject concatenated archives, which ordinary tar readers may interpret differently.
        if (buffered.some((byte) => byte !== 0)) throw new Error('trailing archive data');
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) if (chunk.some((byte) => byte !== 0)) throw new Error('trailing archive data');
        break;
      }
      const text = (start, size) => header.subarray(start, start + size).toString('utf8').split('\0')[0];
      const octal = (start, size) => {
        const value = text(start, size).trim();
        if (!/^[0-7]+$/.test(value)) throw new Error('invalid archive number');
        const number = parseInt(value, 8);
        if (!Number.isSafeInteger(number)) throw new Error('archive number too large');
        return number;
      };
      const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (checksum !== octal(148, 8)) throw new Error('archive checksum failed');
      const size = octal(124, 12);
      total += size;
      if (total > 100 * 1024 ** 3 || names.size > 1_000_000) throw new Error('archive exceeds restore limits');
      const type = text(156, 1);
      if (type === 'x' || type === 'g' || type === 'L') {
        if (Object.keys(extension).length) throw new Error('chained archive metadata is not supported');
        if (size > 1024 * 1024 || type === 'g') throw new Error('unsupported archive metadata');
        const data = await read(size);
        extension = type === 'L' ? { path: data.toString('utf8').replace(/\0.*$/s, '') } : pax(data);
      } else {
        if (!['', '0', '5'].includes(type)) throw new Error('archive links and special files are not allowed');
        // Pinned node-tar emits size with long paths. Accept matching metadata only;
        // never apply it as an override (node-tar header.js also separates extension headers).
        if (extension.size !== undefined && Number(extension.size) !== size) throw new Error('PAX size disagrees with file header');
        const prefix = text(345, 155);
        const raw = extension.path ?? `${prefix ? `${prefix}/` : ''}${text(0, 100)}`;
        const name = safeName(raw);
        extension = {};
        if (!name && type !== '5') throw new Error('invalid root entry');
        if (names.has(name)) throw new Error('duplicate archive entry');
        names.add(name);
        const target = path.join(destination, ...name.split('/'));
        if (type === '5') {
          if (size !== 0) throw new Error('invalid directory entry');
          await fs.mkdir(target, { recursive: true, mode: 0o700 });
        } else {
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          const handle = await fs.open(target, 'wx', 0o600);
          try {
            for (let remaining = size; remaining > 0;) {
              const chunk = await read(Math.min(remaining, 65536));
              await handle.writeFile(chunk);
              remaining -= chunk.length;
            }
          } finally { await handle.close(); }
        }
      }
      if (size % 512) await read(512 - size % 512);
    }
    return [...names];
  } finally { stream.destroy(); input.destroy(); }
}

export async function prepareRestore(archive, target, version) {
  await extractSafe(archive, target);
  const manifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !['daily', 'manual', 'before-reset'].includes(manifest.kind) || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('unsupported backup manifest');
  if (manifest.openclawVersion !== version) throw new Error('backup OpenClaw version does not match this installation');
  const allowed = new Set(['manifest.json', 'openclaw.tar.gz', 'env', 'panel', 'freellmapi', 'auth-secrets']);
  if ((await fs.readdir(target)).some((entry) => !allowed.has(entry))) throw new Error('unexpected backup payload');
  const env = await fs.readFile(path.join(target, 'env'), 'utf8');
  for (const line of env.trim().split('\n').filter(Boolean)) {
    if (!/^(OPENCLAW_GATEWAY_TOKEN|FREELLMAPI_ENCRYPTION_KEY|GOG_KEYRING_PASSWORD)=[A-Za-z0-9_./+=:@%-]+$/.test(line)) throw new Error('unsupported backup secret');
  }
  await extractSafe(path.join(target, 'openclaw.tar.gz'), path.join(target, 'validated-openclaw'), true);
  return { format: manifest.format, kind: manifest.kind, createdAt: manifest.createdAt, openclawVersion: manifest.openclawVersion };
}

export async function preparePayload(archive, target, version) {
  const manifest = await prepareRestore(archive, target, version);
  const result = spawnSync('node', ['/app/dist/index.js', 'backup', 'restore', path.join(target, 'openclaw.tar.gz'), '--target', path.join(target, 'oc'), '--json'], { cwd: '/app', encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('OpenClaw recovery validation failed');
  const candidates = [];
  async function scan(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('restored payload contains links');
      if (item.isDirectory()) await scan(full);
      else if (item.name === 'openclaw.json' && full.includes('/payload/posix/')) candidates.push(full);
    }
  }
  await scan(path.join(target, 'oc'));
  candidates.sort((a, b) => a.length - b.length);
  if (!candidates.length) throw new Error('restored state config missing');
  const config = JSON.parse(await fs.readFile(candidates[0], 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid restored config');
  const { DatabaseSync } = await import('node:sqlite');
  async function sqliteIntegrity(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await sqliteIntegrity(full);
      else if (/\.(sqlite|db)$/.test(item.name)) {
        const db = new DatabaseSync(full, { readOnly: true });
        try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('backup database integrity failed'); }
        finally { db.close(); }
      }
    }
  }
  for (const name of ['panel', 'freellmapi']) {
    if (await fs.stat(path.join(target, name)).catch(() => null)) await sqliteIntegrity(path.join(target, name));
  }
  await fs.writeFile(path.join(target, 'prepared-state.txt'), path.dirname(candidates[0]), { mode: 0o600 });
  // The fully restored payload is now independent of the original (possibly user-editable) archive.
  return manifest;
}

export async function applyPayload(pairs, revision, io = fs) {
  if (!/^[a-zA-Z0-9-]+$/.test(revision)) throw new Error('invalid restore revision');
  const states = [];
  let rollbackFailed = false;
  try {
    for (const [source, target] of pairs) {
      const stat = await io.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(target) === path.parse(target).root) throw new Error('invalid restore target');
      if ((await io.readdir(target)).some((name) => /^\.restore-(rollback|next)-/.test(name))) throw Object.assign(new Error('unfinished recovery exists; preserve rollback folders and inspect them before retrying'), { code: 'recovery_unfinished' });
      const next = path.join(target, `.restore-next-${revision}`);
      const rollback = path.join(target, `.restore-rollback-${revision}`);
      if (await io.lstat(next).catch(() => null) || await io.lstat(rollback).catch(() => null)) throw new Error('restore staging already exists');
      await io.mkdir(next, { mode: 0o700 });
      states.push({ target, next, rollback, previous: [], installed: [], begun: false });
      if (source) {
        for (const item of await io.readdir(source)) await io.cp(path.join(source, item), path.join(next, item), { recursive: true, preserveTimestamps: true, dereference: false });
      }
    }
    for (const state of states) {
      await io.mkdir(state.rollback, { mode: 0o700 });
      state.begun = true;
      for (const name of await io.readdir(state.target)) {
        if ([path.basename(state.next), path.basename(state.rollback)].includes(name)) continue;
        await io.rename(path.join(state.target, name), path.join(state.rollback, name));
        state.previous.push(name);
      }
      for (const name of await io.readdir(state.next)) {
        await io.rename(path.join(state.next, name), path.join(state.target, name));
        state.installed.push(name);
      }
    }
  } catch (error) {
    for (const state of states.reverse()) {
      try {
        for (const name of state.installed) await io.rm(path.join(state.target, name), { recursive: true, force: true });
        for (const name of state.previous) await io.rename(path.join(state.rollback, name), path.join(state.target, name));
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw Object.assign(new Error('restore rollback incomplete; keep .restore-rollback folders for manual recovery'), { code: 'rollback_incomplete' });
    if (error.code === 'recovery_unfinished') throw error;
    error.code = 'restore_rolled_back';
    throw error;
  } finally {
    // Only these generated, checked children are ever removed; mounted roots are preserved.
    for (const state of rollbackFailed ? [] : states) {
      await io.rm(state.next, { recursive: true, force: true });
      if (state.begun) await io.rm(state.rollback, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, archive, version, persistent] = process.argv.slice(2);
  const target = persistent ?? await fs.mkdtemp(path.join(os.tmpdir(), 'clawdesk-validate-'));
  try {
    if (!['inspect', 'prepare'].includes(operation)) throw new Error('unsupported operation');
    console.log(JSON.stringify(await preparePayload(archive, target, version)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { if (!persistent || process.exitCode) await fs.rm(target, { recursive: true, force: true }); }
}
