import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm, link, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig, loadConfig } from '../src/config.js';
import { addExecutable, addWorkspace, codexStatus, disableCodexSessions, editConfig, enableCodexSessions, removeExecutable, removeWorkspace, setExecutionMode, showConfig } from '../src/config-admin.js';

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function fixture(t: TestContext) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'webcodex-config-admin-')));
  const root = path.join(temp, 'project');
  const second = path.join(temp, 'second');
  await Promise.all([mkdir(root), mkdir(second)]);
  const configPath = path.join(temp, 'config.json');
  const raw = defaultConfig(root, configPath);
  await writeFile(configPath, '\uFEFF' + JSON.stringify(raw, null, 2) + '\n');
  t.after(async () => { assert.ok(path.basename(temp).startsWith('webcodex-config-admin-')); await rm(temp, { recursive: true, force: true }); });
  return { temp, root, second, configPath, raw };
}

test('local workspace edits preserve unrelated fields and do not change loaded service authorization', async t => {
  const f = await fixture(t);
  const runningConfig = await loadConfig(f.configPath);
  const result = await addWorkspace(f.configPath, { id: 'second', root: f.second, name: '第二项目', readOnly: true });
  assert.equal(result.restart_required, true);
  assert.equal(runningConfig.workspaces.length, 1);
  assert.equal(runningConfig.execution.mode, 'disabled');
  const next = await loadConfig(f.configPath);
  assert.equal(next.workspaces[1].readOnly, true);
  assert.equal(next.execution.mode, 'disabled');
  assert.deepEqual(next.limits, f.raw.limits);
  assert.deepEqual(next.execution.allowedExecutables, f.raw.execution.allowedExecutables);
  await writeFile(path.join(f.second, 'keep.txt'), 'owner file');
  await removeWorkspace(f.configPath, 'second');
  assert.equal(await readFile(path.join(f.second, 'keep.txt'), 'utf8'), 'owner file');
  await assert.rejects(removeWorkspace(f.configPath, 'default'), { code: 'LAST_WORKSPACE' });
  await assert.rejects(removeWorkspace(f.configPath, 'missing'), { code: 'WORKSPACE_NOT_FOUND' });
});

test('new workspace authorization rejects duplicate, relative, traversing, linked and protected roots', async t => {
  const f = await fixture(t);
  const original = await readFile(f.configPath);
  await assert.rejects(addWorkspace(f.configPath, { id: 'default', root: f.second }), { code: 'WORKSPACE_EXISTS' });
  await assert.rejects(addWorkspace(f.configPath, { id: 'alias', root: f.root }), { code: 'WORKSPACE_EXISTS' });
  await assert.rejects(addWorkspace(f.configPath, { id: 'relative', root: 'second' }), { code: 'CONFIG_PATH_DENIED' });
  await assert.rejects(addWorkspace(f.configPath, { id: 'escape', root: f.root + path.sep + '..' + path.sep + 'second' }), { code: 'CONFIG_PATH_DENIED' });
  const state = path.join(f.temp, 'state');
  const credentials = path.join(f.temp, '.ssh');
  const junction = path.join(f.temp, 'jump');
  await Promise.all([mkdir(state), mkdir(credentials)]);
  await symlink(f.second, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(addWorkspace(f.configPath, { id: 'state', root: state }), { code: 'CONFIG_PATH_DENIED' });
  await assert.rejects(addWorkspace(f.configPath, { id: 'secret', root: credentials }), { code: 'CONFIG_PATH_DENIED' });
  await assert.rejects(addWorkspace(f.configPath, { id: 'linked', root: junction }), { code: 'CONFIG_PATH_DENIED' });
  assert.deepEqual(await readFile(f.configPath), original);
});

test('edits use an exclusive lock and preserve bytes on failed validation, stale SHA or concurrent external edit', async t => {
  const f = await fixture(t);
  const original = await readFile(f.configPath);
  await writeFile(f.configPath + '.lock', 'another local editor');
  await assert.rejects(setExecutionMode(f.configPath, 'trusted-host'), { code: 'CONFIG_LOCKED' });
  await unlink(f.configPath + '.lock');
  await assert.rejects(editConfig(f.configPath, raw => { raw.stateDir = 12; }), { code: 'CONFIG_ERROR' });
  await assert.rejects(editConfig(f.configPath, raw => { raw.execution.mode = 'trusted-host'; }, '0'.repeat(64)), { code: 'CONFIG_CONFLICT' });
  assert.deepEqual(await readFile(f.configPath), original);
  const external = Buffer.from(JSON.stringify({ ...f.raw, rgPath: 'custom-rg' }));
  await assert.rejects(editConfig(f.configPath, async raw => {
    raw.execution.mode = 'trusted-host';
    await writeFile(f.configPath, external);
  }), { code: 'CONFIG_CONFLICT' });
  assert.deepEqual(await readFile(f.configPath), external);
  assert.equal((await readdir(f.temp)).some(name => name.endsWith('.lock') || name.startsWith('.webcodex-write-')), false);
  const sha = createHash('sha256').update(external).digest('hex');
  assert.equal((await editConfig(f.configPath, raw => { raw.execution.mode = 'disabled'; }, sha)).restart_required, true);
});

test('configuration writes refuse hardlinks and linked ancestors', async t => {
  const f = await fixture(t);
  const original = await readFile(f.configPath);
  const hard = path.join(f.temp, 'hard.json');
  await link(f.configPath, hard);
  await assert.rejects(setExecutionMode(f.configPath, 'trusted-host'), { code: 'CONFIG_PATH_DENIED' });
  assert.deepEqual(await readFile(hard), original);
  await unlink(hard);
  const junction = path.join(f.temp, 'linked-parent');
  const realParent = path.join(f.temp, 'real-parent');
  await mkdir(realParent);
  await writeFile(path.join(realParent, 'config.json'), original);
  await symlink(realParent, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(setExecutionMode(path.join(junction, 'config.json'), 'trusted-host'), { code: 'CONFIG_PATH_DENIED' });
});

test('a concurrent local edit fails without replacing the first editors lock or changes', async t => {
  const f = await fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = editConfig(f.configPath, async raw => { entered(); await held; raw.rgPath = 'first-editor-rg'; });
  await active;
  try { await assert.rejects(setExecutionMode(f.configPath, 'trusted-host'), { code: 'CONFIG_LOCKED' }); }
  finally { release(); }
  await first;
  const result = await loadConfig(f.configPath);
  assert.equal(result.rgPath, 'first-editor-rg');
  assert.equal(result.execution.mode, 'disabled');
});

test('local execution edits preserve legacy aliases, validate fixed arguments and show no argument values', async t => {
  const f = await fixture(t);
  const runningConfig = await loadConfig(f.configPath);
  await addExecutable(f.configPath, { alias: 'npm', command: process.execPath, args: ['/local/npm-cli.js', 'private-argument-value'] });
  const configured = await loadConfig(f.configPath);
  assert.equal(configured.execution.allowedExecutables.node, process.execPath);
  assert.deepEqual(configured.execution.allowedExecutables.npm, { command: process.execPath, args: ['/local/npm-cli.js', 'private-argument-value'] });
  const shown = await showConfig(f.configPath);
  assert.equal(shown.execution.executables.find(e => e.alias === 'npm')!.prefix_arg_count, 2);
  assert.equal(JSON.stringify(shown).includes('private-argument-value'), false);
  const before = await readFile(f.configPath);
  await assert.rejects(addExecutable(f.configPath, { alias: 'npm', command: process.execPath, args: [] }), { code: 'EXECUTABLE_EXISTS' });
  await assert.rejects(addExecutable(f.configPath, { alias: 'bad', command: 'node', args: [] }), { code: 'CONFIG_ERROR' });
  await assert.rejects(addExecutable(f.configPath, { alias: 'bad', command: path.join(f.temp, 'npm.cmd'), args: [] }), { code: 'CONFIG_ERROR' });
  await assert.rejects(addExecutable(f.configPath, { alias: 'bad', command: process.execPath, args: ['null\0arg'] }), { code: 'CONFIG_ERROR' });
  await assert.rejects(addExecutable(f.configPath, { alias: '__proto__', command: process.execPath, args: [] }), { code: 'CONFIG_ERROR' });
  await assert.rejects(setExecutionMode(f.configPath, 'automatic'), { code: 'CONFIG_ERROR' });
  assert.deepEqual(await readFile(f.configPath), before);
  await setExecutionMode(f.configPath, 'trusted-host');
  assert.equal((await loadConfig(f.configPath)).execution.mode, 'trusted-host');
  assert.equal(runningConfig.execution.mode, 'disabled');
  await removeExecutable(f.configPath, 'npm');
  assert.deepEqual((await loadConfig(f.configPath)).execution.allowedExecutables, { node: process.execPath });
  await assert.rejects(removeExecutable(f.configPath, 'npm'), { code: 'EXECUTABLE_NOT_FOUND' });
});

test('handwritten configuration rejects __proto__ executable aliases instead of silently omitting them', async t => {
  const f = await fixture(t);
  const raw = JSON.parse(await readFile(f.configPath, 'utf8').then(text => text.replace(/^\uFEFF/, '')));
  Object.defineProperty(raw.execution.allowedExecutables, '__proto__', { value: process.execPath, enumerable: true });
  const bytes = Buffer.from(JSON.stringify(raw));
  await writeFile(f.configPath, bytes);
  await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_ERROR' });
  await assert.rejects(setExecutionMode(f.configPath, 'trusted-host'), { code: 'CONFIG_ERROR' });
  assert.deepEqual(await readFile(f.configPath), bytes);
});

test('CLI supports command-scoped flags, repeated prefix arguments and explicit local mode changes', async t => {
  const f = await fixture(t);
  const invoke = (...args: string[]) => run(process.execPath, [cliPath, ...args, '--config', f.configPath], { cwd: f.temp, windowsHide: true });
  const listed = JSON.parse((await invoke('workspace', 'list')).stdout);
  assert.equal(listed.workspaces[0].workspace_id, 'default');
  await invoke('workspace', 'add', '--id', 'cli', '--root', f.second, '--read-only');
  await invoke('workspace', 'remove', '--id', 'cli');
  const alias = JSON.parse((await invoke('execution', 'add', '--alias', 'cli', '--executable', process.execPath, '--prefix-arg=--no-warnings', '--prefix-arg', 'script.js')).stdout);
  assert.equal(alias.restart_required, true);
  assert.deepEqual((await loadConfig(f.configPath)).execution.allowedExecutables.cli, { command: process.execPath, args: ['--no-warnings', 'script.js'] });
  await invoke('execution', 'set-mode', 'trusted-host');
  assert.equal(JSON.parse((await invoke('config', 'show')).stdout).execution.mode, 'trusted-host');
  const before = await readFile(f.configPath);
  for (const args of [
    ['workspace', 'add', '--id', 'x', '--root', f.second, '--alias', 'bad'],
    ['execution', 'set-mode', 'disabled', '--root', f.second],
    ['doctor', '--transport', 'http'],
    ['config', 'show', '--unknown'],
    ['workspace', 'remove', '--id', 'default', '--id', 'default'],
    ['execution', 'remove'],
  ]) await assert.rejects(invoke(...args));
  assert.deepEqual(await readFile(f.configPath), before);
});

test('Codex history is disabled in new and legacy configurations until an explicit local enable', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.raw.codexSessions, { enabled: false, home: null });
  const { codexSessions: omitted, ...legacy } = f.raw;
  await writeFile(f.configPath, JSON.stringify(legacy));
  assert.deepEqual((await loadConfig(f.configPath)).codexSessions, { enabled: false, home: null });
  assert.deepEqual((await codexStatus(f.configPath)).codex_sessions, { enabled: false, home: null });
  const home = path.join(f.temp, 'codex-store');
  await mkdir(home);
  await writeFile(path.join(home, 'auth.json'), 'synthetic-auth-do-not-display');
  await writeFile(path.join(home, 'config.toml'), 'synthetic-config-do-not-display');
  const runningConfig = await loadConfig(f.configPath);
  const enabled = await enableCodexSessions(f.configPath, home);
  assert.equal(enabled.restart_required, true);
  assert.deepEqual(enabled.codex_sessions, { enabled: true, home });
  assert.deepEqual(runningConfig.codexSessions, { enabled: false, home: null });
  assert.equal(JSON.stringify(enabled).includes('synthetic-'), false);
  const after = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.deepEqual(after, { ...legacy, codexSessions: { enabled: true, home } });
  const disabled = await disableCodexSessions(f.configPath);
  assert.equal(disabled.restart_required, true);
  assert.deepEqual(disabled.codex_sessions, { enabled: false, home });
  assert.equal(await readFile(path.join(home, 'auth.json'), 'utf8'), 'synthetic-auth-do-not-display');
  assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), 'synthetic-config-do-not-display');
  assert.equal((await loadConfig(f.configPath)).execution.mode, 'disabled');
});

test('Codex home authorization rejects relative, traversing, missing and linked directories without changing config', async t => {
  const f = await fixture(t);
  const home = path.join(f.temp, 'codex-store');
  await mkdir(home);
  const jump = path.join(f.temp, 'linked-codex');
  await symlink(home, jump, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await readFile(f.configPath);
  for (const invalid of ['relative', f.root + path.sep + '..' + path.sep + 'codex-store', jump, f.configPath, path.join(f.temp, 'missing')]) {
    await assert.rejects(enableCodexSessions(f.configPath, invalid));
    assert.deepEqual(await readFile(f.configPath), before);
  }
  const linkedParent = path.join(jump, 'sessions');
  await mkdir(path.join(home, 'sessions'));
  await assert.rejects(enableCodexSessions(f.configPath, linkedParent), { code: 'CONFIG_PATH_DENIED' });
  assert.deepEqual(await readFile(f.configPath), before);
  await writeFile(f.configPath, JSON.stringify({ ...f.raw, codexSessions: { enabled: true, home: null } }));
  await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_ERROR' });
  await writeFile(f.configPath, JSON.stringify({ ...f.raw, codexSessions: { enabled: true, home: jump } }));
  await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_PATH_DENIED' });
});

test('configured Codex home remains excluded from new workspaces after disabling session access', async t => {
  const f = await fixture(t);
  const home = path.join(f.temp, 'codex-store');
  const child = path.join(home, 'sessions');
  await mkdir(child, { recursive: true });
  await enableCodexSessions(f.configPath, home);
  for (const root of [home, child]) await assert.rejects(addWorkspace(f.configPath, { id: 'codex-root', root }), { code: 'CONFIG_PATH_DENIED' });
  await disableCodexSessions(f.configPath);
  const before = await readFile(f.configPath);
  await assert.rejects(addWorkspace(f.configPath, { id: 'codex-child', root: child }), { code: 'CONFIG_PATH_DENIED' });
  assert.deepEqual(await readFile(f.configPath), before);
});

test('disabled Codex configuration permits a missing home without relaxing path or other config validation', async t => {
  const f = await fixture(t);
  const missing = path.join(f.temp, 'missing-codex', 'nested');
  await writeFile(f.configPath, JSON.stringify({ ...f.raw, codexSessions: { enabled: false, home: missing } }));
  assert.deepEqual((await loadConfig(f.configPath)).codexSessions, { enabled: false, home: missing });
  assert.deepEqual((await codexStatus(f.configPath)).codex_sessions, { enabled: false, home: missing });
  for (const home of ['relative', f.root + path.sep + '..' + path.sep + 'missing', f.configPath]) {
    const invalid = Buffer.from(JSON.stringify({ ...f.raw, codexSessions: { enabled: false, home } }));
    await writeFile(f.configPath, invalid);
    await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_PATH_DENIED' });
    await assert.rejects(disableCodexSessions(f.configPath), { code: 'CONFIG_PATH_DENIED' });
    assert.deepEqual(await readFile(f.configPath), invalid);
  }
  const jump = path.join(f.temp, 'linked-home');
  await symlink(f.second, jump, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(f.configPath, JSON.stringify({ ...f.raw, codexSessions: { enabled: false, home: path.join(jump, 'missing') } }));
  await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_PATH_DENIED' });
});

test('Codex disable recovers a missing enabled home by changing only its switch, preserving locks and validation', async t => {
  const f = await fixture(t);
  const missing = path.join(f.temp, 'missing-codex');
  const raw = { ...f.raw, codexSessions: { enabled: true, home: missing } };
  const before = Buffer.from(JSON.stringify(raw));
  await writeFile(f.configPath, before);
  await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_PATH_DENIED' });
  await assert.rejects(setExecutionMode(f.configPath, 'trusted-host'), { code: 'CONFIG_PATH_DENIED' });
  await writeFile(f.configPath + '.lock', 'other editor');
  await assert.rejects(disableCodexSessions(f.configPath), { code: 'CONFIG_LOCKED' });
  assert.deepEqual(await readFile(f.configPath), before);
  await unlink(f.configPath + '.lock');
  const result = await disableCodexSessions(f.configPath);
  assert.equal(result.restart_required, true);
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), { ...raw, codexSessions: { enabled: false, home: missing } });
  for (const invalidRaw of [
    { ...raw, unexpected: true },
    { ...raw, execution: { ...raw.execution, mode: 'unsafe' } },
    { ...raw, codexSessions: { enabled: true, home: missing, extra: 'bad' } },
  ]) {
    const invalid = Buffer.from(JSON.stringify(invalidRaw));
    await writeFile(f.configPath, invalid);
    await assert.rejects(disableCodexSessions(f.configPath), { code: 'CONFIG_ERROR' });
    assert.deepEqual(await readFile(f.configPath), invalid);
  }
});

test('Codex CLI validates scoped options and resolves explicit, environment and user-home defaults in isolated processes', async t => {
  const f = await fixture(t);
  const explicit = path.join(f.temp, 'explicit-codex');
  const environment = path.join(f.temp, 'environment-codex');
  const userHome = path.join(f.temp, 'fake-user');
  const userCodex = path.join(userHome, '.codex');
  await Promise.all([mkdir(explicit), mkdir(environment), mkdir(userCodex, { recursive: true })]);
  const env = { ...process.env, CODEX_HOME: environment, USERPROFILE: userHome, HOME: userHome };
  const invoke = (args: string[], overrides: NodeJS.ProcessEnv = {}) => run(process.execPath, [cliPath, ...args, '--config', f.configPath], { cwd: f.temp, env: { ...env, ...overrides }, windowsHide: true });
  assert.deepEqual(JSON.parse((await invoke(['codex', 'status'])).stdout).codex_sessions, { enabled: false, home: null });
  assert.equal(JSON.parse((await invoke(['codex', 'enable', '--home', explicit])).stdout).codex_sessions.home, explicit);
  assert.equal(JSON.parse((await invoke(['codex', 'enable'])).stdout).codex_sessions.home, explicit);
  await writeFile(f.configPath, JSON.stringify(f.raw));
  assert.equal(JSON.parse((await invoke(['codex', 'enable'])).stdout).codex_sessions.home, environment);
  assert.equal(JSON.parse((await invoke(['codex', 'enable'], { CODEX_HOME: '' })).stdout).codex_sessions.home, environment);
  await writeFile(f.configPath, JSON.stringify(f.raw));
  const fallback = JSON.parse((await invoke(['codex', 'enable'], { CODEX_HOME: '' })).stdout);
  assert.equal(fallback.codex_sessions.home, userCodex);
  assert.equal(fallback.restart_required, true);
  assert.equal(JSON.parse((await invoke(['codex', 'disable'])).stdout).codex_sessions.enabled, false);
  const before = await readFile(f.configPath);
  for (const args of [
    ['codex', 'enable', '--root', explicit],
    ['codex', 'disable', '--home', explicit],
    ['codex', 'status', '--home', explicit],
    ['codex', 'enable', '--home', explicit, '--home', environment],
    ['codex', 'enable', '--home', ''],
    ['codex', 'enable', 'unexpected'],
  ]) await assert.rejects(invoke(args));
  assert.deepEqual(await readFile(f.configPath), before);
});
