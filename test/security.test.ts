import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, stat, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { defaultConfig, loadConfig } from '../src/config.js';
import { WorkspacePaths } from '../src/paths.js';
import { App } from '../src/app.js';
import { StateStore, canonical } from '../src/store.js';

async function fixture(t: TestContext) {
  const parent = await realpath(os.tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-security-'));
  const root = path.join(base, 'project');
  await mkdir(root);
  const cleanups: Array<() => unknown | Promise<unknown>> = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-security-'));
    await rm(actual, { recursive: true, force: true });
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  const initGit = () => { git('init', '--quiet'); git('config', 'user.name', 'WebCodex fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false'); };
  const configPath = path.join(base, 'config.json');
  const raw = defaultConfig(root, configPath);
  const createApp = async (settings = raw, location = configPath) => {
    await writeFile(location, JSON.stringify(settings));
    const app = new App(await loadConfig(location));
    cleanups.push(() => app.close());
    return app;
  };
  return { base, root, configPath, raw, createApp, git, initGit, cleanups };
}

test('configuration refuses junction selection and canonical runtime directories remain protected', async t => {
  const f = await fixture(t);
  const control = path.join(f.root, 'control');
  const alias = path.join(f.base, 'alias');
  await mkdir(control);
  await symlink(control, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasConfig = path.join(alias, 'settings.json');
  // The state folder does not exist yet: canonicalization must resolve its existing ancestor.
  const raw = { ...defaultConfig(f.root, aliasConfig), stateDir: path.join(alias, 'new-state', 'nested') };
  await writeFile(aliasConfig, JSON.stringify(raw));
  await assert.rejects(loadConfig(aliasConfig),{code:'CONFIG_ERROR'});
  const canonicalConfig=path.join(control,'settings.json');
  const config = await loadConfig(canonicalConfig);
  assert.equal(config.configPath, path.join(control, 'settings.json'));
  assert.equal(config.stateDir, path.join(control, 'new-state', 'nested'));
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(path.join(config.stateDir, 'sentinel.txt'), 'synthetic state secret');
  const paths = new WorkspacePaths(config);
  await assert.rejects(paths.resolve('default', 'control/settings.json'), { code: 'PATH_DENIED' });
  await assert.rejects(paths.resolve('default', 'control/settings.json', { write: true }), { code: 'PATH_DENIED' });
  await assert.rejects(paths.resolve('default', 'control/new-state/nested/sentinel.txt'), { code: 'PATH_DENIED' });
  const reloaded = await loadConfig(canonicalConfig);
  assert.equal(reloaded.stateDir, config.stateDir, 'existing state folders must also canonicalize');
});

test('a custom config in the workspace keeps its state HTTP token out of file tools', async t => {
  const f = await fixture(t);
  const configPath = path.join(f.root, 'settings.json');
  const raw = { ...defaultConfig(f.root, configPath), stateDir: path.join(f.root, 'service-state') };
  const app = await f.createApp(raw, configPath);
  await writeFile(path.join(app.config.stateDir, 'http-token'), 'SYNTHETIC-BEARER-SECRET');
  await writeFile(path.join(f.root, 'public.txt'), 'public needle');
  await assert.rejects(app.files.read({ workspace_id: 'default', path: 'service-state/http-token' }), { code: 'PATH_DENIED' });
  await assert.rejects(app.files.write({ workspace_id: 'default', path: 'service-state/http-token', content: 'replacement', expected_sha256: null, idempotency_key: 'token-denied' }), { code: 'PATH_DENIED' });
  const listing = await app.files.list({ workspace_id: 'default' });
  assert.ok(listing.entries.every(entry => !['settings.json', 'service-state'].includes(entry.name)));
  const search = await app.files.search({ workspace_id: 'default', query: 'SYNTHETIC-BEARER-SECRET' });
  assert.equal(search.matches.length, 0);
});

test('workspace_open bounds guidance, rejects huge and binary files, and checks workspace authorization', async t => {
  const f = await fixture(t);
  const raw = { ...f.raw, limits: { ...f.raw.limits, readMaxBytes: 256, writeMaxBytes: 1024 } };
  const app = await f.createApp(raw);
  await writeFile(path.join(f.root, 'AGENTS.md'), '中文'.repeat(140));
  const huge = await open(path.join(f.root, 'README.md'), 'w');
  try { await huge.truncate(64 * 1024 * 1024); } finally { await huge.close(); }
  await writeFile(path.join(f.root, 'package.json'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(f.root, 'pyproject.toml'), '[project]\nname = "fixture"\n');
  const overview = await app.openWorkspace({ workspace_id: 'default' });
  assert.deepEqual(overview.guidance.map(item => item.path), ['AGENTS.md', 'pyproject.toml']);
  const agents = overview.guidance.find(item => item.path === 'AGENTS.md')!;
  assert.ok(Buffer.byteLength(agents.preview) <= raw.limits.readMaxBytes);
  assert.equal(agents.truncated, true);
  assert.ok(!agents.preview.includes('\ufffd'));
  await assert.rejects(app.openWorkspace({ workspace_id: 'unauthorized' }), { code: 'WORKSPACE_NOT_FOUND' });
});

test('credential filenames are denied by reads, writes, directory listings and searches', async t => {
  const f = await fixture(t);
  const app = await f.createApp();
  const denied = ['API_key.txt', 'api-key.json', 'ApiKeys.yaml', 'credentials.json', 'secrets.toml', '.npmrc', '.netrc', 'id_ed25519'];
  for (const filename of denied) {
    await writeFile(path.join(f.root, filename), 'SYNTHETIC_CREDENTIAL_SENTINEL');
    await assert.rejects(app.files.read({ workspace_id: 'default', path: filename }), { code: 'PATH_DENIED' });
    await assert.rejects(app.files.write({ workspace_id: 'default', path: filename, content: 'replacement', expected_sha256: null, idempotency_key: 'deny-' + denied.indexOf(filename) }), { code: 'PATH_DENIED' });
  }
  // Source code and documented placeholders remain usable.
  await writeFile(path.join(f.root, 'api_key_manager.ts'), 'export const name = "public";');
  await writeFile(path.join(f.root, 'credentials.example.json'), '{"example":true}');
  const listing = await app.files.list({ workspace_id: 'default' });
  assert.ok(denied.every(filename => !listing.entries.some(entry => entry.name === filename)));
  assert.ok(listing.entries.some(entry => entry.name === 'api_key_manager.ts'));
  assert.ok(listing.entries.some(entry => entry.name === 'credentials.example.json'));
  assert.equal((await app.files.search({ workspace_id: 'default', query: 'SYNTHETIC_CREDENTIAL_SENTINEL' })).matches.length, 0);
});

test('Git inspection and workspace overview reject clean/process filters before any host command executes', async t => {
  const f = await fixture(t);
  f.initGit();
  await writeFile(path.join(f.root, '.gitattributes'), '*.txt filter=probe\n');
  await writeFile(path.join(f.root, 'public.txt'), 'original\n');
  f.git('add', '.gitattributes', 'public.txt');
  f.git('commit', '--quiet', '-m', 'fixture baseline');
  const marker = path.join(f.root, 'marker.txt');
  // This harmless marker command must never execute. Install it only after fixture creation.
  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('marker.txt','filter ran');process.stdin.pipe(process.stdout)"`;
  f.git('config', 'filter.probe.clean', command);
  await writeFile(path.join(f.root, 'public.txt'), 'modified\n');
  const app = await f.createApp();
  assert.equal(app.config.execution.mode, 'disabled');
  await assert.rejects(app.git.status({ workspace_id: 'default' }), { code: 'GIT_FILTERS_UNSUPPORTED' });
  await assert.rejects(app.git.diff({ workspace_id: 'default' }), { code: 'GIT_FILTERS_UNSUPPORTED' });
  assert.deepEqual((await app.openWorkspace({ workspace_id: 'default' })).git, { available: false, reason:'GIT_FILTERS_UNSUPPORTED' });
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  f.git('config', '--unset', 'filter.probe.clean');
  f.git('config', 'filter.probe.process', command);
  await assert.rejects(app.git.status({ workspace_id: 'default' }), { code: 'GIT_FILTERS_UNSUPPORTED' });
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('Git status and staged/unstaged diffs hide tracked protected files but show public changes', async t => {
  const f = await fixture(t);
  f.initGit();
  const stateDir = path.join(f.root, 'service-state');
  await mkdir(stateDir);
  await writeFile(path.join(f.root, '.env'), 'SYNTHETIC_ENV_BEFORE\n');
  await writeFile(path.join(f.root, 'API_key.txt'), 'SYNTHETIC_API_BEFORE\n');
  await writeFile(path.join(stateDir, 'snapshot.txt'), 'SYNTHETIC_STATE_BEFORE\n');
  await writeFile(path.join(f.root, 'public.txt'), 'public before\n');
  f.git('add', '.env', 'API_key.txt', 'service-state/snapshot.txt', 'public.txt');
  f.git('commit', '--quiet', '-m', 'fixture baseline');
  await writeFile(path.join(f.root, '.env'), 'SYNTHETIC_ENV_AFTER\n');
  await writeFile(path.join(f.root, 'API_key.txt'), 'SYNTHETIC_API_AFTER\n');
  await writeFile(path.join(stateDir, 'snapshot.txt'), 'SYNTHETIC_STATE_AFTER\n');
  await writeFile(path.join(f.root, 'public.txt'), 'public after\n');
  const app = await f.createApp({ ...f.raw, stateDir });
  const status = await app.git.status({ workspace_id: 'default' });
  assert.ok(status.entries.some(entry => entry.path === 'public.txt'));
  assert.ok(status.entries.every(entry => !['.env', 'API_key.txt'].includes(entry.path) && !entry.path.startsWith('service-state')));
  assert.ok(status.hidden_entries >= 3);
  const assertDiff = (diff: Awaited<ReturnType<typeof app.git.diff>>) => {
    assert.deepEqual(diff.files, ['public.txt']);
    assert.ok(diff.hidden_files >= 3);
    assert.match(diff.output, /public before/);
    assert.match(diff.output, /public after/);
    assert.doesNotMatch(diff.output, /SYNTHETIC_|\.env|API_key|service-state/);
  };
  assertDiff(await app.git.diff({ workspace_id: 'default' }));
  f.git('add', '.env', 'API_key.txt', 'service-state/snapshot.txt', 'public.txt');
  assertDiff(await app.git.diff({ workspace_id: 'default', staged: true }));
});

test('SQLite ownership survives stale diagnostics and crash recovery keeps pending operations unknown', async t => {
  const f = await fixture(t);
  const stateDir = path.join(f.base, 'crash-state');
  const payload = { operation: 'synthetic' };
  const digest = createHash('sha256').update(canonical(payload)).digest('hex');
  const storeModule = new URL('../src/store.js', import.meta.url).href;
  const script = `import {StateStore} from ${JSON.stringify(storeModule)};const s=new StateStore(process.argv[1]);globalThis.securityFixtureStore=s;s.db.prepare("INSERT INTO operations(scope,op_key,digest,status,created_at) VALUES(?,?,?,'pending','fixture')").run('fixture','abandoned',process.argv[2]);console.log('READY');setInterval(()=>s.db.prepare('SELECT 1').get(),1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, stateDir, digest], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  f.cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  await waitReady(child);
  assert.throws(() => { const unexpected = new StateStore(stateDir); unexpected.close(); }, { code: 'STATE_LOCKED' });
  // Overwrite diagnostics with a stale PID; the live SQLite lock remains authoritative.
  await writeFile(path.join(stateDir, 'daemon.lock'), JSON.stringify({ pid: 2147483647, owner: 'synthetic-stale-owner' }));
  assert.throws(() => { const unexpected = new StateStore(stateDir); unexpected.close(); }, { code: 'STATE_LOCKED' });
  child.kill();
  await closed;
  const recovered = new StateStore(stateDir);
  f.cleanups.push(() => recovered.close());
  assert.equal(recovered.db.prepare("SELECT status FROM operations WHERE op_key='abandoned'").get()?.status, 'unknown');
  let executed = false;
  await assert.rejects(recovered.idempotent('fixture', 'abandoned', payload, async () => { executed = true; return {}; }), { code: 'EXECUTION_UNKNOWN' });
  assert.equal(executed, false);
  assert.equal(JSON.parse(await readFile(path.join(stateDir, 'daemon.lock'), 'utf8')).pid, process.pid);
});

function waitReady(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    let output = '';
    let diagnostics = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture child did not acquire its state lock: ' + diagnostics)); }, 10_000);
    child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString('utf8'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (!output.includes('READY')) reject(new Error(`Fixture child exited (${code}): ${diagnostics}`)); });
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.includes('READY')) { clearTimeout(timer); resolve(); } });
  });
}
