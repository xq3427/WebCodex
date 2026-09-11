import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, link, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { configureExecutionPreset, inspectExecution } from '../src/execution-admin.js';
import { defaultUnifiedConfig, executableDefinition, loadConfig, validateConfig } from '../src/config.js';
import { publicConfig } from '../src/config-admin.js';
import { executionEnvironment, normalizeExecutionEnvironment, validExecutionEnvironment } from '../src/execution-env.js';
import { JobService } from '../src/jobs.js';
import { WorkspacePaths } from '../src/paths.js';
import { StateStore } from '../src/store.js';
import type { ServiceContext } from '../src/types.js';

async function fixture(t: TestContext) {
  const temp = await mkdtemp(path.join(await realpath(tmpdir()), 'webcodex-execution-env-'));
  const root = path.join(temp, 'project');
  await mkdir(root);
  const configPath = path.join(temp, 'config.json');
  const raw = defaultUnifiedConfig(root, configPath);
  await writeFile(configPath, JSON.stringify(raw, null, 2));
  t.after(async () => { assert.ok(path.basename(temp).startsWith('webcodex-execution-env-')); await rm(temp, { recursive: true, force: true }); });
  return { temp, root, raw, configPath };
}

async function ended(jobs: JobService, id: string) {
  for (let i = 0; i < 1000; i++) {
    const result = jobs.poll({ workspace_id: 'default', job_id: id });
    if (!['queued', 'running'].includes(result.status)) return result;
    await delay(10);
  }
  throw new Error('Synthetic job did not finish within 10 seconds.');
}

test('execution env validates both variable names and bounded values without echoing invalid data', async t => {
  const f = await fixture(t);
  const accepted = { CI: 'true', NODE_ENV: 'test', PYTHONUTF8: '1', NO_COLOR: '1', OMP_NUM_THREADS: '2', CUDA_VISIBLE_DEVICES: '0,1', TZ: 'Asia/Shanghai', LANG: 'C.UTF-8' };
  assert.equal(validExecutionEnvironment(accepted), true);
  assert.deepEqual(normalizeExecutionEnvironment(accepted), accepted);
  const validated = await validateConfig({ ...f.raw, execution: { ...f.raw.execution, env: accepted } }, f.configPath);
  assert.deepEqual(validated.execution.env, accepted);
  for (const name of ['PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NPM_CONFIG_USERCONFIG', 'CUSTOM_SECRET', 'TOKEN', 'password', 'node_env']) {
    const input = { [name]: 'synthetic-secret-do-not-print' };
    assert.equal(validExecutionEnvironment(input), false);
    assert.throws(() => normalizeExecutionEnvironment(input), error => {
      assert.equal((error as { code: string }).code, 'INVALID_EXECUTION_ENV');
      assert.equal(String(error).includes('synthetic-secret-do-not-print'), false);
      return true;
    });
    await assert.rejects(validateConfig({ ...f.raw, execution: { ...f.raw.execution, env: input } }, f.configPath), { code: 'CONFIG_ERROR' });
  }
  for (const input of [{ CI: 'true\nAPI_KEY=bad' }, { CI: 'anything' }, { NODE_ENV: 'x'.repeat(257) }, { PYTHONUTF8: '2' }, { OMP_NUM_THREADS: '0' }, { TZ: '../../private' }, { LANG: '$HOME' }]) assert.equal(validExecutionEnvironment(input), false);
  assert.equal(validExecutionEnvironment(Object.assign(Object.create({ CI: 'true' }), { NODE_ENV: 'test' })), false);
});

test('Windows lifecycle scripts receive the system shell without inheriting a parent shell override', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const prior = process.env.ComSpec;
  let env: NodeJS.ProcessEnv;
  try {
    process.env.ComSpec = path.join(f.root, 'untrusted-shell.exe');
    env = executionEnvironment(undefined, process.execPath);
  } finally {
    if (prior === undefined) delete process.env.ComSpec; else process.env.ComSpec = prior;
  }
  assert.ok(env.ComSpec && path.isAbsolute(env.ComSpec));
  assert.notEqual(env.ComSpec, path.join(f.root, 'untrusted-shell.exe'));
  assert.throws(() => normalizeExecutionEnvironment({ ComSpec: 'cmd.exe' }), { code: 'INVALID_EXECUTION_ENV' });
  const result = await promisify(execFile)(env.ComSpec, ['/d', '/c', 'echo WEBCODEX_SYSTEM_SHELL'], { cwd: f.root, env, windowsHide: true });
  assert.equal(result.stdout.trim(), 'WEBCODEX_SYSTEM_SHELL');
});

test('execution inspection is static and does not expose prefix arguments, secrets or create runtime state', async t => {
  const f = await fixture(t);
  const config = await loadConfig(f.configPath);
  const marker = path.join(f.root, 'must-not-run');
  config.execution.allowedExecutables.wouldRun = { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`, 'synthetic-hidden-prefix'] };
  config.execution.allowedExecutables.missing = { command: path.join(f.temp, 'missing.exe'), args: [] };
  config.execution.allowedExecutables.missingEntry = { command: process.execPath, args: [path.join(f.temp, 'missing-entry.js')] };
  config.execution.env = { NODE_ENV: 'test' };
  config.tunnel!.apiKey = 'synthetic-hidden-key';
  const inspected = await inspectExecution(config);
  assert.equal(inspected.static_check_only, true);
  assert.equal(inspected.ready, false);
  assert.equal(inspected.executables.find(item => item.alias === 'node')!.available, true);
  assert.equal(inspected.executables.find(item => item.alias === 'missing')!.status, 'missing');
  assert.equal(inspected.executables.find(item => item.alias === 'missingEntry')!.status, 'entry_missing');
  assert.deepEqual(inspected.configured_environment_names, ['NODE_ENV']);
  assert.equal(JSON.stringify(inspected).includes('synthetic-hidden'), false);
  assert.equal(JSON.stringify(publicConfig(config)).includes('synthetic-hidden'), false);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  await assert.rejects(stat(config.stateDir), { code: 'ENOENT' });
});

test('presets register native entry points without enabling execution or opening state', async t => {
  const f = await fixture(t);
  const added = await configureExecutionPreset(f.configPath, { preset: 'node', alias: 'build-node', command: process.execPath });
  assert.equal(added.execution.mode, 'disabled');
  assert.equal(added.restart_required, true);
  const config = await loadConfig(f.configPath);
  assert.equal(executableDefinition(config.execution.allowedExecutables['build-node']!).command, process.execPath);
  await configureExecutionPreset(f.configPath, { preset: 'node', alias: 'build-node', command: process.execPath });
  await assert.rejects(configureExecutionPreset(f.configPath, { preset: 'node', command: 'node.cmd' }), { code: 'EXECUTION_PROGRAM_REQUIRED' });
  await assert.rejects(configureExecutionPreset(f.configPath, { preset: 'npm', entry: path.join(f.temp, 'npm.cmd') }), { code: 'EXECUTION_ENTRY_REQUIRED' });
  await assert.rejects(configureExecutionPreset(f.configPath, { preset: 'venv' }), { code: 'EXECUTION_PREFIX_REQUIRED' });
  await assert.rejects(configureExecutionPreset(f.configPath, { preset: 'conda', prefix: f.root }), { code: 'EXECUTION_PREFIX_REQUIRED' });
  await assert.rejects(configureExecutionPreset(f.configPath, { preset: 'node', prefix: f.root }), { code: 'INVALID_ARGUMENT' });
  assert.equal((await loadConfig(f.configPath)).execution.mode, 'disabled');
  await assert.rejects(stat(config.stateDir), { code: 'ENOENT' });
});

test('venv and conda prefixes select environment interpreters directly and never run activation files', async t => {
  const f = await fixture(t);
  const venv = path.join(f.temp, 'venv');
  const conda = path.join(f.temp, 'conda');
  const venvProgram = path.join(venv, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const condaProgram = path.join(conda, ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python']));
  await Promise.all([mkdir(path.dirname(venvProgram), { recursive: true }), mkdir(path.dirname(condaProgram), { recursive: true }), mkdir(path.join(conda, 'conda-meta'), { recursive: true })]);
  // A native executable stands in for interpreter metadata; static preset registration never launches it.
  await copyFile(process.execPath, venvProgram);
  await link(venvProgram, condaProgram);
  await writeFile(path.join(venv, 'pyvenv.cfg'), 'home = synthetic\n');
  await writeFile(path.join(venv, 'activate'), 'This activation file must never be evaluated.');
  await configureExecutionPreset(f.configPath, { preset: 'venv', prefix: venv });
  await configureExecutionPreset(f.configPath, { preset: 'conda', prefix: conda });
  const config = await loadConfig(f.configPath);
  assert.deepEqual(executableDefinition(config.execution.allowedExecutables.venv!), { command: venvProgram, args: [] });
  assert.deepEqual(executableDefinition(config.execution.allowedExecutables.conda!), { command: condaProgram, args: [] });
  assert.equal(config.execution.mode, 'disabled');
  await assert.rejects(stat(config.stateDir), { code: 'ENOENT' });
});

test('Python discovery requires an explicit choice for separate environment prefixes', async t => {
  const f = await fixture(t);
  const firstBin = path.join(f.temp, 'first-environment', 'bin');
  const secondBin = path.join(f.temp, 'second-environment', 'bin');
  await Promise.all([mkdir(firstBin, { recursive: true }), mkdir(secondBin, { recursive: true })]);
  const name = process.platform === 'win32' ? 'python.exe' : 'python3';
  const firstEntry = path.join(firstBin, name);
  const secondEntry = path.join(secondBin, name);
  await copyFile(process.execPath, firstEntry);
  await link(firstEntry, secondEntry);
  assert.equal((await stat(firstEntry, { bigint: true })).ino, (await stat(secondEntry, { bigint: true })).ino);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = [firstBin, secondBin].join(path.delimiter);
    const unchanged = await readFile(f.configPath);
    await assert.rejects(configureExecutionPreset(f.configPath, { preset: 'python' }), { code: 'EXECUTION_PROGRAM_REQUIRED' });
    assert.deepEqual(await readFile(f.configPath), unchanged);
    await configureExecutionPreset(f.configPath, { preset: 'python', alias: 'chosen-python', command: secondEntry });
    const config = await loadConfig(f.configPath);
    assert.equal(executableDefinition(config.execution.allowedExecutables['chosen-python']!).command, secondEntry);
    assert.equal(config.execution.mode, 'disabled');
    await assert.rejects(stat(config.stateDir), { code: 'ENOENT' });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test('Python discovery keeps file symlink environments distinct when they share one base executable', async t => {
  const f = await fixture(t);
  const firstBin = path.join(f.temp, 'environment-one', 'bin');
  const secondBin = path.join(f.temp, 'environment-two', 'bin');
  await Promise.all([mkdir(firstBin, { recursive: true }), mkdir(secondBin, { recursive: true })]);
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  const firstEntry = path.join(firstBin, names[0]);
  const secondEntry = path.join(secondBin, names[0]);
  try {
    await symlink(process.execPath, firstEntry, 'file');
    await symlink(process.execPath, path.join(firstBin, names[1]), 'file');
    await symlink(process.execPath, secondEntry, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      const message = 'File symlink coverage requires Windows Developer Mode or the symlink privilege. Re-run from an administrator PowerShell or a Windows environment with Developer Mode enabled; this test does not change system settings.';
      if (process.env.WEBCODEX_REQUIRE_FILE_SYMLINK_TESTS === '1') throw new Error(message, { cause: error });
      t.skip(message); return;
    }
    throw error;
  }
  assert.equal(await realpath(firstEntry), await realpath(secondEntry));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = [firstBin, secondBin].join(path.delimiter);
    const unchanged = await readFile(f.configPath);
    await assert.rejects(configureExecutionPreset(f.configPath, { preset: 'python' }), { code: 'EXECUTION_PROGRAM_REQUIRED' });
    assert.deepEqual(await readFile(f.configPath), unchanged);
    await configureExecutionPreset(f.configPath, { preset: 'python', alias: 'selected-environment', command: secondEntry });
    const explicit = await loadConfig(f.configPath);
    assert.equal(executableDefinition(explicit.execution.allowedExecutables['selected-environment']!).command, secondEntry);
    process.env.PATH = [firstBin, firstBin].join(path.delimiter);
    await configureExecutionPreset(f.configPath, { preset: 'python', alias: 'discovered-environment' });
    const discovered = await loadConfig(f.configPath);
    assert.equal(executableDefinition(discovered.execution.allowedExecutables['discovered-environment']!).command, firstEntry);
    assert.equal(discovered.execution.mode, 'disabled');
    await assert.rejects(stat(discovered.stateDir), { code: 'ENOENT' });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test('real npm-cli build and test close the execution loop with configured env and real failure exit codes', async t => {
  const f = await fixture(t);
  await configureExecutionPreset(f.configPath, { preset: 'npm' });
  const config = await loadConfig(f.configPath);
  config.execution.env = { CI: 'true', NODE_ENV: 'test', PYTHONUTF8: '1', OMP_NUM_THREADS: '2' };
  const secretNames = ['OPENAI_API_KEY', 'MCP_TUNNEL_TOKEN', 'WEBCODEX_HTTP_TOKEN', 'HTTP_PROXY', 'PYTHONPATH', 'NODE_OPTIONS'];
  const prior = Object.fromEntries(secretNames.map(name => [name, process.env[name]]));
  try {
    for (const name of secretNames) process.env[name] = name === 'NODE_OPTIONS' ? '--require=synthetic-missing-injection' : 'synthetic-parent-secret';
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'synthetic-webcodex-execution', version: '1.0.0', private: true, scripts: { build: 'node build.cjs', test: 'node verify.cjs', fail: 'node fail.cjs' } }));
    await writeFile(path.join(f.root, 'build.cjs'), "const fs=require('node:fs');fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/result.json',JSON.stringify({answer:42}));console.log('BUILD_COMPLETE');");
    await writeFile(path.join(f.root, 'verify.cjs'), `const assert=require('node:assert/strict');const fs=require('node:fs');assert.equal(JSON.parse(fs.readFileSync('out/result.json')).answer,42);assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.PYTHONUTF8,'1');assert.equal(process.env.OMP_NUM_THREADS,'2');for(const key of ${JSON.stringify(secretNames)})assert.equal(process.env[key],undefined);console.log('TEST_COMPLETE');`);
    await writeFile(path.join(f.root, 'fail.cjs'), "process.stderr.write('EXPECTED_TEST_FAILURE');process.exitCode=7;");
    const store = new StateStore(config.stateDir);
    const ctx: ServiceContext = { config, store, paths: new WorkspacePaths(config) };
    const jobs = new JobService(ctx);
    try {
      await assert.rejects(jobs.start({ workspace_id: 'default', executable: 'npm', args: ['run', 'build'], idempotency_key: 'disabled-build' }), { code: 'EXECUTION_DISABLED' });
      config.execution.mode = 'trusted-host'; // Isolated in-memory fixture only; the user's configuration stays disabled.
      for (const [script, marker] of [['build', 'BUILD_COMPLETE'], ['test', 'TEST_COMPLETE']] as const) {
        const job = await jobs.start({ workspace_id: 'default', executable: 'npm', args: ['run', script], idempotency_key: script });
        const result = await ended(jobs, job.job_id);
        assert.equal(result.status, 'succeeded', result.output.map(c => c.text).join(''));
        assert.equal(result.exit_code, 0);
        assert.ok(result.output.some(chunk => chunk.text.includes(marker)));
        assert.equal(JSON.stringify(result).includes('synthetic-parent-secret'), false);
      }
      assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'out', 'result.json'), 'utf8')), { answer: 42 });
      const failed = await jobs.start({ workspace_id: 'default', executable: 'npm', args: ['run', 'fail'], idempotency_key: 'fail' });
      const result = await ended(jobs, failed.job_id);
      assert.equal(result.status, 'failed');
      assert.equal(result.exit_code, 7);
      assert.ok(result.output.some(chunk => chunk.stream === 'stderr' && chunk.text.includes('EXPECTED_TEST_FAILURE')));
      const before = jobs.list({ workspace_id: 'default' }).jobs.length;
      config.execution.env = { NODE_OPTIONS: '--require=synthetic-secret' };
      await assert.rejects(jobs.start({ workspace_id: 'default', executable: 'npm', args: ['run', 'build'], idempotency_key: 'build' }), { code: 'INVALID_EXECUTION_ENV' });
      assert.equal(jobs.list({ workspace_id: 'default' }).jobs.length, before);
    } finally { await jobs.close(); store.close(); }
  } finally {
    for (const name of secretNames) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; }
  }
  assert.equal((await loadConfig(f.configPath)).execution.mode, 'disabled');
});
