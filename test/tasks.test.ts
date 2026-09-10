import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, link, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { App } from '../src/app.js';
import { defaultConfig } from '../src/config.js';
import { TaskService, type TaskCreateInput } from '../src/tasks.js';
import type { AppConfig } from '../src/types.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const notes = (key: string): TaskCreateInput => ({ workspace_id: 'default', title: 'Implement a project change', objective: 'Add the requested feature', progress: 'Inspected current files', next_steps: 'Implement and verify the change', idempotency_key: key });

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), folder = await mkdtemp(path.join(parent, 'webcodex-tasks-'));
  const root = path.join(folder, 'project'), other = path.join(folder, 'other');
  await Promise.all([mkdir(root), mkdir(other)]);
  const configPath = path.join(folder, 'config.json'), config: AppConfig = { ...defaultConfig(root, configPath), configPath };
  config.device = { id: randomUUID(), name: 'Synthetic test device' };
  config.workspaces[0].uid = randomUUID();
  config.workspaces.push({ id: 'other', uid: randomUUID(), name: 'Other', root: other, readOnly: false });
  config.tasks = { maxTasksPerWorkspace: 100, maxRevisionsPerTask: 100, maxTrackedFiles: 20, maxSnapshotBytes: 16777216 };
  let app = new App(config), tasks = new TaskService(app.ctx, app.files, app.git);
  t.after(async () => {
    await app.close();
    const actual = await realpath(folder);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-tasks-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { root, other, folder, config, get app() { return app; }, get tasks() { return tasks; }, restart: async () => { await app.close(); app = new App(config); tasks = new TaskService(app.ctx, app.files, app.git); } };
}

async function readAll(tasks: TaskService, input: { workspace_id: string; task_id: string; revision?: number; max_bytes?: number }) {
  const first = await tasks.read(input);
  let content = first.content, next = first.next_cursor, offset = first.chunk.end_bytes, pages = 1;
  while (next) {
    assert.ok(pages++ < 1000);
    const page = await tasks.read({ ...input, cursor: next });
    assert.equal(page.chunk.offset_bytes, offset);
    assert.equal(page.sha256, first.sha256);
    assert.equal(page.freshness, null);
    assert.equal(page.freshness_sampled, false);
    assert.equal(page.content.includes('\ufffd'), false);
    content += page.content; offset = page.chunk.end_bytes; next = page.next_cursor;
  }
  assert.equal(Buffer.byteLength(content), first.chunk.total_bytes);
  assert.equal(hash(content), first.sha256);
  return { first, payload: JSON.parse(content), content, pages };
}

async function ended(app: App, jobId: string, workspaceId = 'default') {
  for (let i = 0; i < 500; i++) {
    const job = app.jobs.poll({ workspace_id: workspaceId, job_id: jobId });
    if (!['queued', 'running'].includes(job.status)) return job;
    await delay(10);
  }
  throw new Error('Synthetic task job did not exit within five seconds.');
}

test('tasks preserve independent append-only revisions, caller status and retry results across restarts', async t => {
  const f = await fixture(t);
  const aInput = notes('task-a'), a = await f.tasks.create(aInput), b = await f.tasks.create({ ...notes('task-b'), title: 'Independent second task', status: 'paused' });
  assert.equal(a.revision, 1); assert.equal(a.status, 'active');
  assert.notEqual(a.task_id, b.task_id);
  const saved = { ...notes('task-a-second'), task_id: a.task_id, expected_revision: 1, progress: 'User says implementation is done', status: 'completed' as const };
  const updated = await f.tasks.checkpoint(saved);
  assert.equal(updated.revision, 2); assert.equal(updated.status, 'completed');
  const old = await readAll(f.tasks, { workspace_id: 'default', task_id: a.task_id, revision: 1 });
  assert.equal(old.payload.notes.progress, aInput.progress); assert.equal(old.payload.status, 'active');
  const current = await readAll(f.tasks, { workspace_id: 'default', task_id: a.task_id });
  assert.equal(current.payload.notes.progress, saved.progress); assert.equal(current.first.head_revision, 2);
  assert.equal(current.first.freshness!.state, 'unknown'); assert.equal(current.first.freshness!.verification_validity, 'unknown');
  assert.equal((await readAll(f.tasks, { workspace_id: 'default', task_id: b.task_id })).payload.status, 'paused');
  const listed = await f.tasks.list({ workspace_id: 'default', limit: 1 });
  assert.equal(listed.tasks.length, 1); assert.equal(listed.next_offset, 1);
  assert.equal((await f.tasks.list({ workspace_id: 'default', limit: 1, offset: 1 })).next_offset, null);
  await f.restart();
  f.app.git.status = async () => { throw new Error('A successful retry must not recapture Git.'); };
  assert.deepEqual(await f.tasks.create(aInput), a);
  assert.deepEqual(await f.tasks.checkpoint(saved), updated);
  assert.equal((await f.tasks.list({ workspace_id: 'default' })).tasks.length, 2);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM webcodex_task_revisions').get()!.count, 3);
  const third = await f.tasks.checkpoint({ ...notes('third'), task_id: a.task_id, expected_revision: 2, title: undefined });
  assert.equal(third.status, 'completed', 'Omitted status preserves the previous caller supplied value.');
});

test('task optimistic revision checks isolate competing writers and reject changed idempotency payloads', async t => {
  const f = await fixture(t), task = await f.tasks.create(notes('new'));
  const update = { ...notes('update-one'), task_id: task.task_id, expected_revision: 1 };
  const updates = [update, { ...update, idempotency_key: 'update-two', progress: 'Another writer' }];
  const outcomes = await Promise.allSettled(updates.map(input => f.tasks.checkpoint(input)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const failure = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failure.reason.code, 'TASK_REVISION_CONFLICT');
  await assert.rejects(f.tasks.create({ ...notes('new'), objective: 'Different payload' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM webcodex_task_revisions WHERE task_id=?').get(task.task_id)!.count, 2);
  const revisions = f.app.store.db.prepare('SELECT revision FROM webcodex_task_revisions WHERE task_id=? ORDER BY revision').all(task.task_id);
  assert.deepEqual(revisions.map(row => row.revision), [1, 2]);
  const current = await readAll(f.tasks, { workspace_id: 'default', task_id: task.task_id });
  // allSettled preserves input order; the asynchronous captures need not commit in that order.
  for (const [index, outcome] of outcomes.entries()) {
    const input = updates[index]!;
    const operation = f.app.store.db.prepare("SELECT status FROM operations WHERE scope LIKE '%/task_checkpoint' AND op_key=?").get(input.idempotency_key);
    assert.ok(operation);
    assert.equal(operation.status, outcome.status === 'fulfilled' ? 'done' : 'failed', input.idempotency_key);
    if (outcome.status === 'fulfilled') {
      assert.equal(outcome.value.revision, 2);
      assert.equal(current.first.head_revision, 2);
      assert.equal(current.payload.notes.progress, input.progress);
    }
  }
});

test('task revision and idempotency completion commit together and rollback together on SQL failure', async t => {
  const f = await fixture(t);
  f.app.store.db.exec("CREATE TRIGGER reject_task_result BEFORE UPDATE OF status ON operations WHEN NEW.status='done' AND NEW.scope LIKE '%/task_create' BEGIN SELECT RAISE(ABORT,'synthetic result write failure'); END;");
  await assert.rejects(f.tasks.create(notes('atomic-write')));
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM webcodex_tasks').get()!.count, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM webcodex_task_revisions').get()!.count, 0);
  assert.equal(f.app.store.db.prepare("SELECT status FROM operations WHERE op_key='atomic-write'").get()!.status, 'failed');
});

test('task notes are fully redacted before persistence and small UTF-8 pages can reassemble an old revision after updates', async t => {
  const f = await fixture(t);
  const secrets = ['sk-proj-' + 'R'.repeat(80), 'SYNTHETIC-TASK-PASSWORD', 'SYNTHETIC-TASK-BEARER'];
  const input = { ...notes('redactions'), title: `password="${secrets[1]}"`, objective: '中文😀'.repeat(400) + secrets[0], progress: 'Authorization: Bearer ' + secrets[2], next_steps: '继续完成工作😀'.repeat(100) };
  const task = await f.tasks.create(input);
  assert.ok(task.redactions >= 3);
  f.config.limits.readMaxBytes = 256;
  assert.equal((await f.tasks.list({ workspace_id: 'default' })).tasks.length, 1, 'Small text pages must still permit a complete task summary.');
  const first = await f.tasks.read({ workspace_id: 'default', task_id: task.task_id });
  assert.ok(first.next_cursor); assert.ok(Buffer.byteLength(first.content) <= 256);
  await f.tasks.checkpoint({ ...notes('later'), task_id: task.task_id, expected_revision: 1 });
  const continued = await f.tasks.read({ workspace_id: 'default', task_id: task.task_id, cursor: first.next_cursor! });
  assert.equal(continued.revision, 1);
  const all = await readAll(f.tasks, { workspace_id: 'default', task_id: task.task_id, revision: 1 });
  assert.ok(all.pages > 10);
  assert.ok(all.payload.notes.objective.endsWith('[REDACTED]'));
  assert.equal(all.payload.notes.next_steps, input.next_steps);
  const persisted = JSON.stringify({ tasks: f.app.store.db.prepare('SELECT * FROM webcodex_tasks').all(), revisions: f.app.store.db.prepare('SELECT * FROM webcodex_task_revisions').all(), operations: f.app.store.db.prepare('SELECT * FROM operations').all(), audits: f.app.store.db.prepare('SELECT * FROM audit_events').all() });
  for (const secret of secrets) { assert.equal(persisted.includes(secret), false); assert.equal(all.content.includes(secret), false); }
  const other = await f.tasks.create(notes('cursor-other'));
  await assert.rejects(f.tasks.read({ workspace_id: 'default', task_id: other.task_id, cursor: first.next_cursor! }), { code: 'INVALID_CURSOR' });
  await assert.rejects(f.tasks.read({ workspace_id: 'default', task_id: task.task_id, revision: 2, cursor: first.next_cursor! }), { code: 'INVALID_CURSOR' });
  await assert.rejects(f.tasks.read({ workspace_id: 'other', task_id: task.task_id, cursor: first.next_cursor! }), { code: 'INVALID_CURSOR' });
  await f.restart();
  await assert.rejects(f.tasks.read({ workspace_id: 'default', task_id: task.task_id, cursor: first.next_cursor! }), { code: 'INVALID_CURSOR' });
  assert.equal((await readAll(f.tasks, { workspace_id: 'default', task_id: task.task_id, revision: 1 })).payload.notes.next_steps, input.next_steps);
});

test('task freshness hashes selected raw files and never infers test validity from stable Git or zero exit status', async t => {
  const f = await fixture(t);
  const content = Buffer.from([0x00, 0xff, 0x01, 0x02]);
  await writeFile(path.join(f.root, 'data.bin'), content);
  f.app.git.status = async () => ({ workspace_id: 'default', root: f.root, repository_kind: 'normal', branch: 'main', head: 'abc123', entries: [{ status: ' M', path: 'data.bin' }], output: ' M data.bin', truncated: false, hidden_entries: 0, format: 'porcelain-v1-filtered' });
  f.config.execution.mode = 'trusted-host';
  const marker = 'SYNTHETIC-EXCLUDED-ARGV-AND-OUTPUT';
  const job = await f.app.jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', `process.stdout.write('${marker}');process.exit(0)`], idempotency_key: 'real-job' });
  const result = await ended(f.app, job.job_id); assert.equal(result.exit_code, 0);
  const task = await f.tasks.create({ ...notes('file-job-facts'), tracked_paths: ['data.bin', 'pending.txt'], job_ids: [job.job_id] });
  const initial = await readAll(f.tasks, { workspace_id: 'default', task_id: task.task_id });
  assert.equal(initial.first.freshness!.state, 'unchanged'); assert.equal(initial.first.freshness!.verification_validity, 'unknown');
  assert.equal(initial.payload.observations.tracked_files[0].sha256, hash(content));
  assert.equal(initial.payload.observations.tracked_files[1].exists, false);
  assert.equal(initial.payload.observations.selected_webcodex_jobs[0].exit_code, 0);
  assert.equal(initial.content.includes(marker), false);
  for (const name of ['args', 'output', 'stdout', 'stderr', 'pid', 'env']) assert.equal(Object.hasOwn(initial.payload.observations.selected_webcodex_jobs[0], name), false);
  await writeFile(path.join(f.root, 'data.bin'), Buffer.from([0x00, 0xfe, 0x01, 0x02]));
  const edited = await f.tasks.read({ workspace_id: 'default', task_id: task.task_id });
  assert.equal(edited.freshness!.git.state, 'unchanged'); assert.equal(edited.freshness!.tracked_files[0].state, 'changed'); assert.equal(edited.freshness!.state, 'changed');
  await writeFile(path.join(f.root, 'data.bin'), content);
  await writeFile(path.join(f.root, 'pending.txt'), 'Now exists');
  assert.equal((await f.tasks.read({ workspace_id: 'default', task_id: task.task_id })).freshness!.tracked_files.find(file => file.path === 'pending.txt')!.state, 'changed');
  await unlink(path.join(f.root, 'data.bin'));
  assert.equal((await f.tasks.read({ workspace_id: 'default', task_id: task.task_id })).freshness!.tracked_files[0].state, 'changed');
});

test('task selected jobs are workspace bound and live changes are reported independently of caller success claims', async t => {
  const f = await fixture(t); f.config.execution.mode = 'trusted-host';
  const other = await f.app.jobs.start({ workspace_id: 'other', executable: 'node', args: ['-e', 'process.exit(0)'], idempotency_key: 'other-job' });
  await ended(f.app, other.job_id, 'other');
  await assert.rejects(f.tasks.create({ ...notes('other-job-note'), job_ids: [other.job_id] }), { code: 'JOB_NOT_FOUND' });
  const failed = await f.app.jobs.start({ workspace_id: 'default', executable: 'node', args: ['-e', 'process.exit(7)'], idempotency_key: 'failed-job' });
  assert.equal((await ended(f.app, failed.job_id)).exit_code, 7);
  const task = await f.tasks.create({ ...notes('failed-fact'), verification_notes: 'Caller claims all tests passed', job_ids: [failed.job_id] });
  const read = await readAll(f.tasks, { workspace_id: 'default', task_id: task.task_id });
  assert.equal(read.payload.notes.verification_notes, 'Caller claims all tests passed');
  assert.equal(read.payload.observations.selected_webcodex_jobs[0].exit_code, 7);
  assert.equal(read.first.freshness!.verification_validity, 'unknown');
  f.app.store.db.prepare("UPDATE webcodex_jobs SET status='unknown' WHERE job_id=?").run(failed.job_id);
  assert.equal((await f.tasks.read({ workspace_id: 'default', task_id: task.task_id })).freshness!.selected_webcodex_jobs[0].state, 'changed');
});

test('task count, revision, file count and total snapshot byte limits reject atomic writes; freshness is unknown when budget decreases', async t => {
  const f = await fixture(t);
  await Promise.all([writeFile(path.join(f.root, 'a.bin'), Buffer.alloc(400)), writeFile(path.join(f.root, 'b.bin'), Buffer.alloc(400))]);
  f.config.tasks!.maxSnapshotBytes = 700;
  await assert.rejects(f.tasks.create({ ...notes('over-budget'), tracked_paths: ['a.bin', 'b.bin'] }), { code: 'FILE_TOO_LARGE' });
  assert.equal((await f.tasks.list({ workspace_id: 'default' })).tasks.length, 0);
  f.config.tasks!.maxSnapshotBytes = 800;
  const task = await f.tasks.create({ ...notes('within-budget'), tracked_paths: ['a.bin', 'b.bin'] });
  f.config.tasks!.maxSnapshotBytes = 500;
  const freshness = (await f.tasks.read({ workspace_id: 'default', task_id: task.task_id })).freshness!;
  assert.equal(freshness.state, 'unknown'); assert.equal(freshness.tracked_files.find(file => file.path === 'b.bin')!.reason, 'FILE_TOO_LARGE');
  f.config.tasks!.maxTasksPerWorkspace = 1;
  await assert.rejects(f.tasks.create(notes('limit')), { code: 'TASK_LIMIT_REACHED' });
  f.config.tasks!.maxRevisionsPerTask = 1;
  await assert.rejects(f.tasks.checkpoint({ ...notes('revision-limit'), task_id: task.task_id, expected_revision: 1 }), { code: 'TASK_REVISION_LIMIT_REACHED' });
  f.config.tasks!.maxTrackedFiles = 1;
  await assert.rejects(f.tasks.create({ ...notes('files-limit'), tracked_paths: ['a.bin', 'b.bin'] }), { code: 'INVALID_ARGUMENT' });
  for (const field of ['objective', 'progress', 'next_steps', 'verification_notes'] as const) await assert.rejects(f.tasks.create({ ...notes('field-' + field), [field]: '界'.repeat(2731) }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM webcodex_task_revisions').get()!.count, 1);
});

test('task records enforce device, workspace UID, root, readonly policy and protected file rules before cached retries', async t => {
  const f = await fixture(t), input = notes('identity'), task = await f.tasks.create(input);
  await assert.rejects(f.tasks.read({ workspace_id: 'other', task_id: task.task_id }), { code: 'TASK_NOT_FOUND' });
  await assert.rejects(f.tasks.checkpoint({ ...notes('other-update'), workspace_id: 'other', task_id: task.task_id, expected_revision: 1 }), { code: 'TASK_NOT_FOUND' });
  f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.tasks.create(input), { code: 'READ_ONLY' });
  await assert.rejects(f.tasks.checkpoint({ ...notes('readonly'), task_id: task.task_id, expected_revision: 1 }), { code: 'READ_ONLY' });
  assert.equal((await f.tasks.read({ workspace_id: 'default', task_id: task.task_id })).revision, 1);
  f.config.workspaces[0].readOnly = false;
  f.config.workspaces[0].root = f.other;
  await assert.rejects(f.tasks.create(input), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  f.config.workspaces[0].root = f.root;
  const deviceId = f.config.device!.id; f.config.device!.id = randomUUID();
  await assert.rejects(f.tasks.read({ workspace_id: 'default', task_id: task.task_id }), { code: 'STATE_DEVICE_MISMATCH' });
  f.config.device!.id = deviceId;
  const uid = f.config.workspaces[0].uid; f.config.workspaces[0].uid = randomUUID();
  await assert.rejects(f.tasks.read({ workspace_id: 'default', task_id: task.task_id }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  f.config.workspaces[0].uid = uid;
  await writeFile(path.join(f.root, '.env'), 'secret');
  await assert.rejects(f.tasks.create({ ...notes('protected'), tracked_paths: ['.env'] }), { code: 'PATH_DENIED' });
  await writeFile(path.join(f.other, 'outside.txt'), 'outside'); await link(path.join(f.other, 'outside.txt'), path.join(f.root, 'linked.txt'));
  await assert.rejects(f.tasks.create({ ...notes('hardlink'), tracked_paths: ['linked.txt'] }), { code: 'PATH_DENIED' });
  await assert.rejects(f.tasks.create({ ...notes('secret-path'), tracked_paths: ['sk-proj-' + 'X'.repeat(30) + '.txt'] }), { code: 'SENSITIVE_PATH' });
  await f.app.close(); f.config.workspaces[0].uid = randomUUID(); f.config.workspaces[0].root = f.other;
  await f.restart();
  await assert.rejects(f.tasks.read({ workspace_id: 'default', task_id: task.task_id }), { code: 'TASK_NOT_FOUND' });
  assert.equal((await f.tasks.list({ workspace_id: 'default' })).tasks.length, 0);
});

test('selected task exports preserve legacy checkpoints unless their exact version is authorized and reuse original revision on retry', async t => {
  const f = await fixture(t), original = 'Existing legacy checkpoint maintained by the user.\n', checkpoint = path.join(f.root, 'WEBCODEX_HANDOFF.md');
  await writeFile(checkpoint, original);
  const input = notes('export-task'), task = await f.tasks.create(input);
  assert.equal(await readFile(checkpoint, 'utf8'), original, 'Task creation must not implicitly import or replace a legacy checkpoint.');
  await f.tasks.checkpoint({ ...notes('export-rev2'), task_id: task.task_id, expected_revision: 1, progress: 'Newer revision' });
  await assert.rejects(f.tasks.export({ workspace_id: 'default', task_id: task.task_id, expected_sha256: null, idempotency_key: 'create-only-export' }), { code: 'VERSION_CONFLICT' });
  const exportInput = { workspace_id: 'default', task_id: task.task_id, revision: 1, expected_sha256: hash(original), idempotency_key: 'selected-export' };
  const exported = await f.tasks.export(exportInput);
  const content = await readFile(checkpoint, 'utf8');
  assert.ok(content.includes(input.progress)); assert.equal(content.includes('Newer revision'), false);
  assert.match(content, /Revision: 1/); assert.match(content, /caller notes.*not independently verified/i);
  assert.equal(exported.sha256, hash(content));
  const later = 'External edit after export must survive a repeated request.\n'; await writeFile(checkpoint, later);
  assert.deepEqual(await f.tasks.export(exportInput), exported);
  assert.equal(await readFile(checkpoint, 'utf8'), later);
  f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.tasks.export(exportInput), { code: 'READ_ONLY' });
  f.config.workspaces[0].readOnly = false;
  await f.restart();
  assert.deepEqual(await f.tasks.export(exportInput), exported);
  assert.equal(await readFile(checkpoint, 'utf8'), later);
  assert.equal((await f.tasks.read({ workspace_id: 'default', task_id: task.task_id })).revision, 2);
});

test('task freshness reports changed paths ahead of bounded unchanged details and treats newly protected files as unknown', async t => {
  const f = await fixture(t), names = Array.from({ length: 21 }, (_, i) => `tracked-${i}.txt`);
  f.config.tasks!.maxTrackedFiles = 21;
  await Promise.all(names.map(name => writeFile(path.join(f.root, name), 'original')));
  const task = await f.tasks.create({ ...notes('many-files'), tracked_paths: names });
  await writeFile(path.join(f.root, names[20]), 'changed');
  const changed = (await f.tasks.read({ workspace_id: 'default', task_id: task.task_id })).freshness!;
  assert.equal(changed.state, 'changed'); assert.equal(changed.tracked_file_count, 21); assert.equal(changed.tracked_files.length, 20);
  assert.equal(changed.tracked_files_truncated, true); assert.equal(changed.tracked_files[0].path, names[20]);
  assert.deepEqual(changed.tracked_file_states, { changed: 1, unknown: 0, unchanged: 20 });
  await writeFile(path.join(f.root, names[20]), 'original');
  await unlink(path.join(f.root, names[0]));
  await writeFile(path.join(f.other, 'protected.txt'), 'original');
  await link(path.join(f.other, 'protected.txt'), path.join(f.root, names[0]));
  const protectedRead = (await f.tasks.read({ workspace_id: 'default', task_id: task.task_id })).freshness!;
  assert.equal(protectedRead.state, 'unknown'); assert.equal(protectedRead.tracked_files[0].reason, 'PATH_DENIED');
  assert.equal(protectedRead.tracked_files[0].current_sha256, undefined);
});
