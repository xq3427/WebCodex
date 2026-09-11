import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { defaultUnifiedConfig, executableDefinition, loadConfig } from '../src/config.js';
import { parseConfigText, serializeConfig, type ConfigFormat } from '../src/config-format.js';
import { detectLinkedWorktree } from '../src/worktree-policy.js';

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const PRIVATE_KEY = 'synthetic-config-secret-never-print';

async function fixture(t: TestContext, format: ConfigFormat) {
  const parent = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(parent, 'webcodex-v06-config-'));
  const root = path.join(base, 'project');
  const home = path.join(base, 'synthetic-codex-home');
  await fs.mkdir(root);
  await fs.mkdir(home);
  const configPath = path.join(base, 'config.' + format);
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic configuration test' });
  raw.codexSessions.enabled = true;
  raw.codexSessions.home = home;
  raw.tunnel.apiKey = PRIVATE_KEY;
  const write = async (value: unknown) => fs.writeFile(configPath, (format === 'toml' ? '# local owner comment\n' : '') + serializeConfig(value, format));
  await write(raw);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  const cli = async (...args: string[]) => {
    const result = await run(process.execPath, [cliPath, ...args, '--config', configPath], { cwd: base, env, windowsHide: true });
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(PRIVATE_KEY + '|SYNTHETIC-INVALID-SECRET'));
    return JSON.parse(result.stdout);
  };
  const failCli = async (args: string[], codes: string[]) => {
    try { await cli(...args); assert.fail('CLI command should reject this configuration or argument'); }
    catch (error) {
      const diagnostic = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(diagnostic.code, 1);
      assert.doesNotMatch((diagnostic.stdout ?? '') + (diagnostic.stderr ?? ''), new RegExp(PRIVATE_KEY + '|SYNTHETIC-INVALID-SECRET'));
      const lines = (diagnostic.stderr ?? '').trim().split(/\r?\n/);
      const parsed = JSON.parse(lines.at(-1)!);
      assert.equal(parsed.ok, false);
      assert.ok(codes.includes(parsed.error.code), JSON.stringify(parsed));
      return parsed.error;
    }
  };
  const readRaw = async () => parseConfigText(await fs.readFile(configPath, 'utf8'), format) as any;
  const worktrees = async () => {
    const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const git = (args: string[]) => run('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], { cwd: root, env: gitEnv, windowsHide: true });
    await fs.writeFile(path.join(root, 'README.md'), 'Synthetic Git fixture.\n');
    await git(['init']);
    await git(['add', 'README.md']);
    await git(['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic fixture']);
    const a = path.join(home, 'worktrees', 'task-a', 'project');
    const b = path.join(home, 'worktrees', 'task-b', 'project');
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.mkdir(path.dirname(b), { recursive: true });
    await git(['worktree', 'add', '-b', 'fixture-a', a]);
    await git(['worktree', 'add', '-b', 'fixture-b', b]);
    return { a, b };
  };
  t.after(async () => {
    const actual = await fs.realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-v06-config-'));
    // Windows may briefly retain a Git worktree directory handle after the
    // awaited fixture process closes. Retry only this verified test directory;
    // a persistent lock still fails cleanup instead of being skipped.
    await fs.rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { base, root, home, raw, configPath, env, write, cli, failCli, readRaw, worktrees };
}

test('Windows CLI writes private configuration without PowerShell module autoload', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'json');
  const modules = path.join(f.base, 'unavailable-powershell-modules');
  const utility = path.join(modules, 'Microsoft.PowerShell.Utility');
  await fs.mkdir(utility, { recursive: true });
  // An inherited module search path can advertise New-Object from a module that
  // Windows PowerShell cannot load. ACL application must not discover modules.
  await fs.writeFile(path.join(utility, 'Microsoft.PowerShell.Utility.psd1'), "@{ RootModule = 'unavailable.psm1'; ModuleVersion = '1.0.0'; FunctionsToExport = @('New-Object') }\n");
  f.env.PSModulePath = modules;
  const system32 = path.join(f.env.SystemRoot ?? f.env.SYSTEMROOT!, 'System32');
  await run(path.join(system32, 'icacls.exe'), [f.configPath, '/grant', '*S-1-1-0:(R)'], { env: f.env, windowsHide: true });
  const saved = await f.cli('execution', 'preset', '--preset', 'node', '--command', process.execPath);
  assert.equal(saved.execution_enabled, false);
  assert.equal((await loadConfig(f.configPath)).tunnel!.apiKey, PRIVATE_KEY);
  const script = `$ErrorActionPreference='Stop';$PSModuleAutoLoadingPreference='None';` +
    `$acl=[System.IO.File]::GetAccessControl('${f.configPath.replace(/'/g, "''")}');` +
    `$expected=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544');$seen=@{};` +
    `if(!$acl.AreAccessRulesProtected){throw 'Configuration inherits access rules'};` +
    `foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){` +
    `if($rule.IdentityReference.Value -notin $expected -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl'){throw 'Configuration has an unexpected access rule'};` +
    `$seen[$rule.IdentityReference.Value]=$true};` +
    `foreach($sid in $expected){if(!$seen.ContainsKey($sid)){throw 'Configuration lacks a required private access rule'}};[Console]::WriteLine('private')`;
  const verified = await run(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: f.env, windowsHide: true, timeout: 10000 });
  assert.equal(verified.stdout.trim(), 'private');
});

for (const format of ['json', 'toml'] as const) {
  test(`CLI --worktree add/rebind persists ${format}, preserves same-root UID, rotates changed-root UID and denies broad Codex-home authorization`, async t => {
    const f = await fixture(t, format);
    const { a, b } = await f.worktrees();
    const added = await f.cli('workspace', 'add', '--id', 'resumed', '--root', a, '--name', 'Resumed task', '--read-only', '--worktree');
    assert.equal(added.restart_required, true);
    const first = await loadConfig(f.configPath);
    const registered = first.workspaces.find(workspace => workspace.id === 'resumed')!;
    assert.equal(registered.root, a);
    assert.equal(registered.readOnly, true);
    assert.match(registered.uid!, /^[a-f0-9-]{36}$/);
    assert.deepEqual(registered.worktree, detectLinkedWorktree(a));
    assert.equal(first.execution.mode, 'disabled');
    assert.equal(first.tunnel!.apiKey, PRIVATE_KEY);
    await f.cli('workspace', 'rebind', '--id', 'resumed', '--root', a, '--name', 'Renamed task', '--worktree');
    const same = await loadConfig(f.configPath);
    assert.equal(same.workspaces.find(workspace => workspace.id === 'resumed')!.uid, registered.uid);
    assert.equal(same.workspaces.find(workspace => workspace.id === 'resumed')!.name, 'Renamed task');
    await f.cli('workspace', 'rebind', '--id', 'resumed', '--root', b, '--worktree');
    const rebound = await loadConfig(f.configPath);
    const replacement = rebound.workspaces.find(workspace => workspace.id === 'resumed')!;
    assert.equal(replacement.root, b);
    assert.notEqual(replacement.uid, registered.uid);
    assert.equal(replacement.readOnly, true);
    assert.deepEqual(replacement.worktree, detectLinkedWorktree(b));
    assert.equal(rebound.device!.id, first.device!.id);
    assert.equal(rebound.workspaces[0].uid, first.workspaces[0].uid);
    const original = await fs.readFile(f.configPath);
    await f.failCli(['workspace', 'add', '--id', 'implicit', '--root', a], ['WORKTREE_AUTHORIZATION_REQUIRED', 'CONFIG_PATH_DENIED', 'PATH_DENIED']);
    await f.failCli(['workspace', 'add', '--id', 'broad-home', '--root', f.home], ['CONFIG_PATH_DENIED', 'PATH_DENIED']);
    await f.failCli(['workspace', 'add', '--id', 'broad-marked', '--root', f.home, '--worktree'], ['WORKTREE_INVALID']);
    await f.failCli(['workspace', 'rebind', '--id', 'resumed', '--root', f.home], ['CONFIG_ERROR', 'CONFIG_PATH_DENIED', 'PATH_DENIED']);
    assert.deepEqual(await fs.readFile(f.configPath), original);
    assert.equal((await f.readRaw()).tunnel.apiKey, PRIVATE_KEY);
    if (format === 'toml') assert.match(original.toString('utf8'), /^# local owner comment/);
    await f.cli('workspace', 'remove', '--id', 'resumed');
    const removed = await loadConfig(f.configPath);
    assert.equal(removed.workspaces.length, 1);
    assert.equal(removed.workspaces[0].id, 'default');
    assert.equal(removed.tunnel!.apiKey, PRIVATE_KEY);
    assert.equal(await fs.readFile(path.join(b, 'README.md'), 'utf8'), 'Synthetic Git fixture.\n');
    await assert.rejects(fs.stat(first.stateDir), { code: 'ENOENT' });
  });

  test(`${format} expands configDir references in worktree roots and Git metadata and rejects mismatched metadata`, async t => {
    const f = await fixture(t, format);
    const { a } = await f.worktrees();
    const authorization = detectLinkedWorktree(a);
    const reference = (absolute: string) => '${configDir}/' + path.relative(f.base, absolute).split(path.sep).join('/');
    const configured = { ...f.raw, workspaces: [{ ...f.raw.workspaces[0], root: reference(a), worktree: { gitDir: reference(authorization.gitDir), commonDir: reference(authorization.commonDir) } }] };
    await f.write(configured);
    const loaded = await loadConfig(f.configPath);
    assert.equal(loaded.workspaces[0].root, a);
    assert.deepEqual(loaded.workspaces[0].worktree, authorization);
    assert.equal((await f.cli('config', 'validate')).ok, true);
    configured.workspaces[0].worktree.commonDir = reference(f.root);
    await f.write(configured);
    await assert.rejects(loadConfig(f.configPath), { code: 'WORKTREE_INVALID' });
  });

  test(`CLI node/npm preset and inspect use ${format} without enabling or executing project commands`, async t => {
    const f = await fixture(t, format);
    const marker = path.join(f.root, 'must-not-execute.txt');
    const npmEntry = path.join(f.base, 'npm-cli.js');
    await fs.writeFile(npmEntry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected execution');`);
    const node = await f.cli('execution', 'preset', '--preset', 'node', '--alias', 'build-node', '--command', process.execPath);
    assert.equal(node.preset, 'node');
    assert.equal(node.execution_enabled, false);
    const npm = await f.cli('execution', 'preset', '--preset', 'npm', '--alias', 'build-npm', '--command', process.execPath, '--entry', npmEntry);
    assert.equal(npm.preset, 'npm');
    assert.equal(npm.execution.mode, 'disabled');
    assert.equal(npm.execution_enabled, false);
    const loaded = await loadConfig(f.configPath);
    assert.deepEqual(executableDefinition(loaded.execution.allowedExecutables['build-node']!), { command: process.execPath, args: [] });
    assert.deepEqual(executableDefinition(loaded.execution.allowedExecutables['build-npm']!), { command: process.execPath, args: [npmEntry] });
    const original = await fs.readFile(f.configPath);
    const inspection = await f.cli('execution', 'inspect');
    assert.equal(inspection.static_check_only, true);
    assert.equal(inspection.ready, false);
    assert.equal(inspection.mode, 'disabled');
    assert.equal(inspection.executables.find((item: any) => item.alias === 'build-npm').entry_file_available, true);
    assert.deepEqual(await fs.readFile(f.configPath), original);
    await f.failCli(['execution', 'preset'], ['CLI_ERROR']);
    await f.failCli(['execution', 'preset', 'node'], ['CLI_ERROR']);
    await f.failCli(['execution', 'preset', '--preset', 'node', '--entry', npmEntry], ['INVALID_ARGUMENT']);
    await f.failCli(['execution', 'preset', '--preset', 'npm', '--command', process.execPath, '--entry', path.join(f.base, 'missing-npm-cli.js')], ['EXECUTION_ENTRY_REQUIRED']);
    assert.deepEqual(await fs.readFile(f.configPath), original);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    await assert.rejects(fs.stat(loaded.stateDir), { code: 'ENOENT' });
    assert.equal((await f.readRaw()).tunnel.apiKey, PRIVATE_KEY);
  });

  test(`${format} loads supported execution.env and CLI validation rejects injection, secrets, invalid values and non-string entries`, async t => {
    const f = await fixture(t, format);
    const env = { CI: 'true', NODE_ENV: 'test', PYTHONUTF8: '1', OMP_NUM_THREADS: '2', CUDA_VISIBLE_DEVICES: '0,1', TZ: 'Asia/Shanghai', LANG: 'C.UTF-8' };
    const configured = { ...f.raw, execution: { ...f.raw.execution, env: env as unknown } };
    await f.write(configured);
    assert.deepEqual((await loadConfig(f.configPath)).execution.env, env);
    const inspected = await f.cli('execution', 'inspect');
    assert.deepEqual(inspected.configured_environment_names, Object.keys(env).sort());
    assert.equal(inspected.mode, 'disabled');
    assert.equal((await f.cli('config', 'validate')).ok, true);
    for (const bad of [
      { NODE_OPTIONS: '--require=SYNTHETIC-INVALID-SECRET' }, { OPENAI_API_KEY: 'SYNTHETIC-INVALID-SECRET' },
      { PATH: 'SYNTHETIC-INVALID-SECRET' }, { PYTHONPATH: 'SYNTHETIC-INVALID-SECRET' }, { NODE_ENV: 'SYNTHETIC-INVALID-SECRET' },
      { CI: true }, { PYTHONUTF8: '2' }, { OMP_NUM_THREADS: '0' }, { TZ: '../../private' }, { CI: 'true\nSYNTHETIC-INVALID-SECRET' },
    ]) {
      configured.execution.env = bad;
      await f.write(configured);
      await assert.rejects(loadConfig(f.configPath), error => {
        assert.equal((error as any).code, 'CONFIG_ERROR');
        assert.doesNotMatch(String(error), /SYNTHETIC-INVALID-SECRET/);
        return true;
      });
    }
    await f.failCli(['config', 'validate'], ['CONFIG_ERROR']);
  });
}
