import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import childProcess from 'node:child_process';
import { LocalCopyService, type LocalCopyInput } from '../src/local-copy.js';
import { FileService, hash } from '../src/filesystem.js';
import { StateStore } from '../src/store.js';
import { defaultConfig } from '../src/config.js';
import { WorkspacePaths } from '../src/paths.js';
import type { AppConfig } from '../src/types.js';

async function fixture(t: TestContext) {
  const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'webcodex-local-copy-'));
  const root = path.join(base, 'destination'), source = path.join(base, 'source');
  await fs.mkdir(root); await fs.mkdir(source);
  const configPath = path.join(base, 'config.json'), config: AppConfig = { ...defaultConfig(root, configPath), configPath };
  config.workspaces.push({ ...config.workspaces[0], id: 'source', root: source, name: 'Read-only source', readOnly: true });
  const store = new StateStore(config.stateDir), ctx = { config, store, paths: new WorkspacePaths(config) }, files = new FileService(ctx);
  t.after(async () => { store.close(); const actual = await fs.realpath(base); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-local-copy-')); await fs.rm(actual, { recursive: true, force: true }); });
  return { root, source, config, ctx, store, files, service: new LocalCopyService(ctx, files) };
}
const original = () => Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('COPY-PRIVATE-CONTENT-原文件\r\n')]);
const request = (bytes: Buffer, key = 'local-copy'): LocalCopyInput => ({ workspace_id: 'default', path: '复制结果-🙂.bin', source_workspace_id: 'source', source_path: '源文件.bin', expected_source_sha256: hash(bytes), expected_sha256: null, idempotency_key: key });
async function prepare(t: TestContext, bytes = original()) {
  const f = await fixture(t), input = request(bytes);
  await fs.writeFile(path.join(f.source, input.source_path), bytes);
  return { ...f, bytes, input };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Local copy lock did not complete')), 8_000); })]); }
  finally { clearTimeout(timer!); }
}

test('copies exact binary bytes from a read-only workspace without network, commands or content disclosure', async t => {
  const f = await prepare(t);
  for (const target of [https, http]) t.mock.method(target, 'request', () => { assert.fail('Local copy must not use the network'); });
  t.mock.method(childProcess, 'spawn', () => { assert.fail('Local copy must not execute commands'); });
  const saved = await f.service.copy(f.input);
  assert.equal(f.config.execution.mode, 'disabled'); assert.equal(saved.verified, true); assert.equal(saved.source, 'local_workspace');
  assert.equal(saved.sha256, hash(f.bytes)); assert.equal(saved.source_sha256, hash(f.bytes)); assert.equal(saved.size_bytes, f.bytes.length);
  assert.equal(saved.content_processing, 'none'); assert.deepEqual(await fs.readFile(path.join(f.root, f.input.path)), f.bytes);
  assert.deepEqual(await fs.readFile(path.join(f.source, f.input.source_path)), f.bytes);
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_copy', idempotency_key: f.input.idempotency_key });
  assert.equal(status.stage, 'done'); assert.equal(status.current_observation!.sha256, hash(f.bytes)); assert.equal(status.receipt.change_id, saved.change_id);
  assert.equal('changes' in status && status.changes?.[0].change_id, saved.change_id);
  assert.deepEqual(f.store.db.prepare('SELECT tool FROM file_operations').all().map(row => row.tool), ['fs_copy']);
  const diagnostic = JSON.stringify({ saved, status, journal: f.store.db.prepare('SELECT * FROM file_operations').all(), audit: f.store.db.prepare('SELECT * FROM audit_events').all() });
  assert.ok(!diagnostic.includes('COPY-PRIVATE-CONTENT')); assert.ok(!diagnostic.includes(f.bytes.toString('base64')));
});

test('text and empty files retain their exact bytes, BOM and newlines', async t => {
  for (const bytes of [Buffer.from('\ufeff中文\r\nsecond\n'), Buffer.alloc(0)]) {
    const f = await prepare(t, bytes), saved = await f.service.copy(f.input);
    assert.equal(saved.size_bytes, bytes.length); assert.equal(saved.sha256, hash(bytes));
    assert.deepEqual(await fs.readFile(path.join(f.root, f.input.path)), bytes);
  }
});

test('copies can exceed the text limit but never the configured binary limit', async t => {
  const f = await prepare(t, Buffer.alloc(4096, 7)); f.config.limits.writeMaxBytes = 1; f.config.limits.binaryWriteMaxBytes = 4096;
  await f.service.copy(f.input);
  f.config.limits.binaryWriteMaxBytes = 4095;
  await assert.rejects(f.service.copy({ ...f.input, path: 'too-large.bin', idempotency_key: 'too-large' }), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(fs.stat(path.join(f.root, 'too-large.bin')), { code: 'ENOENT' });
});

test('both source and destination path policy reject escape, URLs, absolute paths and protected files', async t => {
  const f = await prepare(t);
  for (const denied of ['../outside.bin', '.env', '.webcodex/private.bin', '.git/config', 'https://example.com/file', 'sandbox:/mnt/data/file', path.join(f.root, 'absolute.bin')]) {
    await assert.rejects(f.service.copy({ ...f.input, path: denied }), { code: 'PATH_DENIED' });
    await assert.rejects(f.service.copy({ ...f.input, source_path: denied }), { code: 'PATH_DENIED' });
  }
  await assert.rejects(f.service.copy({ ...f.input, path: 'missing/file.bin' }), { code: 'ENOENT' });
  await assert.rejects(f.service.copy({ ...f.input, source_workspace_id: 'absent' }), { code: 'WORKSPACE_NOT_FOUND' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM file_operations').get()!.n, 0);
});

test('disabled workspaces and a read-only destination cannot be copied into', async t => {
  const f = await prepare(t); f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.service.copy(f.input), { code: 'READ_ONLY' });
  f.config.workspaces[0].readOnly = false; f.config.workspaces[1].enabled = false;
  await assert.rejects(f.service.copy(f.input), { code: 'WORKSPACE_DISABLED' });
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM file_operations').get()!.n, 0);
});

test('invalid hashes, source version conflicts and destination conflicts leave existing bytes untouched', async t => {
  const f = await prepare(t), previous = Buffer.from([9, 0, 8]), target = path.join(f.root, f.input.path);
  await fs.writeFile(target, previous);
  await assert.rejects(f.service.copy({ ...f.input, expected_source_sha256: 'invalid' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.service.copy({ ...f.input, expected_sha256: 'invalid' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.service.copy({ ...f.input, expected_source_sha256: '0'.repeat(64), idempotency_key: 'source-conflict' }), { code: 'SOURCE_VERSION_CONFLICT' });
  await assert.rejects(f.service.copy({ ...f.input, idempotency_key: 'create-only' }), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(await fs.readFile(target), previous);
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_copy', idempotency_key: 'source-conflict' });
  assert.equal(status.stage, 'failed'); assert.equal(status.retryable, false);
});

test('overwrite has a durable before-image and supports exact restoration', async t => {
  const f = await prepare(t), previous = Buffer.from([9, 0, 8]), target = path.join(f.root, f.input.path);
  await fs.writeFile(target, previous);
  const saved = await f.service.copy({ ...f.input, expected_sha256: hash(previous) });
  assert.deepEqual(await fs.readFile(target), f.bytes);
  const diff = await f.files.changeDiff({ workspace_id: 'default', change_id: saved.change_id! });
  assert.equal(diff.diff_kind, 'binary'); assert.equal(diff.restore_sha256, hash(previous));
  await f.files.restore({ workspace_id: 'default', change_id: saved.change_id!, expected_sha256: saved.sha256!, idempotency_key: 'restore-copy' });
  assert.deepEqual(await fs.readFile(target), previous);
});

test('idempotent replay is historical even after source deletion or destination edits; changed requests conflict', async t => {
  const f = await prepare(t), saved = await f.service.copy(f.input), target = path.join(f.root, f.input.path);
  await fs.unlink(path.join(f.source, f.input.source_path)); await fs.writeFile(target, 'external edit');
  assert.deepEqual(await f.service.copy({ ...f.input, expected_source_sha256: f.input.expected_source_sha256.toUpperCase() }), saved);
  assert.equal(await fs.readFile(target, 'utf8'), 'external edit');
  await assert.rejects(f.service.copy({ ...f.input, expected_source_sha256: '0'.repeat(64) }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.service.copy({ ...f.input, path: 'other.bin' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await f.files.changesList({ workspace_id: 'default' })).changes.length, 1);
});

test('same paths and filesystem path aliases are rejected without deadlocking', async t => {
  const f = await prepare(t); f.config.workspaces[1].readOnly = false;
  await assert.rejects(bounded(f.service.copy({ ...f.input, workspace_id: 'source', path: './源文件.bin' })), { code: 'COPY_SAME_PATH' });
  const absolute = path.join(f.source, f.input.source_path);
  // Model a Windows short-name alias without depending on per-volume 8.3 settings.
  const alias = path.join(f.source, 'SOURC~1.BIN'), realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => String(args[0]) === alias ? absolute : realpath(...args));
  let entered = 0;
  await bounded(f.files.withPathsLocked([absolute, alias], async () => { entered++; }));
  assert.equal(entered, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM file_operations').get()!.n, 0);
});

test('opposite-direction concurrent copies acquire the same lock order and cannot silently copy stale source bytes', async t => {
  const f = await prepare(t), other = Buffer.from([0, 10]); f.config.workspaces[1].readOnly = false;
  await fs.writeFile(path.join(f.root, f.input.path), other);
  const reverse: LocalCopyInput = { workspace_id: 'source', path: f.input.source_path, source_workspace_id: 'default', source_path: f.input.path,
    expected_source_sha256: hash(other), expected_sha256: hash(f.bytes), idempotency_key: 'reverse' };
  const results = await bounded(Promise.allSettled([f.service.copy({ ...f.input, expected_sha256: hash(other) }), f.service.copy(reverse)]));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(['SOURCE_VERSION_CONFLICT', 'VERSION_CONFLICT'].includes(failure.reason.code));
});

test('source edits after preparation are checked again before destination mutation', async t => {
  const f = await prepare(t), writeBytes = f.files.writeBytes.bind(f.files);
  t.mock.method(f.files, 'writeBytes', async (...args: Parameters<typeof writeBytes>) => {
    await fs.writeFile(path.join(f.source, f.input.source_path), 'changed source'); return writeBytes(...args);
  });
  await assert.rejects(f.service.copy(f.input), { code: 'SOURCE_VERSION_CONFLICT' });
  assert.deepEqual(await fs.readdir(f.root), []);
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_copy', idempotency_key: f.input.idempotency_key });
  assert.equal(status.stage, 'failed'); assert.equal(status.receipt, null);
});

test('source changes while staging temporary output stop commit and preserve existing destination', async t => {
  const f = await prepare(t), previous = Buffer.from([0, 17]), target = path.join(f.root, f.input.path), open = fs.open.bind(fs);
  await fs.writeFile(target, previous);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes('.webcodex-write-')) await fs.writeFile(path.join(f.source, f.input.source_path), 'changed during staging');
    return handle;
  });
  await assert.rejects(f.service.copy({ ...f.input, expected_sha256: hash(previous) }), { code: 'SOURCE_VERSION_CONFLICT' });
  assert.deepEqual(await fs.readFile(target), previous);
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_copy', idempotency_key: f.input.idempotency_key });
  assert.equal(status.stage, 'failed'); assert.equal('changes' in status && status.changes?.[0].status, 'failed');
  assert.deepEqual(await fs.readdir(f.root), [f.input.path]);
});

test('both workspace bindings are rechecked on receipt replay and before commit', async t => {
  for (const index of [0, 1]) {
    const f = await prepare(t); await f.service.copy(f.input);
    const previousUid = f.config.workspaces[index].uid; f.config.workspaces[index].uid = 'changed-identity';
    await assert.rejects(f.service.copy(f.input), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
    f.config.workspaces[index].uid = previousUid;
  }
  const f = await prepare(t), writeBytes = f.files.writeBytes.bind(f.files), previousRoot = f.config.workspaces[1].root;
  t.mock.method(f.files, 'writeBytes', async (...args: Parameters<typeof writeBytes>) => {
    f.config.workspaces[1].root = f.root; return writeBytes(...args);
  });
  await assert.rejects(f.service.copy(f.input), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  f.config.workspaces[1].root = previousRoot; assert.deepEqual(await fs.readdir(f.root), []);
});

test('post-write uncertainty has change linkage and is never automatically replayed', async t => {
  const f = await prepare(t), previous = Buffer.from([0, 17]), target = path.join(f.root, f.input.path), rename = fs.rename.bind(fs);
  await fs.writeFile(target, previous);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => { await rename(...args); if (args[1] === target) await fs.writeFile(target, 'external replacement'); });
  const input = { ...f.input, expected_sha256: hash(previous) };
  await assert.rejects(f.service.copy(input), { code: 'FILE_WRITE_VERIFICATION_FAILED' });
  await assert.rejects(f.service.copy(input), { code: 'EXECUTION_UNKNOWN' });
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_copy', idempotency_key: f.input.idempotency_key });
  assert.equal(status.stage, 'unknown'); assert.equal(status.receipt, null); assert.equal('changes' in status && status.changes?.[0].status, 'unknown');
  assert.equal(await fs.readFile(target, 'utf8'), 'external replacement');
});

test('copy receipts survive store reopening and bind the original source workspace registration', async t => {
  const f = await prepare(t), saved = await f.service.copy(f.input); f.store.close();
  const reopened = new StateStore(f.config.stateDir);
  try {
    const ctx = { config: f.config, store: reopened, paths: new WorkspacePaths(f.config) }, files = new FileService(ctx);
    assert.deepEqual(await new LocalCopyService(ctx, files).copy(f.input), saved);
    assert.equal((await files.operationStatus({ workspace_id: 'default', tool: 'fs_copy', idempotency_key: f.input.idempotency_key })).stage, 'done');
  } finally { reopened.close(); }
  const replacementRoot = path.join(path.dirname(f.source), 'different-source');
  await fs.mkdir(replacementRoot); await fs.writeFile(path.join(replacementRoot, f.input.source_path), f.bytes);
  f.config.workspaces[1].root = replacementRoot;
  const rebound = new StateStore(f.config.stateDir);
  try {
    const ctx = { config: f.config, store: rebound, paths: new WorkspacePaths(f.config) }, files = new FileService(ctx);
    await assert.rejects(new LocalCopyService(ctx, files).copy(f.input), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal((await files.changesList({ workspace_id: 'default' })).changes.length, 1);
  } finally { rebound.close(); }
});

test('a lost completion receipt and an abandoned committing phase reopen as unknown without recopying', async t => {
  const f = await prepare(t), prepareStatement = f.store.db.prepare.bind(f.store.db); let fail = true;
  t.mock.method(f.store.db, 'prepare', (sql: string) => {
    if (fail && sql.startsWith("UPDATE file_operations SET stage='done'")) { fail = false; throw new Error('Synthetic copy receipt failure'); }
    return prepareStatement(sql);
  });
  await assert.rejects(f.service.copy(f.input), /Synthetic copy receipt failure/);
  const input = { workspace_id: 'default', tool: 'fs_copy' as const, idempotency_key: f.input.idempotency_key };
  assert.equal((await f.files.operationStatus(input)).stage, 'unknown');
  // Model a process exit after the destination committed but before a final row.
  f.store.db.prepare("UPDATE file_operations SET stage='committing' WHERE tool='fs_copy'").run(); f.store.close();
  const reopened = new StateStore(f.config.stateDir);
  try {
    const ctx = { config: f.config, store: reopened, paths: new WorkspacePaths(f.config) }, files = new FileService(ctx);
    const status = await files.operationStatus(input);
    assert.equal(status.stage, 'unknown'); assert.equal(status.receipt, null);
    assert.equal('changes' in status && status.changes?.[0].status, 'applied');
    await assert.rejects(new LocalCopyService(ctx, files).copy(f.input), { code: 'EXECUTION_UNKNOWN' });
    assert.deepEqual(await fs.readFile(path.join(f.root, f.input.path)), f.bytes);
    assert.equal((await files.changesList({ workspace_id: 'default' })).changes.length, 1);
  } finally { reopened.close(); }
});

test('directories, missing sources and hard links are not copied', async t => {
  const f = await prepare(t);
  await assert.rejects(f.service.copy({ ...f.input, source_path: '.' }), { code: 'NOT_A_FILE' });
  await assert.rejects(f.service.copy({ ...f.input, source_path: 'missing.bin', idempotency_key: 'missing' }), { code: 'ENOENT' });
  await fs.link(path.join(f.source, f.input.source_path), path.join(f.source, 'hard-link.bin'));
  await assert.rejects(f.service.copy({ ...f.input, source_path: 'hard-link.bin', idempotency_key: 'hard-link' }), { code: 'PATH_DENIED' });
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('source and destination symlinks are denied where the OS permits creating them', async t => {
  const f = await prepare(t), sourceLink = path.join(f.source, 'symbolic.bin');
  try { await fs.symlink(path.join(f.source, f.input.source_path), sourceLink); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Windows process lacks permission to create symbolic links'); return; } throw error; }
  await assert.rejects(f.service.copy({ ...f.input, source_path: 'symbolic.bin' }), { code: 'PATH_DENIED' });
  await fs.symlink(path.join(f.source, f.input.source_path), path.join(f.root, 'symbolic.bin'));
  await assert.rejects(f.service.copy({ ...f.input, path: 'symbolic.bin' }), { code: 'PATH_DENIED' });
});
