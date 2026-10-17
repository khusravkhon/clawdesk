// Opt-in integration gate: current compiled application, real HTTP, real SQLite and restore.sh.
// Cached images supply Linux dependencies only. No personal stack or network is mounted.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertFixtureOwner, assertFixtureDataRoot, treeHash } from './lifecycle-safety.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = `clawdesk-lifecycle-${randomUUID().replaceAll('-', '')}`;
const ownerLabel = 'io.clawdesk.lifecycle';
const gatewayImage = process.env.CLAWDESK_TEST_GATEWAY_IMAGE ?? 'ghcr.io/khusravkhon/clawdesk-gateway:local';
const panelImage = process.env.CLAWDESK_TEST_PANEL_IMAGE ?? 'ghcr.io/khusravkhon/clawdesk-panel:local';
const root = await fs.mkdtemp(path.join(os.tmpdir(), `${runId}-`));
const volume = `${runId}-data`;
const fixturePassword = `Fixture-only-${randomUUID()}`;
const environment = { ...process.env, COMPOSE_PROJECT_NAME: runId, MSYS_NO_PATHCONV: '1' };
let volumeCreated = false;
let composeWritten = false;
let cookie = '';

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: repo, env: environment, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options });
  // Child output can contain fixture owner codes. Keep it private even on a failed gate.
  if (result.error || result.status !== 0) {
    const diagnostic = (result.stderr ?? '').replaceAll(fixturePassword, '[fixture password]').replace(/[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}/g, '[owner code]').slice(-1600);
    throw new Error(`${path.basename(executable)} ${args.slice(0, 2).join(' ')} failed (${result.error?.code ?? result.status}): ${diagnostic}`);
  }
  return result.stdout.trim();
}
const docker = (...args) => command('docker', args);
const compose = (...args) => docker('compose', '--project-directory', root, '-f', path.join(root, 'docker-compose.yml'), ...args);
const exec = (service, script, input = {}) => JSON.parse(compose('exec', '-T', service, 'node', '--input-type=module', '-e', script, JSON.stringify(input)));
async function waitReady() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try { if (exec('panel', 'console.log(JSON.stringify({ok:(await fetch("http://127.0.0.1:8080/api/health")).ok}))').ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('fixture panel did not become healthy within 120 seconds');
}
function api(method, url, body, status = 200) {
  const result = exec('panel', `const p=JSON.parse(process.argv[1]); const r=await fetch('http://127.0.0.1:8080'+p.url,{method:p.method,headers:{'content-type':'application/json',cookie:p.cookie},...(p.body===undefined?{}:{body:JSON.stringify(p.body)})}); console.log(JSON.stringify({status:r.status,cookie:r.headers.get('set-cookie'),body:await r.json()}));`, { method, url, body, cookie });
  assert.equal(result.status, status, `HTTP ${method} ${url} returned ${result.status}; response withheld`);
  if (result.cookie) cookie = result.cookie.split(';')[0];
  return result.body;
}
function containerScript(service, script, input) { return exec(service, script, input); }
const evidence = { runId, checks: {}, externalNetwork: false, dockerSocketInServices: false, actualEmbeddingInference: false };

try {
  for (const [cwd, args] of [
    ['packages/shared', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']],
    ['packages/templates', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']],
    ['apps/bff', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']],
    ['apps/web', ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'error']],
  ]) command(process.execPath, args, { cwd: path.join(repo, cwd) });
  evidence.images = Object.fromEntries([gatewayImage, panelImage].map((image) => [image, docker('image', 'inspect', '-f', '{{.Id}}', image)]));
  evidence.artifactSha256 = {};
  for (const directory of ['apps/bff/dist', 'apps/bff/drizzle', 'apps/web/dist', 'packages/shared/dist', 'packages/templates/dist', 'packages/templates/agents', 'deploy/scripts']) evidence.artifactSha256[directory] = await treeHash(path.join(repo, directory));
  docker('volume', 'create', '--label', `${ownerLabel}=${runId}`, volume); volumeCreated = true;
  assertFixtureOwner(runId, docker('volume', 'inspect', '-f', `{{index .Labels "${ownerLabel}"}}`, volume));
  const dataRoot = docker('volume', 'inspect', '-f', '{{.Mountpoint}}', volume);
  assertFixtureDataRoot(dataRoot, volume, runId);
  const state = `${dataRoot}/openclaw`;
  const bind = (source, target, readOnly = true) => ({ type: 'bind', source: path.resolve(repo, source).replaceAll('\\', '/'), target, read_only: readOnly });
  const host = (source, target) => ({ type: 'bind', source, target });
  const volumes = Object.fromEntries(['panel-data', 'freellmapi-data', 'openclaw-auth-secrets'].map((name) => [name, { labels: { [ownerLabel]: runId } }]));
  const common = { restart: 'no', labels: { [ownerLabel]: runId } };
  const gatewayMounts = [host(state, state), host(`${dataRoot}/backups`, `${dataRoot}/backups`), host(`${dataRoot}/files`, `${state}/workspace/files`),
    { type: 'volume', source: 'panel-data', target: '/var/lib/clawdesk-sources/panel' }, { type: 'volume', source: 'freellmapi-data', target: '/var/lib/clawdesk-sources/freellmapi' }, { type: 'volume', source: 'openclaw-auth-secrets', target: '/home/node/.config/openclaw' }];
  evidence.bridgeSha256 = {};
  for (const name of await fs.readdir(path.join(repo, 'deploy'))) if (/^clawdesk-.*\.mjs$/.test(name) && !name.includes('.test.') && !name.includes('.bench.')) {
    gatewayMounts.push(bind(`deploy/${name}`, `/usr/local/lib/${name}`));
    evidence.bridgeSha256[name] = createHash('sha256').update(await fs.readFile(path.join(repo, 'deploy', name))).digest('hex');
  }
  gatewayMounts.push(bind('deploy/gateway-start.sh', '/usr/local/bin/clawdesk-gateway-start'));
  evidence.gatewayStartSha256 = createHash('sha256').update(await fs.readFile(path.join(repo, 'deploy/gateway-start.sh'))).digest('hex');
  const panelMounts = [bind('apps/bff/dist', '/app/dist'), bind('apps/bff/drizzle', '/app/drizzle'), bind('apps/web/dist', '/app/web'),
    { type: 'volume', source: 'panel-data', target: '/data' }];
  for (const pkg of ['shared', 'templates']) {
    const resolved = docker('run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'readlink', panelImage, '-f', `/app/node_modules/@clawdesk/${pkg}`);
    assert.ok(resolved.startsWith('/app/node_modules/.pnpm/') && resolved.endsWith(`/node_modules/@clawdesk/${pkg}`));
    panelMounts.push(bind(`packages/${pkg}/dist`, `${resolved}/dist`));
    if (pkg === 'templates') panelMounts.push(bind('packages/templates/agents', `${resolved}/agents`));
  }
  const definition = { name: runId, services: {
    gateway: { ...common, image: gatewayImage, network_mode: 'none', environment: { HOME: '/home/node', OPENCLAW_HOME: '/home/node', OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: `${state}/openclaw.json`, OPENCLAW_WORKSPACE_DIR: `${state}/workspace`, OPENCLAW_GATEWAY_TOKEN: 'fixture-only-token', FREELLMAPI_ENCRYPTION_KEY: 'fixture-only-key', GOG_KEYRING_PASSWORD: 'fixture-only-password', OPENCLAW_DISABLE_BONJOUR: '1' }, volumes: gatewayMounts, command: ['node', 'dist/index.js', 'gateway', '--bind', 'loopback', '--port', '18789'] },
    panel: { ...common, image: panelImage, network_mode: 'service:gateway', depends_on: ['gateway'], environment: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '8080', DATA_DIR: '/data', WEB_DIST: '/app/web', LOG_LEVEL: 'error', GATEWAY_URL: 'ws://127.0.0.1:18789', OPENCLAW_GATEWAY_TOKEN: 'fixture-only-token', CLAWDESK_SANDBOX: 'off' }, volumes: panelMounts },
  }, volumes };
  await fs.writeFile(path.join(root, 'docker-compose.yml'), JSON.stringify(definition)); composeWritten = true;
  await fs.mkdir(path.join(root, 'scripts'));
  for (const file of ['restore.sh', 'restore-safe.mjs']) await fs.copyFile(path.join(repo, 'deploy/scripts', file), path.join(root, 'scripts', file));
  await fs.writeFile(path.join(root, '.env'), [`COMPOSE_PROJECT_NAME=${runId}`, `CLAWDESK_DATA_DIR=${dataRoot}`, `CLAWDESK_FILES_DIR=${dataRoot}/files`, 'OPENCLAW_GATEWAY_TOKEN=fixture-only-token', 'FREELLMAPI_ENCRYPTION_KEY=fixture-only-key', 'GOG_KEYRING_PASSWORD=fixture-only-password', ''].join(String.fromCharCode(10)));
  docker('run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'node', '-v', `${volume}:/fixture`, gatewayImage, '--input-type=module', '-e', `import fs from 'node:fs/promises';const p=JSON.parse(process.argv[1]);for(const n of ['openclaw/workspace','openclaw/cron','openclaw/models/llama.cpp','backups','files'])await fs.mkdir('/fixture/'+n,{recursive:true});await fs.writeFile('/fixture/openclaw/openclaw.json',JSON.stringify({gateway:{mode:'local',auth:{mode:'token',token:'fixture-only-token'}},agents:{defaults:{workspace:p.state+'/workspace',memorySearch:{enabled:false}}},channels:{telegram:{enabled:false,botToken:'123:fixture-disabled'}}}));await fs.writeFile('/fixture/openclaw/workspace/USER.md','Fixture owner note');await fs.writeFile('/fixture/openclaw/cron/jobs.json',JSON.stringify({version:1,jobs:[]}));await fs.writeFile('/fixture/openclaw/models/llama.cpp/fixture.gguf','FAKE MODEL NO INFERENCE');await fs.writeFile('/fixture/files/fixture.txt','shared fixture content');`, JSON.stringify({ state }));
  docker('run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'sh', '-v', `${volume}:/fixture`, gatewayImage, '-c', 'chown -R 1000:1000 /fixture');
  compose('up', '-d', '--pull', 'never'); await waitReady();
  for (const mount of panelMounts.filter((mount) => mount.type === 'bind')) {
    const actual = exec('panel', `import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';const treeHash=${treeHash.toString()};console.log(JSON.stringify(await treeHash(JSON.parse(process.argv[1]).root)));`, { root: mount.target });
    const relative = path.relative(repo, mount.source).replaceAll('\\', '/');
    assert.equal(actual, evidence.artifactSha256[relative], `mounted artifact mismatch: ${mount.target}`);
  }
  for (const [name, expected] of Object.entries(evidence.bridgeSha256)) assert.equal(exec('gateway', `import fs from 'node:fs/promises';import {createHash} from 'node:crypto';console.log(JSON.stringify(createHash('sha256').update(await fs.readFile('/usr/local/lib/'+JSON.parse(process.argv[1]).name)).digest('hex')));`, { name }), expected);
  assert.equal(exec('gateway', `import fs from 'node:fs/promises';import {createHash} from 'node:crypto';console.log(JSON.stringify(createHash('sha256').update(await fs.readFile('/usr/local/bin/clawdesk-gateway-start')).digest('hex')));`), evidence.gatewayStartSha256);
  api('GET', '/api/reminders', undefined, 401);
  const code = containerScript('panel', `import fs from 'node:fs/promises';console.log(JSON.stringify((await fs.readFile('/data/owner-code','utf8')).trim()));`);
  api('POST', '/api/auth/setup', { code, password: fixturePassword });
  api('POST', '/api/space', { mode: 'personal', name: 'Isolated fixture', locale: 'ru', timezone: 'Asia/Dushanbe' });
  const preferences = { quietHours: { enabled: true, start: '22:00', end: '08:00', timeZone: 'Asia/Dushanbe' } };
  api('PUT', '/api/reminders/preferences', preferences);
  const request = { requestId: randomUUID(), text: 'Fixture reminder', dueAt: Date.now() + 3600000, timeZone: 'Asia/Dushanbe' };
  const first = api('POST', '/api/reminders', request);
  const duplicate = api('POST', '/api/reminders', request);
  assert.equal(first.reminders.length, 1); assert.equal(duplicate.reminders.length, 1);
  const action = { requestId: randomUUID(), action: 'snooze', snoozeMinutes: 20 };
  api('POST', `/api/reminders/${first.reminders[0].id}/action`, action);
  assert.equal(api('POST', `/api/reminders/${first.reminders[0].id}/action`, action).reminders.length, 2);
  evidence.checks.realHttpAuthPersonalIdempotency = true;
  // Force the genuine Gateway process down without recreating its network namespace.
  compose('stop', 'gateway');
  const note = api('POST', '/api/memory/main/notes', { text: 'Fixture durable owner fact', source: 'lifecycle fixture' }, 201);
  assert.equal(note.applied, false); assert.equal(note.notes.length, 1);
  const offline = api('GET', '/api/today');
  assert.equal(offline.connection.state, 'unknown'); assert.equal(offline.search.state, 'unknown'); assert.equal(offline.notes.state, 'available'); assert.equal(offline.reminders.state, 'available');
  compose('start', 'gateway');
  compose('restart', 'panel'); await waitReady();
  assert.equal(api('GET', '/api/memory/main/notes').notes[0].text, 'Fixture durable owner fact');
  assert.equal(api('GET', '/api/reminders').reminders.length, 2);
  assert.deepEqual(api('GET', '/api/reminders').preferences, preferences);
  evidence.checks.gatewayOfflineAndProcessRestart = true;
  const gatewayDeadline = Date.now() + 120000;
  let gatewayReady = false;
  while (Date.now() < gatewayDeadline) {
    try { const h = containerScript('gateway', `const r=await fetch('http://127.0.0.1:18789/health',{signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({ok:r.ok}));`); if (h.ok && api('GET', '/api/health').gateway.state === 'connected') { gatewayReady = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(gatewayReady, 'genuine Gateway must be healthy and connected to BFF');
  evidence.checks.nativeGatewayConnected = true;
  assert.equal(api('POST', '/api/memory/main/notes/sync', {}).applied, true);
  const disabledSchedule = { id: randomUUID(), agentId: 'main', name: 'Fixture disabled schedule', enabled: false, createdAtMs: Date.now(), updatedAtMs: Date.now(), schedule: { kind: 'at', at: new Date(Date.now() + 86400000).toISOString() }, sessionTarget: 'isolated', wakeMode: 'now', payload: { kind: 'agentTurn', message: 'Fixture never executes' }, delivery: { mode: 'none' }, state: {} };
  containerScript('gateway', `import fs from 'node:fs/promises';const p=JSON.parse(process.argv[1]);await fs.writeFile(p.state+'/cron/jobs.json',JSON.stringify({version:1,jobs:[p.job]}));console.log('true');`, { state, job: disabledSchedule });
  containerScript('gateway', `import fs from 'node:fs/promises';await fs.writeFile('/home/node/.config/openclaw/fixture.json',JSON.stringify({secret:'fixture-only-secret'}));console.log('true');`);
  const backup = containerScript('gateway', `import {createBackup} from '/usr/local/lib/clawdesk-backup.mjs';console.log(JSON.stringify(await createBackup('manual')));`);
  compose('cp', `gateway:${dataRoot}/backups/${backup.name}`, path.join(root, 'backup.tar'));
  const noteFileBefore = containerScript('gateway', `import fs from 'node:fs/promises';import {createHash} from 'node:crypto';const p=JSON.parse(process.argv[1]);console.log(JSON.stringify(createHash('sha256').update(await fs.readFile(p.state+'/workspace/USER.md')).digest('hex')));`, { state });
  api('POST', '/api/memory/main/notes', { text: 'Must disappear after restore' }, 201);
  api('PUT', '/api/reminders/preferences', { quietHours: { ...preferences.quietHours, enabled: false } });
  const openReminder = api('GET', '/api/reminders').reminders.find((item) => item.action === 'open');
  api('POST', `/api/reminders/${openReminder.id}/action`, { requestId: randomUUID(), action: 'done' });
  containerScript('gateway', `import fs from 'node:fs/promises';const p=JSON.parse(process.argv[1]);await fs.writeFile(p.state+'/models/llama.cpp/fixture.gguf','mutated');await fs.writeFile(p.state+'/workspace/files/fixture.txt','mutated');await fs.writeFile('/home/node/.config/openclaw/fixture.json','{}');const config=JSON.parse(await fs.readFile(p.state+'/openclaw.json','utf8'));config.channels.telegram.botToken='mutated';await fs.writeFile(p.state+'/openclaw.json',JSON.stringify(config));await fs.writeFile(p.state+'/cron/jobs.json',JSON.stringify({version:1,jobs:[{id:'post-backup-only',enabled:false}]}));console.log('true');`, { state });
  const envPath = path.join(root, '.env');
  await fs.writeFile(envPath, (await fs.readFile(envPath, 'utf8')).replace('OPENCLAW_GATEWAY_TOKEN=fixture-only-token', 'OPENCLAW_GATEWAY_TOKEN=mutated').replace('FREELLMAPI_ENCRYPTION_KEY=fixture-only-key', 'FREELLMAPI_ENCRYPTION_KEY=mutated').replace('GOG_KEYRING_PASSWORD=fixture-only-password', 'GOG_KEYRING_PASSWORD=mutated'));
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  command(bash, [path.join(root, 'scripts/restore.sh').replaceAll('\\', '/'), '--yes', '--target', runId, '--target-data', dataRoot, path.join(root, 'backup.tar').replaceAll('\\', '/')], { timeout: 300000 });
  await waitReady();
  const restoredGatewayDeadline = Date.now() + 120000;
  let restoredGatewayConnected = false;
  while (Date.now() < restoredGatewayDeadline) {
    if (api('GET', '/api/health').gateway.state === 'connected') { restoredGatewayConnected = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(restoredGatewayConnected, 'restored BFF must reconnect to the genuine Gateway');
  evidence.checks.restoredGatewayConnected = true;
  const restoredEnv = await fs.readFile(envPath, 'utf8');
  for (const line of ['OPENCLAW_GATEWAY_TOKEN=fixture-only-token', 'FREELLMAPI_ENCRYPTION_KEY=fixture-only-key', 'GOG_KEYRING_PASSWORD=fixture-only-password']) assert.ok(restoredEnv.split(/\r?\n/).includes(line), 'fixture environment secret was not restored');
  evidence.checks.environmentSecretsRestored = true;
  cookie = ''; api('POST', '/api/auth/login', { password: fixturePassword });
  const restoredNotes = api('GET', '/api/memory/main/notes');
  assert.equal(restoredNotes.notes.length, 1); assert.equal(restoredNotes.notes[0].text, 'Fixture durable owner fact');
  assert.equal(api('GET', '/api/reminders').reminders.length, 2);
  assert.equal(api('GET', '/api/reminders').reminders.find((item) => item.id === openReminder.id).action, 'open');
  assert.deepEqual(api('GET', '/api/reminders').preferences, preferences);
  const restoredSchedule = containerScript('gateway', `import fs from 'node:fs/promises';const p=JSON.parse(process.argv[1]);console.log(JSON.stringify(JSON.parse(await fs.readFile(p.state+'/cron/jobs.json','utf8')).jobs));`, { state });
  assert.equal(restoredSchedule.length, 1); assert.equal(restoredSchedule[0].id, disabledSchedule.id); assert.equal(restoredSchedule[0].enabled, false);
  const restored = containerScript('gateway', `import fs from 'node:fs/promises';import {createHash} from 'node:crypto';const p=JSON.parse(process.argv[1]);const config=JSON.parse(await fs.readFile(p.state+'/openclaw.json','utf8'));const secret=JSON.parse(await fs.readFile('/home/node/.config/openclaw/fixture.json','utf8'));console.log(JSON.stringify({telegramDisabled:config.channels.telegram.enabled===false&&config.channels.telegram.botToken==='123:fixture-disabled',secret:secret.secret==='fixture-only-secret',model:(await fs.readFile(p.state+'/models/llama.cpp/fixture.gguf','utf8'))==='FAKE MODEL NO INFERENCE',shared:(await fs.readFile(p.state+'/workspace/files/fixture.txt','utf8'))==='shared fixture content',note:createHash('sha256').update(await fs.readFile(p.state+'/workspace/USER.md')).digest('hex')===p.noteHash}));`, { state, noteHash: noteFileBefore });
  assert.deepEqual(restored, { telegramDisabled: true, secret: true, model: true, shared: true, note: true });
  evidence.checks.realBackupFullRestoreShellAndApi = true;
  evidence.checks.restored = restored;
  for (const [directory, expected] of Object.entries(evidence.artifactSha256)) assert.equal(await treeHash(path.join(repo, directory)), expected, `fixture sources changed during gate: ${directory}`);
} finally {
  if (composeWritten) {
    const ids = docker('ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${runId}`).split(/\s+/).filter(Boolean);
    for (const id of ids) assertFixtureOwner(runId, docker('inspect', '-f', `{{index .Config.Labels "${ownerLabel}"}}`, id));
    for (const item of docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${runId}`).split(/\s+/).filter(Boolean)) assertFixtureOwner(runId, docker('volume', 'inspect', '-f', `{{index .Labels "${ownerLabel}"}}`, item));
    compose('down', '--volumes', '--timeout', '15');
  }
  if (volumeCreated) {
    assertFixtureOwner(runId, docker('volume', 'inspect', '-f', `{{index .Labels "${ownerLabel}"}}`, volume));
    docker('volume', 'rm', volume);
  }
  assert.ok(path.basename(root).startsWith(`${runId}-`));
  await fs.rm(root, { recursive: true, force: true });
  evidence.fixtureRemoved = true;
}
console.log(JSON.stringify(evidence, null, 2));
