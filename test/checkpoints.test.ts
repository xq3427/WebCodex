import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, link, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { App } from '../src/app.js';
import { defaultConfig } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const filename = 'WEBCODEX_HANDOFF.md';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const run = promisify(execFile);
const notes = (idempotencyKey: string) => ({
  workspace_id: 'default', objective: 'Implement the next project change', progress: 'Prepared the design and inspected files',
  next_steps: 'Implement the pending change and run the required checks', verification_notes: 'Caller report: checks have not been run',
  expected_sha256: null as string | null, idempotency_key: idempotencyKey,
});

async function fixture(t: TestContext, limits: Partial<AppConfig['limits']> = {}) {
  const parent = await realpath(tmpdir());
  const folder = await mkdtemp(path.join(parent, 'webcodex-checkpoint-test-'));
  const root = path.join(folder, 'project');
  const other = path.join(folder, 'other');
  await Promise.all([mkdir(root), mkdir(other)]);
  const configPath = path.join(folder, 'config.json');
  const config: AppConfig = { ...defaultConfig(root, configPath), configPath };
  config.workspaces.push({ id: 'other', name: 'Other project', root: other, readOnly: false });
  Object.assign(config.limits, limits);
  let app = new App(config);
  t.after(async () => {
    await app.close();
    const actual = await realpath(folder);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-checkpoint-test-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { root, other, folder, config, get app() { return app; }, restart: async () => { await app.close(); app = new App(config); } };
}

function observations(content: string) {
  const match = content.match(/^```json\n([\s\S]*?)\n```/m);
  assert.ok(match, 'The checkpoint must include structured service observations.');
  return JSON.parse(match[1]) as {
    captured_at: string; execution_mode: string;
    git: { available: boolean; entries?: Array<{ path: string }> };
    selected_webcodex_jobs: Array<{ job_id: string; status: string; exit_code: number | null; created_at: string; started_at: string | null; ended_at: string | null }>;
  };
}

async function ended(app: App, workspaceId: string, jobId: string) {
  for (let i = 0; i < 500; i++) {
    const job = app.jobs.poll({ workspace_id: workspaceId, job_id: jobId });
    if (!['queued', 'running'].includes(job.status)) return job;
    await delay(10);
  }
  throw new Error('Synthetic checkpoint job did not finish within five seconds.');
}

test('checkpoint create/read uses a fixed project file, records caller notes and survives service restart', async t => {
  const f = await fixture(t);
  const missing = await f.app.checkpoints.read({ workspace_id: 'default' });
  assert.equal(missing.exists, false);
  assert.equal(missing.path, filename);
  assert.equal(missing.sha256, null);
  const session = '11111111-1111-4111-8111-111111111111';
  const input = { ...notes('checkpoint-create'), session_id: session };
  const saved = await f.app.checkpoints.save(input);
  assert.equal(saved.path, filename);
  assert.equal(saved.workspace_id, 'default');
  assert.ok(saved.change_id);
  assert.ok(Number.isFinite(Date.parse(saved.saved_at)));
  const original = await readFile(path.join(f.root, filename));
  assert.equal(saved.sha256, hash(original));
  const content = original.toString('utf8');
  for (const value of [input.objective, input.progress, input.next_steps, input.verification_notes, session]) assert.ok(content.includes(value));
  assert.match(content, /caller notes.*not independently verified/i);
  const facts = observations(content);
  assert.equal(facts.git.available, false, 'A workspace without Git must still allow saving a checkpoint.');
  assert.deepEqual(facts.selected_webcodex_jobs, []);
  assert.equal(facts.execution_mode, 'disabled');
  assert.equal(f.config.codexSessions.enabled, false, 'A session ID is only a reference and must not enable/read history.');
  await f.restart();
  const read = await f.app.checkpoints.read({ workspace_id: 'default' });
  assert.equal(read.exists, true);
  assert.equal(read.sha256, saved.sha256);
  assert.equal(read.content, content);
  assert.equal(read.truncated, false);
});

test('checkpoint version conflicts do not overwrite edits, and standard file restoration restores the prior note', async t => {
  const f = await fixture(t);
  const first = await f.app.checkpoints.save(notes('version-first'));
  const firstBytes = await readFile(path.join(f.root, filename));
  await assert.rejects(f.app.checkpoints.save(notes('create-collision')), { code: 'VERSION_CONFLICT' });
  const second = await f.app.checkpoints.save({ ...notes('version-second'), progress: 'Implemented the pending change', expected_sha256: first.sha256 });
  await assert.rejects(f.app.checkpoints.save({ ...notes('stale-version'), expected_sha256: first.sha256 }), { code: 'VERSION_CONFLICT' });
  assert.equal(hash(await readFile(path.join(f.root, filename))), second.sha256);
  const restored = await f.app.files.restore({ workspace_id: 'default', change_id: second.change_id!, expected_sha256: second.sha256, idempotency_key: 'restore-checkpoint' });
  assert.equal(restored.sha256, first.sha256);
  assert.deepEqual(await readFile(path.join(f.root, filename)), firstBytes);
});

test('checkpoint retries preserve the original facts/time and never overwrite a subsequent external edit', async t => {
  const f = await fixture(t);
  const input = notes('stable-checkpoint');
  let samples = 0;
  f.app.git.status = async () => { samples++; return { workspace_id: 'default', root:f.root, repository_kind:'normal', branch:null, head:null, entries: [], output: '', truncated: false, hidden_entries: 0, format: 'porcelain-v1-filtered' }; };
  const first = await f.app.checkpoints.save(input);
  assert.equal(samples, 1);
  const external = 'A later owner edit must survive an old checkpoint retry.\n';
  await writeFile(path.join(f.root, filename), external);
  await delay(5);
  assert.deepEqual(await f.app.checkpoints.save(input), first);
  assert.equal(samples, 1);
  assert.equal(await readFile(path.join(f.root, filename), 'utf8'), external);
  await assert.rejects(f.app.checkpoints.save({ ...input, progress: 'Different content with the same operation key' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.restart();
  f.app.git.status = async () => { throw new Error('An idempotent retry must not resample Git.'); };
  assert.deepEqual(await f.app.checkpoints.save(input), first);
  assert.equal(await readFile(path.join(f.root, filename), 'utf8'), external);
});

test('checkpoint observations contain filtered Git paths and selected real job outcomes without argv/stdout/pid', async t => {
  const f = await fixture(t);
  await run('git', ['init', '--quiet', f.root], { windowsHide: true });
  await Promise.all([
    writeFile(path.join(f.root, 'visible.txt'), 'visible project file'),
    writeFile(path.join(f.root, '.env'), 'synthetic-env-content'),
    writeFile(path.join(f.root, 'API_key.txt'), 'synthetic-key-content'),
  ]);
  f.config.execution.mode = 'trusted-host';
  const marker = 'SYNTHETIC-STDOUT-AND-ARGV-EXCLUDED';
  const selected = await f.app.jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', `process.stdout.write('${marker}');process.exitCode=7`], idempotency_key: 'checkpoint-real-job' });
  const result = await ended(f.app, 'default', selected.job_id);
  assert.equal(result.exit_code, 7);
  const unselected = await f.app.jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', 'process.exit(0)'], idempotency_key: 'unselected-job' });
  await ended(f.app, 'default', unselected.job_id);
  await f.app.checkpoints.save({ ...notes('job-evidence'), job_ids: [selected.job_id] });
  const text = await readFile(path.join(f.root, filename), 'utf8');
  const facts = observations(text);
  assert.equal(facts.git.available, true);
  assert.ok(facts.git.entries!.some(entry => entry.path === 'visible.txt'));
  assert.equal(facts.git.entries!.some(entry => entry.path === '.env' || entry.path === 'API_key.txt'), false);
  assert.equal(facts.selected_webcodex_jobs.length, 1);
  const job = facts.selected_webcodex_jobs[0];
  assert.equal(job.job_id, selected.job_id);
  assert.equal(job.status, 'failed');
  assert.equal(job.exit_code, 7);
  assert.equal(job.created_at, result.created_at);
  assert.equal(job.started_at, result.started_at);
  assert.equal(job.ended_at, result.ended_at);
  for (const prohibited of ['args', 'argv', 'stdout', 'stderr', 'output', 'pid', 'error', 'env']) assert.equal(Object.hasOwn(job, prohibited), false);
  assert.equal(text.includes(marker), false);
  assert.equal(text.includes(unselected.job_id), false);
  assert.match(text, /exit code does not establish.*test suite passed/i);
});

test('checkpoint redacts every caller field before persistence, audit and idempotent result serialization', async t => {
  const f = await fixture(t);
  const secrets = ['sk-proj-' + 'A'.repeat(40), 'SYNTHETIC-PASSWORD-ONLY', 'SYNTHETIC-URL-PASSWORD', 'SYNTHETIC-BEARER-TOKEN'];
  const saved = await f.app.checkpoints.save({
    ...notes('redacted-checkpoint'), objective: 'Goal ' + secrets[0], progress: `password="${secrets[1]}"`,
    next_steps: `Review https://user:${secrets[2]}@example.invalid/path`, verification_notes: `Authorization: Bearer ${secrets[3]}`,
  });
  const note = await readFile(path.join(f.root, filename), 'utf8');
  const audits = f.app.store.db.prepare('SELECT event,details FROM audit_events').all();
  const operations = f.app.store.db.prepare('SELECT scope,op_key,status,result FROM operations').all();
  for (const secret of secrets) {
    for (const value of [note, JSON.stringify(saved), JSON.stringify(audits), JSON.stringify(operations)]) assert.equal(value.includes(secret), false);
  }
  assert.ok(saved.redactions >= secrets.length);
  assert.ok(note.includes('[REDACTED]'));
});

test('checkpoint read redacts full externally edited content before truncation while returning its original byte hash', async t => {
  const f = await fixture(t, { readMaxBytes: 256 });
  const secret = 'sk-proj-' + 'B'.repeat(80);
  const text = 'x'.repeat(240) + ' ' + secret + '\n' + '后续'.repeat(300);
  const bytes = Buffer.from(text);
  await writeFile(path.join(f.root, filename), bytes);
  const read = await f.app.checkpoints.read({ workspace_id: 'default' });
  assert.equal(read.exists, true);
  assert.equal(read.sha256, hash(bytes));
  assert.equal(read.truncated, true);
  assert.ok(Buffer.byteLength(read.content!) <= 256);
  assert.equal(read.content!.includes('sk-proj-'), false, 'Truncation must not leave a recognizable prefix of a secret.');
  assert.equal(read.content!.includes('\ufffd'), false);
  assert.ok(read.content!.includes('[REDACTED]'));
  assert.deepEqual(await readFile(path.join(f.root, filename)), bytes, 'A redacted read must never rewrite the file.');
});

test('checkpoint field and total write limits reject complete saves without leaving a partial note', async t => {
  const f = await fixture(t);
  for (const field of ['objective', 'progress', 'next_steps', 'verification_notes'] as const) {
    await assert.rejects(f.app.checkpoints.save({ ...notes('too-large-' + field), [field]: '界'.repeat(2731) }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(f.app.checkpoints.save({ ...notes('too-many-jobs'), job_ids: Array.from({ length: 11 }, (_, i) => 'job-' + i) }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.app.checkpoints.save({ ...notes('invalid-session'), session_id: '../not-a-session' }), { code: 'INVALID_ARGUMENT' });
  assert.equal((await f.app.checkpoints.read({ workspace_id: 'default' })).exists, false);
  f.config.limits.writeMaxBytes = 1024;
  await assert.rejects(f.app.checkpoints.save({ ...notes('total-limit'), objective: 'a'.repeat(600), progress: 'b'.repeat(600) }), { code: 'CHECKPOINT_TOO_LARGE' });
  assert.equal((await f.app.checkpoints.read({ workspace_id: 'default' })).exists, false);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS total FROM file_changes').get()!.total, 0);
});

test('checkpoints enforce read-only and protected paths, reject links and never sample another workspace job', async t => {
  const f = await fixture(t);
  f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.app.checkpoints.save(notes('read-only-note')), { code: 'READ_ONLY' });
  assert.equal((await f.app.checkpoints.read({ workspace_id: 'default' })).exists, false);
  f.config.workspaces[0].readOnly = false;
  const outside = path.join(f.other, 'outside-note.md');
  await writeFile(outside, 'Do not modify linked contents.');
  await link(outside, path.join(f.root, filename));
  await assert.rejects(f.app.checkpoints.read({ workspace_id: 'default' }), { code: 'PATH_DENIED' });
  await assert.rejects(f.app.checkpoints.save(notes('hardlinked-note')), { code: 'PATH_DENIED' });
  await unlink(path.join(f.root, filename));
  const jump = path.join(f.folder, 'linked-workspace');
  await symlink(f.other, jump, process.platform === 'win32' ? 'junction' : 'dir');
  f.config.workspaces[0].root = jump;
  await assert.rejects(f.app.checkpoints.save(notes('junction-note')), { code: 'PATH_DENIED' });
  f.config.workspaces[0].root = f.root;
  f.config.codexSessions.home = f.root;
  await assert.rejects(f.app.checkpoints.read({ workspace_id: 'default' }), { code: 'PATH_DENIED' });
  await assert.rejects(f.app.checkpoints.save(notes('protected-note')), { code: 'PATH_DENIED' });
  f.config.codexSessions.home = null;
  f.config.execution.mode = 'trusted-host';
  const otherJob = await f.app.jobs.start({ workspace_id: 'other', executable: 'node', args: ['-e', 'process.exit(0)'], idempotency_key: 'other-workspace-job' });
  await ended(f.app, 'other', otherJob.job_id);
  await assert.rejects(f.app.checkpoints.save({ ...notes('cross-workspace-note'), job_ids: [otherJob.job_id] }), { code: 'JOB_NOT_FOUND' });
  assert.equal((await f.app.checkpoints.read({ workspace_id: 'default' })).exists, false);
  assert.equal(await readFile(outside, 'utf8'), 'Do not modify linked contents.');
});
