import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { defaultConfig } from '../src/config.js';
import { effectiveWorkspaceExecution, publicWorkspaceExecution } from '../src/execution-profiles.js';
import { initializeIdentity } from '../src/identity.js';
import { JobService } from '../src/jobs.js';
import { WorkspacePaths } from '../src/paths.js';
import { canonical, StateStore } from '../src/store.js';
import type { AppConfig, ServiceContext } from '../src/types.js';

const REPORT = "console.log(JSON.stringify({marker:process.argv[1],node:process.env.NODE_ENV??null,ci:process.env.CI??null,cwd:process.cwd()}))";
const program = (marker: string) => ({ command: process.execPath, args: ['-e', REPORT, '--', marker] });

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-profiles-'));
  const roots = ['项目 A', '项目 B', 'global', 'readonly'].map(name => path.join(base, name));
  await Promise.all(roots.map(root => mkdir(root)));
  const configPath = path.join(base, 'config.json');
  const defaults = defaultConfig(roots[0], configPath);
  const config: AppConfig = {
    ...defaults, version: 2, device: { id: randomUUID(), name: 'Execution profiles fixture' }, configPath,
    workspaces: roots.map((root, index) => ({ id: ['a', 'b', 'global', 'readonly'][index], uid: randomUUID(), name: path.basename(root), root, readOnly: index === 3, ...(index !== 2 ? { executionProfile: index === 1 ? 'b' : 'a' } : {}) })),
    execution: {
      ...defaults.execution, mode: 'trusted-host', maxConcurrent: 4, maxTimeoutMs: 10000, defaultTimeoutMs: 10000,
      allowedExecutables: { run: program('global'), global_only: process.execPath, node: process.execPath },
      env: { NODE_ENV: 'development', CI: 'false' },
      profiles: {
        a: { allowedExecutables: { run: program('A'), a_only: process.execPath, node: process.execPath }, env: { NODE_ENV: 'test' } },
        b: { allowedExecutables: { run: program('B'), node: process.execPath }, env: { NODE_ENV: 'production', CI: 'true' } },
      },
    },
  };
  let store = new StateStore(config.stateDir, { expectedDeviceId: config.device!.id });
  let ctx: ServiceContext = { config, store, paths: new WorkspacePaths(config) };
  let jobs = new JobService(ctx);
  const restart = async () => {
    await jobs.close(); store.close();
    store = new StateStore(config.stateDir, { expectedDeviceId: config.device!.id });
    ctx = { config, store, paths: new WorkspacePaths(config) };
    jobs = new JobService(ctx);
  };
  t.after(async () => {
    try { await jobs.close(); } finally { store.close(); }
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-profiles-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { base, roots, config, get ctx() { return ctx; }, get jobs() { return jobs; }, get store() { return store; }, restart };
}

async function ended(jobs: JobService, workspaceId: string, jobId: string) {
  let cursor = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await jobs.wait({ workspace_id: workspaceId, job_id: jobId, cursor, wait_ms: 200 });
    cursor = result.next_cursor;
    if (result.terminal) return jobs.poll({ workspace_id: workspaceId, job_id: jobId });
  }
  throw new Error('Fixture command did not terminate.');
}

test('effective execution profiles replace globals and public summaries omit argument/environment values', async t => {
  const f = await fixture(t);
  const a = effectiveWorkspaceExecution(f.config, 'a');
  assert.equal(a.profile, 'a');
  assert.equal(a.allowedExecutables.global_only, undefined);
  assert.deepEqual(a.env, { NODE_ENV: 'test' });
  a.env.NODE_ENV = 'production';
  (a.allowedExecutables.run as { args: string[] }).args.push('unexpected');
  assert.deepEqual(f.config.execution.profiles!.a!.env, { NODE_ENV: 'test' });
  assert.deepEqual(f.config.execution.profiles!.a!.allowedExecutables.run, program('A'));
  const summary = publicWorkspaceExecution(f.config, 'b');
  assert.equal(summary.profile, 'b');
  assert.deepEqual(summary.configured_environment_names, ['CI', 'NODE_ENV']);
  assert.equal(summary.executables.find(item => item.alias === 'run')!.prefix_arg_count, 4);
  assert.ok(!JSON.stringify(summary).includes(REPORT));
  assert.ok(!JSON.stringify(summary).includes('production'));
  assert.equal(effectiveWorkspaceExecution(f.config, 'global').profile, null);
  assert.throws(() => effectiveWorkspaceExecution(f.config, 'unknown'), { code: 'WORKSPACE_NOT_FOUND' });
  f.config.workspaces[0].executionProfile = 'missing';
  assert.throws(() => effectiveWorkspaceExecution(f.config, 'a'), { code: 'EXECUTION_PROFILE_NOT_FOUND' });
});

test('real profile programs, env and cwd remain isolated across workspaces sharing an operation key', async t => {
  const f = await fixture(t);
  const jobs = await Promise.all(['a', 'b', 'global'].map(workspace_id => f.jobs.start({ workspace_id, executable: 'run', idempotency_key: 'same-key' })));
  const results = await Promise.all(jobs.map((job, index) => ended(f.jobs, ['a', 'b', 'global'][index], job.job_id)));
  assert.equal(new Set(jobs.map(job => job.job_id)).size, 3);
  const expected = [
    { marker: 'A', node: 'test', ci: null, cwd: f.roots[0] },
    { marker: 'B', node: 'production', ci: 'true', cwd: f.roots[1] },
    { marker: 'global', node: 'development', ci: 'false', cwd: f.roots[2] },
  ];
  for (const [index, result] of results.entries()) {
    assert.equal(result.exit_code, 0);
    assert.deepEqual(JSON.parse(result.output.map(chunk => chunk.text).join('')), expected[index]);
    assert.equal(result.execution_profile, ['a', 'b', null][index]);
    assert.match(result.execution_context_sha256!, /^[a-f0-9]{64}$/);
  }
  await assert.rejects(f.jobs.start({ workspace_id: 'a', executable: 'global_only', idempotency_key: 'global-denied' }), { code: 'EXECUTABLE_NOT_ALLOWED' });
  await assert.rejects(f.jobs.start({ workspace_id: 'b', executable: 'a_only', idempotency_key: 'a-denied' }), { code: 'EXECUTABLE_NOT_ALLOWED' });
  const stored = JSON.stringify(f.store.db.prepare('SELECT details FROM audit_events').all());
  assert.ok(!stored.includes('production'));
  assert.ok(!stored.includes('development'));
});

test('profiles do not override global execution disablement, read-only policy, timeouts or concurrency', async t => {
  const f = await fixture(t);
  const input = { workspace_id: 'a', executable: 'node', args: ['-e', 'process.stdin.resume()'], stdin: 'pipe' as const, idempotency_key: 'guarded' };
  f.config.execution.mode = 'disabled';
  await assert.rejects(f.jobs.start(input), { code: 'EXECUTION_DISABLED' });
  f.config.execution.mode = 'trusted-host';
  await assert.rejects(f.jobs.start({ ...input, workspace_id: 'readonly' }), { code: 'READ_ONLY' });
  await assert.rejects(f.jobs.start({ ...input, timeout_ms: 10001 }), { code: 'INVALID_ARGUMENT' });
  f.config.execution.maxConcurrent = 1;
  const job = await f.jobs.start(input);
  await assert.rejects(f.jobs.start({ ...input, workspace_id: 'b' }), { code: 'CONCURRENCY_LIMIT' });
  await f.jobs.writeStdin({ workspace_id: 'a', job_id: job.job_id, end: true, idempotency_key: 'end' });
  assert.equal((await ended(f.jobs, 'a', job.job_id)).exit_code, 0);
});

test('new start receipts bind profile name, command, fixed args and effective environment across restarts', async t => {
  const f = await fixture(t);
  const input = { workspace_id: 'a', executable: 'run', idempotency_key: 'bound-start' };
  const job = await f.jobs.start(input);
  await ended(f.jobs, 'a', job.job_id);
  assert.equal((await f.jobs.start(input)).job_id, job.job_id);
  const original = structuredClone(f.config.execution.profiles!.a!);
  for (const change of [
    () => { f.config.execution.profiles!.a!.env = { NODE_ENV: 'production' }; },
    () => { f.config.execution.profiles!.a!.allowedExecutables.run = program('changed'); },
    () => { f.config.execution.profiles!.a!.allowedExecutables.run = { command: path.join(f.base, 'different-native-program'), args: program('A').args }; },
    () => { f.config.execution.profiles!.copy = structuredClone(original); f.config.workspaces[0].executionProfile = 'copy'; },
  ]) {
    change();
    await assert.rejects(f.jobs.start(input), { code: 'IDEMPOTENCY_CONFLICT' });
    f.config.execution.profiles!.a = structuredClone(original);
    f.config.workspaces[0].executionProfile = 'a';
  }
  await f.restart();
  assert.equal((await f.jobs.start(input)).job_id, job.job_id);
  assert.equal(f.jobs.list({ workspace_id: 'a' }).jobs.length, 1);
  const globalInput = { workspace_id: 'global', executable: 'run', idempotency_key: 'bound-global' };
  const global = await f.jobs.start(globalInput);
  await ended(f.jobs, 'global', global.job_id);
  f.config.execution.env = { NODE_ENV: 'test', CI: 'false' };
  await assert.rejects(f.jobs.start(globalInput), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('stdin rechecks profile authorization on cached retries and before new bytes are delivered', async t => {
  const f = await fixture(t);
  const job = await f.jobs.start({ workspace_id: 'a', executable: 'node', args: ['-e', "let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>console.log(text))"], stdin: 'pipe', idempotency_key: 'pipe' });
  const first = { workspace_id: 'a', job_id: job.job_id, content: 'once', idempotency_key: 'input' };
  const receipt = await f.jobs.writeStdin(first);
  f.config.workspaces[0].executionProfile = 'b';
  await assert.rejects(f.jobs.writeStdin(first), { code: 'EXECUTION_PROFILE_CHANGED' });
  await assert.rejects(f.jobs.writeStdin({ ...first, idempotency_key: 'different-key' }), { code: 'EXECUTION_PROFILE_CHANGED' });
  f.config.workspaces[0].executionProfile = 'a';
  delete f.config.execution.profiles!.a!.allowedExecutables.node;
  await assert.rejects(f.jobs.writeStdin(first), { code: 'EXECUTABLE_NOT_ALLOWED' });
  f.config.execution.profiles!.a!.allowedExecutables.node = process.execPath;
  await assert.rejects(f.jobs.writeStdin({ ...first, workspace_id: 'b' }), { code: 'JOB_NOT_FOUND' });
  f.config.execution.mode = 'disabled';
  await assert.rejects(f.jobs.writeStdin(first), { code: 'EXECUTION_DISABLED' });
  f.config.execution.mode = 'trusted-host';
  f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.jobs.writeStdin(first), { code: 'READ_ONLY' });
  f.config.workspaces[0].readOnly = false;
  assert.deepEqual(await f.jobs.writeStdin(first), receipt);
  await f.jobs.writeStdin({ workspace_id: 'a', job_id: job.job_id, end: true, idempotency_key: 'eof' });
  const result = await ended(f.jobs, 'a', job.job_id);
  assert.equal(result.stdin.bytes_attempted, 4);
  assert.equal(result.output.map(chunk => chunk.text).join('').trim(), 'once');
});

test('pre-profile global receipts remain readable but cannot be reinterpreted as a profile launch', async t => {
  const f = await fixture(t);
  const input = { workspace_id: 'global', executable: 'run', idempotency_key: 'legacy-start' };
  const job = await f.jobs.start(input);
  await ended(f.jobs, 'global', job.job_id);
  const binding = initializeIdentity(f.ctx).workspaceIdentity('global');
  const legacy = { workspace_id: 'global', executable: 'run', args: [], cwd: '.', timeout_ms: 10000 };
  const digest = createHash('sha256').update(canonical(legacy)).digest('hex');
  f.store.db.prepare('UPDATE operations SET digest=? WHERE scope=? AND op_key=?').run(digest, 'workspace:' + binding + '/exec_start', input.idempotency_key);
  f.store.db.prepare('UPDATE webcodex_jobs SET execution_profile=NULL,execution_context_sha256=NULL WHERE job_id=?').run(job.job_id);
  f.config.execution.allowedExecutables.run = program('different current config');
  await f.restart();
  const replay = await f.jobs.start(input);
  assert.equal(replay.job_id, job.job_id);
  assert.equal(replay.execution_context_sha256, null);
  assert.equal(f.jobs.list({ workspace_id: 'global' }).jobs.length, 1);
  f.config.workspaces[2].executionProfile = 'a';
  await assert.rejects(f.jobs.start(input), { code: 'IDEMPOTENCY_CONFLICT' });
  delete f.config.workspaces[2].executionProfile;
  f.store.db.prepare("UPDATE operations SET status='pending',result=NULL WHERE scope=? AND op_key=?").run('workspace:' + binding + '/exec_start', input.idempotency_key);
  await f.restart();
  await assert.rejects(f.jobs.start(input), { code: 'EXECUTION_UNKNOWN' });
  assert.equal(f.jobs.list({ workspace_id: 'global' }).jobs.length, 1);
});

test('start detects profile edits during awaited path authorization before launching or returning a cached job', async t => {
  const f = await fixture(t);
  const input = { workspace_id: 'a', executable: 'run', idempotency_key: 'cached-job' };
  const job = await f.jobs.start(input);
  await ended(f.jobs, 'a', job.job_id);
  const resolve = f.ctx.paths.resolve.bind(f.ctx.paths);
  for (const idempotency_key of ['new-job', input.idempotency_key]) {
    f.config.execution.profiles!.a!.env = { NODE_ENV: 'test' };
    f.ctx.paths.resolve = async (...args) => {
      const resolved = await resolve(...args);
      f.config.execution.profiles!.a!.env = { NODE_ENV: 'production' };
      return resolved;
    };
    await assert.rejects(f.jobs.start({ ...input, idempotency_key }), { code: 'EXECUTION_PROFILE_CHANGED' });
    f.ctx.paths.resolve = resolve;
  }
  assert.equal(f.jobs.list({ workspace_id: 'a' }).jobs.length, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE op_key='new-job'").get()!.n, 0);
});

test('old global stdin receipts remain deduplicated across upgrade without reattaching a process', async t => {
  const f = await fixture(t);
  const job = await f.jobs.start({ workspace_id: 'global', executable: 'node', args: ['-e', "let n=0;process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>console.log(n))"], stdin: 'pipe', idempotency_key: 'legacy-pipe' });
  const input = { workspace_id: 'global', job_id: job.job_id, content: 'exactly once', end: true, idempotency_key: 'legacy-input' };
  const receipt = await f.jobs.writeStdin(input);
  await ended(f.jobs, 'global', job.job_id);
  const binding = initializeIdentity(f.ctx).workspaceIdentity('global');
  const legacy = { job_id: job.job_id, content: input.content, end: true };
  f.store.db.prepare('UPDATE operations SET digest=? WHERE scope=? AND op_key=?').run(createHash('sha256').update(canonical(legacy)).digest('hex'), 'workspace:' + binding + '/exec_write_stdin', input.idempotency_key);
  f.store.db.prepare('UPDATE webcodex_jobs SET execution_profile=NULL,execution_context_sha256=NULL WHERE job_id=?').run(job.job_id);
  await f.restart();
  assert.deepEqual(await f.jobs.writeStdin(input), receipt);
  await assert.rejects(f.jobs.writeStdin({ ...input, idempotency_key: 'new-input' }), { code: 'JOB_NOT_WRITABLE' });
  assert.equal(f.jobs.poll({ workspace_id: 'global', job_id: job.job_id }).stdin.bytes_attempted, Buffer.byteLength(input.content));
  f.config.workspaces[2].executionProfile = 'a';
  await assert.rejects(f.jobs.writeStdin(input), { code: 'EXECUTION_PROFILE_CHANGED' });
});
