import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '../src/config.js';
import { WorkspacePaths } from '../src/paths.js';
import { StateStore } from '../src/store.js';
import { JobService } from '../src/jobs.js';
import { initializeIdentity } from '../src/identity.js';
import type { AppConfig, ServiceContext } from '../src/types.js';

async function fixture(t: TestContext, overrides: Partial<AppConfig['execution']> = {}) {
  const temp = await mkdtemp(path.join(await realpath(tmpdir()), 'webcodex-jobs-'));
  const workspace = path.join(temp, 'workspace');
  const workspace2 = path.join(temp, 'workspace2');
  await Promise.all([mkdir(workspace), mkdir(workspace2)]);
  const configPath = path.join(temp, 'config.json');
  const defaults = defaultConfig(await realpath(workspace), configPath);
  const config: AppConfig = {
    ...defaults, configPath,
    workspaces: [...defaults.workspaces, { id: 'other', name: 'Other', root: await realpath(workspace2), readOnly: false }],
    execution: { ...defaults.execution, mode: 'trusted-host', maxTimeoutMs: 10_000, ...overrides },
  };
  const store = new StateStore(config.stateDir);
  const ctx: ServiceContext = { config, store, paths: new WorkspacePaths(config) };
  const jobs = new JobService(ctx);
  t.after(async () => {
    try { await jobs.close(); }
    finally { store.close(); await rm(temp, { recursive: true, force: true }); }
  });
  return { jobs, ctx, store, temp };
}

async function ended(jobs: JobService, jobId: string) {
  for (let i = 0; i < 500; i++) {
    const result = jobs.poll({ workspace_id: 'default', job_id: jobId });
    if (!['queued', 'running'].includes(result.status)) return result;
    await delay(10);
  }
  throw new Error('Job did not finish within 5 seconds.');
}

async function ready(jobs: JobService, jobId: string, marker: string) {
  for (let i = 0; i < 500; i++) {
    const result = jobs.poll({ workspace_id: 'default', job_id: jobId });
    const text = result.output.map(chunk => chunk.text).join('');
    if (text.includes(marker)) return text;
    if (!['queued', 'running'].includes(result.status)) throw new Error(`Job ended before ${marker}: ${text}`);
    await delay(10);
  }
  throw new Error(`Job did not produce ${marker} within 5 seconds.`);
}

test('execution is disabled by default, and aliases never act as arbitrary paths or shell wrappers', async t => {
  const { jobs, ctx } = await fixture(t, { mode: 'disabled' });
  const args = { workspace_id: 'default', executable: 'node', args: ['-e', 'process.exit(0)'], idempotency_key: 'disabled' };
  await assert.rejects(jobs.start(args), { code: 'EXECUTION_DISABLED' });
  ctx.config.execution.mode = 'trusted-host';
  await assert.rejects(jobs.start({ ...args, executable: process.execPath }), { code: 'EXECUTABLE_NOT_ALLOWED' });
  ctx.config.execution.allowedExecutables.wrapper = path.join(path.dirname(process.execPath), 'npm.cmd');
  await assert.rejects(jobs.start({ ...args, executable: 'wrapper' }), { code: 'INVALID_EXECUTABLE' });
  assert.equal(jobs.list({ workspace_id: 'default' }).jobs.length, 0);
});

test('jobs preserve real exit codes, stderr labels, and persist stdout after completion', async t => {
  const { jobs } = await fixture(t);
  const job = await jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', "process.stdout.write('hello');process.stderr.write('problem');process.exitCode=7"], idempotency_key: 'exit-seven' });
  const result = await ended(jobs, job.job_id);
  assert.equal(result.status, 'failed');
  assert.equal(result.exit_code, 7);
  assert.equal(result.output.filter(c => c.stream === 'stdout').map(c => c.text).join(''), 'hello');
  assert.equal(result.output.filter(c => c.stream === 'stderr').map(c => c.text).join(''), 'problem');
  assert.ok(result.ended_at);
  assert.equal(jobs.poll({ workspace_id: 'default', job_id: job.job_id, cursor: result.next_cursor }).output.length, 0);
});

test('configured argument prefixes precede caller args, are audited, and alias edits reject conflicting new receipts', async t => {
  const { jobs, ctx, store } = await fixture(t);
  const prefix = ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', '固定参数'];
  ctx.config.execution.allowedExecutables.prefixed = { command: process.execPath, args: prefix };
  const input = { workspace_id: 'default', executable: 'prefixed', args: ['user argument', '--flag'], idempotency_key: 'fixed-prefix' };
  const first = await jobs.start(input);
  const result = await ended(jobs, first.job_id);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(JSON.parse(result.output.map(c => c.text).join('')), ['固定参数', ...input.args]);
  assert.deepEqual(result.args, [...prefix, ...input.args]);
  const record = store.db.prepare("SELECT details FROM audit_events WHERE event='exec.start'").get()!;
  const details = JSON.parse(String(record.details));
  assert.equal(details.executable, 'prefixed');
  assert.equal(details.command, process.execPath);
  assert.deepEqual(details.args, result.args);
  assert.equal(Object.hasOwn(details, 'env'), false);
  ctx.config.execution.allowedExecutables.prefixed = { command: process.execPath, args: ['-e', "process.stdout.write('changed')", '--'] };
  await assert.rejects(jobs.start(input), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(jobs.list({ workspace_id: 'default' }).jobs.length, 1);
  await assert.rejects(jobs.start({ ...input, args: ['different'] }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('UTF-8 output survives split writes and incremental byte pagination without duplicates', async t => {
  const { jobs } = await fixture(t);
  const text = 'A你好😀Z';
  const code = `const b=Buffer.from(${JSON.stringify(text)});let i=0;const timer=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(timer)},2)`;
  const job = await jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', code], idempotency_key: 'utf8' });
  await ended(jobs, job.job_id);
  let cursor = 0;
  let output = '';
  for (let i = 0; i < 20; i++) {
    const result = jobs.poll({ workspace_id: 'default', job_id: job.job_id, cursor, max_bytes: 4 });
    const addition = result.output.map(c => c.text).join('');
    assert.ok(Buffer.byteLength(addition) <= 4);
    output += addition;
    cursor = result.next_cursor;
    if (!result.has_more) break;
  }
  assert.equal(output, text);
  assert.equal(cursor, Buffer.byteLength(text));
  assert.throws(() => jobs.poll({ workspace_id: 'default', job_id: job.job_id, cursor: 2 }), { code: 'INVALID_CURSOR' });
});

test('output caps stop persistence while pipes continue draining, and preserve a valid UTF-8 prefix', async t => {
  const { jobs, store } = await fixture(t, { maxOutputBytes: 1025 });
  const job = await jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', "process.stdout.write('你'.repeat(500000));setTimeout(()=>process.stdout.write('abc'),20)"], idempotency_key: 'large-output' });
  const result = await ended(jobs, job.job_id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output_truncated, true);
  assert.equal(result.output_bytes, 1023);
  assert.equal(result.output.map(c => c.text).join(''), '你'.repeat(341));
  const stored = store.db.prepare('SELECT SUM(length(CAST(text AS BLOB))) AS bytes FROM webcodex_job_chunks WHERE job_id = ?').get(job.job_id)!;
  assert.equal(stored.bytes, 1023);
});

test('idempotent starts coalesce concurrent requests and reject changed arguments', async t => {
  const { jobs } = await fixture(t);
  const input = { workspace_id: 'default', executable: 'node', args: ['-e', "process.stdout.write('once')"], idempotency_key: 'one-job' };
  const [first, second] = await Promise.all([jobs.start(input), jobs.start(input)]);
  assert.equal(first.job_id, second.job_id);
  assert.equal(jobs.list({ workspace_id: 'default' }).jobs.length, 1);
  await ended(jobs, first.job_id);
  assert.equal((await jobs.start(input)).status, 'succeeded');
  await assert.rejects(jobs.start({ ...input, args: ['-e', "process.stdout.write('twice')"] }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('timeouts and explicit cancellation terminate managed jobs', async t => {
  const { jobs } = await fixture(t);
  const timed = await jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', 'setInterval(()=>{},1000)'], timeout_ms: 150, idempotency_key: 'timeout' });
  assert.equal((await ended(jobs, timed.job_id)).status, 'timed_out');
  const cancellable = await jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', "process.stdout.write('READY');setInterval(()=>{},1000)"], idempotency_key: 'cancel' });
  await ready(jobs, cancellable.job_id, 'READY');
  assert.equal((await jobs.cancel({ workspace_id: 'default', job_id: cancellable.job_id })).status, 'cancelled');
  assert.equal((await jobs.cancel({ workspace_id: 'default', job_id: cancellable.job_id })).status, 'cancelled');
});

test('cancellation kills a real descendant process, including on Windows', async t => {
  const { jobs } = await fixture(t);
  const descendantCode = "process.stdout.write('CHILD='+process.pid+'\\n');setInterval(()=>{},1000)";
  const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore','inherit','inherit'],windowsHide:true});setInterval(()=>{},1000)`;
  const job = await jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', parentCode], idempotency_key: 'tree' });
  const output = await ready(jobs, job.job_id, 'CHILD=');
  const descendant = Number(output.match(/CHILD=(\d+)/)![1]);
  assert.ok(descendant > 0);
  await jobs.cancel({ workspace_id: 'default', job_id: job.job_id });
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try { process.kill(descendant, 0); await delay(10); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; alive = false; }
  }
  assert.equal(alive, false, 'The descendant process must have exited after cancellation.');
});

test('workspace ownership, read-only workspaces, cwd confinement, and concurrency limits are enforced', async t => {
  const { jobs, ctx } = await fixture(t, { maxConcurrent: 1 });
  const input = { workspace_id: 'default', executable: 'node', args: ['-e', 'setInterval(()=>{},1000)'], idempotency_key: 'limited' };
  await assert.rejects(jobs.start({ ...input, cwd: '..', idempotency_key: 'escape' }), { code: 'PATH_DENIED' });
  ctx.config.workspaces.find(w => w.id === 'other')!.readOnly = true;
  await assert.rejects(jobs.start({ ...input, workspace_id: 'other', idempotency_key: 'read-only' }), { code: 'READ_ONLY' });
  const job = await jobs.start(input);
  await assert.rejects(jobs.start({ ...input, idempotency_key: 'second' }), { code: 'CONCURRENCY_LIMIT' });
  assert.throws(() => jobs.poll({ workspace_id: 'other', job_id: job.job_id }), { code: 'JOB_NOT_FOUND' });
  await assert.rejects(jobs.cancel({ workspace_id: 'other', job_id: job.job_id }), { code: 'JOB_NOT_FOUND' });
  assert.deepEqual(jobs.list({ workspace_id: 'other' }), { jobs: [] });
  await jobs.cancel({ workspace_id: 'default', job_id: job.job_id });
});

test('command environment excludes inherited credentials and runtime injection variables', async t => {
  const { jobs } = await fixture(t);
  const names = ['OPENAI_API_KEY', 'WEBCODEX_HTTP_TOKEN', 'SSH_AUTH_SOCK', 'MCP_TUNNEL_TOKEN', 'PYTHONPATH'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = 'test-secret-do-not-inherit';
  try {
    const code = `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map(n=>[n,process.env[n]??null])))`;
    const job = await jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', code], idempotency_key: 'environment' });
    const result = await ended(jobs, job.job_id);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(JSON.parse(result.output.map(c => c.text).join('')), names.map(name => [name, null]));
  } finally {
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
  }
});

test('spawn failure reports failed instead of running or succeeded', async t => {
  const { jobs, ctx, temp } = await fixture(t);
  ctx.config.execution.allowedExecutables.missing = path.join(temp, 'missing-executable.exe');
  const job = await jobs.start({ workspace_id: 'default', executable: 'missing', idempotency_key: 'missing-exe' });
  assert.equal(job.status, 'failed');
  assert.ok(job.error);
  assert.notEqual(job.exit_code, 0);
});

test('restart marks stale jobs unknown and never signals their recorded PID', async t => {
  const { jobs, ctx, store } = await fixture(t);
  await jobs.close();
  store.db.prepare(`INSERT INTO webcodex_jobs
    (job_id,workspace_id,workspace_binding,executable_alias,args_json,cwd,status,created_at,timeout_ms,pid)
    VALUES ('stale','default',?,'node','[]','.','running',?,1000,?)`).run(initializeIdentity(ctx).workspaceIdentity('default'), new Date().toISOString(), process.pid);
  const recovered = new JobService(ctx);
  try {
    const job = recovered.poll({ workspace_id: 'default', job_id: 'stale' });
    assert.equal(job.status, 'unknown');
    assert.match(job.error!, /unknown/);
    assert.equal((await recovered.cancel({ workspace_id: 'default', job_id: 'stale' })).status, 'unknown');
    assert.ok(process.pid > 0, 'Current test process must still be alive.');
  } finally { await recovered.close(); }
});

test('close drains pending starts and kills existing children before returning', async t => {
  const { jobs } = await fixture(t);
  const running = await jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', 'setInterval(()=>{},1000)'], idempotency_key: 'shutdown-running' });
  const pending = jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', 'setInterval(()=>{},1000)'], idempotency_key: 'shutdown-pending' });
  const outcome = pending.then(value => value, error => error);
  await jobs.close();
  const result = await outcome;
  if (result instanceof Error) assert.equal((result as Error & { code: string }).code, 'SERVICE_CLOSING');
  assert.equal(jobs.poll({ workspace_id: 'default', job_id: running.job_id }).status, 'cancelled');
  assert.equal(jobs.list({ workspace_id: 'default' }).jobs.some(job => job.status === 'running'), false);
});

test('failed cancellation retains ownership and concurrency slot, then permits a proven retry', async t => {
  const { jobs, temp } = await fixture(t, { maxConcurrent: 1 });
  const input = { workspace_id: 'default', executable: 'node', args: ['-e', "process.stdout.write('READY');setInterval(()=>{},1000)"], idempotency_key: 'retry-cancel' };
  const job = await jobs.start(input);
  await ready(jobs, job.job_id, 'READY');
  const priorSystemRoot = process.env.SystemRoot;
  const originalKill = process.kill;
  try {
    if (process.platform === 'win32') process.env.SystemRoot = path.join(temp, 'nonexistent-system-root');
    else process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') throw Object.assign(new Error('Injected kill denial'), { code: 'EPERM' });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    await assert.rejects(jobs.cancel({ workspace_id: 'default', job_id: job.job_id }), { code: 'PROCESS_TERMINATION_UNCONFIRMED' });
    assert.equal(jobs.poll({ workspace_id: 'default', job_id: job.job_id }).status, 'unknown');
    await assert.rejects(jobs.start({ ...input, idempotency_key: 'still-full' }), { code: 'CONCURRENCY_LIMIT' });
  } finally {
    if (priorSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = priorSystemRoot;
    process.kill = originalKill;
  }
  assert.equal((await jobs.cancel({ workspace_id: 'default', job_id: job.job_id })).status, 'cancelled');
});
