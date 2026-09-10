import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '../src/config.js';
import { WorkspacePaths } from '../src/paths.js';
import { StateStore } from '../src/store.js';
import { FileService } from '../src/filesystem.js';
import { JobService } from '../src/jobs.js';
import { GitService } from '../src/git.js';
import { CheckpointService } from '../src/checkpoints.js';
import { initializeIdentity } from '../src/identity.js';
import type { AppConfig, ServiceContext } from '../src/types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type PortableConfig = AppConfig & { device?: { id: string; name: string }; workspaces: Array<AppConfig['workspaces'][number] & { uid?: string }> };

function openRuntime(config: PortableConfig) {
  const store = new StateStore(config.stateDir);
  const ctx: ServiceContext = { config, store, paths: new WorkspacePaths(config) };
  try {
    const identity = initializeIdentity(ctx);
    const files = new FileService(ctx);
    const jobs = new JobService(ctx);
    const checkpoints = new CheckpointService(ctx, files, new GitService(ctx));
    return { ctx, store, identity, files, jobs, checkpoints, close: async () => { await jobs.close(); store.close(); } };
  } catch (error) { store.close(); throw error; }
}

async function fixture(t: TestContext, prepare?: (config: PortableConfig) => Promise<void>) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-identity-'));
  const root = path.join(base, 'project-a');
  const other = path.join(base, 'project-b');
  await Promise.all([mkdir(root), mkdir(other)]);
  const configPath = path.join(base, 'config.json');
  const config: PortableConfig = { ...defaultConfig(root, configPath), configPath };
  config.execution.mode = 'trusted-host';
  let runtime: ReturnType<typeof openRuntime> | undefined;
  t.after(async () => {
    try { await runtime?.close(); }
    finally {
      const resolved = await realpath(base);
      assert.equal(path.dirname(resolved), parent);
      assert.ok(path.basename(resolved).startsWith('webcodex-identity-'));
      await rm(resolved, { recursive: true, force: true });
    }
  });
  await prepare?.(config);
  runtime = openRuntime(config);
  return { base, root, other, config, get runtime() { return runtime!; }, restart: async (next = config) => {
    await runtime!.close();
    runtime = openRuntime(next);
    return runtime;
  } };
}

async function ended(jobs: JobService, id: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = jobs.poll({ workspace_id: 'default', job_id: id });
    if (!['queued', 'running'].includes(result.status)) return result;
    await delay(10);
  }
  throw new Error('Synthetic job did not finish.');
}

const jobInput = (key: string) => ({ workspace_id: 'default', executable: 'node', args: ['-e', 'process.stdout.write(process.cwd())'], idempotency_key: key });
const checkpointInput = (key: string) => ({ workspace_id: 'default', objective: 'Synthetic task', progress: 'Inspecting a fixture', next_steps: 'Run fixture checks', expected_sha256: null as string | null, idempotency_key: key });

test('v1 fresh state keeps device, workspace identity and retries stable across restarts', async t => {
  const f = await fixture(t);
  const source = f.runtime.identity.workspaceSource('default');
  const input = { workspace_id: 'default', path: 'file.txt', content: 'one', expected_sha256: null, idempotency_key: 'stable-write' };
  const change = await f.runtime.files.write(input);
  const job = await f.runtime.jobs.start(jobInput('stable-job'));
  assert.equal((await ended(f.runtime.jobs, job.job_id)).status, 'succeeded');
  const note = await f.runtime.checkpoints.save({ ...checkpointInput('stable-checkpoint'), job_ids: [job.job_id] });
  await f.restart();
  assert.deepEqual(f.runtime.identity.workspaceSource('default'), source);
  assert.deepEqual(await f.runtime.files.write(input), change);
  assert.equal((await f.runtime.jobs.start(jobInput('stable-job'))).job_id, job.job_id);
  assert.equal((await f.runtime.checkpoints.save({ ...checkpointInput('stable-checkpoint'), job_ids: [job.job_id] })).change_id, note.change_id);
  assert.equal((await f.runtime.files.changesList({ workspace_id: 'default' })).changes.length, 2);
});

test('reusing a v1 alias for another root isolates old changes, jobs and cached successes', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'same.txt'), 'A-before');
  await writeFile(path.join(f.other, 'same.txt'), 'B-before');
  const input = { workspace_id: 'default', path: 'same.txt', content: 'A-after', expected_sha256: hash('A-before'), idempotency_key: 'same-key' };
  const change = await f.runtime.files.write(input);
  const firstJob = await f.runtime.jobs.start(jobInput('same-job-key'));
  await ended(f.runtime.jobs, firstJob.job_id);
  const originalIdentity = f.runtime.identity.workspaceIdentity('default');
  const next = structuredClone(f.config);
  next.workspaces[0].root = f.other;
  await f.restart(next);
  assert.notEqual(f.runtime.identity.workspaceIdentity('default'), originalIdentity);
  await assert.rejects(f.runtime.files.write(input), { code: 'VERSION_CONFLICT' });
  assert.equal(await readFile(path.join(f.other, 'same.txt'), 'utf8'), 'B-before');
  assert.equal((await f.runtime.files.changesList({ workspace_id: 'default' })).changes.length, 0);
  assert.deepEqual(f.runtime.jobs.list({ workspace_id: 'default' }), { jobs: [] });
  assert.throws(() => f.runtime.jobs.poll({ workspace_id: 'default', job_id: firstJob.job_id }), { code: 'JOB_NOT_FOUND' });
  await assert.rejects(f.runtime.checkpoints.save({ ...checkpointInput('old-job-facts'), job_ids: [firstJob.job_id] }), { code: 'JOB_NOT_FOUND' });
  await writeFile(path.join(f.other, 'same.txt'), 'A-after');
  await assert.rejects(f.runtime.files.changeDiff({ workspace_id: 'default', change_id: change.change_id! }), { code: 'CHANGE_NOT_FOUND' });
  await assert.rejects(f.runtime.files.restore({ workspace_id: 'default', change_id: change.change_id!, expected_sha256: change.sha256, idempotency_key: 'old-restore' }), { code: 'CHANGE_NOT_FOUND' });
  assert.equal(await readFile(path.join(f.other, 'same.txt'), 'utf8'), 'A-after');
  const secondJob = await f.runtime.jobs.start(jobInput('same-job-key'));
  assert.notEqual(secondJob.job_id, firstJob.job_id);
  assert.equal((await ended(f.runtime.jobs, secondJob.job_id)).output.map(chunk => chunk.text).join(''), f.other);
  assert.equal(f.runtime.store.db.prepare('SELECT before_sha256 FROM file_changes WHERE id=?').get(change.change_id!)!.before_sha256, hash('A-before'));
});

test('v2 binds device and workspace UID to state, and a new UID starts separate history', async t => {
  const f = await fixture(t, async config => {
    Object.assign(config, { version: 2, device: { id: randomUUID(), name: 'Device A' } });
    config.workspaces[0].uid = randomUUID();
  });
  const input = { workspace_id: 'default', path: 'item.txt', content: 'value', expected_sha256: null, idempotency_key: 'v2-write' };
  const change = await f.runtime.files.write(input);
  const before = f.runtime.identity.workspaceSource('default');
  const wrongDevice = structuredClone(f.config);
  wrongDevice.device!.id = randomUUID();
  await assert.rejects(f.restart(wrongDevice), { code: 'STATE_DEVICE_MISMATCH' });
  const moved = structuredClone(f.config);
  moved.workspaces[0].root = f.other;
  await assert.rejects(f.restart(moved), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  await f.restart();
  assert.deepEqual(f.runtime.identity.workspaceSource('default'), before);
  assert.deepEqual(await f.runtime.files.write(input), change);
  const rebound = structuredClone(f.config);
  rebound.workspaces[0].uid = randomUUID();
  await f.restart(rebound);
  assert.equal((await f.runtime.files.changesList({ workspace_id: 'default' })).changes.length, 0);
  await assert.rejects(f.runtime.files.write(input), { code: 'VERSION_CONFLICT' });
  await assert.rejects(f.runtime.files.restore({ workspace_id: 'default', change_id: change.change_id!, expected_sha256: change.sha256, idempotency_key: 'wrong-instance-restore' }), { code: 'CHANGE_NOT_FOUND' });
});

test('v1 to v2 migration preserves explicit persisted device and root UIDs', async t => {
  const f = await fixture(t);
  const source = f.runtime.identity.workspaceSource('default');
  const input = { workspace_id: 'default', path: 'migrate.txt', content: 'keep', expected_sha256: null, idempotency_key: 'migration-write' };
  const change = await f.runtime.files.write(input);
  const migrated = structuredClone(f.config);
  Object.assign(migrated, { version: 2, device: { id: source.device_id, name: 'Migrated device' } });
  migrated.workspaces[0].uid = source.workspace_uid;
  await f.restart(migrated);
  assert.deepEqual(await f.runtime.files.write(input), change);
  assert.equal(f.runtime.identity.workspaceSource('default').workspace_uid, source.workspace_uid);
  assert.equal(f.runtime.identity.source().device_name, 'Migrated device');
});

test('legacy state is retained unbound; old records and operation keys are never adopted', async t => {
  const oldWrite = { workspace_id: 'default', path: 'legacy.txt', content: 'legacy-after', expected_sha256: hash('legacy-before'), idempotency_key: 'legacy-write' };
  const f = await fixture(t, async config => {
    const store = new StateStore(config.stateDir);
    try {
      store.db.exec(`CREATE TABLE file_changes (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL, before_blob BLOB,
        before_sha256 TEXT, after_sha256 TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, restores_id TEXT, error TEXT
      ); CREATE TABLE webcodex_jobs (
        job_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, executable_alias TEXT NOT NULL, args_json TEXT NOT NULL,
        cwd TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
        timeout_ms INTEGER NOT NULL, pid INTEGER, exit_code INTEGER, signal TEXT,
        output_bytes INTEGER NOT NULL DEFAULT 0, output_truncated INTEGER NOT NULL DEFAULT 0, error TEXT
      );`);
      store.db.prepare("INSERT INTO file_changes(id,workspace_id,path,before_blob,before_sha256,after_sha256,status,created_at) VALUES('legacy-change','default','legacy.txt',?,?,?,'applied','legacy')")
        .run(Buffer.from('legacy-before'), hash('legacy-before'), hash('legacy-after'));
      store.db.prepare("INSERT INTO webcodex_jobs(job_id,workspace_id,executable_alias,args_json,cwd,status,created_at,timeout_ms,exit_code) VALUES('legacy-job','default','node','[]','.','succeeded','legacy',60000,0)").run();
      await store.idempotent('local-user/default/fs_write', oldWrite.idempotency_key, oldWrite, async () => ({ changed: true, change_id: 'legacy-change', sha256: hash('legacy-after') }));
      await store.idempotent('exec.start:default', 'legacy-job-key', {}, async () => ({ job_id: 'legacy-job' }));
      await writeFile(path.join(config.workspaces[0].root, 'legacy.txt'), 'legacy-after');
    } finally { store.close(); }
  });
  assert.equal((await f.runtime.files.changesList({ workspace_id: 'default' })).changes.length, 0);
  assert.deepEqual(f.runtime.jobs.list({ workspace_id: 'default' }), { jobs: [] });
  await assert.rejects(f.runtime.files.write(oldWrite), { code: 'LEGACY_OPERATION_UNBOUND' });
  await assert.rejects(f.runtime.jobs.start(jobInput('legacy-job-key')), { code: 'LEGACY_OPERATION_UNBOUND' });
  assert.throws(() => f.runtime.jobs.poll({ workspace_id: 'default', job_id: 'legacy-job' }), { code: 'LEGACY_RECORD_UNBOUND' });
  await assert.rejects(f.runtime.jobs.cancel({ workspace_id: 'default', job_id: 'legacy-job' }), { code: 'LEGACY_RECORD_UNBOUND' });
  await assert.rejects(f.runtime.files.changeDiff({ workspace_id: 'default', change_id: 'legacy-change' }), { code: 'LEGACY_RECORD_UNBOUND' });
  await assert.rejects(f.runtime.files.restore({ workspace_id: 'default', change_id: 'legacy-change', expected_sha256: hash('legacy-after'), idempotency_key: 'legacy-restore' }), { code: 'LEGACY_RECORD_UNBOUND' });
  await assert.rejects(f.runtime.checkpoints.save({ ...checkpointInput('legacy-checkpoint'), job_ids: ['legacy-job'] }), { code: 'LEGACY_RECORD_UNBOUND' });
  const fresh = await f.runtime.files.write({ workspace_id: 'default', path: 'fresh.txt', content: 'fresh', expected_sha256: null, idempotency_key: 'fresh-write' });
  assert.ok(fresh.change_id);
  const old = f.runtime.store.db.prepare("SELECT workspace_binding,before_blob FROM file_changes WHERE id='legacy-change'").get()!;
  assert.equal(old.workspace_binding, null);
  assert.equal(Buffer.from(old.before_blob as Uint8Array).toString(), 'legacy-before');
  assert.equal(f.runtime.store.db.prepare("SELECT workspace_binding FROM webcodex_jobs WHERE job_id='legacy-job'").get()!.workspace_binding, null);
  assert.equal(f.runtime.store.db.prepare('SELECT count(*) AS n FROM operations WHERE scope=?').get('local-user/default/fs_write')!.n, 1);
});

test('live identity edits and current path policy are checked before cached successes', async t => {
  const f = await fixture(t);
  const input = { workspace_id: 'default', path: 'cache.txt', content: 'one', expected_sha256: null, idempotency_key: 'live-cache' };
  await f.runtime.files.write(input);
  const job = await f.runtime.jobs.start(jobInput('live-job'));
  await ended(f.runtime.jobs, job.job_id);
  const note = checkpointInput('live-note');
  await f.runtime.checkpoints.save(note);
  f.config.workspaces[0].root = f.other;
  await assert.rejects(f.runtime.files.write(input), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  await assert.rejects(f.runtime.jobs.start(jobInput('live-job')), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  await assert.rejects(f.runtime.checkpoints.save(note), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  assert.throws(() => f.runtime.jobs.poll({ workspace_id: 'default', job_id: job.job_id }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  f.config.workspaces[0].root = f.root;
  f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.runtime.files.write(input), { code: 'READ_ONLY' });
  await assert.rejects(f.runtime.jobs.start(jobInput('live-job')), { code: 'READ_ONLY' });
  f.config.workspaces[0].readOnly = false;
  f.config.codexSessions.home = f.root;
  await assert.rejects(f.runtime.files.write(input), { code: 'PATH_DENIED' });
  await assert.rejects(f.runtime.jobs.start(jobInput('live-job')), { code: 'PATH_DENIED' });
  f.config.codexSessions.home = null;
  f.config.toolsDir = f.root;
  await assert.rejects(f.runtime.files.write(input), { code: 'PATH_DENIED' });
  assert.throws(() => f.runtime.jobs.list({ workspace_id: 'default' }), { code: 'PATH_DENIED' });
  delete f.config.toolsDir;
  f.config.workspaces[0].uid = randomUUID();
  await assert.rejects(f.runtime.files.write(input), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  delete f.config.workspaces[0].uid;
  f.config.device = { id: randomUUID(), name: 'Unexpected device' };
  await assert.rejects(f.runtime.files.write(input), { code: 'STATE_DEVICE_MISMATCH' });
  delete f.config.device;
});

test('root junction replacement preserves the existing path-policy error', async t => {
  const f = await fixture(t);
  const input = { workspace_id: 'default', path: 'root.txt', content: 'one', expected_sha256: null, idempotency_key: 'root-cache' };
  await f.runtime.files.write(input);
  const original = path.join(f.base, 'original-project-a');
  await rename(f.root, original);
  try {
    await symlink(f.other, f.root, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.runtime.files.write(input), { code: 'PATH_DENIED' });
    assert.throws(() => f.runtime.jobs.list({ workspace_id: 'default' }), { code: 'PATH_DENIED' });
  } finally {
    await unlink(f.root).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    await rename(original, f.root);
  }
});

test('restoration retries recheck newly protected paths and jobs use configured default timeout', async t => {
  const f = await fixture(t);
  const protectedFolder = path.join(f.root, 'later-protected');
  await mkdir(protectedFolder);
  await writeFile(path.join(protectedFolder, 'file.txt'), 'before');
  const changed = await f.runtime.files.write({ workspace_id: 'default', path: 'later-protected/file.txt', content: 'after', expected_sha256: hash('before'), idempotency_key: 'protect-write' });
  const restore = { workspace_id: 'default', change_id: changed.change_id!, expected_sha256: changed.sha256, idempotency_key: 'protect-restore' };
  await f.runtime.files.restore(restore);
  f.config.codexSessions.home = protectedFolder;
  await assert.rejects(f.runtime.files.restore(restore), { code: 'PATH_DENIED' });
  f.config.codexSessions.home = null;
  Object.assign(f.config.execution, { defaultTimeoutMs: 12345 });
  const job = await f.runtime.jobs.start(jobInput('configured-timeout'));
  assert.equal(job.timeout_ms, 12345);
  await ended(f.runtime.jobs, job.job_id);
});
