import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createPatch } from 'diff';
import { FileService, hash } from '../src/filesystem.js';
import { FileImportService, chatGptFileSchema } from '../src/file-import.js';
import { fileOperations } from '../src/file-operations.js';
import { StateStore, canonical } from '../src/store.js';
import { WorkspacePaths } from '../src/paths.js';
import { defaultConfig } from '../src/config.js';
import { initializeIdentity } from '../src/identity.js';
import { AppError } from '../src/errors.js';
import type { AppConfig } from '../src/types.js';

async function fixture(t: TestContext) {
  const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'webcodex-operation-test-'));
  const root = path.join(base, 'project'); await fs.mkdir(root);
  const configPath = path.join(base, 'config.json'), config: AppConfig = { ...defaultConfig(root, configPath), configPath };
  const stores: StateStore[] = [];
  const open = () => { const store = new StateStore(config.stateDir); stores.push(store); const ctx = { config, store, paths: new WorkspacePaths(config) }; return { store, ctx, files: new FileService(ctx) }; };
  t.after(async () => { for (const store of stores) store.close(); const actual = await fs.realpath(base); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-operation-test-')); await fs.rm(actual, { recursive: true, force: true }); });
  return { ...open(), config, root, base, open };
}
const file = { file_id: 'file-SYNTHETIC-PRIVATE-ID', download_url: 'https://files.oaiusercontent.com/a?sig=SYNTHETIC-PRIVATE-URL', file_name: 'first.pptx' };
const imported = () => ({ workspace_id: 'default', path: '原文件.pptx', file: { ...file }, expected_sha256: null, idempotency_key: 'import' });
const bytes = Buffer.from([0, 1, 2, 255]);

test('refreshed URLs and optional metadata replay the historical completed import and status separates later edits', async t => {
  const f = await fixture(t); let downloads = 0;
  const service = new FileImportService(f.ctx, f.files, async () => { downloads++; return bytes; });
  const request = imported(), saved = await service.import(request);
  await fs.writeFile(path.join(f.root, request.path), 'External edit');
  assert.deepEqual(await service.import({ ...request, file: { ...file, download_url: 'https://files.oaiusercontent.com/a?sig=REFRESHED-PRIVATE-URL', mime_type: 'different/optional', file_name: 'renamed.pptx' } }), saved);
  assert.equal(downloads, 1);
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_import_file', idempotency_key: 'import' });
  assert.equal(status.stage, 'done'); assert.equal(status.receipt.sha256, hash(bytes)); assert.equal(status.current_observation!.sha256, hash(Buffer.from('External edit')));
  assert.equal('content_sha256' in status && status.content_sha256, hash(bytes));
  assert.equal('changes' in status && status.changes?.[0].change_id, saved.change_id);
  const persisted = JSON.stringify({ status, journal: f.store.db.prepare('SELECT * FROM file_operations').all(), audit: f.store.db.prepare('SELECT * FROM audit_events').all() });
  for (const secret of [file.file_id, file.download_url, 'REFRESHED-PRIVATE-URL']) assert.ok(!persisted.includes(secret));
  await assert.rejects(service.import({ ...request, file: { ...file, file_id: 'another-file' } }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('a timeout before mutation can retry the same operation with a refreshed URL and configured timeout', async t => {
  const f = await fixture(t); f.config.fileImports = { maxAttempts: 3, downloadTimeoutMs: 12345 }; let calls = 0;
  const service = new FileImportService(f.ctx, f.files, async (_url, options) => { assert.equal(options.timeoutMs, 12345); if (++calls === 1) throw new AppError('FILE_IMPORT_TIMEOUT', 'Synthetic timeout'); return bytes; });
  const request = imported(); await assert.rejects(service.import(request), { code: 'FILE_IMPORT_TIMEOUT' });
  const failed = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_import_file', idempotency_key: 'import' });
  assert.equal(failed.stage, 'retryable_failure'); assert.equal('retryable' in failed && failed.retryable, true);
  assert.equal(failed.current_observation!.status, 'absent');
  await service.import({ ...request, file: { ...file, download_url: 'https://files.oaiusercontent.com/refreshed?sig=NEW-PRIVATE' } });
  assert.equal(calls, 2); assert.deepEqual(await fs.readFile(path.join(f.root, request.path)), bytes);
  const done = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_import_file', idempotency_key: 'import' });
  assert.equal(done.stage, 'done'); assert.equal('attempts' in done && done.attempts, 2);
});

test('attempt budgets are durable and prevent endless prewrite retries after reopening the store', async t => {
  const f = await fixture(t); f.config.fileImports = { maxAttempts: 2, downloadTimeoutMs: 60000 }; let calls = 0;
  const download = async () => { calls++; throw new AppError('FILE_IMPORT_DOWNLOAD_FAILED', 'Synthetic network failure'); };
  let service = new FileImportService(f.ctx, f.files, download);
  await assert.rejects(service.import(imported()), { code: 'FILE_IMPORT_DOWNLOAD_FAILED' });
  f.store.close(); const reopened = f.open(); service = new FileImportService(reopened.ctx, reopened.files, download);
  await assert.rejects(service.import(imported()), { code: 'FILE_IMPORT_DOWNLOAD_FAILED' });
  await assert.rejects(service.import(imported()), { code: 'FILE_OPERATION_RETRY_LIMIT' });
  assert.equal(calls, 2);
  const status = await reopened.files.operationStatus({ workspace_id: 'default', tool: 'fs_import_file', idempotency_key: 'import' });
  assert.equal(status.stage, 'retryable_failure'); assert.equal('retryable' in status && status.retryable, false); assert.equal('attempts' in status && status.attempts, 2);
});

test('busy admission consumes no key or attempt and the same request starts after capacity clears', async t => {
  const f = await fixture(t); let begin!: () => void, release!: (bytes: Buffer) => void, calls = 0;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const service = new FileImportService(f.ctx, f.files, () => { if (++calls > 1) return Promise.resolve(bytes); begin(); return new Promise(resolve => { release = resolve; }); });
  const first = service.import(imported()); await started;
  const retry = service.import({ ...imported(), file: { ...file, download_url: 'https://files.oaiusercontent.com/a?sig=FRESH' } });
  const next = { ...imported(), path: 'second.pptx', idempotency_key: 'second' };
  await assert.rejects(service.import(next), { code: 'FILE_IMPORT_BUSY' });
  assert.equal((await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_import_file', idempotency_key: 'second' })).found, false);
  release(bytes); assert.deepEqual(await retry, await first);
  await service.import(next); assert.equal(calls, 2);
});

test('a recorded download digest rejects changed bytes on any later safe retry', async t => {
  const f = await fixture(t), journal = fileOperations(f.ctx);
  const options = { workspace_id: 'default', tool: 'fs_import_file' as const, idempotency_key: 'digest', path: 'digest.bin', payload: { file_identity_sha256: hash(Buffer.from('stable-id')) }, maxAttempts: 3, retryableErrors: ['FILE_IMPORT_TIMEOUT'] };
  await assert.rejects(journal.run(options, async operation => { operation.content(hash(bytes), bytes.length); throw new AppError('FILE_IMPORT_TIMEOUT', 'Synthetic known prewrite failure'); }), { code: 'FILE_IMPORT_TIMEOUT' });
  await assert.rejects(journal.run(options, async operation => { operation.content(hash(Buffer.from([9])), 1); }), { code: 'FILE_IMPORT_CONTENT_CHANGED' });
  assert.equal((await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_import_file', idempotency_key: 'digest' })).stage, 'failed');
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('write, patch, restore and mkdir journals link exact changes and respect readonly status access', async t => {
  const f = await fixture(t), request = { workspace_id: 'default', path: 'text.txt', content: 'before\n', expected_sha256: null, idempotency_key: 'write' };
  const written = await f.files.write(request);
  const patched = await f.files.applyPatch({ workspace_id: 'default', path: request.path, patch: createPatch(request.path, request.content, 'after\n'), expected_sha256: written.sha256!, idempotency_key: 'patch' });
  const restored = await f.files.restore({ workspace_id: 'default', change_id: patched.change_id!, expected_sha256: patched.sha256, idempotency_key: 'restore' });
  await f.files.mkdir({ workspace_id: 'default', path: 'folder', idempotency_key: 'mkdir' });
  f.config.workspaces[0].readOnly = true;
  for (const [tool, key, changeId] of [['fs_write', 'write', written.change_id], ['fs_apply_patch', 'patch', patched.change_id], ['changes_restore', 'restore', restored.change_id], ['fs_mkdir', 'mkdir', null]] as const) {
    const status = await f.files.operationStatus({ workspace_id: 'default', tool, idempotency_key: key });
    assert.equal(status.stage, 'done'); assert.equal('changes' in status && status.changes?.length, changeId ? 1 : 0);
    if (changeId) assert.equal('changes' in status && status.changes?.[0].change_id, changeId);
    else assert.deepEqual(status.current_observation, { status: 'available', kind: 'directory', path: 'folder' });
  }
  assert.equal((await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_write', idempotency_key: 'absent' })).found, false);
});

test('unknown commit is never replayed and its status retains change linkage and current observations', async t => {
  const f = await fixture(t), request = imported(), target = path.join(f.root, request.path);
  await fs.writeFile(target, Buffer.from([0, 9]));
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => { await rename(...args); if (args[1] === target) await fs.writeFile(target, Buffer.from([0, 7])); });
  let calls = 0; const service = new FileImportService(f.ctx, f.files, async () => { calls++; return bytes; });
  const overwrite = { ...request, expected_sha256: hash(Buffer.from([0, 9])) };
  await assert.rejects(service.import(overwrite), { code: 'FILE_WRITE_VERIFICATION_FAILED' });
  await assert.rejects(service.import({ ...overwrite, file: { ...file, download_url: 'https://files.oaiusercontent.com/refreshed' } }), { code: 'EXECUTION_UNKNOWN' });
  assert.equal(calls, 1);
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_import_file', idempotency_key: 'import' });
  assert.equal(status.stage, 'unknown'); assert.equal('changes' in status && status.changes?.[0].status, 'unknown'); assert.equal(status.receipt, null);
  assert.equal(status.current_observation!.sha256, hash(Buffer.from([0, 7])));
});

test('legacy receipt remains readable but a refreshed legacy request cannot silently create another write', async t => {
  const f = await fixture(t), request = imported(), binding = initializeIdentity(f.ctx).workspaceIdentity('default');
  const payload = { workspace_id: request.workspace_id, path: request.path, expected_sha256: null, source_sha256: hash(Buffer.from(JSON.stringify(chatGptFileSchema.parse(request.file)))) };
  const oldReceipt = { workspace_id: 'default', path: request.path, changed: true, change_id: 'old-change', sha256: hash(bytes), verified: true, size_bytes: bytes.length };
  f.store.db.prepare('INSERT INTO operations(scope,op_key,digest,status,result,created_at) VALUES(?,?,?,?,?,?)').run(`workspace:${binding}/fs_import_file`, 'import', createHash('sha256').update(canonical(payload)).digest('hex'), 'done', JSON.stringify(oldReceipt), new Date().toISOString());
  let calls = 0; const service = new FileImportService(f.ctx, f.files, async () => { calls++; return bytes; });
  assert.deepEqual(await service.import(request), oldReceipt);
  await assert.rejects(service.import({ ...request, file: { ...file, download_url: 'https://files.oaiusercontent.com/refresh' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_import_file', idempotency_key: 'import' });
  assert.equal('legacy' in status && status.legacy, true); assert.deepEqual(status.receipt, oldReceipt); assert.equal(status.current_observation, null); assert.equal(calls, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('startup marks abandoned single-file changes unknown and never replays a crash after replacement', async t => {
  const f = await fixture(t); f.store.close();
  const modules = { files: new URL('../src/filesystem.js', import.meta.url).href, store: new URL('../src/store.js', import.meta.url).href, paths: new URL('../src/paths.js', import.meta.url).href };
  const child = `import { promises as fs } from 'node:fs';import path from 'node:path';const {FileService,hash}=await import(${JSON.stringify(modules.files)});const {StateStore}=await import(${JSON.stringify(modules.store)});const {WorkspacePaths}=await import(${JSON.stringify(modules.paths)});const config=JSON.parse(process.env.WEBCODEX_SYNTHETIC_CONFIG);const store=new StateStore(config.stateDir),files=new FileService({config,store,paths:new WorkspacePaths(config)});await fs.writeFile(path.join(config.workspaces[0].root,'crash.bin'),Buffer.from([0,1]));const rename=fs.rename.bind(fs);fs.rename=async(...args)=>{await rename(...args);process.exit(73)};await files.writeBytes({workspace_id:'default',path:'crash.bin',bytes:Buffer.from([0,2]),expected_sha256:hash(Buffer.from([0,1])),idempotency_key:'crash'});`;
  const code = await new Promise<number | null>((resolve, reject) => { const process = spawn(globalThis.process.execPath, ['--input-type=module', '--eval', child], { env: { ...globalThis.process.env, WEBCODEX_SYNTHETIC_CONFIG: JSON.stringify(f.config) }, windowsHide: true, stdio: 'ignore' }); process.once('error', reject); process.once('exit', resolve); });
  assert.equal(code, 73); const reopened = f.open();
  const status = await reopened.files.operationStatus({ workspace_id: 'default', tool: 'fs_write_bytes', idempotency_key: 'crash' });
  assert.equal(status.stage, 'unknown'); assert.equal('changes' in status && status.changes?.[0].status, 'unknown'); assert.equal(status.current_observation!.sha256, hash(Buffer.from([0, 2])));
  await assert.rejects(reopened.files.writeBytes({ workspace_id: 'default', path: 'crash.bin', bytes: Buffer.from([0, 2]), expected_sha256: hash(Buffer.from([0, 1])), idempotency_key: 'crash' }), { code: 'EXECUTION_UNKNOWN' });
  assert.equal(reopened.store.db.prepare('SELECT length(before_blob) AS size FROM file_changes').get()!.size, 2);
});

test('constructing another FileService with the same store never marks a live commit unknown', async t => {
  const f = await fixture(t), journal = fileOperations(f.ctx);
  const result = await journal.run({ workspace_id: 'default', tool: 'fs_write', idempotency_key: 'live', path: 'live.txt', payload: { path: 'live.txt' } }, async operation => {
    const change = f.files.prepareBatchChange('default', 'live.txt', null, Buffer.from('live'))!; operation.linkChange(change);
    new FileService(f.ctx);
    assert.equal(f.store.db.prepare('SELECT status FROM file_changes WHERE id=?').get(change)!.status, 'pending');
    assert.equal(journal.status({ workspace_id: 'default', tool: 'fs_write', idempotency_key: 'live' }).stage, 'committing');
    operation.noMutation(); return { tested: true };
  });
  assert.deepEqual(result, { tested: true });
});

test('completion receipt persistence failure reports unknown without repeating the completed write', async t => {
  const f = await fixture(t), prepare = f.store.db.prepare.bind(f.store.db); let fail = true;
  t.mock.method(f.store.db, 'prepare', (sql: string) => {
    if (fail && sql.startsWith("UPDATE file_operations SET stage='done'")) { fail = false; throw new Error('Synthetic receipt failure'); }
    return prepare(sql);
  });
  const request = { workspace_id: 'default', path: 'receipt.txt', content: 'written once', expected_sha256: null, idempotency_key: 'receipt' };
  await assert.rejects(f.files.write(request), /Synthetic receipt failure/);
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_write', idempotency_key: 'receipt' });
  assert.equal(status.stage, 'unknown'); assert.equal('changes' in status && status.changes?.[0].status, 'applied'); assert.equal(status.receipt, null);
  assert.equal(status.current_observation!.sha256, hash(Buffer.from(request.content)));
  await assert.rejects(f.files.write(request), { code: 'EXECUTION_UNKNOWN' });
  assert.equal(await fs.readFile(path.join(f.root, request.path), 'utf8'), request.content);
});

test('lowering current retry policy constrains an existing operation allowance', async t => {
  const f = await fixture(t); f.config.fileImports = { maxAttempts: 3, downloadTimeoutMs: 60000 }; let calls = 0;
  const service = new FileImportService(f.ctx, f.files, async () => { calls++; throw new AppError('FILE_IMPORT_TIMEOUT', 'Synthetic timeout'); });
  await assert.rejects(service.import(imported()), { code: 'FILE_IMPORT_TIMEOUT' });
  f.config.fileImports.maxAttempts = 1;
  await assert.rejects(service.import(imported()), { code: 'FILE_OPERATION_RETRY_LIMIT' });
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_import_file', idempotency_key: 'import' });
  assert.equal('max_attempts' in status && status.max_attempts, 1); assert.equal('retryable' in status && status.retryable, false); assert.equal(calls, 1);
  f.config.fileImports.maxAttempts = 3;
  await assert.rejects(service.import(imported()), { code: 'FILE_OPERATION_RETRY_LIMIT' });
  assert.equal(calls, 1);
});
