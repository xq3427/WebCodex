import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaultUnifiedConfig } from '../src/config.js';
import { serializeConfig } from '../src/config-format.js';

const helper = path.resolve('scripts/resolve-tunnel-install.mjs');
const installer = path.resolve('scripts/install-tunnel.ps1');
const { resolveTunnelInstall } = await import(pathToFileURL(helper).href);
const secret = 'SYNTHETIC-INSTALL-SECRET-DO-NOT-PRINT';

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-installer-config-'));
  t.after(async () => {
    const actual = await realpath(base); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-installer-config-'));
    await rm(actual, { recursive: true, force: true });
  });
  const project = path.join(base, 'workspace'), external = path.join(base, "外置 config's"), userHome = path.join(base, 'user');
  await Promise.all([mkdir(project), mkdir(external), mkdir(userHome)]);
  const env = { LOCALAPPDATA: path.join(base, 'local-data'), XDG_CONFIG_HOME: path.join(base, 'xdg-data') };
  async function config(file: string, toolsDir = '${configDir}/tools') {
    await mkdir(path.dirname(file), { recursive: true });
    const raw = defaultUnifiedConfig(project, file); raw.toolsDir = toolsDir; raw.tunnel.apiKey = secret;
    const text = serializeConfig(raw, file.endsWith('.toml') ? 'toml' : 'json');
    await writeFile(file, text, { mode: 0o600 });
    return { file, text };
  }
  return { base, project, external, userHome, env, config };
}

test('explicit JSON and TOML selection resolves toolsDir against the configuration location without writes or secret output', async t => {
  const f = await fixture(t);
  for (const extension of ['json', 'toml']) {
    const c = await f.config(path.join(f.external, 'config.' + extension), '../设备 tools');
    const result = await resolveTunnelInstall({ config: c.file, cwd: f.project, env: {}, userHome: f.userHome });
    assert.equal(result.config_path, c.file);
    assert.equal(result.tools_dir, path.join(f.base, '设备 tools'));
    assert.equal(result.client_root, path.join(f.base, '设备 tools', 'tunnel-client'));
    assert.equal(result.architecture, process.arch === 'x64' ? 'amd64' : process.arch);
    assert.equal(result.install_started, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(await readFile(c.file, 'utf8'), c.text);
    await assert.rejects(access(result.tools_dir), { code: 'ENOENT' });
    await assert.rejects(access(path.join(f.external, 'state')), { code: 'ENOENT' });
  }
});

test('installer discovery uses explicit selection then environment then project then user, without merging defaults', async t => {
  const f = await fixture(t);
  const project = await f.config(path.join(f.project, '.webcodex', 'config.toml'));
  const external = await f.config(path.join(f.external, 'config.json'));
  const userDir = process.platform === 'win32' ? path.join(f.env.LOCALAPPDATA, 'WebCodex') : process.platform === 'darwin' ? path.join(f.userHome, 'Library', 'Application Support', 'WebCodex') : path.join(f.env.XDG_CONFIG_HOME, 'webcodex');
  const user = await f.config(path.join(userDir, 'config.json'));
  assert.equal((await resolveTunnelInstall({ cwd: f.project, env: f.env, userHome: f.userHome })).config_path, project.file);
  assert.equal((await resolveTunnelInstall({ cwd: f.project, env: { ...f.env, WEBCODEX_CONFIG: external.file }, userHome: f.userHome })).config_path, external.file);
  assert.equal((await resolveTunnelInstall({ config: project.file, cwd: f.project, env: { ...f.env, WEBCODEX_CONFIG: external.file }, userHome: f.userHome })).config_path, project.file);
  assert.equal((await resolveTunnelInstall({ cwd: f.external, env: f.env, userHome: f.userHome })).config_path, user.file);
});

test('ambiguous defaults and missing explicit selections fail instead of installing elsewhere', async t => {
  const f = await fixture(t);
  await f.config(path.join(f.project, '.webcodex', 'config.json'));
  await f.config(path.join(f.project, '.webcodex', 'config.toml'));
  await assert.rejects(resolveTunnelInstall({ cwd: f.project, env: f.env, userHome: f.userHome }), { code: 'CONFIG_AMBIGUOUS' });
  await assert.rejects(resolveTunnelInstall({ config: path.join(f.external, 'missing.json'), cwd: f.project, env: f.env, userHome: f.userHome }), { code: 'CONFIG_NOT_FOUND' });
});

test('helper stdout preserves Unicode paths through ASCII JSON and failures do not expose configuration contents', async t => {
  const f = await fixture(t), c = await f.config(path.join(f.external, 'config.toml'), '../设备 tools');
  const result = spawnSync(process.execPath, [helper, '--config', c.file], { cwd: f.project, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.equal(/[^\x00-\x7f]/.test(result.stdout), false);
  assert.equal(JSON.parse(result.stdout).tools_dir, path.join(f.base, '设备 tools'));
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  await writeFile(c.file, '{"apiKey":"' + secret + '"}');
  const failed = spawnSync(process.execPath, [helper, '--config', c.file], { cwd: f.project, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.ifError(failed.error); assert.equal(failed.status, 1);
  assert.equal((failed.stdout + failed.stderr).includes(secret), false);
  assert.equal(JSON.parse(failed.stderr).ok, false);
});

test('PowerShell installer -Config and default discovery use the same destination without starting installation', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), c = await f.config(path.join(f.external, 'config.toml'), '../设备 tools');
  await f.config(path.join(f.project, '.webcodex', 'config.json'));
  const run = (args: string[], env = process.env) => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-ResolveOnly', ...args], { cwd: f.project, env, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout + result.stderr).includes(secret), false);
    return JSON.parse(result.stdout);
  };
  const selected = run(['-Config', c.file]);
  assert.equal(selected.client_root, path.join(f.base, '设备 tools', 'tunnel-client'));
  assert.equal(selected.install_started, false);
  assert.equal(run([], { ...process.env, WEBCODEX_CONFIG: c.file }).client_root, selected.client_root);
  const override = run(['-Config', c.file, '-Architecture', 'arm64']);
  assert.equal(override.architecture, 'arm64');
  await assert.rejects(access(selected.tools_dir), { code: 'ENOENT' });
  assert.equal(await readFile(c.file, 'utf8'), c.text);
});
