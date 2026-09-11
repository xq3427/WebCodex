import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BinaryInputService } from '../src/binary-input.js';
import { BinaryChunkService } from '../src/binary-chunks.js';
import { binaryChunkLimits } from '../src/binary-limits.js';
import { FileService, hash } from '../src/filesystem.js';
import { StateStore } from '../src/store.js';
import { defaultConfig } from '../src/config.js';
import { WorkspacePaths } from '../src/paths.js';
import type { AppConfig } from '../src/types.js';

async function fixture(t: TestContext) {
  const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'webcodex-binary-chunks-'));
  const root = path.join(base, 'project'); await fs.mkdir(root);
  const configPath = path.join(base, 'config.json'), config: AppConfig = { ...defaultConfig(root, configPath), configPath }, stores: StateStore[] = [];
  const open = () => { const store = new StateStore(config.stateDir); stores.push(store); const ctx = { config, store, paths: new WorkspacePaths(config) }, files = new FileService(ctx), binaryInputs = new BinaryInputService(ctx, files); return { store, ctx, files, binaryInputs, chunks: new BinaryChunkService(ctx, files, binaryInputs) }; };
  t.after(async () => { for (const store of stores) store.close(); const actual = await fs.realpath(base); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-binary-chunks-')); await fs.rm(actual, { recursive: true, force: true }); });
  return { ...open(), root, config, open };
}
const input = (whole: Buffer, offset = 0, length = 65536, key = 'transfer') => {
  const chunk = whole.subarray(offset, offset + length);
  return { workspace_id: 'default', path: '论文原文件-🙂.pptx', content_base64: chunk.toString('base64'), chunk_sha256: hash(chunk), offset_bytes: offset, content_sha256: hash(whole), size_bytes: whole.length, expected_sha256: null, idempotency_key: key };
};
const count = (store: StateStore, table: string) => Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

test('default chunk and file budgets are independent of the inline cap, while explicit old settings are preserved', async t => {
  const f = await fixture(t);
  delete f.config.binaryInputs; delete f.config.limits.binaryWriteMaxBytes;
  f.config.limits.inlineBinaryWriteMaxBytes = 1024;
  assert.deepEqual(binaryChunkLimits(f.config), { chunkMaxBytes: 65536, fileMaxBytes: 33554432, maxCacheBytes: 67108864, maxSessions: 4, ttlMs: 900000 });
  f.config.binaryInputs = { chunkMaxBytes: 12288, maxSessions: 2, maxCacheBytes: 1048576, ttlMs: 300000 };
  assert.deepEqual(binaryChunkLimits(f.config), { chunkMaxBytes: 12288, fileMaxBytes: 1048576, maxCacheBytes: 1048576, maxSessions: 2, ttlMs: 300000 });
  f.config.limits.binaryWriteMaxBytes = 8192;
  assert.equal(binaryChunkLimits(f.config).chunkMaxBytes, 8192); assert.equal(binaryChunkLimits(f.config).fileMaxBytes, 8192);
});

test('64 KiB chunks preserve a multi-MiB original file across restart even with a smaller inline cap', async t => {
  const f = await fixture(t), whole = Buffer.alloc(2 * 1048576 + 117);
  for (let i = 0; i < whole.length; i++) whole[i] = i % 251;
  f.config.binaryInputs = { chunkMaxBytes: 65536, maxSessions: 4, maxCacheBytes: 67108864, ttlMs: 900000 };
  f.config.limits.inlineBinaryWriteMaxBytes = 1024;
  const first = await f.chunks.append(input(whole));
  assert.equal(first.next_offset, 65536); assert.equal(first.chunk_max_bytes, 65536);
  f.store.close(); const reopened = f.open();
  // Chunk completion must hand verified bytes to the internal writer, never
  // expand the entire file into another Base64 call to the public inline path.
  t.mock.method(reopened.binaryInputs, 'write', () => { assert.fail('Chunk completion must not call the inline writer'); });
  let last: any;
  for (let offset = 65536; offset < whole.length; offset += 65536) {
    last = await reopened.chunks.append(input(whole, offset));
    if (last.status === 'receiving') await assert.rejects(fs.stat(path.join(f.root, input(whole).path)), { code: 'ENOENT' });
  }
  assert.equal(last.status, 'saved'); assert.equal(last.size_bytes, whole.length); assert.equal(last.sha256, hash(whole));
  assert.equal(last.source, 'chunked_base64'); assert.equal(last.content_processing, 'none');
  assert.deepEqual(await fs.readFile(path.join(f.root, input(whole).path)), whole);
  assert.equal(count(reopened.store, 'file_operations'), 1); assert.equal(count(reopened.store, 'binary_input_chunks'), 0);
  const duplicate = await reopened.chunks.append(input(whole, 2 * 1048576));
  assert.deepEqual(duplicate, last); assert.equal(count(reopened.store, 'file_changes'), 1);
  const status = await reopened.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' });
  assert.equal(status.status, 'saved'); assert.equal(status.operation.tool, 'fs_write_binary');
  assert.equal(status.operation.current_observation.sha256, hash(whole));
});

test('a pre-existing inline receipt remains compatible with the chunk journal payload and is never rewritten', async t => {
  const f = await fixture(t), whole = Buffer.from('historical original bytes'), chunk = input(whole);
  const receipt = await f.binaryInputs.write(chunk);
  assert.equal(receipt.source, 'inline_base64');
  await fs.writeFile(path.join(f.root, chunk.path), 'later external edit'); f.store.close();
  const reopened = f.open(), saved = await reopened.chunks.append(chunk);
  assert.equal(saved.status, 'saved'); assert.equal(saved.source, 'inline_base64'); assert.deepEqual(saved.receipt, receipt);
  assert.equal(await fs.readFile(path.join(f.root, chunk.path), 'utf8'), 'later external edit');
  assert.equal(count(reopened.store, 'file_changes'), 1); assert.equal(count(reopened.store, 'binary_input_sessions'), 0);
});

test('tampering with a persisted chunk after restart fails full verification before writing', async t => {
  const f = await fixture(t), whole = Buffer.alloc(65536 + 17, 139);
  f.config.binaryInputs = { chunkMaxBytes: 65536, maxSessions: 4, maxCacheBytes: 67108864, ttlMs: 900000 };
  await f.chunks.append(input(whole));
  f.store.db.prepare('UPDATE binary_input_chunks SET bytes=? WHERE offset_bytes=0').run(Buffer.alloc(65536, 140));
  f.store.close(); const reopened = f.open();
  await assert.rejects(reopened.chunks.append(input(whole, 65536)), { code: 'BINARY_CHUNK_INTEGRITY_ERROR' });
  assert.equal(count(reopened.store, 'file_operations'), 0); assert.equal(count(reopened.store, 'file_changes'), 0);
  assert.equal((await reopened.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' })).status, 'failed');
  await assert.rejects(fs.stat(path.join(f.root, input(whole).path)), { code: 'ENOENT' });
});

test('a reduced whole-file limit blocks existing large transfers independently of the inline cap', async t => {
  const f = await fixture(t), whole = Buffer.alloc(300000, 71);
  f.config.binaryInputs = { chunkMaxBytes: 65536, maxSessions: 4, maxCacheBytes: 67108864, ttlMs: 900000 };
  await f.chunks.append(input(whole)); f.config.limits.binaryWriteMaxBytes = 262144;
  const status = await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' });
  assert.equal(status.status, 'blocked'); assert.equal(status.policy.file_limit_bytes, 262144);
  await assert.rejects(f.chunks.append(input(whole, 65536)), { code: 'BINARY_INPUT_TOO_LARGE' });
  assert.equal(count(f.store, 'binary_input_chunks'), 1); assert.equal(count(f.store, 'file_changes'), 0);
});

test('a chunk cap reduced while awaiting path validation is enforced before allocating staging', async t => {
  const f = await fixture(t), whole = Buffer.alloc(65536 + 5, 38);
  f.config.binaryInputs = { chunkMaxBytes: 65536, maxSessions: 4, maxCacheBytes: 67108864, ttlMs: 900000 };
  const pending = f.chunks.append(input(whole)); f.config.binaryInputs.chunkMaxBytes = 12288;
  await assert.rejects(pending, { code: 'BINARY_INPUT_TOO_LARGE' });
  assert.equal(count(f.store, 'binary_input_sessions'), 0); assert.equal(count(f.store, 'file_changes'), 0);
});

test('an old persisted finalizing session becomes unknown after restart and cannot be replayed', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2, 3]), prepare = f.store.db.prepare.bind(f.store.db);
  const mocked = t.mock.method(f.store.db, 'prepare', (sql: string) => { if (sql.startsWith("UPDATE binary_input_sessions SET stage='finalizing'")) throw new Error('Synthetic process interruption'); return prepare(sql); });
  await assert.rejects(f.chunks.append(input(whole)), /Synthetic process interruption/); mocked.mock.restore();
  f.store.db.prepare("UPDATE binary_input_sessions SET stage='finalizing'").run();
  f.store.close(); const reopened = f.open();
  assert.equal((await reopened.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' })).status, 'unknown');
  await assert.rejects(reopened.chunks.append(input(whole)), { code: 'EXECUTION_UNKNOWN' });
  assert.equal(count(reopened.store, 'binary_input_chunks'), 1); assert.equal(count(reopened.store, 'file_changes'), 0);
});

test('explicit legacy 12 KiB chunks remain valid and 170732 original bytes save in 14 chunks', async t => {
  const f = await fixture(t), whole = Buffer.from(Array.from({ length: 170732 }, (_, i) => i % 251)); let last: any;
  f.config.binaryInputs = { chunkMaxBytes: 12288, maxSessions: 4, maxCacheBytes: 1048576, ttlMs: 900000 };
  for (let offset = 0; offset < whole.length; offset += 12288) {
    last = await f.chunks.append(input(whole, offset, 12288));
    assert.equal(last.next_offset, Math.min(offset + 12288, whole.length)); assert.equal(last.chunk_max_bytes, 12288);
    if (last.next_offset < whole.length) { assert.equal(last.status, 'receiving'); assert.equal(last.whole_file_verified, false); await assert.rejects(fs.stat(path.join(f.root, input(whole).path)), { code: 'ENOENT' }); }
  }
  assert.equal(last.status, 'saved'); assert.equal(last.verified, true); assert.equal(last.sha256, hash(whole)); assert.equal(last.size_bytes, whole.length);
  assert.deepEqual(await fs.readFile(path.join(f.root, input(whole).path)), whole);
  assert.equal(count(f.store, 'binary_input_chunks'), 0); assert.equal(count(f.store, 'binary_input_sessions'), 0); assert.equal(count(f.store, 'file_operations'), 1);
  assert.deepEqual(await f.chunks.append(input(whole, 159744)), last);
  const status = await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' });
  assert.equal(status.status, 'saved'); assert.equal(status.operation.stage, 'done'); assert.equal(status.operation.current_observation.sha256, hash(whole));
});

test('duplicate chunks are exact and ordered, and metadata cannot change under one key', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2, 3, 4, 5]), first = input(whole, 0, 3);
  f.config.binaryInputs = { chunkMaxBytes: 3, maxSessions: 4, maxCacheBytes: 1048576, ttlMs: 900000 };
  const progress = await f.chunks.append(first); assert.deepEqual(await f.chunks.append(first), progress);
  const different = Buffer.from([0, 9, 2]);
  await assert.rejects(f.chunks.append({ ...first, content_base64: different.toString('base64'), chunk_sha256: hash(different) }), { code: 'BINARY_CHUNK_CONFLICT' });
  await assert.rejects(f.chunks.append(input(whole, 4, 2)), { code: 'BINARY_CHUNK_ORDER' });
  await assert.rejects(f.chunks.append({ ...first, path: 'different.pptx' }), { code: 'BINARY_CHUNK_CONFLICT' });
  assert.equal((await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' })).next_offset, 3);
  assert.equal((await f.chunks.append(input(whole, 3, 3))).status, 'saved');
});

test('a corrupt final chunk is rejected without consuming its offset and a corrected chunk can finish', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2, 3, 4, 5]);
  f.config.binaryInputs = { chunkMaxBytes: 3, maxSessions: 4, maxCacheBytes: 1048576, ttlMs: 900000 };
  await f.chunks.append(input(whole, 0, 3));
  await assert.rejects(f.chunks.append({ ...input(whole, 3, 3), chunk_sha256: '0'.repeat(64) }), { code: 'BINARY_CHUNK_INTEGRITY_ERROR' });
  assert.equal((await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' })).next_offset, 3); assert.equal(count(f.store, 'file_changes'), 0);
  assert.equal((await f.chunks.append(input(whole, 3, 3))).status, 'saved');
});

test('whole-file SHA failure freezes staging and never writes the target', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2, 3, 4, 5]);
  f.config.binaryInputs = { chunkMaxBytes: 3, maxSessions: 4, maxCacheBytes: 1048576, ttlMs: 900000 };
  await f.chunks.append({ ...input(whole, 0, 3), content_sha256: 'a'.repeat(64) });
  await assert.rejects(f.chunks.append({ ...input(whole, 3, 3), content_sha256: 'a'.repeat(64) }), { code: 'BINARY_CHUNK_INTEGRITY_ERROR' });
  assert.equal((await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' })).status, 'failed');
  assert.equal(count(f.store, 'file_operations'), 0); assert.equal(count(f.store, 'file_changes'), 0); assert.deepEqual(await fs.readdir(f.root), []);
});

test('receiving progress and chunk bytes survive a clean restart', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2, 3, 4, 5]);
  f.config.binaryInputs = { chunkMaxBytes: 3, maxSessions: 4, maxCacheBytes: 1048576, ttlMs: 900000 };
  await f.chunks.append(input(whole, 0, 3)); f.store.close(); const reopened = f.open();
  const status = await reopened.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' });
  assert.equal(status.status, 'receiving'); assert.equal(status.next_offset, 3);
  assert.equal((await reopened.chunks.append(input(whole, 3, 3))).status, 'saved');
  assert.deepEqual(await fs.readFile(path.join(f.root, input(whole).path)), whole);
});

test('a complete persisted receiving session can finalize by retransmitting the accepted last chunk', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2, 3]), prepare = f.store.db.prepare.bind(f.store.db);
  const mock = t.mock.method(f.store.db, 'prepare', (sql: string) => { if (sql.startsWith("UPDATE binary_input_sessions SET stage='finalizing'")) throw new Error('Synthetic interruption before writer'); return prepare(sql); });
  await assert.rejects(f.chunks.append(input(whole)), /Synthetic interruption/); mock.mock.restore(); f.store.close(); const reopened = f.open();
  const status = await reopened.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' });
  assert.equal(status.status, 'receiving'); assert.equal(status.resume_action, 'repeat_last_chunk'); assert.equal(status.retry_chunk_offset, 0); assert.equal(status.retry_chunk_bytes, whole.length);
  assert.equal((await reopened.chunks.append(input(whole))).status, 'saved');
  assert.deepEqual(await fs.readFile(path.join(f.root, input(whole).path)), whole);
});

test('declared sizes reserve cache capacity and lazy TTL cleanup releases only staging', async t => {
  const f = await fixture(t); f.config.binaryInputs = { chunkMaxBytes: 3, maxSessions: 2, maxCacheBytes: 10, ttlMs: 1000 };
  const whole = Buffer.from([0, 1, 2, 3, 4, 5]), first = input(whole, 0, 3);
  await fs.writeFile(path.join(f.root, 'unrelated.txt'), 'keep'); await f.chunks.append(first);
  await assert.rejects(f.chunks.append({ ...input(whole, 0, 3, 'second'), path: 'second.bin' }), { code: 'BINARY_CHUNK_CAPACITY' });
  f.store.db.prepare('UPDATE binary_input_sessions SET expires_at=?').run(Date.now() - 1);
  await f.chunks.append({ ...input(whole, 0, 3, 'second'), path: 'second.bin' });
  assert.equal(count(f.store, 'binary_input_sessions'), 1); assert.equal(count(f.store, 'binary_input_chunks'), 1);
  assert.equal(await fs.readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'keep');
  f.store.db.prepare('UPDATE binary_input_sessions SET expires_at=?').run(Date.now() - 1);
  assert.equal((await f.chunks.status({ workspace_id: 'default', idempotency_key: 'second' })).status, 'expired');
  assert.equal(count(f.store, 'binary_input_chunks'), 1); // Status never mutates staging.
  await f.chunks.append({ ...input(whole, 0, 3, 'third'), path: 'third.bin' });
  assert.equal(count(f.store, 'binary_input_sessions'), 1); assert.equal(f.store.db.prepare('SELECT operation_key FROM binary_input_sessions').get()!.operation_key, 'third');
});

test('session count and reduced cache policy constrain existing transfers', async t => {
  const f = await fixture(t); f.config.binaryInputs = { chunkMaxBytes: 4, maxSessions: 1, maxCacheBytes: 20, ttlMs: 1000 };
  const whole = Buffer.from([0, 1, 2, 3, 4, 5]); await f.chunks.append(input(whole, 0, 4));
  await assert.rejects(f.chunks.append({ ...input(whole, 0, 4, 'second'), path: 'second.bin' }), { code: 'BINARY_CHUNK_CAPACITY' });
  f.config.binaryInputs.maxCacheBytes = 3;
  const status = await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' });
  assert.equal(status.chunk_max_bytes, 3); assert.equal(status.status, 'blocked'); assert.equal(status.resume_action, 'inspect_local_limits');
  await assert.rejects(f.chunks.append(input(whole, 4, 2)), { code: 'BINARY_INPUT_TOO_LARGE' });
  assert.equal(count(f.store, 'file_changes'), 0);
});

test('CAS is checked at final commit and readonly policy protects both destination and staging', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2, 3, 4, 5]), target = path.join(f.root, input(whole).path), before = Buffer.from('original');
  f.config.binaryInputs = { chunkMaxBytes: 3, maxSessions: 4, maxCacheBytes: 1048576, ttlMs: 900000 };
  await fs.writeFile(target, before); const first = { ...input(whole, 0, 3), expected_sha256: hash(before) }, last = { ...input(whole, 3, 3), expected_sha256: hash(before) };
  await f.chunks.append(first); f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.chunks.append(last), { code: 'READ_ONLY' });
  assert.equal((await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' })).next_offset, 3);
  f.config.workspaces[0].readOnly = false; await fs.writeFile(target, 'external');
  await assert.rejects(f.chunks.append(last), { code: 'VERSION_CONFLICT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'external');
  const status = await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' }); assert.equal(status.status, 'failed'); assert.equal(status.operation.stage, 'failed');
});

test('unknown downstream outcomes freeze chunk replay and preserve separate current observations', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2, 3]), target = path.join(f.root, input(whole).path), before = Buffer.from([0, 9]);
  await fs.writeFile(target, before); const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => { await rename(...args); if (args[1] === target) await fs.writeFile(target, Buffer.from([0, 7])); });
  const request = { ...input(whole), expected_sha256: hash(before) };
  await assert.rejects(f.chunks.append(request), { code: 'FILE_WRITE_VERIFICATION_FAILED' });
  await assert.rejects(f.chunks.append(request), { code: 'EXECUTION_UNKNOWN' });
  const status = await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' });
  assert.equal(status.status, 'unknown'); assert.equal(status.operation.current_observation.sha256, hash(Buffer.from([0, 7]))); assert.equal(count(f.store, 'file_changes'), 1);
});

test('identical in-flight final chunks join the same writer while another chunk gets busy', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2, 3]), write = f.binaryInputs.writeVerifiedBytes.bind(f.binaryInputs); let enter!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(f.binaryInputs, 'writeVerifiedBytes', async (...args: Parameters<typeof write>) => { calls++; enter(); await released; return write(...args); });
  const first = f.chunks.append(input(whole)); await entered; const duplicate = f.chunks.append(input(whole));
  await assert.rejects(f.chunks.append(input(Buffer.from([0, 9, 2, 3]))), { code: 'BINARY_CHUNK_BUSY' });
  release(); assert.deepEqual(await duplicate, await first); assert.equal(calls, 1);
});

test('malformed chunks fail before staging and empty files use one canonical empty chunk', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2]);
  for (const content_base64 of ['AA==\n', 'data:application/octet-stream;base64,AA==', 'AR==', 'AA']) await assert.rejects(f.chunks.append({ ...input(whole), content_base64 }), { code: 'BINARY_CHUNK_INVALID' });
  await assert.rejects(f.chunks.append({ ...input(whole), offset_bytes: -1 }), { code: 'BINARY_CHUNK_INVALID' });
  await assert.rejects(f.chunks.append(input(whole, 3, 0)), { code: 'BINARY_CHUNK_INVALID' });
  assert.equal(count(f.store, 'binary_input_sessions'), 0);
  const saved = await f.chunks.append(input(Buffer.alloc(0))); assert.equal(saved.status, 'saved'); assert.equal(saved.size_bytes, 0);
});

test('saved Windows-style paths remain saved when receipt exists but staging cleanup was interrupted', async t => {
  const f = await fixture(t), whole = Buffer.from([0, 1, 2, 3]), prepare = f.store.db.prepare.bind(f.store.db);
  await fs.mkdir(path.join(f.root, 'sub'));
  const mocked = t.mock.method(f.store.db, 'prepare', (sql: string) => { if (sql === 'DELETE FROM binary_input_sessions WHERE id=?') throw new Error('Synthetic cleanup interruption'); return prepare(sql); });
  const request = { ...input(whole), path: 'sub\\original.pptx' };
  await assert.rejects(f.chunks.append(request), /Synthetic cleanup interruption/); mocked.mock.restore();
  const status = await f.chunks.status({ workspace_id: 'default', idempotency_key: request.idempotency_key });
  assert.equal(status.status, 'saved'); assert.equal(status.receipt.path, 'sub/original.pptx'); assert.equal(status.operation.path, request.path);
  assert.equal(count(f.store, 'binary_input_chunks'), 1); // Read-only status retains staging.
  assert.deepEqual(await fs.readFile(path.join(f.root, 'sub', 'original.pptx')), whole);
});

test('raising the chunk limit preserves exact smaller duplicates but never permits undersized new chunks', async t => {
  const f = await fixture(t), whole = Buffer.from(Array.from({ length: 12 }, (_, i) => i));
  f.config.binaryInputs = { chunkMaxBytes: 4, maxSessions: 4, maxCacheBytes: 1048576, ttlMs: 900000 };
  await assert.rejects(f.chunks.append(input(whole, 0, 1)), { code: 'BINARY_CHUNK_INVALID' });
  assert.equal(count(f.store, 'binary_input_sessions'), 0);
  await f.chunks.append(input(whole, 0, 4)); f.config.binaryInputs.chunkMaxBytes = 8;
  const duplicate = await f.chunks.append(input(whole, 0, 4));
  assert.equal(duplicate.status, 'receiving'); assert.equal(duplicate.next_offset, 4); assert.equal(duplicate.chunk_max_bytes, 8);
  await assert.rejects(f.chunks.append(input(whole, 4, 4)), { code: 'BINARY_CHUNK_INVALID' });
  assert.equal(count(f.store, 'binary_input_chunks'), 1);
  assert.equal((await f.chunks.append(input(whole, 4, 8))).status, 'saved');
  assert.deepEqual(await fs.readFile(path.join(f.root, input(whole).path)), whole);
});

test('a smaller current cap explicitly blocks an oversized stored recovery chunk without bypassing policy', async t => {
  const f = await fixture(t), whole = Buffer.from(Array.from({ length: 8 }, (_, i) => i)), prepare = f.store.db.prepare.bind(f.store.db);
  const mocked = t.mock.method(f.store.db, 'prepare', (sql: string) => { if (sql.startsWith("UPDATE binary_input_sessions SET stage='finalizing'")) throw new Error('Synthetic interruption'); return prepare(sql); });
  await assert.rejects(f.chunks.append(input(whole)), /Synthetic interruption/); mocked.mock.restore();
  f.config.binaryInputs = { chunkMaxBytes: 4, maxSessions: 4, maxCacheBytes: 1048576, ttlMs: 900000 };
  const status = await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' });
  assert.equal(status.status, 'blocked'); assert.equal(status.policy_blocked, true); assert.equal(status.resume_action, 'inspect_local_limits');
  assert.equal(status.policy.required_recovery_chunk_bytes, 8); assert.equal(status.policy.chunk_limit_bytes, 4);
  await assert.rejects(f.chunks.append(input(whole)), { code: 'BINARY_INPUT_TOO_LARGE' });
  assert.equal(count(f.store, 'file_changes'), 0); assert.equal(count(f.store, 'file_operations'), 0); assert.equal(count(f.store, 'binary_input_chunks'), 1);
  f.config.binaryInputs.chunkMaxBytes = 8;
  const permitted = await f.chunks.status({ workspace_id: 'default', idempotency_key: 'transfer' });
  assert.equal(permitted.status, 'receiving'); assert.equal(permitted.resume_action, 'repeat_last_chunk');
  assert.equal((await f.chunks.append(input(whole))).status, 'saved');
});
