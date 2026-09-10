import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm, symlink, link, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig, defaultUnifiedConfig, discoverConfigPath, expandConfigPath, loadConfig, resolveConfigSelectionPath, validateConfig } from '../src/config.js';
import { addExecutable, addWorkspace, disableCodexSessions, enableCodexSessions, rebindWorkspace, removeExecutable, removeWorkspace, renameDevice, setExecutionMode, showConfig } from '../src/config-admin.js';
import { configFormatForPath, parseConfigText, serializeConfig, type ConfigFormat } from '../src/config-format.js';

async function fixture(t: TestContext, format: ConfigFormat = 'json') {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'webcodex-unified-')));
  const root = path.join(temp, '项目 with spaces');
  const second = path.join(temp, 'second project');
  const codexHome = path.join(temp, 'saved-codex');
  await Promise.all([mkdir(root), mkdir(second), mkdir(codexHome)]);
  const configPath = path.join(temp, 'config.' + format);
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: '测试设备' });
  await writeFile(configPath, serializeConfig(raw, format));
  t.after(async () => { assert.ok(path.basename(temp).startsWith('webcodex-unified-')); await rm(temp, { recursive: true, force: true }); });
  return { temp, root, second, codexHome, configPath, raw, format };
}

test('v1 remains valid and v2 JSON/TOML have identical effective settings', async t => {
  const f = await fixture(t);
  const legacy = defaultConfig(f.root, f.configPath);
  const v1 = await validateConfig(legacy, f.configPath);
  assert.equal(v1.version, 1);
  assert.equal(v1.device, undefined);
  assert.deepEqual(v1.codexSessions, { enabled: false, home: null });
  const json = await validateConfig(parseConfigText(serializeConfig(f.raw, 'json'), 'json'), f.configPath);
  const toml = await validateConfig(parseConfigText(serializeConfig(f.raw, 'toml'), 'toml'), f.configPath);
  assert.deepEqual(toml, json);
  assert.equal(json.workspaces[0].root, f.root);
  assert.equal(json.nodePath, process.execPath);
  assert.deepEqual(json.execution.allowedExecutables.node, { command: process.execPath, args: [] });
  assert.equal(json.execution.mode, 'disabled');
  assert.equal(json.tunnel?.enabled, false);
  assert.notEqual(defaultUnifiedConfig(f.root, f.configPath).device.id, f.raw.device.id);
  assert.notEqual(defaultUnifiedConfig(f.root, f.configPath).workspaces[0].uid, f.raw.workspaces[0].uid);
  const upper = structuredClone(f.raw);
  upper.device.id = upper.device.id.toUpperCase();
  upper.workspaces[0].uid = upper.workspaces[0].uid.toUpperCase();
  const normalized = await validateConfig(upper, f.configPath);
  assert.equal(normalized.device?.id, f.raw.device.id);
  assert.equal(normalized.workspaces[0].uid, f.raw.workspaces[0].uid);
});

test('strict parsers reject duplicate/reserved keys without source snippets', () => {
  const sources: Array<[ConfigFormat, string]> = [
    ['json', '{"secret-sentinel":"key-value","secret-sentinel":2}'],
    ['json', '{"a":1,"\\u0061":2,"key-value":3}'],
    ['json', '{"nested":{"__proto__":{"key-value":true}}}'],
    ['json', '{"nested":{"constructor":"key-value"}}'],
    ['json', '{"nested":[{"prototype":"key-value"}]}'],
    ['json', '{"value":"key-value"'],
    ['toml', 'secret-sentinel = "key-value"\nsecret-sentinel = 2'],
    ['toml', '[nested]\n"constructor" = "key-value"'],
    ['toml', 'value = "key-value'],
  ];
  for (const [format, source] of sources) assert.throws(() => parseConfigText(source, format), error => {
    assert.equal((error as { code: string }).code, 'CONFIG_ERROR');
    assert.doesNotMatch(JSON.stringify(error) + String(error), /key-value|secret-sentinel/);
    return true;
  });
  assert.deepEqual(parseConfigText('\uFEFF{"version":1}', 'json'), { version: 1 });
  assert.throws(() => parseConfigText(' '.repeat(1048577), 'json'), { code: 'CONFIG_ERROR' });
  assert.equal(configFormatForPath('CONFIG.TOML'), 'toml');
  assert.throws(() => configFormatForPath('config.yaml'), { code: 'CONFIG_ERROR' });
});

test('TOML serializer preserves source comments for replacement, removal and structural additions', () => {
  const source = '# top comment\nversion = 2\n\n[device] # device header\nname = "old" # name note\nid = "test-id"\n\n[[workspaces]] # first header\nid = "first" # first id\nroot = "first"\n# first standalone\n[[workspaces]] # second header\nid = "second"\nroot = "second"\n\n[execution.allowedExecutables.node]\ncommand = "node"\nargs = [] # original args\n';
  const raw = parseConfigText(source, 'toml') as { device: { name: string }; workspaces: Array<{ id: string; root: string }>; execution: { allowedExecutables: Record<string, { command: string; args: string[] }> } };
  raw.device.name = '新 name';
  raw.execution.allowedExecutables.node.args = ['quote"', 'backslash\\', 'literal$(x)'];
  raw.execution.allowedExecutables.extra = { command: 'other', args: [] };
  const edited = serializeConfig(raw, 'toml', { originalText: source });
  assert.deepEqual(parseConfigText(edited, 'toml'), raw);
  assert.match(edited, /name = "新 name" # name note/);
  assert.match(edited, /# original args/);
  raw.workspaces.splice(0, 1);
  delete raw.execution.allowedExecutables.extra;
  const removed = serializeConfig(raw, 'toml', { originalText: edited });
  assert.deepEqual(parseConfigText(removed, 'toml'), raw);
  for (const comment of ['# top comment', '# device header', '# first header', '# first id', '# first standalone', '# second header']) assert.ok(removed.includes(comment));
  raw.workspaces.push({ id: 'third', root: 'third' });
  const appended = serializeConfig(raw, 'toml', { originalText: removed });
  assert.deepEqual(parseConfigText(appended, 'toml'), raw);
  assert.equal(serializeConfig(raw, 'toml', { originalText: appended }), appended);
});

test('v2 schema rejects unknown fields, missing IDs, duplicate UIDs and unsafe authentication', async t => {
  const f = await fixture(t);
  const candidates: unknown[] = [
    { ...f.raw, 'secret-sentinel-key-value': true },
    { ...f.raw, device: { id: '', name: 'local' } },
    { ...f.raw, workspaces: [{ id: 'one', uid: '', name: 'one', root: f.root }] },
    { ...f.raw, workspaces: [...f.raw.workspaces, { ...f.raw.workspaces[0], id: 'second', root: f.second }] },
    { ...f.raw, tunnel: { ...f.raw.tunnel, enabled: true, id: 'tunnel_test' } },
    { ...f.raw, tunnel: { ...f.raw.tunnel, apiKey: 'key-value\u200b' } },
    { ...f.raw, tunnel: { ...f.raw.tunnel, apiKey: 'key value' } },
    { ...f.raw, tunnel: { ...f.raw.tunnel, proxyUrl: 'https://user:key-value@example.com' } },
    { ...f.raw, tunnel: { ...f.raw.tunnel, proxyUrl: 'http://localhost:3128/a?key-value' } },
    { ...f.raw, tunnel: { ...f.raw.tunnel, proxyUrl: 'socks5://localhost:3128' } },
    { ...f.raw, tunnel: { ...f.raw.tunnel, clientPath: process.execPath } },
    { ...f.raw, tunnel: { ...f.raw.tunnel, clientVersion: 'latest' } },
    { ...f.raw, server: { transport: 'http' }, http: { port: 8765, bearerToken: 'key-value' } },
    { ...f.raw, codexSessions: { ...f.raw.codexSessions, home: 'auto' } },
    { ...f.raw, execution: { ...f.raw.execution, maxTimeoutMs: 1000 } },
    { ...f.raw, logging: { level: 'info' } },
  ];
  for (const candidate of candidates) await assert.rejects(validateConfig(candidate, f.configPath), error => {
    assert.doesNotMatch(JSON.stringify(error) + String(error), /key-value|secret-sentinel/);
    return true;
  });
  const valid = { ...f.raw, tunnel: { ...f.raw.tunnel, enabled: true, id: 'tunnel_test', apiKey: 'test-${nodePath}-`$(literal)', proxyUrl: 'http://localhost:3128', clientVersion: 'v0.1.0' }, server: { transport: 'http' }, http: { port: 8765, bearerToken: 'x'.repeat(48) } };
  assert.equal((await validateConfig(valid, f.configPath)).tunnel?.apiKey, valid.tunnel.apiKey);
});

test('path references are explicit substitutions and native executable wrappers are refused', async t => {
  const f = await fixture(t);
  const context = { configDir: f.temp, userHome: path.join(f.temp, 'synthetic-home'), nodePath: process.execPath };
  assert.equal(resolveConfigSelectionPath('~/config.toml', { cwd: f.temp, userHome: context.userHome }), path.join(context.userHome, 'config.toml'));
  assert.equal(resolveConfigSelectionPath('sub/config.json', { cwd: f.temp, userHome: context.userHome }), path.join(f.temp, 'sub', 'config.json'));
  assert.throws(() => resolveConfigSelectionPath('', { cwd: f.temp }), { code: 'CONFIG_ERROR' });
  assert.equal(expandConfigPath('${configDir}/a', context), path.join(f.temp, 'a'));
  assert.equal(expandConfigPath('${userHome}/a', context), path.join(context.userHome, 'a'));
  assert.equal(expandConfigPath('~/a', context), path.join(context.userHome, 'a'));
  assert.equal(expandConfigPath('relative folder/a', context), path.join(f.temp, 'relative folder', 'a'));
  assert.equal(expandConfigPath('${nodePath}', context), process.execPath);
  assert.equal(expandConfigPath('literal-$(not-executed)', context), path.join(f.temp, 'literal-$(not-executed)'));
  for (const bad of ['${HOME}/a', '${env:KEY}/a', '${nodePath', '~someone/a']) assert.throws(() => expandConfigPath(bad, context), { code: 'CONFIG_ERROR' });
  await assert.rejects(validateConfig({ ...f.raw, nodePath: '${nodePath}' }, f.configPath), { code: 'CONFIG_ERROR' });
  await assert.rejects(validateConfig({ ...f.raw, gitPath: 'git.cmd' }, f.configPath), { code: 'CONFIG_ERROR' });
  await assert.rejects(validateConfig({ ...f.raw, execution: { ...f.raw.execution, allowedExecutables: { node: 'node.bat' } } }, f.configPath), { code: 'CONFIG_ERROR' });
  const alternate = { ...f.raw, stateDir: './relative state', toolsDir: '${configDir}/tool files' };
  const config = await validateConfig(alternate, f.configPath);
  assert.equal(config.stateDir, path.join(f.temp, 'relative state'));
  assert.equal(config.toolsDir, path.join(f.temp, 'tool files'));
});

test('runtime environment credentials and Codex home never overlay a selected v2 document', async t => {
  const f = await fixture(t);
  const names = ['CONTROL_PLANE_API_KEY', 'WEBCODEX_HTTP_TOKEN', 'CODEX_HOME'] as const;
  const prior = names.map(name => process.env[name]);
  process.env.CONTROL_PLANE_API_KEY = 'synthetic-environment-api-key';
  process.env.WEBCODEX_HTTP_TOKEN = 'synthetic-environment-token-'.repeat(2);
  process.env.CODEX_HOME = f.codexHome;
  try {
    const config = await loadConfig(f.configPath);
    assert.equal(config.tunnel?.apiKey, '');
    assert.equal(config.http.bearerToken, '');
    assert.equal(config.codexSessions.home, null);
    await assert.rejects(validateConfig({ ...f.raw, tunnel: { ...f.raw.tunnel, enabled: true, id: 'tunnel_test' } }, f.configPath), { code: 'CONFIG_ERROR' });
    await assert.rejects(validateConfig({ ...f.raw, server: { transport: 'http' } }, f.configPath), { code: 'CONFIG_ERROR' });
  } finally { names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index]; }); }
});

test('discovery selects one file by precedence and never falls through explicit errors or ambiguity', async t => {
  const f = await fixture(t);
  const cwd = path.join(f.temp, 'discovery');
  const userHome = path.join(f.temp, 'user');
  const local = path.join(cwd, '.webcodex');
  const env: NodeJS.ProcessEnv = { LOCALAPPDATA: path.join(userHome, 'appdata'), XDG_CONFIG_HOME: path.join(userHome, 'xdg') };
  const userDir = process.platform === 'win32' ? path.join(env.LOCALAPPDATA!, 'WebCodex') : process.platform === 'darwin' ? path.join(userHome, 'Library', 'Application Support', 'WebCodex') : path.join(env.XDG_CONFIG_HOME!, 'webcodex');
  await Promise.all([mkdir(local, { recursive: true }), mkdir(userDir, { recursive: true })]);
  const userJson = path.join(userDir, 'config.json');
  const localToml = path.join(local, 'config.toml');
  const localJson = path.join(local, 'config.json');
  const options = { cwd, env, userHome };
  await assert.rejects(discoverConfigPath(undefined, options), { code: 'CONFIG_NOT_FOUND' });
  await writeFile(userJson, '{}');
  assert.equal(await discoverConfigPath(undefined, options), userJson);
  await writeFile(localToml, 'not valid TOML');
  assert.equal(await discoverConfigPath(undefined, options), localToml);
  await assert.rejects(loadConfig(await discoverConfigPath(undefined, options)), { code: 'CONFIG_ERROR' });
  await writeFile(localJson, '{}');
  await assert.rejects(discoverConfigPath(undefined, options), { code: 'CONFIG_AMBIGUOUS' });
  assert.equal(await discoverConfigPath(localToml, options), localToml);
  assert.equal(await discoverConfigPath(undefined, { ...options, env: { ...env, WEBCODEX_CONFIG: f.configPath } }), f.configPath);
  assert.equal(await discoverConfigPath(localJson, { ...options, env: { ...env, WEBCODEX_CONFIG: f.configPath } }), localJson);
  await assert.rejects(discoverConfigPath('missing.json', options), { code: 'CONFIG_NOT_FOUND' });
  await assert.rejects(discoverConfigPath(undefined, { ...options, env: { ...env, WEBCODEX_CONFIG: 'missing.json' } }), { code: 'CONFIG_NOT_FOUND' });
});

test('show hides keys, tokens, proxy credentials and executable fixed arguments', async t => {
  const f = await fixture(t, 'toml');
  f.raw.tunnel.apiKey = 'test-api-key-sentinel';
  f.raw.http.bearerToken = 'test-token-sentinel-'.repeat(3);
  f.raw.execution.allowedExecutables.node.args = ['test-argument-sentinel', 'quote"slash\\中文`$()'];
  await writeFile(f.configPath, serializeConfig(f.raw, f.format));
  const shown = await showConfig(f.configPath);
  assert.equal(shown.tunnel?.api_key_configured, true);
  assert.equal(shown.http_bearer_token_configured, true);
  assert.equal(shown.execution.executables[0].prefix_arg_count, 2);
  assert.doesNotMatch(JSON.stringify(shown), /test-api-key-sentinel|test-token-sentinel|test-argument-sentinel|quote/);
  await renameDevice(f.configPath, 'Changed name');
  const loaded = await loadConfig(f.configPath);
  assert.equal(loaded.device?.id, f.raw.device.id);
  assert.equal(loaded.device?.name, 'Changed name');
  assert.deepEqual(loaded.execution.allowedExecutables.node, { command: process.execPath, args: f.raw.execution.allowedExecutables.node.args });
});

test('TOML administration preserves comments while changing scalars, aliases and workspace tables', async t => {
  const f = await fixture(t, 'toml');
  const source = '# file owner comment\n' + serializeConfig(f.raw, 'toml').replace('mode = "disabled"', 'mode = "disabled" # execution note').replace('[[workspaces]]', '[[workspaces]] # workspace header note').replace('name = "测试设备"', 'name = "测试设备" # device name note');
  await writeFile(f.configPath, source);
  await setExecutionMode(f.configPath, 'trusted-host');
  await renameDevice(f.configPath, 'Device two');
  await addExecutable(f.configPath, { alias: 'other', command: process.execPath, args: ['argument with "quotes"', '$()', '中文\\path'] });
  await addWorkspace(f.configPath, { id: 'second', root: f.second });
  const added = await loadConfig(f.configPath);
  assert.match(added.workspaces[1].uid!, /^[a-f0-9-]{36}$/);
  assert.notEqual(added.workspaces[1].uid, added.workspaces[0].uid);
  await removeWorkspace(f.configPath, 'default');
  await removeExecutable(f.configPath, 'other');
  const after = await readFile(f.configPath, 'utf8');
  for (const comment of ['# file owner comment', '# execution note', '# workspace header note', '# device name note']) assert.ok(after.includes(comment));
  assert.match(after, /mode = "trusted-host" # execution note/);
  assert.match(after, /name = "Device two" # device name note/);
  assert.equal((await loadConfig(f.configPath)).workspaces[0].id, 'second');
  assert.equal((await readdir(f.temp)).some(file => file.endsWith('.lock') || file.startsWith('.webcodex-write-config-')), false);
});

test('unsupported multiline TOML is valid to load and fails editing without changing its bytes', async t => {
  const f = await fixture(t, 'toml');
  const source = serializeConfig(f.raw, 'toml').replace('args = []', 'args = [\n  "argument", # multiline comment\n]');
  assert.notEqual(source, serializeConfig(f.raw, 'toml'));
  await writeFile(f.configPath, source);
  assert.equal((await loadConfig(f.configPath)).version, 2);
  await assert.rejects(renameDevice(f.configPath, 'New name'), { code: 'CONFIG_EDIT_UNSUPPORTED' });
  assert.equal(await readFile(f.configPath, 'utf8'), source);
  assert.equal((await readdir(f.temp)).some(file => file.endsWith('.lock') || file.startsWith('.webcodex-write-config-')), false);
});

test('Codex home enable retains the saved source and budgets despite an environment change', async t => {
  const f = await fixture(t);
  f.raw.codexSessions.home = f.codexHome;
  f.raw.codexSessions.maxWindowsPerRequest = 3;
  await writeFile(f.configPath, serializeConfig(f.raw, f.format));
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(f.temp, 'environment-home-that-does-not-exist');
  try {
    await enableCodexSessions(f.configPath);
    const loaded = await loadConfig(f.configPath);
    assert.equal(loaded.codexSessions.home, f.codexHome);
    assert.equal(loaded.codexSessions.maxWindowsPerRequest, 3);
    await enableCodexSessions(f.configPath, f.second);
    assert.equal((await loadConfig(f.configPath)).codexSessions.home, f.second);
    await disableCodexSessions(f.configPath);
    await enableCodexSessions(f.configPath);
    assert.equal((await loadConfig(f.configPath)).codexSessions.home, f.second);
  } finally { if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior; }
});

test('rebind repairs only a selected missing root and rotates UID when the root changes', async t => {
  const f = await fixture(t, 'toml');
  f.raw.workspaces[0].root = path.join(f.temp, 'missing original root');
  await writeFile(f.configPath, serializeConfig(f.raw, f.format));
  await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_ERROR' });
  await rebindWorkspace(f.configPath, { id: 'default', root: f.second, name: 'Rebound', readOnly: true });
  const repaired = await loadConfig(f.configPath);
  assert.equal(repaired.workspaces[0].root, f.second);
  assert.equal(repaired.workspaces[0].readOnly, true);
  assert.notEqual(repaired.workspaces[0].uid, f.raw.workspaces[0].uid);
  assert.equal(repaired.device?.id, f.raw.device.id);
  assert.equal(repaired.execution.mode, f.raw.execution.mode);
  await rebindWorkspace(f.configPath, { id: 'default', root: f.second, name: 'Same root' });
  assert.equal((await loadConfig(f.configPath)).workspaces[0].uid, repaired.workspaces[0].uid);
  const malformed = { ...f.raw, execution: { ...f.raw.execution, maxConcurrent: 0 } };
  await writeFile(f.configPath, serializeConfig(malformed, f.format));
  const before = await readFile(f.configPath);
  await assert.rejects(rebindWorkspace(f.configPath, { id: 'default', root: f.second }), { code: 'CONFIG_ERROR' });
  assert.deepEqual(await readFile(f.configPath), before);
});

test('configuration loader refuses linked files, linked directories and oversized files', async t => {
  const f = await fixture(t);
  const hard = path.join(f.temp, 'hard.json');
  await link(f.configPath, hard);
  await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_ERROR' });
  await unlink(hard);
  const linkedDir = path.join(f.temp, 'linked');
  const plainDir = path.join(f.temp, 'plain');
  await mkdir(plainDir);
  await writeFile(path.join(plainDir, 'config.json'), serializeConfig(f.raw, 'json'));
  await symlink(plainDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadConfig(path.join(linkedDir, 'config.json')), { code: 'CONFIG_ERROR' });
  await writeFile(f.configPath, ' '.repeat(1048577));
  await assert.rejects(loadConfig(f.configPath), { code: 'CONFIG_ERROR' });
});
