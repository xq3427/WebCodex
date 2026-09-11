import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { defaultConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { WorkspacePaths } from '../src/paths.js';
import { FileService, hash } from '../src/filesystem.js';
import { FileImportService } from '../src/file-import.js';
import { FileSaveService, FILE_SAVE_POLL_LIMIT, type FileSaveInput } from '../src/file-save.js';
import { downloadChatGptFile } from '../src/file-download.js';
import { AppError } from '../src/errors.js';
import type { AppConfig } from '../src/types.js';

const SOURCE = 'https://files.oaiusercontent.com/synthetic-original.png?sig=SYNTHETIC_PRIVATE_DOWNLOAD';
const FILE_ID = 'file-SYNTHETIC_PRIVATE_HOST_ID';
const small = Buffer.from([137, 80, 78, 71, 0, 255, 12, 24]);
const request = (bytes = small, extra: Partial<FileSaveInput> = {}): FileSaveInput => ({ workspace_id: 'default', path: '原图.png',
  file_id: FILE_ID, size_bytes: bytes.length, content_sha256: hash(bytes), expected_sha256: null, idempotency_key: 'save-original', ...extra });
async function fixture(t: TestContext, download: typeof downloadChatGptFile = async () => small) {
  const parent = await fs.realpath(tmpdir()), base = await fs.mkdtemp(path.join(parent, 'webcodex-file-save-'));
  const root = path.join(base, 'project'); await fs.mkdir(root);
  const configPath = path.join(base, 'synthetic-config.json'), config: AppConfig = { ...defaultConfig(root, configPath), configPath };
  let now = 1000000;
  const stores: StateStore[] = [], services: FileSaveService[] = [];
  const open = () => {
    const store = new StateStore(config.stateDir); stores.push(store);
    const ctx = { config, store, paths: new WorkspacePaths(config) }, files = new FileService(ctx);
    const imports = new FileImportService(ctx, files, download), saves = new FileSaveService(ctx, files, imports, { now: () => now }); services.push(saves);
    return { store, ctx, files, imports, saves };
  };
  t.after(async () => {
    for (const service of services) service.close();
    for (const store of stores) store.close();
    const actual = await fs.realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-file-save-'));
    await fs.rm(actual, { recursive: true, force: true });
  });
  return { ...open(), root, base, config, reopen: open, advance: (ms: number) => { now += ms; } };
}
function crc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, bytes: Buffer) {
  const body = Buffer.concat([Buffer.from(type), bytes]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]);
}
function syntheticPng() {
  const size = 2341397, width = 768, height = 512, pixels = Buffer.alloc((width * 3 + 1) * height, 0x89);
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ihdr = pngChunk('IHDR', header);
  const compressed = deflateSync(pixels), idat = pngChunk('IDAT', compressed), end = pngChunk('IEND', Buffer.alloc(0));
  const padding = pngChunk('wcTx', Buffer.alloc(size - signature.length - ihdr.length - idat.length - end.length - 12, 0xa5));
  return { bytes: Buffer.concat([signature, ihdr, padding, idat, end]), pixels };
}

test('an authorized host file saves all 2,341,397 original PNG bytes without model-visible credentials', async t => {
  const png = syntheticPng(); let downloads = 0;
  const f = await fixture(t, async (url, options) => { downloads++; assert.equal(url, SOURCE); assert.equal(options.maxBytes, 33554432); return png.bytes; });
  // This route stores no byte chunks. Its importer is serial and governed by
  // binaryWriteMaxBytes; the separate chunk staging cache must not truncate it.
  f.config.binaryInputs = { chunkMaxBytes: 65536, maxSessions: 4, maxCacheBytes: 1024, ttlMs: 900000 };
  const input = request(png.bytes), opened = await f.saves.open(input), privateData = opened.meta!.webcodexFileSave;
  assert.equal(opened.data.status, 'awaiting_host_file'); assert.equal(privateData.file_id, FILE_ID);
  const result = await f.saves.complete({ ticket: privateData.ticket, download_url: SOURCE });
  assert.equal(result.status, 'saved'); assert.equal(result.verified, true); assert.equal(result.size_bytes, 2341397); assert.equal(result.sha256, hash(png.bytes));
  const saved = await fs.readFile(path.join(f.root, input.path)); assert.deepEqual(saved, png.bytes);
  const imageData: Buffer[] = [];
  for (let offset = 8; offset < saved.length;) {
    const size = saved.readUInt32BE(offset), type = saved.subarray(offset + 4, offset + 8).toString('ascii');
    assert.equal(saved.readUInt32BE(offset + 8 + size), crc32(saved.subarray(offset + 4, offset + 8 + size)));
    if (type === 'IDAT') imageData.push(saved.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  assert.deepEqual(inflateSync(Buffer.concat(imageData)), png.pixels);
  assert.equal((await f.files.stat({ workspace_id: input.workspace_id, path: input.path })).sha256, input.content_sha256);
  assert.equal((await f.saves.complete({ ticket: privateData.ticket, download_url: SOURCE })).status, 'saved');
  const reopened = await f.saves.open(input); assert.equal(reopened.data.status, 'saved'); assert.equal(reopened.meta, undefined); assert.equal(downloads, 1);
  const publicData = JSON.stringify([opened.data, result, reopened.data, await f.saves.status(inputForStatus(input))]);
  const persisted = JSON.stringify({ sessions: f.store.db.prepare('SELECT * FROM file_save_sessions').all(), operations: f.store.db.prepare('SELECT * FROM file_operations').all(), audit: f.store.db.prepare('SELECT * FROM audit_events').all() });
  for (const secret of [SOURCE, FILE_ID, privateData.ticket, 'SYNTHETIC_PRIVATE_DOWNLOAD']) {
    assert.equal(publicData.includes(secret), false); assert.equal(persisted.includes(secret), false);
  }
});
const inputForStatus = (input: FileSaveInput) => ({ workspace_id: input.workspace_id, idempotency_key: input.idempotency_key });

for (const mismatch of ['hash', 'size'] as const) test(`original ${mismatch} mismatch preserves the prior file and is never replayed`, async t => {
  let downloads = 0; const f = await fixture(t, async () => { downloads++; return small; });
  const before = Buffer.from('old original image'); await fs.writeFile(path.join(f.root, '原图.png'), before);
  const input = request(small, { expected_sha256: hash(before), ...(mismatch === 'hash' ? { content_sha256: hash(Buffer.from('different original')) } : { size_bytes: small.length + 1 }) });
  const opened = await f.saves.open(input), ticket = opened.meta!.webcodexFileSave.ticket;
  const result = await f.saves.complete({ ticket, download_url: SOURCE });
  assert.equal(result.status, 'failed'); assert.equal(result.error_code, 'FILE_IMPORT_ORIGINAL_MISMATCH'); assert.equal(result.operation.stage, 'failed');
  assert.deepEqual(await fs.readFile(path.join(f.root, input.path)), before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM file_changes').get()!.count, 0);
  assert.equal((await f.saves.complete({ ticket, download_url: SOURCE })).status, 'failed');
  assert.equal((await f.saves.open(input)).meta, undefined); assert.equal(downloads, 1);
});

test('duplicate opens share a ticket and conflicting source or destination metadata never borrows it', async t => {
  const f = await fixture(t), input = request();
  const opened = await Promise.all([f.saves.open(input), f.saves.open({ ...input })]);
  assert.deepEqual(opened[0].meta, opened[1].meta);
  for (const extra of [{ path: 'other.png' }, { file_id: 'file_other' }, { content_sha256: hash(Buffer.from('other')) }, { size_bytes: 9 }, { expected_sha256: hash(small) }]) {
    await assert.rejects(f.saves.open({ ...input, ...extra }), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  for (const file_id of ['sandbox:/mnt/data/original.png', 'https://files.oaiusercontent.com/a', 'sediment://file-a', 'file-../a', 'file-C:\\a', 'file-', 'file-' + 'a'.repeat(512)]) {
    await assert.rejects(f.saves.open({ ...input, file_id, idempotency_key: 'bad-id' }), { code: 'FILE_SAVE_INVALID_ARGUMENT' });
  }
});

test('concurrent completion shares one import and host timeout reports cannot downgrade an active or saved write', async t => {
  let begin!: () => void, finish!: (bytes: Buffer) => void, downloads = 0;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const f = await fixture(t, async url => { assert.equal(url, SOURCE); downloads++; begin(); return new Promise(resolve => { finish = resolve; }); });
  const opened = await f.saves.open(request()), ticket = opened.meta!.webcodexFileSave.ticket;
  const firstInput = { ticket, download_url: SOURCE }, first = f.saves.complete(firstInput);
  firstInput.download_url = 'https://files.oaiusercontent.com/changed-after-call'; await started;
  const second = f.saves.complete({ ticket, download_url: 'https://files.oaiusercontent.com/refreshed' });
  const reported = await f.saves.fail({ ticket, error_code: 'FILE_SAVE_TRANSFER_UNCERTAIN' });
  assert.equal(reported.status, 'pending'); assert.equal(reported.phase, 'importing');
  finish(small); assert.deepEqual(await first, await second); assert.equal(downloads, 1);
  assert.equal((await f.saves.fail({ ticket, error_code: 'HOST_FILE_RESOLUTION_FAILED' })).status, 'saved');
  assert.equal((await f.saves.status(inputForStatus(request()))).status, 'saved');
});

test('host errors and unconfirmed dispatch stop the ticket without starting a download', async t => {
  let downloads = 0; const f = await fixture(t, async () => { downloads++; return small; });
  for (const [index, error_code] of ['HOST_FILE_API_UNAVAILABLE', 'HOST_FILE_REFERENCE_UNAVAILABLE', 'HOST_FILE_RESOLUTION_FAILED', 'FILE_SAVE_TRANSFER_UNCERTAIN'].entries()) {
    const input = request(small, { idempotency_key: 'host-failure-' + index });
    const opened = await f.saves.open(input), ticket = opened.meta!.webcodexFileSave.ticket;
    const failed = await f.saves.fail({ ticket, error_code: error_code as 'HOST_FILE_API_UNAVAILABLE' });
    assert.equal(failed.status, error_code === 'FILE_SAVE_TRANSFER_UNCERTAIN' ? 'unknown' : 'failed'); assert.equal(failed.error_code, error_code);
    assert.equal((await f.saves.complete({ ticket, download_url: SOURCE })).status, failed.status);
    assert.equal((await f.saves.open(input)).meta, undefined);
  }
  assert.equal(downloads, 0); assert.deepEqual(await fs.readdir(f.root), []);
});

test('destination and configured size failures are checked before host resolution', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'old.png'), small);
  await assert.rejects(f.saves.open(request(small, { path: 'old.png' })), { code: 'VERSION_CONFLICT' });
  await assert.rejects(f.saves.open(request(small, { expected_sha256: hash(small) })), { code: 'VERSION_CONFLICT' });
  await assert.rejects(f.saves.open(request(small, { path: '../escape.png' })), { code: 'PATH_DENIED' });
  await assert.rejects(f.saves.open(request(small, { path: 'missing/new.png' })), { code: 'ENOENT' });
  f.config.limits.binaryWriteMaxBytes = 1024;
  await assert.rejects(f.saves.open(request(Buffer.alloc(1025))), { code: 'FILE_IMPORT_TOO_LARGE' });
  f.config.workspaces[0].readOnly = true;
  await assert.rejects(f.saves.open(request()), { code: 'READ_ONLY' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM file_save_sessions').get()!.count, 0);
});

test('binding, target edits and tighter configuration prevent use of an already issued ticket', async t => {
  let downloads = 0; const f = await fixture(t, async () => { downloads++; return small; });
  const input = request(), opened = await f.saves.open(input), ticket = opened.meta!.webcodexFileSave.ticket;
  f.config.workspaces[0].uid = randomUUID();
  await assert.rejects(f.saves.complete({ ticket, download_url: SOURCE }), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  f.config.workspaces[0].uid = undefined;
  await fs.writeFile(path.join(f.root, input.path), 'external edit');
  const conflict = await f.saves.complete({ ticket, download_url: SOURCE });
  assert.equal(conflict.status, 'failed'); assert.equal(conflict.error_code, 'VERSION_CONFLICT');
  assert.equal(await fs.readFile(path.join(f.root, input.path), 'utf8'), 'external edit');
  const big = request(Buffer.alloc(2048), { path: 'large.png', idempotency_key: 'tightened-size' }), bigOpened = await f.saves.open(big);
  f.config.limits.binaryWriteMaxBytes = 1024;
  assert.equal((await f.saves.status(inputForStatus(big))).status, 'blocked');
  const denied = await f.saves.complete({ ticket: bigOpened.meta!.webcodexFileSave.ticket, download_url: SOURCE });
  assert.equal(denied.status, 'failed'); assert.equal(denied.error_code, 'FILE_IMPORT_TOO_LARGE'); assert.equal(downloads, 0);
});

test('pending observations are bounded and ticket expiry does not permit reopening the same operation', async t => {
  const f = await fixture(t);
  f.config.binaryInputs = { chunkMaxBytes: 65536, maxSessions: 1, maxCacheBytes: 67108864, ttlMs: 1000 };
  const input = request(), opened = await f.saves.open(input);
  for (let index = 0; index < FILE_SAVE_POLL_LIMIT + 3; index++) {
    const state = await f.saves.status(inputForStatus(input));
    assert.equal(state.status, 'pending'); assert.equal(state.poll_count, Math.min(index + 1, FILE_SAVE_POLL_LIMIT));
    assert.equal(state.can_poll, index + 1 < FILE_SAVE_POLL_LIMIT);
    assert.equal(state.polls_remaining, Math.max(FILE_SAVE_POLL_LIMIT - index - 1, 0)); assert.equal(state.retry_after_ms, 1000);
  }
  await assert.rejects(f.saves.open(request(small, { path: 'next.png', idempotency_key: 'next' })), { code: 'FILE_SAVE_CAPACITY' });
  f.advance(1001);
  assert.equal((await f.saves.status(inputForStatus(input))).status, 'expired');
  assert.equal((await f.saves.complete({ ticket: opened.meta!.webcodexFileSave.ticket, download_url: SOURCE })).status, 'expired');
  assert.equal((await f.saves.open(input)).data.status, 'expired');
  assert.equal((await f.saves.open(request(small, { path: 'next.png', idempotency_key: 'next' }))).data.status, 'awaiting_host_file');
});

test('shortening TTL invalidates pending tickets against their creation time', async t => {
  const f = await fixture(t), input = request(); await f.saves.open(input);
  f.advance(2000); f.config.binaryInputs = { chunkMaxBytes: 65536, maxSessions: 4, maxCacheBytes: 67108864, ttlMs: 1000 };
  assert.equal((await f.saves.status(inputForStatus(input))).status, 'expired');
  assert.equal((await f.saves.open(input)).meta, undefined);
});

test('completion checks expiry without a prior poll and a lowered session limit prevents fresh downloads', async t => {
  let downloads = 0; const f = await fixture(t, async () => { downloads++; return small; });
  f.config.binaryInputs = { chunkMaxBytes: 65536, maxSessions: 2, maxCacheBytes: 67108864, ttlMs: 1000 };
  const expired = await f.saves.open(request()); f.advance(1001);
  assert.equal((await f.saves.complete({ ticket: expired.meta!.webcodexFileSave.ticket, download_url: SOURCE })).status, 'expired');
  const first = await f.saves.open(request(small, { idempotency_key: 'first' }));
  const secondInput = request(small, { path: 'second.png', idempotency_key: 'second' }), second = await f.saves.open(secondInput);
  f.config.binaryInputs.maxSessions = 1;
  assert.equal((await f.saves.status(inputForStatus(secondInput))).status, 'blocked');
  const blocked = await f.saves.complete({ ticket: first.meta!.webcodexFileSave.ticket, download_url: SOURCE });
  assert.equal(blocked.status, 'failed'); assert.equal(blocked.error_code, 'FILE_SAVE_CAPACITY'); assert.equal(downloads, 0);
  assert.equal((await f.saves.complete({ ticket: second.meta!.webcodexFileSave.ticket, download_url: SOURCE })).status, 'saved');
});

test('normalized relative destination paths retain verified receipts', async t => {
  const f = await fixture(t), input = request(small, { path: './原图.png' });
  const opened = await f.saves.open(input);
  const saved = await f.saves.complete({ ticket: opened.meta!.webcodexFileSave.ticket, download_url: SOURCE });
  assert.equal(saved.status, 'saved'); assert.equal(saved.path, '原图.png');
  assert.equal((await f.saves.open(input)).data.status, 'saved');
  const edited = Buffer.from('Edited after the verified save'); await fs.writeFile(path.join(f.root, '原图.png'), edited);
  const current = await f.saves.status(inputForStatus(input));
  assert.equal(current.sha256, hash(small)); assert.equal(current.current_observation?.sha256, hash(edited));
});

test('closing one service clone preserves another clone ticket and active import', async t => {
  let finish!: (bytes: Buffer) => void, begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const f = await fixture(t, async () => { begin(); return new Promise(resolve => { finish = resolve; }); });
  const clone = new FileSaveService(f.ctx, f.files, f.imports, { now: () => 1000000 }); t.after(() => clone.close());
  const opened = await f.saves.open(request()), ticket = opened.meta!.webcodexFileSave.ticket;
  const pending = clone.complete({ ticket, download_url: SOURCE }); await started;
  f.saves.close(); f.saves.close();
  assert.equal((await clone.status(inputForStatus(request()))).status, 'pending');
  finish(small); assert.equal((await pending).status, 'saved');
  assert.equal((await clone.complete({ ticket, download_url: SOURCE })).status, 'saved');
});

test('restart preserves saved and failed import outcomes while old pending tickets cannot resume', async t => {
  let downloads = 0;
  const f = await fixture(t, async () => { downloads++; return small; });
  const good = request(), goodOpened = await f.saves.open(good);
  await f.saves.complete({ ticket: goodOpened.meta!.webcodexFileSave.ticket, download_url: SOURCE });
  const bad = request(small, { path: 'bad.png', content_sha256: hash(Buffer.from('wrong source')), idempotency_key: 'bad' });
  const badOpened = await f.saves.open(bad); await f.saves.complete({ ticket: badOpened.meta!.webcodexFileSave.ticket, download_url: SOURCE });
  const pending = request(small, { path: 'pending.png', idempotency_key: 'pending' }), pendingOpened = await f.saves.open(pending);
  f.saves.close(); f.store.close(); const reopened = f.reopen();
  assert.equal((await reopened.saves.status(inputForStatus(good))).status, 'saved');
  assert.equal((await reopened.saves.open(good)).meta, undefined);
  assert.equal((await reopened.saves.status(inputForStatus(bad))).error_code, 'FILE_IMPORT_ORIGINAL_MISMATCH');
  assert.equal((await reopened.saves.open(bad)).data.status, 'failed');
  assert.equal((await reopened.saves.open(pending)).data.status, 'expired');
  await assert.rejects(reopened.saves.complete({ ticket: pendingOpened.meta!.webcodexFileSave.ticket, download_url: SOURCE }), { code: 'FILE_SAVE_TICKET_NOT_FOUND' });
  assert.equal(downloads, 2);
});

test('a durable uncertain import remains uncertain across host failure reports, repeat opens and restart', async t => {
  let downloads = 0; const f = await fixture(t, async () => { downloads++; return small; });
  t.mock.method(f.files, 'writeBytes', async (...[_input, operation]: Parameters<FileService['writeBytes']>) => { operation?.mutationStarted(); throw new AppError('FILE_WRITE_VERIFICATION_FAILED', 'Synthetic uncertain write.'); });
  const input = request(), opened = await f.saves.open(input), ticket = opened.meta!.webcodexFileSave.ticket;
  assert.equal((await f.saves.complete({ ticket, download_url: SOURCE })).status, 'unknown');
  assert.equal((await f.saves.fail({ ticket, error_code: 'HOST_FILE_RESOLUTION_FAILED' })).status, 'unknown');
  assert.equal((await f.saves.open(input)).data.status, 'unknown');
  f.saves.close(); f.store.close(); const reopened = f.reopen();
  assert.equal((await reopened.saves.status(inputForStatus(input))).status, 'unknown');
  assert.equal((await reopened.saves.open(input)).meta, undefined); assert.equal(downloads, 1);
});

test('retryable downloader failure and denied URL never become automatic component retries', async t => {
  let downloads = 0; const f = await fixture(t, async () => { downloads++; throw new AppError('FILE_IMPORT_TIMEOUT', 'Synthetic timeout.'); });
  const opened = await f.saves.open(request()), ticket = opened.meta!.webcodexFileSave.ticket;
  assert.equal((await f.saves.complete({ ticket, download_url: SOURCE })).status, 'failed');
  assert.equal((await f.saves.complete({ ticket, download_url: SOURCE })).status, 'failed'); assert.equal(downloads, 1);
  const imports = new FileImportService(f.ctx, f.files, downloadChatGptFile), saves = new FileSaveService(f.ctx, f.files, imports);
  t.after(() => saves.close());
  const denied = await saves.open(request(small, { idempotency_key: 'denied-source' }));
  const result = await saves.complete({ ticket: denied.meta!.webcodexFileSave.ticket, download_url: 'sandbox:/mnt/data/private.png' });
  assert.equal(result.status, 'failed'); assert.equal(result.error_code, 'FILE_IMPORT_SOURCE_DENIED');
  assert.equal(JSON.stringify(result).includes('/mnt/data/private.png'), false); assert.deepEqual(await fs.readdir(f.root), []);
});

test('optional import original identity is atomic and binds idempotency without changing legacy calls', async t => {
  const f = await fixture(t);
  const basic = { workspace_id: 'default', path: 'legacy.bin', file: { file_id: FILE_ID, download_url: SOURCE }, expected_sha256: null, idempotency_key: 'legacy' };
  const saved = await f.imports.import(basic); assert.equal(saved.sha256, hash(small));
  for (const invalid of [{ expected_source_sha256: hash(small) }, { expected_source_bytes: small.length },
    { expected_source_sha256: 'wrong', expected_source_bytes: small.length }, { expected_source_sha256: hash(small), expected_source_bytes: -1 },
    { expected_source_sha256: hash(small), expected_source_bytes: 1.5 }, { expected_source_sha256: hash(small), expected_source_bytes: 134217729 }]) {
    await assert.rejects(f.imports.import({ ...basic, ...invalid, idempotency_key: 'invalid-source' }), { code: 'FILE_IMPORT_INVALID_ARGUMENT' });
  }
  await assert.rejects(f.imports.import({ ...basic, expected_source_sha256: hash(small), expected_source_bytes: small.length }), { code: 'IDEMPOTENCY_CONFLICT' });
});
