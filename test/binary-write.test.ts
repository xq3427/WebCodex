import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileService, hash } from '../src/filesystem.js';
import { defaultConfig } from '../src/config.js';
import { WorkspacePaths } from '../src/paths.js';
import { StateStore } from '../src/store.js';
import { fileOperations } from '../src/file-operations.js';
import type { AppConfig } from '../src/types.js';

async function fixture(t: TestContext, limits: Partial<AppConfig['limits']> = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'webcodex-binary-write-'));
  const root = path.join(folder, 'project');
  await fs.mkdir(root);
  const configPath = path.join(folder, 'config.json');
  const config: AppConfig = { ...defaultConfig(root, configPath), configPath };
  Object.assign(config.limits, limits);
  const store = new StateStore(config.stateDir);
  const files = new FileService({ config, paths: new WorkspacePaths(config), store });
  t.after(async () => {
    store.close();
    const real = await fs.realpath(folder);
    assert.equal(path.dirname(real), parent);
    assert.ok(path.basename(real).startsWith('webcodex-binary-write-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  return { root, config, files, store };
}

const request = (bytes: Buffer, idempotency_key = 'save') => ({ workspace_id: 'default', path: '原文件.bin', bytes, expected_sha256: null, idempotency_key });
const arbitraryBytes = () => Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('\r\n原文件\n')]);

test('exact-byte saves preserve binary bytes, return a verified digest, and stat does not decode', async t => {
  const { files, root, config } = await fixture(t);
  const bytes = arbitraryBytes();
  const saved = await files.writeBytes(request(bytes));
  assert.equal(saved.sha256, hash(bytes));
  assert.equal(saved.size_bytes, bytes.length);
  assert.equal(saved.verified, true);
  assert.equal(saved.changed, true);
  assert.deepEqual(await fs.readFile(path.join(root, '原文件.bin')), bytes);
  const history = await files.changesList({ workspace_id: 'default' });
  config.workspaces[0].readOnly = true;
  assert.deepEqual(await files.stat({ workspace_id: 'default', path: '原文件.bin' }), {
    workspace_id: 'default', path: '原文件.bin', kind: 'file', size_bytes: bytes.length, sha256: hash(bytes),
  });
  assert.deepEqual(await files.changesList({ workspace_id: 'default' }), history);
  await assert.rejects(files.read({ workspace_id: 'default', path: '原文件.bin' }), { code: 'UNSUPPORTED_ENCODING' });
});

test('idempotent replay binds exact bytes without serializing the Buffer in its payload', async t => {
  const { files, store, root, config } = await fixture(t);
  const journal = fileOperations({ config, store, paths: new WorkspacePaths(config) });
  const original = journal.run.bind(journal);
  const payloads: unknown[] = [];
  t.mock.method(journal, 'run', (...args: Parameters<typeof journal.run>) => {
    payloads.push(args[0].payload);
    return original(...args);
  });
  const input = request(arbitraryBytes());
  const saved = await files.writeBytes(input);
  assert.deepEqual(await files.writeBytes({ ...input, bytes: Buffer.from(input.bytes) }), saved);
  const payload = payloads[0] as Record<string, unknown>;
  assert.equal(payload.content_sha256, hash(input.bytes));
  assert.equal(payload.size_bytes, input.bytes.length);
  assert.equal(Object.hasOwn(payload, 'bytes'), false);
  assert.ok(JSON.stringify(payload).length < 500);
  const different = Buffer.from(input.bytes);
  different[0] ^= 1;
  await assert.rejects(files.writeBytes({ ...input, bytes: different }), { code: 'IDEMPOTENCY_CONFLICT' });
  await fs.writeFile(path.join(root, input.path), 'external edit');
  assert.deepEqual(await files.writeBytes(input), saved);
  assert.equal(await fs.readFile(path.join(root, input.path), 'utf8'), 'external edit');
  assert.equal((await files.changesList({ workspace_id: 'default' })).changes.length, 1);
});

test('input bytes and destination are captured before asynchronous work', async t => {
  const { files, root } = await fixture(t);
  const input = request(arbitraryBytes());
  const expected = Buffer.from(input.bytes);
  const saving = files.writeBytes(input);
  input.bytes.fill(0);
  input.path = 'changed.bin';
  const saved = await saving;
  assert.equal(saved.path, '原文件.bin');
  assert.equal(saved.sha256, hash(expected));
  assert.deepEqual(await fs.readFile(path.join(root, '原文件.bin')), expected);
  await assert.rejects(fs.stat(path.join(root, 'changed.bin')), { code: 'ENOENT' });
});

test('binary overwrites require the current hash, retain backups, and restore exact bytes', async t => {
  const { files, root } = await fixture(t);
  const before = arbitraryBytes();
  const after = Buffer.from([0, 1, 2, 0xff]);
  const created = await files.writeBytes(request(before));
  await assert.rejects(files.writeBytes(request(after, 'exclusive')), { code: 'VERSION_CONFLICT' });
  await assert.rejects(files.writeBytes({ ...request(after, 'stale'), expected_sha256: 'a'.repeat(64) }), { code: 'VERSION_CONFLICT' });
  const changed = await files.writeBytes({ ...request(after, 'overwrite'), expected_sha256: created.sha256 });
  const preview = await files.changeDiff({ workspace_id: 'default', change_id: changed.change_id! });
  assert.equal(preview.diff_kind, 'binary');
  assert.equal(preview.operation, 'modify');
  assert.equal(preview.current_size_bytes, after.length);
  assert.equal(preview.restore_size_bytes, before.length);
  assert.equal(preview.current_sha256, hash(after));
  assert.equal(preview.restore_sha256, hash(before));
  assert.equal(preview.diff, '');
  const restored = await files.restore({ workspace_id: 'default', change_id: changed.change_id!, expected_sha256: changed.sha256, idempotency_key: 'restore' });
  assert.equal(restored.verified, true);
  assert.equal(restored.size_bytes, before.length);
  assert.deepEqual(await fs.readFile(path.join(root, '原文件.bin')), before);
});

test('undoing binary creation and deletion supports byte previews and exact recreation', async t => {
  const { files, root } = await fixture(t);
  const bytes = arbitraryBytes();
  const created = await files.writeBytes(request(bytes));
  const preview = await files.changeDiff({ workspace_id: 'default', change_id: created.change_id! });
  assert.equal(preview.diff_kind, 'binary');
  assert.equal(preview.operation, 'delete');
  assert.equal(preview.restore_size_bytes, null);
  const deleted = await files.restore({ workspace_id: 'default', change_id: created.change_id!, expected_sha256: created.sha256, idempotency_key: 'delete' });
  assert.equal(deleted.size_bytes, null);
  assert.equal(deleted.verified, true);
  await assert.rejects(fs.stat(path.join(root, '原文件.bin')), { code: 'ENOENT' });
  const recreation = await files.changeDiff({ workspace_id: 'default', change_id: deleted.change_id! });
  assert.equal(recreation.diff_kind, 'binary');
  assert.equal(recreation.operation, 'create');
  assert.equal(recreation.current_size_bytes, null);
  assert.equal(recreation.restore_size_bytes, bytes.length);
  await files.restore({ workspace_id: 'default', change_id: deleted.change_id!, expected_sha256: null, idempotency_key: 'recreate' });
  assert.deepEqual(await fs.readFile(path.join(root, '原文件.bin')), bytes);
});

test('binary limit is independent of text limits and governs stat, backups and restore', async t => {
  const { files, root, config } = await fixture(t, { writeMaxBytes: 32, binaryWriteMaxBytes: 512 });
  const bytes = arbitraryBytes();
  const saved = await files.writeBytes(request(bytes));
  assert.equal((await files.stat({ workspace_id: 'default', path: '原文件.bin' })).size_bytes, bytes.length);
  await assert.rejects(files.write({ workspace_id: 'default', path: 'text.txt', content: 'a'.repeat(33), expected_sha256: null, idempotency_key: 'text' }), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(files.writeBytes({ ...request(Buffer.alloc(513), 'large'), path: 'large.bin' }), { code: 'FILE_TOO_LARGE' });
  await fs.writeFile(path.join(root, 'existing.bin'), Buffer.alloc(513));
  await assert.rejects(files.stat({ workspace_id: 'default', path: 'existing.bin' }), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(files.writeBytes({ ...request(Buffer.from([0]), 'existing'), path: 'existing.bin', expected_sha256: hash(Buffer.alloc(513)) }), { code: 'FILE_TOO_LARGE' });
  const replaced = await files.writeBytes({ ...request(Buffer.from([0]), 'small-replacement'), expected_sha256: saved.sha256 });
  config.limits.binaryWriteMaxBytes = 64;
  await assert.rejects(files.changeDiff({ workspace_id: 'default', change_id: replaced.change_id! }), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(files.restore({ workspace_id: 'default', change_id: replaced.change_id!, expected_sha256: replaced.sha256, idempotency_key: 'limited-restore' }), { code: 'FILE_TOO_LARGE' });
  assert.deepEqual(await fs.readFile(path.join(root, '原文件.bin')), Buffer.from([0]));
  config.limits.binaryWriteMaxBytes = 512;
  await files.restore({ workspace_id: 'default', change_id: replaced.change_id!, expected_sha256: replaced.sha256, idempotency_key: 'restore' });
  assert.deepEqual(await fs.readFile(path.join(root, '原文件.bin')), bytes);
});

test('binary saves and stat enforce workspace policy, relative paths, and link restrictions', async t => {
  const { files, config, root } = await fixture(t);
  const bytes = arbitraryBytes();
  for (const denied of ['../outside.bin', '.env', '.webcodex/secret.bin', path.join(root, 'absolute.bin')]) {
    await assert.rejects(files.writeBytes({ ...request(bytes, denied), path: denied }), { code: 'PATH_DENIED' });
    await assert.rejects(files.stat({ workspace_id: 'default', path: denied }), { code: 'PATH_DENIED' });
  }
  await assert.rejects(files.writeBytes({ ...request(bytes), path: 'missing/child.bin' }), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'linked.bin'), bytes);
  await fs.link(path.join(root, 'linked.bin'), path.join(root, 'alias.bin'));
  await assert.rejects(files.writeBytes({ ...request(bytes), path: 'alias.bin', expected_sha256: hash(bytes) }), { code: 'PATH_DENIED' });
  await assert.rejects(files.stat({ workspace_id: 'default', path: 'alias.bin' }), { code: 'PATH_DENIED' });
  config.workspaces[0].readOnly = true;
  await assert.rejects(files.writeBytes(request(bytes)), { code: 'READ_ONLY' });
  assert.equal((await files.changesList({ workspace_id: 'default' })).changes.length, 0);
});

test('a binary limit below the text limit still limits output, while stat can inspect larger text', async t => {
  const { files, root } = await fixture(t, { writeMaxBytes: 4096, binaryWriteMaxBytes: 1024 });
  await assert.rejects(files.writeBytes(request(Buffer.alloc(1025))), { code: 'FILE_TOO_LARGE' });
  const existing = Buffer.alloc(2048, 65);
  await fs.writeFile(path.join(root, '原文件.bin'), existing);
  assert.equal((await files.stat({ workspace_id: 'default', path: '原文件.bin' })).size_bytes, existing.length);
  const saved = await files.writeBytes({ ...request(Buffer.from([0, 1])), expected_sha256: hash(existing) });
  assert.equal(saved.size_bytes, 2);
  await assert.rejects(files.restore({ workspace_id: 'default', change_id: saved.change_id!, expected_sha256: saved.sha256, idempotency_key: 'oversized-restore' }), { code: 'FILE_TOO_LARGE' });
  assert.deepEqual(await fs.readFile(path.join(root, '原文件.bin')), Buffer.from([0, 1]));
});

test('concurrent binary writes with one original version have exactly one winner', async t => {
  const { files, root } = await fixture(t);
  const before = arbitraryBytes();
  await fs.writeFile(path.join(root, '原文件.bin'), before);
  const attempts = [1, 2, 3].map(value => files.writeBytes({ ...request(Buffer.from([0, value]), `race-${value}`), expected_sha256: hash(before) }));
  const outcomes = await Promise.allSettled(attempts);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  for (const outcome of outcomes) if (outcome.status === 'rejected') assert.equal(outcome.reason.code, 'VERSION_CONFLICT');
  assert.equal((await files.changesList({ workspace_id: 'default' })).changes.length, 1);
});

test('post-write corruption is not reported as a verified save and keeps an unknown change', async t => {
  const { files, root, store } = await fixture(t);
  const before = arbitraryBytes();
  const output = path.join(root, '原文件.bin');
  await fs.writeFile(output, before);
  const originalRename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args);
    if (args[1] === output) await fs.writeFile(output, Buffer.from([0, 99]));
  });
  const input = { ...request(Buffer.from([0, 1]), 'corruption'), expected_sha256: hash(before) };
  await assert.rejects(files.writeBytes(input), { code: 'FILE_WRITE_VERIFICATION_FAILED' });
  const history = (await files.changesList({ workspace_id: 'default' })).changes;
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'unknown');
  assert.deepEqual(Buffer.from(store.db.prepare('SELECT before_blob FROM file_changes WHERE id=?').get(history[0].id)!.before_blob as Uint8Array), before);
  await assert.rejects(files.writeBytes(input), { code: 'EXECUTION_UNKNOWN' });
  assert.deepEqual(await fs.readFile(output), Buffer.from([0, 99]));
});

test('empty byte saves and unchanged replacements are verified without needless changes', async t => {
  const { files } = await fixture(t);
  const saved = await files.writeBytes(request(Buffer.alloc(0)));
  assert.equal(saved.size_bytes, 0);
  assert.equal(saved.sha256, hash(Buffer.alloc(0)));
  assert.equal(saved.verified, true);
  const unchanged = await files.writeBytes({ ...request(Buffer.alloc(0), 'unchanged'), expected_sha256: saved.sha256 });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.change_id, null);
  assert.equal(unchanged.verified, true);
  assert.equal((await files.changesList({ workspace_id: 'default' })).changes.length, 1);
});

test('text-like exact byte saves do not preserve old encoding or normalize newlines', async t => {
  const { files, root } = await fixture(t);
  const before = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('旧文本\r\n', 'utf16le')]);
  await fs.writeFile(path.join(root, '原文件.bin'), before);
  const after = Buffer.from('new\ntext\r\n');
  const saved = await files.writeBytes({ ...request(after), expected_sha256: hash(before) });
  assert.deepEqual(await fs.readFile(path.join(root, '原文件.bin')), after);
  const preview = await files.changeDiff({ workspace_id: 'default', change_id: saved.change_id! });
  assert.equal(preview.diff_kind, 'binary');
  assert.equal(preview.diff, '');
});
