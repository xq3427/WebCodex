import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import childProcess from 'node:child_process';
import { BinaryInputService, inlineBinaryWriteLimit } from '../src/binary-input.js';
import { FileService, hash } from '../src/filesystem.js';
import { StateStore } from '../src/store.js';
import { defaultConfig } from '../src/config.js';
import { WorkspacePaths } from '../src/paths.js';
import type { AppConfig } from '../src/types.js';

async function fixture(t: TestContext) {
  const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'webcodex-inline-binary-'));
  const root = path.join(base, 'project'); await fs.mkdir(root);
  const configPath = path.join(base, 'config.json'), config: AppConfig = { ...defaultConfig(root, configPath), configPath };
  const store = new StateStore(config.stateDir), ctx = { config, store, paths: new WorkspacePaths(config) }, files = new FileService(ctx);
  t.after(async () => { store.close(); const actual = await fs.realpath(base); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-inline-binary-')); await fs.rm(actual, { recursive: true, force: true }); });
  return { root, config, store, files, service: new BinaryInputService(ctx, files) };
}
const request = (bytes: Buffer, key = 'binary-save') => ({ workspace_id: 'default', path: '论文原文件-🙂.bin', content_base64: bytes.toString('base64'), content_sha256: hash(bytes), size_bytes: bytes.length, expected_sha256: null, idempotency_key: key });
const original = () => Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('独立验收标记-BASE64-SOURCE-PRIVATE\r\n')]);

test('canonical Base64 saves exact original bytes with a public journal and no network or execution', async t => {
  const f = await fixture(t), bytes = original(), input = request(bytes);
  for (const target of [https, http]) t.mock.method(target, 'request', () => { assert.fail('Inline binary input must not use the network'); });
  t.mock.method(childProcess, 'spawn', () => { assert.fail('Inline binary input must not execute commands'); });
  const saved = await f.service.write(input);
  assert.equal(f.config.execution.mode, 'disabled'); assert.equal(saved.verified, true); assert.equal(saved.sha256, hash(bytes));
  assert.equal(saved.size_bytes, bytes.length); assert.equal(saved.source, 'inline_base64'); assert.equal(saved.content_processing, 'none');
  assert.deepEqual(await fs.readFile(path.join(f.root, input.path)), bytes);
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_write_binary', idempotency_key: input.idempotency_key });
  assert.equal(status.stage, 'done'); assert.equal(status.receipt.sha256, hash(bytes)); assert.equal(status.current_observation!.sha256, hash(bytes));
  assert.equal('changes' in status && status.changes?.[0].change_id, saved.change_id);
  assert.deepEqual(f.store.db.prepare('SELECT tool FROM file_operations').all().map(row => row.tool), ['fs_write_binary']);
  const diagnostic = JSON.stringify({ status, journal: f.store.db.prepare('SELECT * FROM file_operations').all(), audit: f.store.db.prepare('SELECT * FROM audit_events').all() });
  assert.ok(!diagnostic.includes(input.content_base64)); assert.ok(!diagnostic.includes('BASE64-SOURCE-PRIVATE'));
});

test('matching retries return historical receipts without rewriting subsequent edits; changed content conflicts', async t => {
  const f = await fixture(t), bytes = original(), input = request(bytes), saved = await f.service.write(input);
  await fs.writeFile(path.join(f.root, input.path), 'external');
  assert.deepEqual(await f.service.write({ ...input, content_sha256: input.content_sha256.toUpperCase() }), saved);
  assert.equal(await fs.readFile(path.join(f.root, input.path), 'utf8'), 'external');
  const changed = request(Buffer.from([0, 1]), input.idempotency_key);
  await assert.rejects(f.service.write(changed), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await f.files.changesList({ workspace_id: 'default' })).changes.length, 1);
});

test('binary overwrites require current hashes and preserve before-images for exact restoration', async t => {
  const f = await fixture(t), bytes = original(), saved = await f.service.write(request(bytes));
  const replacement = Buffer.from([0, 255, 1, 254]), next = request(replacement, 'overwrite');
  await assert.rejects(f.service.write({ ...next, idempotency_key: 'create-only' }), { code: 'VERSION_CONFLICT' });
  const overwritten = await f.service.write({ ...next, expected_sha256: saved.sha256 });
  assert.deepEqual(await fs.readFile(path.join(f.root, next.path)), replacement);
  const preview = await f.files.changeDiff({ workspace_id: 'default', change_id: overwritten.change_id! });
  assert.equal(preview.diff_kind, 'binary'); assert.equal(preview.restore_sha256, hash(bytes));
  await f.files.restore({ workspace_id: 'default', change_id: overwritten.change_id!, expected_sha256: overwritten.sha256, idempotency_key: 'restore' });
  assert.deepEqual(await fs.readFile(path.join(f.root, next.path)), bytes);
});

test('malformed Base64 and invalid declarations fail before operations or files are created', async t => {
  const f = await fixture(t), input = request(Buffer.from([0]));
  for (const content_base64 of ['data:application/octet-stream;base64,AA==', 'AA==\n', 'AA==\r\n  ', ' AA==', 'AA', 'AA=', 'AA===', 'A===', 'AA=A', 'A-==', 'A_==', 'AR==', 'AAB=', 'AAAA=', '💾', null]) {
    await assert.rejects(f.service.write({ ...input, content_base64: content_base64 as never }), { code: 'BINARY_INPUT_INVALID' });
  }
  for (const size_bytes of [-1, 0.5, NaN, Infinity]) await assert.rejects(f.service.write({ ...input, size_bytes }), { code: 'BINARY_INPUT_INVALID' });
  for (const content_sha256 of ['', 'z'.repeat(64), null]) await assert.rejects(f.service.write({ ...input, content_sha256: content_sha256 as never }), { code: 'BINARY_INPUT_INVALID' });
  await assert.rejects(f.service.write({ ...input, expected_sha256: 'wrong' }), { code: 'BINARY_INPUT_INVALID' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM file_operations').get()!.n, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('valid Base64 with a wrong decoded size or digest fails integrity checks before overwriting', async t => {
  const f = await fixture(t), bytes = original(), input = request(bytes);
  await fs.writeFile(path.join(f.root, input.path), 'untouched');
  for (const changed of [{ ...input, size_bytes: input.size_bytes + 1 }, { ...input, content_sha256: '0'.repeat(64) }]) {
    await assert.rejects(f.service.write(changed), { code: 'BINARY_INPUT_INTEGRITY_ERROR' });
  }
  assert.equal(await fs.readFile(path.join(f.root, input.path), 'utf8'), 'untouched');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM file_operations').get()!.n, 0);
});

test('both inline and ordinary binary limits constrain decoded bytes, including misleading declarations', async t => {
  const f = await fixture(t);
  delete f.config.limits.inlineBinaryWriteMaxBytes; delete f.config.limits.binaryWriteMaxBytes;
  assert.equal(inlineBinaryWriteLimit(f.config.limits), 262144);
  f.config.limits.inlineBinaryWriteMaxBytes = 7; f.config.limits.binaryWriteMaxBytes = 100;
  const atLimit = request(Buffer.alloc(7, 5)); await f.service.write(atLimit);
  for (const input of [request(Buffer.alloc(8), 'eight'), { ...request(Buffer.alloc(9), 'misdeclared'), size_bytes: 1 }, { ...request(Buffer.alloc(1000), 'encoded-large'), size_bytes: 1 }]) {
    await assert.rejects(f.service.write(input), { code: 'BINARY_INPUT_TOO_LARGE' });
  }
  f.config.limits.inlineBinaryWriteMaxBytes = 100; f.config.limits.binaryWriteMaxBytes = 3;
  await assert.rejects(f.service.write(request(Buffer.alloc(4), 'binary-cap')), { code: 'BINARY_INPUT_TOO_LARGE' });
  assert.equal((await f.files.changesList({ workspace_id: 'default' })).changes.length, 1);
});

test('raising chunk limits cannot bypass the public one-call inline cap', async t => {
  const f = await fixture(t);
  f.config.binaryInputs = { chunkMaxBytes: 262144, maxSessions: 4, maxCacheBytes: 67108864, ttlMs: 900000 };
  f.config.limits.inlineBinaryWriteMaxBytes = 1024;
  await assert.rejects(f.service.write(request(Buffer.alloc(65536))), { code: 'BINARY_INPUT_TOO_LARGE' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM file_operations').get()!.n, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('the internal byte handoff rechecks integrity, file limits and paths before journaling', async t => {
  const f = await fixture(t), bytes = original(), input = request(bytes);
  for (const invalid of [{ ...input, size_bytes: bytes.length + 1 }, { ...input, content_sha256: '0'.repeat(64) }]) {
    await assert.rejects(f.service.writeVerifiedBytes(invalid, bytes), { code: 'BINARY_INPUT_INTEGRITY_ERROR' });
  }
  await assert.rejects(f.service.writeVerifiedBytes({ ...input, path: '../outside.bin' }, bytes), { code: 'PATH_DENIED' });
  f.config.limits.binaryWriteMaxBytes = bytes.length - 1;
  await assert.rejects(f.service.writeVerifiedBytes(input, bytes), { code: 'BINARY_INPUT_TOO_LARGE' });
  f.config.limits.binaryWriteMaxBytes = bytes.length;
  f.config.binaryInputs = { chunkMaxBytes: 65536, maxSessions: 4, maxCacheBytes: bytes.length - 1, ttlMs: 900000 };
  await assert.rejects(f.service.writeVerifiedBytes(input, bytes), { code: 'BINARY_INPUT_TOO_LARGE' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM file_operations').get()!.n, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('the internal handoff owns verified bytes before await and rechecks a limit reduced during path resolution', async t => {
  const f = await fixture(t), bytes = original(), input = request(bytes);
  const first = f.service.writeVerifiedBytes(input, bytes); bytes.fill(0);
  const saved = await first; assert.equal(saved.sha256, input.content_sha256);
  assert.deepEqual(await fs.readFile(path.join(f.root, input.path)), original());
  const second = request(original(), 'second'); second.path = 'second.bin';
  const pending = f.service.writeVerifiedBytes(second, original());
  f.config.limits.binaryWriteMaxBytes = 1;
  await assert.rejects(pending, { code: 'BINARY_INPUT_TOO_LARGE' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM file_operations').get()!.n, 1);
  await assert.rejects(fs.stat(path.join(f.root, second.path)), { code: 'ENOENT' });
});

test('authorization and path policy apply unchanged to inline binary writes', async t => {
  const f = await fixture(t), input = request(original());
  for (const denied of ['../outside.bin', '.env', '.webcodex/private.bin', path.join(f.root, 'absolute.bin')]) {
    await assert.rejects(f.service.write({ ...input, path: denied }), { code: 'PATH_DENIED' });
  }
  await assert.rejects(f.service.write({ ...input, path: 'missing/file.bin' }), { code: 'ENOENT' });
  f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.service.write(input), { code: 'READ_ONLY' });
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM file_operations').get()!.n, 0);
});

test('post-write uncertainty is journaled and never automatically replayed', async t => {
  const f = await fixture(t), input = request(original()), target = path.join(f.root, input.path);
  const previous = Buffer.from([0, 4]); await fs.writeFile(target, previous);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => { await rename(...args); if (args[1] === target) await fs.writeFile(target, Buffer.from([0, 8])); });
  const overwrite = { ...input, expected_sha256: hash(previous) };
  await assert.rejects(f.service.write(overwrite), { code: 'FILE_WRITE_VERIFICATION_FAILED' });
  await assert.rejects(f.service.write(overwrite), { code: 'EXECUTION_UNKNOWN' });
  const status = await f.files.operationStatus({ workspace_id: 'default', tool: 'fs_write_binary', idempotency_key: input.idempotency_key });
  assert.equal(status.stage, 'unknown'); assert.equal(status.receipt, null); assert.equal('changes' in status && status.changes?.[0].status, 'unknown');
  assert.deepEqual(await fs.readFile(target), Buffer.from([0, 8]));
});

test('empty canonical input creates a verified empty file', async t => {
  const f = await fixture(t), input = request(Buffer.alloc(0)), saved = await f.service.write(input);
  assert.equal(input.content_base64, ''); assert.equal(saved.size_bytes, 0); assert.equal(saved.sha256, hash(Buffer.alloc(0)));
  assert.equal((await fs.readFile(path.join(f.root, input.path))).length, 0);
});
