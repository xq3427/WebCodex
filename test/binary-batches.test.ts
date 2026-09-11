import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppError } from '../src/errors.js';
import { defaultConfig } from '../src/config.js';
import { FileBatchService, type FileBatchChange } from '../src/file-batches.js';
import { FileImportService } from '../src/file-import.js';
import { FileService, hash } from '../src/filesystem.js';
import { WorkspacePaths } from '../src/paths.js';
import { StateStore } from '../src/store.js';
import type { AppConfig } from '../src/types.js';

const MiB = 1024 * 1024;
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const text = (name: string, content: string): FileBatchChange => ({ op: 'write', path: name, content, expected_sha256: null });
const file = (op: 'move' | 'copy', name: string, to: string, bytes: Buffer): FileBatchChange => ({ op, path: name, to, expected_sha256: hash(bytes) });
const remove = (name: string, bytes: Buffer): FileBatchChange => ({ op: 'delete', path: name, expected_sha256: hash(bytes) });

async function fixture(t: TestContext) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'webcodex-binary-batch-'));
  const root = path.join(folder, 'project'); await fs.mkdir(root);
  const configPath = path.join(folder, 'config.json');
  const config: AppConfig = { ...defaultConfig(root, configPath), configPath };
  let ctx = { config, paths: new WorkspacePaths(config), store: new StateStore(config.stateDir) };
  const files = new FileService(ctx), batches = new FileBatchService(ctx, files);
  t.after(async () => {
    ctx.store.close();
    const actual = await fs.realpath(folder);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-binary-batch-'));
    await fs.rm(actual, { recursive: true, force: true });
  });
  return { root, config, ctx, files, batches, reopen: () => {
    ctx.store.close(); ctx = { config, paths: new WorkspacePaths(config), store: new StateStore(config.stateDir) };
    const files = new FileService(ctx);
    return { ctx, files, batches: new FileBatchService(ctx, files) };
  } };
}

async function apply(batches: FileBatchService, changes: FileBatchChange[], idempotency_key: string) {
  const preview = await batches.preview({ workspace_id: 'default', changes });
  const request = { workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key };
  return { preview, request, result: await batches.apply(request) };
}

for (const size of [10 * MiB, 32 * MiB]) test(`${size / MiB} MiB import, copy, move, delete and restore preserve original bytes with execution disabled`, async t => {
  const f = await fixture(t), bytes = Buffer.alloc(size, 0xa5); Buffer.from('二进制文件\0\r\n').copy(bytes);
  const importer = new FileImportService(f.ctx, f.files, async () => bytes);
  const imported = await importer.import({ workspace_id: 'default', path: '原件.pptx', expected_sha256: null, idempotency_key: 'import-large',
    file: { download_url: 'https://files.oaiusercontent.com/synthetic', file_id: 'synthetic-large-file' } });
  assert.equal(f.config.execution.mode, 'disabled'); assert.equal(imported.size_bytes, size);
  const copied = await apply(f.batches, [file('copy', '原件.pptx', '副本.pptx', bytes)], 'copy-large');
  assert.equal(copied.result.status, 'applied'); assert.equal(copied.preview.total_bytes, size * 2);
  assert.equal(copied.preview.text_total_bytes, 0); assert.equal(copied.preview.path_count, 2);
  assert.equal(copied.preview.changes[0].diff_kind, 'binary'); assert.equal(copied.preview.changes[0].diff, '');
  assert.equal(copied.preview.changes[0].diff_truncated, false);
  assert.equal(copied.result.steps[1].status, 'unchanged'); assert.equal(copied.result.steps[1].change_id, null);
  assert.equal((await f.files.stat({ workspace_id: 'default', path: '副本.pptx' })).sha256, hash(bytes));
  assert.deepEqual(await fs.readFile(path.join(f.root, '原件.pptx')), bytes);
  assert.equal((await fs.stat(path.join(f.root, '副本.pptx'))).mode & 0o777, (await fs.stat(path.join(f.root, '原件.pptx'))).mode & 0o777);
  assert.deepEqual(await f.batches.apply(copied.request), copied.result);
  const copyStatus = await f.batches.status({ workspace_id: 'default', idempotency_key: 'copy-large' });
  assert.ok(copyStatus.exists && copyStatus.observations.every(item => ['after', 'both'].includes(item.matches)));
  const moved = await apply(f.batches, [file('move', '副本.pptx', '已移动.pptx', bytes)], 'move-large');
  assert.equal(moved.result.status, 'applied'); await assert.rejects(fs.stat(path.join(f.root, '副本.pptx')), code('ENOENT'));
  assert.deepEqual(await f.batches.apply(moved.request), moved.result);
  const deleted = await apply(f.batches, [remove('已移动.pptx', bytes)], 'delete-large');
  assert.equal(deleted.result.status, 'applied'); await assert.rejects(fs.stat(path.join(f.root, '已移动.pptx')), code('ENOENT'));
  const changeId = deleted.result.steps[0].change_id!;
  const restorePreview = await f.files.changeDiff({ workspace_id: 'default', change_id: changeId });
  assert.equal(restorePreview.diff_kind, 'binary'); assert.equal(restorePreview.restore_size_bytes, size);
  await f.files.restore({ workspace_id: 'default', change_id: changeId, expected_sha256: null, idempotency_key: 'restore-large' });
  assert.deepEqual(await fs.readFile(path.join(f.root, '已移动.pptx')), bytes);
  assert.ok(f.ctx.store.db.prepare('SELECT write_kind FROM file_changes').all().every(row => row.write_kind === 'bytes'));
});

test('large ASCII PDF move/copy/delete previews are metadata, not decoded or diffed content', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(16 * MiB, 65); Buffer.from('%PDF-1.7\nDO_NOT_RETURN_DOCUMENT_TEXT').copy(bytes);
  await fs.writeFile(path.join(f.root, 'large.pdf'), bytes);
  for (const change of [file('copy', 'large.pdf', 'copy.pdf', bytes), file('move', 'large.pdf', 'move.pdf', bytes), remove('large.pdf', bytes)]) {
    const preview = await f.batches.preview({ workspace_id: 'default', changes: [change], max_bytes: 1 });
    assert.equal(preview.changes[0].diff_kind, 'binary'); assert.equal(preview.returned_diff_bytes, 0);
    assert.equal(preview.truncated, false); assert.equal(JSON.stringify(preview).includes('DO_NOT_RETURN_DOCUMENT_TEXT'), false);
  }
});

test('text sub-budget and combined binary budget remain independent in mixed batches', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(2048, 0);
  await fs.writeFile(path.join(f.root, 'source.bin'), bytes);
  f.config.fileBatches = { maxFiles: 10, maxTotalBytes: 4096, binaryMaxTotalBytes: 8192 };
  f.config.limits.writeMaxBytes = 4096;
  await assert.rejects(f.batches.preview({ workspace_id: 'default', changes: [text('a', 'a'.repeat(3000)), text('b', 'b'.repeat(3000))] }), code('BATCH_TOO_LARGE'));
  await assert.rejects(f.batches.preview({ workspace_id: 'default', changes: [text('a', 'a'.repeat(3000)), text('b', 'b'.repeat(3000)), remove('source.bin', bytes)] }), code('BATCH_TOO_LARGE'));
  const changes = [text('a', 'a'.repeat(3000)), file('copy', 'source.bin', 'copied.bin', bytes)];
  const preview = await f.batches.preview({ workspace_id: 'default', changes });
  assert.equal(preview.total_bytes, 7096); assert.equal(preview.text_total_bytes, 3000); assert.equal(preview.byte_operation_total_bytes, 4096);
  f.config.fileBatches.binaryMaxTotalBytes = 6000;
  await assert.rejects(f.batches.preview({ workspace_id: 'default', changes }), code('BATCH_TOO_LARGE'));
  // Pure text operations keep their own budget even when a byte-only policy is lower.
  f.config.fileBatches.binaryMaxTotalBytes = 1024;
  assert.equal((await f.batches.preview({ workspace_id: 'default', changes: [text('a', 'a'.repeat(3000))] })).total_bytes, 3000);
});

test('byte and text per-file limits cannot be bypassed by choosing another batch operation', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(3072, 1); await fs.writeFile(path.join(f.root, 'source'), bytes);
  f.config.limits.binaryWriteMaxBytes = 2048; f.config.limits.writeMaxBytes = 4096;
  for (const change of [remove('source', bytes), file('copy', 'source', 'copy', bytes), file('move', 'source', 'move', bytes)]) {
    await assert.rejects(f.batches.preview({ workspace_id: 'default', changes: [change] }), code('FILE_TOO_LARGE'));
  }
  f.config.limits.binaryWriteMaxBytes = 8192; f.config.limits.writeMaxBytes = 1024;
  await assert.rejects(f.batches.preview({ workspace_id: 'default', changes: [text('big-text', 'x'.repeat(2048))] }), code('FILE_TOO_LARGE'));
  assert.equal((await f.batches.preview({ workspace_id: 'default', changes: [file('copy', 'source', 'copy', bytes)] })).changes[0].write_kind, 'bytes');
});

test('copy requires an absent destination, independent paths and writable authority', async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255]);
  await fs.writeFile(path.join(f.root, 'source'), bytes); await fs.writeFile(path.join(f.root, 'exists'), bytes);
  await assert.rejects(f.batches.preview({ workspace_id: 'default', changes: [file('copy', 'source', 'exists', bytes)] }), code('VERSION_CONFLICT'));
  await assert.rejects(f.batches.preview({ workspace_id: 'default', changes: [file('copy', 'source', './source', bytes)] }), code('BATCH_PATH_CONFLICT'));
  await assert.rejects(f.batches.preview({ workspace_id: 'default', changes: [file('copy', 'source', 'copy', bytes), remove('copy', bytes)] }), code('BATCH_PATH_CONFLICT'));
  await assert.rejects(f.batches.preview({ workspace_id: 'default', changes: [file('copy', 'source', '../escape', bytes)] }), code('PATH_DENIED'));
  await assert.rejects(f.batches.preview({ workspace_id: 'default', changes: [file('copy', 'source', '.env', bytes)] }), code('PATH_DENIED'));
  const preview = await f.batches.preview({ workspace_id: 'default', changes: [file('copy', 'source', 'copy', bytes)] });
  f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.batches.apply({ workspace_id: 'default', changes: [file('copy', 'source', 'copy', bytes)], expected_plan_sha256: preview.plan_sha256, idempotency_key: 'readonly-copy' }), code('READ_ONLY'));
});

test('copy source is rechecked after earlier mutations and a conflict rolls those mutations back', async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 1, 2]); await fs.writeFile(path.join(f.root, 'source'), bytes);
  const changes = [text('first', 'first'), file('copy', 'source', 'copy', bytes)];
  const preview = await f.batches.preview({ workspace_id: 'default', changes });
  const commit = f.files.commitForBatch.bind(f.files);
  f.files.commitForBatch = async (...args) => {
    const result = await commit(...args);
    if (args[1] === 'first' && args[4] !== null) await fs.writeFile(path.join(f.root, 'source'), 'external');
    return result;
  };
  const result = await f.batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'source-race' });
  assert.equal(result.status, 'rolled_back'); assert.equal(result.error?.code, 'VERSION_CONFLICT');
  await assert.rejects(fs.stat(path.join(f.root, 'copy')), code('ENOENT')); await assert.rejects(fs.stat(path.join(f.root, 'first')), code('ENOENT'));
  assert.equal(await fs.readFile(path.join(f.root, 'source'), 'utf8'), 'external');
});

test('mixed batch rollback restores a 10 MiB deleted original with byte-tagged backups', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(10 * MiB, 0xff); await fs.writeFile(path.join(f.root, 'original.bin'), bytes);
  const changes = [remove('original.bin', bytes), text('fail', 'fail')];
  const preview = await f.batches.preview({ workspace_id: 'default', changes });
  const commit = f.files.commitForBatch.bind(f.files);
  f.files.commitForBatch = async (...args) => { if (args[1] === 'fail') throw new AppError('TEST_FAILURE', 'Synthetic failure.'); return commit(...args); };
  const result = await f.batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'large-rollback' });
  assert.equal(result.status, 'rolled_back'); assert.equal(result.steps[0].write_kind, 'bytes'); assert.ok(result.steps[0].rollback_change_id);
  assert.equal(result.steps[1].write_kind, 'text'); assert.deepEqual(await fs.readFile(path.join(f.root, 'original.bin')), bytes);
  const status = await f.batches.status({ workspace_id: 'default', idempotency_key: 'large-rollback' });
  assert.ok(status.exists && status.observations.every(item => item.matches === 'before'));
});

test('copy acknowledgement uncertainty is partial and cannot remove a potentially saved file', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(4096, 0); await fs.writeFile(path.join(f.root, 'source'), bytes);
  const changes = [file('copy', 'source', 'copy', bytes)]; const preview = await f.batches.preview({ workspace_id: 'default', changes });
  const commit = f.files.commitForBatch.bind(f.files);
  f.files.commitForBatch = async (...args) => { await commit(...args); throw new AppError('TEST_LOST_ACK', 'Synthetic acknowledgement loss.'); };
  const result = await f.batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'copy-unknown' });
  assert.equal(result.status, 'partial'); assert.equal(result.steps[0].status, 'unknown');
  assert.deepEqual(await fs.readFile(path.join(f.root, 'copy')), bytes); assert.deepEqual(await fs.readFile(path.join(f.root, 'source')), bytes);
});

test('plan hashes bind text, binary, combined and path policies before any mutation', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(2048, 0); await fs.writeFile(path.join(f.root, 'source'), bytes);
  const changes = [file('copy', 'source', 'copy', bytes)]; const original = await f.batches.preview({ workspace_id: 'default', changes });
  f.config.fileBatches = { maxFiles: 20, maxTotalBytes: 4 * MiB, binaryMaxTotalBytes: 64 * MiB };
  const changed = await f.batches.preview({ workspace_id: 'default', changes }); assert.notEqual(changed.plan_sha256, original.plan_sha256);
  await assert.rejects(f.batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: original.plan_sha256, idempotency_key: 'changed-policy' }), code('BATCH_PLAN_CONFLICT'));
  f.config.limits.binaryWriteMaxBytes = 16 * MiB;
  assert.notEqual((await f.batches.preview({ workspace_id: 'default', changes })).plan_sha256, changed.plan_sha256);
  await assert.rejects(fs.stat(path.join(f.root, 'copy')), code('ENOENT'));
});

test('byte status observations survive restart and retain byte policy independently from text limits', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(2 * MiB, 0); await fs.writeFile(path.join(f.root, 'source'), bytes);
  const applied = await apply(f.batches, [file('copy', 'source', 'copy', bytes)], 'restart-copy');
  const reopened = f.reopen(); const status = await reopened.batches.status({ workspace_id: 'default', idempotency_key: 'restart-copy' });
  assert.ok(status.exists && status.steps.every(step => step.write_kind === 'bytes'));
  assert.ok(status.exists && status.observations.every(item => ['after', 'both'].includes(item.matches)));
  assert.deepEqual(await reopened.batches.apply(applied.request), applied.result);
  f.config.fileBatches = { maxFiles: 20, maxTotalBytes: 4 * MiB, binaryMaxTotalBytes: MiB };
  const limited = await reopened.batches.status({ workspace_id: 'default', idempotency_key: 'restart-copy' });
  assert.ok(limited.exists && limited.observations.every(item => item.matches === 'unknown'));
  assert.ok(limited.exists && limited.observations[0].error_code === 'FILE_TOO_LARGE');
});
