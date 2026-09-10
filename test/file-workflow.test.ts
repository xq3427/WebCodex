import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { applyPatch } from 'diff';
import { FileService } from '../src/filesystem.js';
import { defaultConfig } from '../src/config.js';
import { WorkspacePaths } from '../src/paths.js';
import { StateStore } from '../src/store.js';
import type { AppConfig } from '../src/types.js';

const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const errorCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

async function fixture(t: TestContext, limits: Partial<AppConfig['limits']> = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'webcodex-workflow-test-'));
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
    assert.ok(path.basename(real).startsWith('webcodex-workflow-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  return { root, config, files, store };
}

test('batch reads isolate denied and missing paths without exposing absolute paths', async t => {
  const { files, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'first.txt'), 'first\nsecond\n');
  await fs.writeFile(path.join(root, 'last.txt'), 'last\n');
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE-CONTENT');
  const read = await files.readMany({ workspace_id: 'default', files: [
    { path: 'first.txt', start_line: 2, end_line: 2 },
    { path: '.env' },
    { path: '../outside.txt' },
    { path: path.join(root, 'first.txt') },
    { path: 'missing.txt' },
    { path: 'first.txt', start_line: 3 },
    { path: 'last.txt' },
  ] });
  assert.equal(read.results.length, 7);
  assert.ok(read.results[0].ok);
  assert.equal(read.results[0].data.content, 'second\n');
  assert.equal(read.results[0].data.sha256, sha('first\nsecond\n'));
  assert.equal(read.results[0].data.start_line, 2);
  assert.equal(read.results[0].data.next_start_line, null);
  for (const index of [1, 2, 3, 4, 5]) {
    const result = read.results[index];
    assert.equal(result.index, index);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, index <= 3 ? 'PATH_DENIED' : index === 4 ? 'NOT_FOUND' : 'INVALID_RANGE');
  }
  assert.ok(read.results[6].ok);
  assert.equal(read.results[6].data.content, 'last\n');
  assert.equal(read.content_bytes, 12);
  assert.equal(read.truncated, false);
  assert.ok(!JSON.stringify(read).includes('PRIVATE-CONTENT'));
  assert.ok(!JSON.stringify(read).includes(JSON.stringify(root).slice(1, -1)));
});

test('batch budget preserves UTF-8 boundaries, original hashes, and explicit omitted entries', async t => {
  const { files, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'long.txt'), '甲乙\nnext\n');
  await fs.writeFile(path.join(root, 'other.txt'), '丙');
  await fs.writeFile(path.join(root, 'small.txt'), 'a');
  const read = await files.readMany({ workspace_id: 'default', max_total_bytes: 4, files: [
    { path: 'long.txt' }, { path: 'other.txt' }, { path: 'small.txt' }, { path: 'long.txt', start_line: 2 },
  ] });
  assert.ok(read.results[0].ok);
  assert.equal(read.results[0].data.content, '甲');
  assert.equal(read.results[0].data.sha256, sha('甲乙\nnext\n'));
  assert.equal(read.results[0].data.size_bytes, Buffer.byteLength('甲乙\nnext\n'));
  assert.equal(read.results[0].data.encoding, 'utf8');
  assert.equal(read.results[0].data.truncated, true);
  assert.equal(read.results[0].data.line_cut, true);
  assert.equal(read.results[0].data.next_start_line, 1);
  for (const index of [1, 3]) {
    const result = read.results[index];
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'READ_BUDGET_EXHAUSTED');
      assert.equal(result.omitted, true);
    }
  }
  assert.ok(read.results[2].ok);
  assert.equal(read.results[2].data.content, 'a');
  assert.equal(read.content_bytes, 4);
  assert.equal(read.max_total_bytes, 4);
  assert.equal(read.truncated, true);
  assert.ok(!JSON.stringify(read).includes('\ufffd'));
  const nextLine = await files.readMany({ workspace_id: 'default', files: [{ path: 'long.txt', start_line: 2 }] });
  assert.ok(nextLine.results[0].ok);
  assert.equal(nextLine.results[0].data.content, 'next\n');
});

test('batch read preserves BOM metadata and applies configured total limits', async t => {
  const { files, config, root } = await fixture(t, { readMaxBytes: 256, writeMaxBytes: 1024 });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文\r\nend\r\n', 'utf16le')]);
  await fs.writeFile(path.join(root, 'utf16.txt'), utf16);
  await fs.writeFile(path.join(root, 'long.txt'), 'x'.repeat(300));
  const read = await files.readMany({ workspace_id: 'default', files: [{ path: 'utf16.txt', end_line: 1 }, { path: 'long.txt' }] });
  assert.ok(read.results[0].ok);
  assert.equal(read.results[0].data.content, '中文\r\n');
  assert.equal(read.results[0].data.encoding, 'utf16le');
  assert.equal(read.results[0].data.bom, true);
  assert.equal(read.results[0].data.newline, 'crlf');
  assert.equal(read.results[0].data.sha256, sha(utf16));
  assert.equal(read.results[0].data.next_start_line, 2);
  assert.equal(read.content_bytes, config.limits.readMaxBytes);
  assert.equal(read.truncated, true);
  const request = { workspace_id: 'default', files: [{ path: 'utf16.txt' }] };
  await assert.rejects(files.readMany({ ...request, files: [] }), errorCode('INVALID_ARGUMENT'));
  await assert.rejects(files.readMany({ ...request, files: Array(17).fill({ path: 'utf16.txt' }) }), errorCode('INVALID_ARGUMENT'));
  for (const max_total_bytes of [0, 257, 1.5]) await assert.rejects(files.readMany({ ...request, max_total_bytes }), errorCode('INVALID_ARGUMENT'));
});

test('restoration preview shows modification direction without changing files or history', async t => {
  const { files, root, config } = await fixture(t);
  const before = 'first\n原来\nlast\n';
  const after = 'first\n现在\nlast\n';
  await fs.writeFile(path.join(root, 'edit.txt'), before);
  const change = await files.write({ workspace_id: 'default', path: 'edit.txt', content: after, expected_sha256: sha(before), idempotency_key: 'modify' });
  const historyBefore = await files.changesList({ workspace_id: 'default' });
  config.workspaces[0].readOnly = true;
  const preview = await files.changeDiff({ workspace_id: 'default', change_id: change.change_id! });
  assert.equal(preview.direction, 'restore');
  assert.equal(preview.operation, 'modify');
  assert.equal(preview.current_sha256, sha(after));
  assert.equal(preview.restore_sha256, sha(before));
  assert.equal(preview.current_format?.encoding, 'utf8');
  assert.equal(preview.restore_format?.encoding, 'utf8');
  assert.equal(preview.truncated, false);
  assert.equal(preview.returned_bytes, Buffer.byteLength(preview.diff));
  assert.equal(preview.diff_bytes, preview.returned_bytes);
  assert.ok(preview.diff.includes('-现在\n+原来\n'));
  assert.equal(applyPatch(after, preview.diff), before);
  assert.equal(await fs.readFile(path.join(root, 'edit.txt'), 'utf8'), after);
  assert.deepEqual(await files.changesList({ workspace_id: 'default' }), historyBefore);
  assert.ok(!preview.diff.includes(root));
});

test('restoration previews cover deleting a creation and recreating a recorded deletion', async t => {
  const { files, root } = await fixture(t);
  const change = await files.write({ workspace_id: 'default', path: 'new.txt', content: 'hello\n', expected_sha256: null, idempotency_key: 'create' });
  const removal = await files.changeDiff({ workspace_id: 'default', change_id: change.change_id! });
  assert.equal(removal.operation, 'delete');
  assert.equal(removal.current_sha256, sha('hello\n'));
  assert.equal(removal.restore_sha256, null);
  assert.equal(removal.restore_format, null);
  assert.ok(removal.diff.includes('+++ /dev/null\n'));
  assert.ok(removal.diff.includes('-hello\n'));
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'hello\n');
  const deleted = await files.restore({ workspace_id: 'default', change_id: change.change_id!, expected_sha256: change.sha256, idempotency_key: 'delete' });
  const recreation = await files.changeDiff({ workspace_id: 'default', change_id: deleted.change_id! });
  assert.equal(recreation.operation, 'create');
  assert.equal(recreation.current_sha256, null);
  assert.equal(recreation.current_format, null);
  assert.equal(recreation.restore_sha256, sha('hello\n'));
  assert.ok(recreation.diff.includes('--- /dev/null\n'));
  assert.ok(recreation.diff.includes('+hello\n'));
  await assert.rejects(fs.stat(path.join(root, 'new.txt')), errorCode('ENOENT'));
  await assert.rejects(files.changeDiff({ workspace_id: 'default', change_id: change.change_id! }), errorCode('CHANGE_NOT_RESTORABLE'));
  await fs.writeFile(path.join(root, 'new.txt'), 'external');
  await assert.rejects(files.changeDiff({ workspace_id: 'default', change_id: deleted.change_id! }), errorCode('VERSION_CONFLICT'));
});

test('restoration preview rejects edited files, missing changes, unconfirmed records, and corrupt backups', async t => {
  const { files, root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'edit.txt'), 'before');
  const changed = await files.write({ workspace_id: 'default', path: 'edit.txt', content: 'after', expected_sha256: sha('before'), idempotency_key: 'edit' });
  const request = { workspace_id: 'default', change_id: changed.change_id! };
  await fs.writeFile(path.join(root, 'edit.txt'), 'external');
  await assert.rejects(files.changeDiff(request), errorCode('VERSION_CONFLICT'));
  assert.equal(await fs.readFile(path.join(root, 'edit.txt'), 'utf8'), 'external');
  await fs.writeFile(path.join(root, 'edit.txt'), 'after');
  store.db.prepare('UPDATE file_changes SET status=? WHERE id=?').run('unknown', changed.change_id!);
  await assert.rejects(files.changeDiff(request), errorCode('CHANGE_NOT_RESTORABLE'));
  store.db.prepare('UPDATE file_changes SET status=?,before_blob=? WHERE id=?').run('applied', Buffer.from('tampered'), changed.change_id!);
  await assert.rejects(files.changeDiff(request), errorCode('CHANGE_CORRUPT'));
  await assert.rejects(files.changeDiff({ ...request, change_id: 'missing' }), errorCode('CHANGE_NOT_FOUND'));
});

test('restoration preview obeys updated control-path policy and UTF-8 output budgets', async t => {
  const { files, root, config } = await fixture(t, { readMaxBytes: 256, writeMaxBytes: 1024 });
  const created = await files.write({ workspace_id: 'default', path: 'control.json', content: '秘密'.repeat(80), expected_sha256: null, idempotency_key: 'create' });
  const request = { workspace_id: 'default', change_id: created.change_id! };
  const preview = await files.changeDiff({ ...request, max_bytes: 121, context_lines: 0 });
  assert.equal(preview.truncated, true);
  assert.ok(preview.returned_bytes <= 121);
  assert.equal(preview.returned_bytes, Buffer.byteLength(preview.diff));
  assert.ok(preview.diff_bytes > preview.returned_bytes);
  assert.ok(!preview.diff.includes('\ufffd'));
  assert.equal(preview.current_sha256, created.sha256);
  config.configPath = path.join(root, 'control.json');
  await assert.rejects(files.changeDiff(request), errorCode('PATH_DENIED'));
  for (const max_bytes of [0, 257, 1.5]) await assert.rejects(files.changeDiff({ ...request, max_bytes }), errorCode('INVALID_ARGUMENT'));
  for (const context_lines of [-1, 21, 1.5]) await assert.rejects(files.changeDiff({ ...request, context_lines }), errorCode('INVALID_ARGUMENT'));
});

test('restore rejects corrupt backups before changing the file or recording a restoration', async t => {
  const { files, root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'edit.txt'), 'before');
  const changed = await files.write({ workspace_id: 'default', path: 'edit.txt', content: 'after', expected_sha256: sha('before'), idempotency_key: 'edit' });
  const request = { workspace_id: 'default', change_id: changed.change_id!, expected_sha256: changed.sha256, idempotency_key: 'restore-corrupt' };
  store.db.prepare('UPDATE file_changes SET before_blob=? WHERE id=?').run(Buffer.from('tampered'), changed.change_id!);
  const history = await files.changesList({ workspace_id: 'default' });
  await assert.rejects(files.restore(request), errorCode('CHANGE_CORRUPT'));
  assert.equal(await fs.readFile(path.join(root, 'edit.txt'), 'utf8'), 'after');
  assert.deepEqual(await files.changesList({ workspace_id: 'default' }), history);
  assert.deepEqual(await fs.readdir(root), ['edit.txt']);
});

test('restore and preview reject backups over a reduced write limit without adding failed changes', async t => {
  const { files, root, config } = await fixture(t, { readMaxBytes: 256, writeMaxBytes: 2048 });
  const original = 'a'.repeat(1500);
  await fs.writeFile(path.join(root, 'edit.txt'), original);
  const changed = await files.write({ workspace_id: 'default', path: 'edit.txt', content: 'after', expected_sha256: sha(original), idempotency_key: 'edit' });
  config.limits.writeMaxBytes = 1024;
  const history = await files.changesList({ workspace_id: 'default' });
  const request = { workspace_id: 'default', change_id: changed.change_id! };
  await assert.rejects(files.changeDiff(request), errorCode('FILE_TOO_LARGE'));
  await assert.rejects(files.restore({ ...request, expected_sha256: changed.sha256, idempotency_key: 'restore-large' }), errorCode('FILE_TOO_LARGE'));
  assert.equal(await fs.readFile(path.join(root, 'edit.txt'), 'utf8'), 'after');
  assert.deepEqual(await files.changesList({ workspace_id: 'default' }), history);
  assert.deepEqual(await fs.readdir(root), ['edit.txt']);
});
