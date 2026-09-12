import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findNpmCli } from '../scripts/package-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const shell = windows ? 'powershell.exe' : '/bin/sh';
const script = windows ? 'install.ps1' : 'install.sh';

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, ...options });
  if (result.error) throw result.error;
  return result;
}

async function fixture(t, version = '0.0.0-install-test.1', withCli = true) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'webcodex-installer-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bundle = path.join(temporary, "release bundle 中文's");
  const source = path.join(temporary, 'source');
  const packageRoot = path.join(source, 'package');
  const installDir = path.join(temporary, "installed app 中文's");
  const workspace = path.join(temporary, "workspace 中文's");
  await mkdir(path.join(packageRoot, 'dist', 'src'), { recursive: true });
  await mkdir(bundle);
  await cp(path.join(root, 'distribution'), bundle, { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'webcodex-mcp', version, type: 'module', bin: { 'webcodex-mcp': 'dist/src/cli.js' },
    scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(process.env.TEST_INSTALL_SCRIPT_MARKER,\'unexpected\')"' },
  }));
  if (withCli) await writeFile(path.join(packageRoot, 'dist', 'src', 'cli.js'), `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2);
const config=args[args.indexOf('--config')+1];
if(!config)process.exit(9);
if(args[0]==='setup'&&!fs.existsSync(config))fs.writeFileSync(config,'synthetic_config = true\\n');
fs.writeFileSync(path.join(path.dirname(config),'last-call.json'),JSON.stringify(args));
console.log('Synthetic installer CLI completed');
`);
  const archiveName = `webcodex-mcp-${version}.tgz`;
  const archive = path.join(bundle, archiveName);
  const env = { ...process.env, npm_config_registry: 'http://127.0.0.1:9', npm_config_offline: 'true', npm_config_cache: path.join(temporary, 'cache'), TEST_INSTALL_SCRIPT_MARKER: path.join(temporary, 'lifecycle-script-ran'), WEBCODEX_INSTALL_NO_PAUSE: '1' };
  // Use Node's Unicode path handling: the system tar on some Windows runners
  // encodes the Chinese destination as question marks before opening the file.
  const packed = run(process.execPath, [await findNpmCli(), 'pack', '--json', '--ignore-scripts', '--offline', '--cache', env.npm_config_cache, '--pack-destination', bundle], { cwd: packageRoot, env });
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  assert.equal(JSON.parse(packed.stdout)[0].filename, archiveName);
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(path.join(bundle, 'SHA256SUMS'), `${hash}  ${archiveName}\n`);
  const invoke = (target = installDir, { defaultWorkspace = false, extraArgs = [] } = {}) => run(shell, windows
    ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(bundle, script), '-InstallDir', target, ...(defaultWorkspace ? [] : ['-Workspace', workspace]), '-NoPanel', ...extraArgs]
    : [path.join(bundle, script), '--install-dir', target, ...(defaultWorkspace ? [] : ['--workspace', workspace]), '--no-panel', ...extraArgs], { cwd: temporary, env });
  return { temporary, bundle, source, installDir, workspace, archive, version, env, invoke };
}

test('installers verify local package and official portable runtime without global installation', async () => {
  const ps = await readFile(path.join(root, 'distribution/install.ps1'), 'utf8');
  const sh = await readFile(path.join(root, 'distribution/install.sh'), 'utf8');
  const cmd = await readFile(path.join(root, 'distribution/install.cmd'), 'utf8');
  for (const text of [ps, sh]) {
    assert.match(text, /SHA256SUMS/);
    assert.match(text, /SHASUMS256\.txt/);
    assert.match(text, /https:\/\/nodejs\.org\/dist/);
    assert.match(text, /22\.23\.2/);
    assert.match(text, /--omit=dev --ignore-scripts/);
    assert.doesNotMatch(text, /(?:npm(?:\.cmd)? install -g|Set-MpPreference|netsh|New-Service|Set-ExecutionPolicy|setx)/);
  }
  assert.match(cmd, /-File "%~dp0install\.ps1"/);
  assert.match(cmd, /exit \/b %WEBCODEX_INSTALL_EXIT%/);
});

test('native installer deploys a synthetic offline package, preserves config, reuses a release and starts its launcher', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  const first = f.invoke();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Package checksum verified/);
  const config = path.join(f.installDir, 'config.toml');
  const initialArgs = JSON.parse(await readFile(path.join(f.installDir, 'last-call.json'), 'utf8'));
  assert.deepEqual(initialArgs, ['setup', '--workspace', f.workspace, '--config', config, '--no-panel']);
  assert.equal(await readFile(config, 'utf8'), 'synthetic_config = true\n');
  assert.equal((await stat(f.workspace)).isDirectory(), true);
  await assert.rejects(stat(f.env.TEST_INSTALL_SCRIPT_MARKER), { code: 'ENOENT' });
  const installedCli = path.join(f.installDir, 'app', f.version, 'node_modules/webcodex-mcp/dist/src/cli.js');
  const initialMtime = (await stat(installedCli)).mtimeMs;
  await writeFile(config, 'existing_private_setting = "preserve exactly"\n');
  const repeat = f.invoke();
  assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
  assert.match(repeat.stdout, /Reusing this verified release/);
  assert.equal((await stat(installedCli)).mtimeMs, initialMtime);
  assert.equal(await readFile(config, 'utf8'), 'existing_private_setting = "preserve exactly"\n');
  const launch = run(shell, windows
    ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.installDir, 'webcodex.ps1')]
    : [path.join(f.installDir, 'webcodex')], { env: f.env });
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.installDir, 'last-call.json'), 'utf8')), ['setup', '--config', config]);
  assert.deepEqual(await readdir(path.join(f.installDir, 'app')), [f.version]);
});

test('a modified setup archive fails its checksum before creating installation files', async t => {
  const f = await fixture(t);
  await writeFile(f.archive, 'modified package bytes');
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /SHA-256 verification failed/);
  await assert.rejects(stat(f.installDir), { code: 'ENOENT' });
});

test('an incomplete package fails and its temporary application staging directory is cleaned', { timeout: 180_000 }, async t => {
  const f = await fixture(t, '0.0.0-install-test.2', false);
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /does not include the built WebCodex CLI/);
  assert.deepEqual(await readdir(path.join(f.installDir, 'app')), []);
  await assert.rejects(stat(path.join(f.installDir, 'config.toml')), { code: 'ENOENT' });
});

test('default workspace is separate from application and proxy is forwarded to setup', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  const result = f.invoke(f.installDir, { defaultWorkspace: true, extraArgs: [windows ? '-Proxy' : '--proxy', 'http://127.0.0.1:9'] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.installDir, 'last-call.json'), 'utf8')), [
    'setup', '--workspace', path.join(f.installDir, 'workspace'), '--config', path.join(f.installDir, 'config.toml'), '--no-panel', '--proxy', 'http://127.0.0.1:9',
  ]);
  assert.equal((await stat(path.join(f.installDir, 'workspace'))).isDirectory(), true);
});

test('installing a new release preserves the old version and existing private configuration', { timeout: 180_000 }, async t => {
  const f = await fixture(t, '0.0.0-install-test.3');
  const initial = f.invoke();
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  const oldCli = path.join(f.installDir, 'app', f.version, 'node_modules/webcodex-mcp/dist/src/cli.js');
  const oldMtime = (await stat(oldCli)).mtimeMs;
  await writeFile(path.join(f.installDir, 'config.toml'), 'existing_private_setting = "keep on upgrade"\n');
  const next = await fixture(t, '0.0.0-install-test.4');
  await rm(f.archive);
  await cp(next.archive, path.join(f.bundle, path.basename(next.archive)));
  await cp(path.join(next.bundle, 'SHA256SUMS'), path.join(f.bundle, 'SHA256SUMS'));
  const upgrade = f.invoke();
  assert.equal(upgrade.status, 0, upgrade.stdout + upgrade.stderr);
  assert.equal((await stat(oldCli)).mtimeMs, oldMtime);
  assert.equal(await readFile(path.join(f.installDir, 'config.toml'), 'utf8'), 'existing_private_setting = "keep on upgrade"\n');
  assert.deepEqual((await readdir(path.join(f.installDir, 'app'))).sort(), [f.version, next.version]);
  assert.match(await readFile(path.join(f.installDir, windows ? 'webcodex.ps1' : 'webcodex'), 'utf8'), /0\.0\.0-install-test\.4/);
});

test('Windows double-click entry point forwards quoted paths and returns installation failure', { skip: !windows, timeout: 180_000 }, async t => {
  const f = await fixture(t);
  const command = `""${path.join(f.bundle, 'install.cmd')}" -InstallDir "${f.installDir}" -Workspace "${f.workspace}" -NoPanel"`;
  const invoke = () => run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { env: f.env, windowsVerbatimArguments: true });
  const success = invoke();
  assert.equal(success.status, 0, success.stdout + success.stderr);
  assert.equal(await readFile(path.join(f.installDir, 'config.toml'), 'utf8'), 'synthetic_config = true\n');
  await writeFile(f.archive, 'changed original bytes');
  const failure = invoke();
  assert.notEqual(failure.status, 0);
  assert.match(failure.stdout + failure.stderr, /SHA-256 verification failed/);
});

test('an existing JSON configuration is preserved and selected by setup and the launcher', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await mkdir(f.installDir);
  const config = path.join(f.installDir, 'config.json');
  const bytes = '{"existing_private_setting":"preserve this JSON"}\n';
  await writeFile(config, bytes);
  const result = f.invoke();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(config, 'utf8'), bytes);
  await assert.rejects(stat(path.join(f.installDir, 'config.toml')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.installDir, 'last-call.json'), 'utf8')), [
    'setup', '--workspace', f.workspace, '--config', config, '--no-panel',
  ]);
  const launch = run(shell, windows
    ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.installDir, 'webcodex.ps1')]
    : [path.join(f.installDir, 'webcodex')], { env: f.env });
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.installDir, 'last-call.json'), 'utf8')), ['setup', '--config', config]);
  assert.equal(await readFile(config, 'utf8'), bytes);
});

test('two existing config formats require explicit selection before application installation', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await mkdir(f.installDir);
  const json = path.join(f.installDir, 'config.json');
  const toml = path.join(f.installDir, 'config.toml');
  const jsonBytes = '{"existing_private_setting":"JSON"}\n';
  const tomlBytes = 'existing_private_setting = "TOML"\n';
  await writeFile(json, jsonBytes);
  await writeFile(toml, tomlBytes);
  const refused = f.invoke();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /Both config.json and config.toml exist/);
  await assert.rejects(stat(path.join(f.installDir, 'app')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.installDir, 'last-call.json')), { code: 'ENOENT' });
  assert.equal(await readFile(json, 'utf8'), jsonBytes);
  assert.equal(await readFile(toml, 'utf8'), tomlBytes);
  const selected = f.invoke(f.installDir, { extraArgs: [windows ? '-Config' : '--config', path.relative(f.temporary, json)] });
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.installDir, 'last-call.json'), 'utf8')), [
    'setup', '--workspace', f.workspace, '--config', json, '--no-panel',
  ]);
  assert.equal(await readFile(json, 'utf8'), jsonBytes);
  assert.equal(await readFile(toml, 'utf8'), tomlBytes);
});
