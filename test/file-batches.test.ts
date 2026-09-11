import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPatch } from 'diff';
import { AppError } from '../src/errors.js';
import { defaultConfig } from '../src/config.js';
import { FileBatchService, type FileBatchChange } from '../src/file-batches.js';
import { FileService, hash } from '../src/filesystem.js';
import { WorkspacePaths } from '../src/paths.js';
import { StateStore } from '../src/store.js';
import type { AppConfig } from '../src/types.js';

const sha = (text: string | Buffer) => hash(typeof text === 'string' ? Buffer.from(text) : text);
const errorCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const write = (name: string, content: string, before: string | null = null): FileBatchChange => ({ op: 'write', path: name, content, expected_sha256: before === null ? null : sha(before) });
async function fixture(t: TestContext) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'webcodex-batch-test-'));
  const root = path.join(folder, 'project');
  await fs.mkdir(root);
  const otherRoot = path.join(folder, 'other-project');
  await fs.mkdir(otherRoot);
  const configPath = path.join(folder, 'config.json');
  const config: AppConfig = { ...defaultConfig(root, configPath), configPath };
  config.workspaces.push({ ...config.workspaces[0], id: 'other', root: otherRoot });
  const context = () => ({ config, paths: new WorkspacePaths(config), store: new StateStore(config.stateDir) });
  let ctx = context();
  const files = new FileService(ctx);
  const batches = new FileBatchService(ctx, files);
  t.after(async () => {
    ctx.store.close();
    const real = await fs.realpath(folder);
    assert.equal(path.dirname(real), parent);
    assert.ok(path.basename(real).startsWith('webcodex-batch-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  return { root, otherRoot, config, ctx, files, batches, reopen: () => { ctx.store.close(); ctx = context(); const files = new FileService(ctx); return { ctx, files, batches: new FileBatchService(ctx, files) }; } };
}

test('batch preview writes no files or plans and returns every change with explicit bounded diff omissions', async t => {
  const { batches, root, ctx } = await fixture(t);
  const changes = [write('one.txt', '中文'.repeat(100)), write('two.txt', 'two')];
  const preview = await batches.preview({ workspace_id: 'default', changes, max_bytes: 32 });
  assert.equal(preview.persisted, false);
  assert.equal(preview.atomic, false);
  assert.equal(preview.changes.length, 2);
  assert.equal(preview.changes[1].diff_omission, 'RESPONSE_BUDGET');
  assert.equal(preview.truncated, true);
  assert.ok(preview.returned_diff_bytes <= 32);
  assert.equal(preview.changes.some(change => change.diff.includes('\uFFFD')), false);
  assert.equal((await fs.readdir(root)).length, 0);
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM file_changes').get()?.n, 0);
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM file_batches').get()?.n, 0);
  assert.equal((await batches.status({ workspace_id: 'default', idempotency_key: 'missing' })).exists, false);
  assert.equal((await batches.preview({ workspace_id: 'default', changes, max_bytes: 256 })).plan_sha256, preview.plan_sha256);
});

test('write, exact patch, delete and create-only move apply together with all backups saved first and exact replay', async t => {
  const { batches, root, files, ctx } = await fixture(t);
  await fs.writeFile(path.join(root, 'patch.txt'), 'old\r\n');
  await fs.writeFile(path.join(root, 'delete.txt'), 'delete');
  await fs.writeFile(path.join(root, 'source.bin'), Buffer.from([0, 1, 2, 255]));
  const changes: FileBatchChange[] = [write('new.txt', 'new'), { op: 'patch', path: 'patch.txt', patch: createPatch('patch.txt', 'old\n', 'new\n'), expected_sha256: sha('old\r\n') }, { op: 'delete', path: 'delete.txt', expected_sha256: sha('delete') }, { op: 'move', path: 'source.bin', to: 'destination.bin', expected_sha256: sha(Buffer.from([0, 1, 2, 255])) }];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  assert.equal(preview.path_count, 5);
  const commit = files.commitForBatch.bind(files);
  let first = true;
  files.commitForBatch = async (...args) => {
    if (first) {
      first = false;
      assert.equal(ctx.store.db.prepare("SELECT COUNT(*) AS n FROM file_changes WHERE status='pending'").get()?.n, 5);
      assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM file_batch_steps').get()?.n, 5);
      assert.equal(await fs.readFile(path.join(root, 'patch.txt'), 'utf8'), 'old\r\n');
    }
    return commit(...args);
  };
  const request = { workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'all-ops' };
  const result = await batches.apply(request);
  assert.equal(result.status, 'applied');
  assert.equal(result.steps.length, 5);
  assert.equal(await fs.readFile(path.join(root, 'patch.txt'), 'utf8'), 'new\r\n');
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'new');
  await assert.rejects(fs.stat(path.join(root, 'delete.txt')), errorCode('ENOENT'));
  await assert.rejects(fs.stat(path.join(root, 'source.bin')), errorCode('ENOENT'));
  assert.deepEqual(await fs.readFile(path.join(root, 'destination.bin')), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(await batches.apply(request), result);
  await assert.rejects(batches.apply({ ...request, expected_plan_sha256: 'a'.repeat(64) }), errorCode('IDEMPOTENCY_CONFLICT'));
  const status = await batches.status({ workspace_id: 'default', idempotency_key: 'all-ops' });
  assert.equal(status.status, 'applied');
  assert.ok(status.exists && status.observations.every(value => value.matches === 'after'));
});

test('precondition and plan mismatches abort the whole batch before backups or writes', async t => {
  const { batches, root, ctx } = await fixture(t);
  await fs.writeFile(path.join(root, 'existing.txt'), 'old');
  const changes = [write('new.txt', 'new'), write('existing.txt', 'updated', 'old')];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  await fs.writeFile(path.join(root, 'existing.txt'), 'external');
  await assert.rejects(batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'stale' }), errorCode('VERSION_CONFLICT'));
  await assert.rejects(fs.stat(path.join(root, 'new.txt')), errorCode('ENOENT'));
  assert.equal((await batches.status({ workspace_id: 'default', idempotency_key: 'stale' })).exists, false);
  await fs.writeFile(path.join(root, 'existing.txt'), 'old');
  await assert.rejects(batches.apply({ workspace_id: 'default', changes: [write('new.txt', 'changed'), changes[1]], expected_plan_sha256: preview.plan_sha256, idempotency_key: 'different' }), errorCode('BATCH_PLAN_CONFLICT'));
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM file_changes').get()?.n, 0);
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM file_batches').get()?.n, 0);
});

test('write and patch preserve UTF-16 BOM and established newlines inside a batch', async t => {
  const { batches, root } = await fixture(t);
  for (const encoding of ['utf16le', 'utf16be'] as const) {
    const body = Buffer.from('原文\r\n', 'utf16le');
    if (encoding === 'utf16be') body.swap16();
    const bytes = Buffer.concat([Buffer.from(encoding === 'utf16le' ? [255, 254] : [254, 255]), body]);
    const name = encoding + '.txt';
    await fs.writeFile(path.join(root, name), bytes);
    const changes: FileBatchChange[] = [{ op: 'write', path: name, content: '更新\n', expected_sha256: sha(bytes) }];
    const preview = await batches.preview({ workspace_id: 'default', changes });
    await batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: encoding });
    const result = await fs.readFile(path.join(root, name));
    assert.deepEqual(result.subarray(0, 2), bytes.subarray(0, 2));
    assert.equal(new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-16be').decode(result), '更新\r\n');
  }
});

test('path aliases, linked files, directories, protected paths, existing move destinations and chains are rejected', async t => {
  const { batches, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  await fs.writeFile(path.join(root, 'b.txt'), 'b');
  await fs.mkdir(path.join(root, 'dir'));
  for (const changes of [[write('new.txt', 'x'), write('./new.txt', 'y')], [{ op: 'move', path: 'a.txt', to: 'c.txt', expected_sha256: sha('a') }, write('c.txt', 'y')]] as FileBatchChange[][]) {
    await assert.rejects(batches.preview({ workspace_id: 'default', changes }), errorCode('BATCH_PATH_CONFLICT'));
  }
  if (process.platform === 'win32') await assert.rejects(batches.preview({ workspace_id: 'default', changes: [write('New.txt', 'x'), write('new.txt', 'y')] }), errorCode('BATCH_PATH_CONFLICT'));
  await assert.rejects(batches.preview({ workspace_id: 'default', changes: [{ op: 'move', path: 'a.txt', to: 'b.txt', expected_sha256: sha('a') }] }), errorCode('VERSION_CONFLICT'));
  await assert.rejects(batches.preview({ workspace_id: 'default', changes: [write('dir', 'x')] }), errorCode('NOT_A_FILE'));
  await assert.rejects(batches.preview({ workspace_id: 'default', changes: [write('../escape', 'x')] }), errorCode('PATH_DENIED'));
  await assert.rejects(batches.preview({ workspace_id: 'default', changes: [write('.env', 'x')] }), errorCode('PATH_DENIED'));
  await fs.link(path.join(root, 'a.txt'), path.join(root, 'hardlink.txt'));
  await assert.rejects(batches.preview({ workspace_id: 'default', changes: [{ op: 'delete', path: 'a.txt', expected_sha256: sha('a') }] }), errorCode('PATH_DENIED'));
});

test('batch path and byte budgets include move destinations, original backups and encoded output', async t => {
  const { batches, root, config } = await fixture(t);
  await fs.writeFile(path.join(root, 'source.txt'), '12345');
  config.fileBatches = { maxFiles: 1, maxTotalBytes: 100 };
  await assert.rejects(batches.preview({ workspace_id: 'default', changes: [{ op: 'move', path: 'source.txt', to: 'dest.txt', expected_sha256: sha('12345') }] }), errorCode('BATCH_TOO_LARGE'));
  config.fileBatches = { maxFiles: 2, maxTotalBytes: 9, binaryMaxTotalBytes: 9 };
  await assert.rejects(batches.preview({ workspace_id: 'default', changes: [write('source.txt', '67890', '12345')] }), errorCode('BATCH_TOO_LARGE'));
  await assert.rejects(batches.preview({ workspace_id: 'default', changes: [{ op: 'move', path: 'source.txt', to: 'dest.txt', expected_sha256: sha('12345') }] }), errorCode('BATCH_TOO_LARGE'));
  config.fileBatches.maxTotalBytes = 10;
  config.fileBatches.binaryMaxTotalBytes = 10;
  assert.equal((await batches.preview({ workspace_id: 'default', changes: [{ op: 'move', path: 'source.txt', to: 'dest.txt', expected_sha256: sha('12345') }] })).total_bytes, 10);
});

test('a later failure conditionally rolls back earlier steps and retains a queryable failure receipt', async t => {
  const { batches, files, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'first.txt'), 'first');
  const changes = [write('first.txt', 'updated', 'first'), write('second.txt', 'second')];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  const commit = files.commitForBatch.bind(files);
  files.commitForBatch = async (...args) => {
    if (args[1] === 'second.txt') throw new AppError('TEST_FAILURE', 'Injected failure before second write.');
    return commit(...args);
  };
  const request = { workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'rollback' };
  const result = await batches.apply(request);
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.steps[0].status, 'rolled_back');
  assert.ok(result.steps[0].rollback_change_id);
  assert.equal(result.steps[1].status, 'failed');
  assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'first');
  await assert.rejects(fs.stat(path.join(root, 'second.txt')), errorCode('ENOENT'));
  assert.deepEqual(await batches.apply(request), result);
  const status = await batches.status({ workspace_id: 'default', idempotency_key: 'rollback' });
  assert.ok(status.exists && status.observations.every(item => item.matches === 'before'));
});

test('rollback preserves external edits and reports partial progress instead of overwriting a conflict', async t => {
  const { batches, files, root } = await fixture(t);
  const changes = [write('first.txt', 'first'), write('second.txt', 'second')];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  const commit = files.commitForBatch.bind(files);
  files.commitForBatch = async (...args) => {
    if (args[1] === 'second.txt') {
      await fs.writeFile(path.join(root, 'first.txt'), 'external');
      throw new AppError('TEST_FAILURE', 'Injected late failure.');
    }
    return commit(...args);
  };
  const result = await batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'conflict' });
  assert.equal(result.status, 'partial');
  assert.equal(result.steps[0].status, 'rollback_conflict');
  assert.equal(result.steps[0].error_code, 'VERSION_CONFLICT');
  assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'external');
  const status = await batches.status({ workspace_id: 'default', idempotency_key: 'conflict' });
  assert.ok(status.exists && status.observations[0].matches === 'neither');
});

test('ordinary writes share all batch path locks and cannot interleave a partially applied group', async t => {
  const { batches, files, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'second.txt'), 'original');
  const changes = [write('first.txt', 'first'), write('second.txt', 'batch', 'original')];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  const commit = files.commitForBatch.bind(files);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  files.commitForBatch = async (...args) => {
    if (args[1] === 'first.txt') { entered(); await gate; }
    return commit(...args);
  };
  const pending = batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'locked' });
  await ready;
  let settled = false;
  const outside = files.write({ workspace_id: 'default', path: 'second.txt', content: 'outside', expected_sha256: sha('original'), idempotency_key: 'outside' }).then(() => { settled = true; return 'success'; }, error => { settled = true; return error.code; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  release();
  assert.equal((await pending).status, 'applied');
  assert.equal(await outside, 'VERSION_CONFLICT');
  assert.equal(await fs.readFile(path.join(root, 'second.txt'), 'utf8'), 'batch');
});

test('read-only policy blocks application and receipt replay while previews and observations remain readable', async t => {
  const { batches, config } = await fixture(t);
  const changes = [write('file.txt', 'text')];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  const request = { workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'read-only' };
  await batches.apply(request);
  config.workspaces[0].readOnly = true;
  await assert.rejects(batches.apply(request), errorCode('READ_ONLY'));
  assert.equal((await batches.status({ workspace_id: 'default', idempotency_key: 'read-only' })).status, 'applied');
  assert.ok((await batches.preview({ workspace_id: 'default', changes: [write('file.txt', 'replacement', 'text')] })).plan_sha256);
});

test('interrupted journals reopen as unknown and expose saved progress separately from actual file observations', async t => {
  const setup = await fixture(t);
  const changes = [write('file.txt', 'text')];
  const preview = await setup.batches.preview({ workspace_id: 'default', changes });
  const request = { workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'restart' };
  const result = await setup.batches.apply(request);
  // Reproduce the durable state at the crash window after a file replacement and
  // before its batch step/result receipt was persisted.
  setup.ctx.store.db.prepare("UPDATE file_batches SET status='applying',result=NULL,finished_at=NULL WHERE id=?").run(result.batch_id);
  setup.ctx.store.db.prepare("UPDATE file_batch_steps SET status='applying' WHERE batch_id=?").run(result.batch_id);
  setup.ctx.store.db.prepare("UPDATE operations SET status='pending',result=NULL WHERE op_key='restart'").run();
  const { batches } = setup.reopen();
  const status = await batches.status({ workspace_id: 'default', idempotency_key: 'restart' });
  assert.equal(status.status, 'unknown');
  assert.ok(status.exists && status.steps[0].status === 'applying' && status.observations[0].matches === 'after');
  assert.ok(status.exists && status.recorded_result === null);
  await assert.rejects(batches.apply(request), errorCode('EXECUTION_UNKNOWN'));
  assert.equal(await fs.readFile(path.join(setup.root, 'file.txt'), 'utf8'), 'text');
});

test('batch diff redacts complete credential values before the response is truncated and hashes remain raw', async t => {
  const { batches, root } = await fixture(t);
  const credential = 'sk-proj-' + 'a'.repeat(200);
  const before = 'api_key = "' + credential + '"\n';
  await fs.writeFile(path.join(root, 'settings.txt'), before);
  const changes = [write('settings.txt', 'safe\n', before)];
  const preview = await batches.preview({ workspace_id: 'default', changes, max_bytes: 512 });
  assert.equal(preview.changes[0].before_sha256, sha(before));
  assert.equal(preview.changes[0].diff_redacted, true);
  assert.ok(preview.changes[0].diff.includes('[REDACTED]'));
  assert.equal(preview.changes[0].diff.includes(credential.slice(0, 24)), false);
  const tiny = await batches.preview({ workspace_id: 'default', changes, max_bytes: 120 });
  assert.equal(tiny.changes[0].diff.includes(credential.slice(0, 24)), false);
});

test('status supplies the remaining byte cap before IO and does not reuse an uncertain read allowance', async t => {
  const { batches, files, root, config } = await fixture(t);
  const changes = [write('first.txt', 'a'), write('second.txt', 'b')];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  await batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'budget' });
  config.fileBatches = { maxFiles: 20, maxTotalBytes: 10 };
  await fs.writeFile(path.join(root, 'first.txt'), 'x'.repeat(11));
  const snapshot = files.snapshotForBatch.bind(files);
  const allowances: (number | undefined)[] = [];
  files.snapshotForBatch = async (absolute, maxBytes) => { allowances.push(maxBytes); return snapshot(absolute, maxBytes); };
  const status = await batches.status({ workspace_id: 'default', idempotency_key: 'budget' });
  assert.deepEqual(allowances, [10]);
  assert.ok(status.exists && status.observations.every(item => item.matches === 'unknown'));
  assert.ok(status.exists && status.observations[0].error_code === 'FILE_TOO_LARGE');
});

test('move failures remove only their newly created destination and preserve an externally edited source', async t => {
  const { batches, files, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'source.txt'), 'source');
  const changes: FileBatchChange[] = [{ op: 'move', path: 'source.txt', to: 'destination.txt', expected_sha256: sha('source') }];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  const commit = files.commitForBatch.bind(files);
  files.commitForBatch = async (...args) => {
    if (args[1] === 'source.txt') await fs.writeFile(path.join(root, 'source.txt'), 'external');
    return commit(...args);
  };
  const result = await batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'move-failure' });
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.error?.code, 'VERSION_CONFLICT');
  assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'external');
  await assert.rejects(fs.stat(path.join(root, 'destination.txt')), errorCode('ENOENT'));
});

test('uncertain post-replacement failures remain partial and are never guessed safe to roll back', async t => {
  const { batches, files, root } = await fixture(t);
  const changes = [write('file.txt', 'text')];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  const commit = files.commitForBatch.bind(files);
  files.commitForBatch = async (...args) => { await commit(...args); throw new AppError('TEST_RECEIPT_FAILURE', 'Lost the success acknowledgement.'); };
  const result = await batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'unknown-step' });
  assert.equal(result.status, 'partial');
  assert.equal(result.steps[0].status, 'unknown');
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'text');
});

test('plans and journals are bound to one workspace identity even when filenames and content match', async t => {
  const { batches, config } = await fixture(t);
  const changes = [write('file.txt', 'text')];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  const other = await batches.preview({ workspace_id: 'other', changes });
  assert.notEqual(preview.plan_sha256, other.plan_sha256);
  await assert.rejects(batches.apply({ workspace_id: 'other', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'bound' }), errorCode('BATCH_PLAN_CONFLICT'));
  await batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'bound' });
  assert.equal((await batches.status({ workspace_id: 'other', idempotency_key: 'bound' })).exists, false);
  config.workspaces[0].root = config.workspaces[1].root;
  await assert.rejects(batches.status({ workspace_id: 'default', idempotency_key: 'bound' }), errorCode('WORKSPACE_IDENTITY_MISMATCH'));
});

test('moves, conditional move rollback and explicit restore preserve ordinary source permission bits', async t => {
  const { batches, files, root } = await fixture(t);
  const source = path.join(root, 'script.sh');
  await fs.writeFile(source, '#!/bin/sh\necho okay\n');
  await fs.chmod(source, 0o751);
  const mode = (await fs.stat(source)).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o751);
  const original = await fs.readFile(source);
  const changes: FileBatchChange[] = [{ op: 'move', path: 'script.sh', to: 'moved.sh', expected_sha256: sha(original) }];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  assert.equal(preview.changes[0].after_mode, mode);
  const applied = await batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'mode-move' });
  assert.equal(applied.status, 'applied');
  assert.equal((await fs.stat(path.join(root, 'moved.sh'))).mode & 0o777, mode);
  await files.restore({ workspace_id: 'default', change_id: applied.steps[1].change_id!, expected_sha256: null, idempotency_key: 'restore-source-mode' });
  assert.equal((await fs.stat(source)).mode & 0o777, mode);
  const rollbackChanges: FileBatchChange[] = [{ op: 'move', path: 'script.sh', to: 'another.sh', expected_sha256: sha(original) }, write('failure.txt', 'fail')];
  const rollbackPreview = await batches.preview({ workspace_id: 'default', changes: rollbackChanges });
  const commit = files.commitForBatch.bind(files);
  files.commitForBatch = async (...args) => { if (args[1] === 'failure.txt') throw new AppError('TEST_FAILURE', 'Later failure.'); return commit(...args); };
  const rolledBack = await batches.apply({ workspace_id: 'default', changes: rollbackChanges, expected_plan_sha256: rollbackPreview.plan_sha256, idempotency_key: 'mode-rollback' });
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal((await fs.stat(source)).mode & 0o777, mode);
  assert.deepEqual(await fs.readFile(source), original);
  await assert.rejects(fs.stat(path.join(root, 'another.sh')), errorCode('ENOENT'));
});

test('legacy change records without saved modes remain restorable without inventing original permissions', async t => {
  const { batches, files, root, ctx } = await fixture(t);
  await fs.writeFile(path.join(root, 'legacy.txt'), 'legacy');
  const changes: FileBatchChange[] = [{ op: 'delete', path: 'legacy.txt', expected_sha256: sha('legacy') }];
  const preview = await batches.preview({ workspace_id: 'default', changes });
  const applied = await batches.apply({ workspace_id: 'default', changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'legacy-delete' });
  const changeId = applied.steps[0].change_id!;
  ctx.store.db.prepare('UPDATE file_changes SET before_mode=NULL,after_mode=NULL WHERE id=?').run(changeId);
  await files.restore({ workspace_id: 'default', change_id: changeId, expected_sha256: null, idempotency_key: 'legacy-restore' });
  assert.equal(await fs.readFile(path.join(root, 'legacy.txt'), 'utf8'), 'legacy');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, 'legacy.txt'))).mode & 0o777, 0o600);
});
