import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createPatch } from 'diff';
import { FileService } from '../src/filesystem.js';
import { defaultConfig } from '../src/config.js';
import { WorkspacePaths } from '../src/paths.js';
import { StateStore } from '../src/store.js';
import type { AppConfig } from '../src/types.js';

const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const errorCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
async function fixture(t: TestContext, limits: Partial<AppConfig['limits']> = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'webcodex-file-test-'));
  const root = path.join(folder, 'project');
  await fs.mkdir(root);
  const configPath = path.join(folder, 'config.json');
  const config: AppConfig = { ...defaultConfig(root, configPath), configPath };
  Object.assign(config.limits, limits);
  const store = new StateStore(config.stateDir);
  const ctx = { config, paths: new WorkspacePaths(config), store };
  const files = new FileService(ctx);
  t.after(async () => {
    store.close();
    const real = await fs.realpath(folder);
    assert.equal(path.dirname(real), parent);
    assert.ok(path.basename(real).startsWith('webcodex-file-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  return { root, config, files, store, ctx };
}

test('create is exclusive, version checks prevent overwrites, and operation IDs replay exactly', async t => {
  const { files, root } = await fixture(t);
  const request = { workspace_id: 'default', path: 'hello.txt', content: '你好\n', expected_sha256: null, idempotency_key: 'create' };
  const created = await files.write(request);
  assert.equal(created.sha256, sha('你好\n'));
  assert.deepEqual(await files.write(request), created);
  await assert.rejects(files.write({ ...request, content: 'other' }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(files.write({ ...request, idempotency_key: 'create-again' }), errorCode('VERSION_CONFLICT'));
  await fs.writeFile(path.join(root, 'hello.txt'), 'external\n');
  await assert.rejects(files.write({ ...request, content: 'overwritten', expected_sha256: created.sha256, idempotency_key: 'stale' }), errorCode('VERSION_CONFLICT'));
  assert.equal(await fs.readFile(path.join(root, 'hello.txt'), 'utf8'), 'external\n');
  const history = await files.changesList({ workspace_id: 'default' });
  assert.equal(history.changes.length, 1);
});

test('concurrent mutations with the same original version have exactly one winner', async t => {
  const { files, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'race.txt'), 'start');
  const requests = ['first', 'second', 'third'].map(content => files.write({ workspace_id: 'default', path: 'race.txt', content, expected_sha256: sha('start'), idempotency_key: content }));
  const results = await Promise.allSettled(requests);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'VERSION_CONFLICT');
  assert.equal((await files.changesList({ workspace_id: 'default' })).changes.length, 1);
});

test('UTF-8 BOM and UTF-16 LE/BE files retain their encoding, BOM, and CRLF', async t => {
  const { files, root } = await fixture(t);
  for (const kind of ['utf8', 'utf16le', 'utf16be'] as const) {
    const body = kind === 'utf8' ? Buffer.from('中文\r\nsecond\r\n') : Buffer.from('中文\r\nsecond\r\n', 'utf16le');
    if (kind === 'utf16be') body.swap16();
    const bom = Buffer.from(kind === 'utf8' ? [0xef, 0xbb, 0xbf] : kind === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]);
    const name = `${kind}.txt`;
    await fs.writeFile(path.join(root, name), Buffer.concat([bom, body]));
    const read = await files.read({ workspace_id: 'default', path: name, start_line: 1, end_line: 1 });
    assert.equal(read.content, '中文\r\n');
    assert.equal(read.encoding, kind);
    assert.equal(read.bom, true);
    await files.write({ workspace_id: 'default', path: name, content: '改好\nsecond\n', expected_sha256: read.sha256, idempotency_key: kind });
    const updated = await files.read({ workspace_id: 'default', path: name });
    assert.equal(updated.content, '改好\r\nsecond\r\n');
    assert.equal(updated.encoding, kind);
    assert.equal(updated.newline, 'crlf');
    assert.ok((await fs.readFile(path.join(root, name))).subarray(0, bom.length).equals(bom));
  }
});

test('patch dry-run, exact line context, path checks, and restore preserve later edits', async t => {
  const { files, root } = await fixture(t);
  const original = 'alpha\r\n中文\r\nomega\r\n';
  const name = 'patch.txt';
  await fs.writeFile(path.join(root, name), original);
  const patch = createPatch(name, original.replace(/\r\n/g, '\n'), 'alpha\n改好\nomega\n');
  const request = { workspace_id: 'default', path: name, patch, expected_sha256: sha(original), idempotency_key: 'preview' };
  const preview = await files.applyPatch({ ...request, dry_run: true });
  assert.equal(preview.changed, true);
  assert.equal(await fs.readFile(path.join(root, name), 'utf8'), original);
  assert.equal((await files.changesList({ workspace_id: 'default' })).changes.length, 0);
  await assert.rejects(files.applyPatch({ ...request, patch: patch.replaceAll(name, 'elsewhere.txt'), idempotency_key: 'wrong-path' }), errorCode('PATCH_PATH_MISMATCH'));
  await assert.rejects(files.applyPatch({ ...request, patch: patch + createPatch('other.txt', 'a', 'b'), idempotency_key: 'multiple' }), errorCode('INVALID_PATCH'));
  await assert.rejects(files.applyPatch({ ...request, patch: patch.replace('alpha', 'missing'), idempotency_key: 'bad-context' }), errorCode('PATCH_CONFLICT'));
  const applied = await files.applyPatch({ ...request, idempotency_key: 'apply' });
  assert.equal(await fs.readFile(path.join(root, name), 'utf8'), 'alpha\r\n改好\r\nomega\r\n');
  await fs.writeFile(path.join(root, name), 'external');
  await assert.rejects(files.restore({ workspace_id: 'default', change_id: applied.change_id!, expected_sha256: applied.sha256, idempotency_key: 'restore-conflict' }), errorCode('VERSION_CONFLICT'));
  await fs.writeFile(path.join(root, name), 'alpha\r\n改好\r\nomega\r\n');
  const restored = await files.restore({ workspace_id: 'default', change_id: applied.change_id!, expected_sha256: applied.sha256, idempotency_key: 'restore' });
  assert.equal(restored.sha256, sha(original));
  assert.equal(await fs.readFile(path.join(root, name), 'utf8'), original);
  const rows = (await files.changesList({ workspace_id: 'default' })).changes;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].restores_id, applied.change_id);
  assert.equal(rows[1].status, 'restored');
});

test('patches do not relocate repeated context or accept invalid hunk ranges', async t => {
  const { files, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'repeat.txt'), 'first\nsecond\n');
  await assert.rejects(files.applyPatch({ workspace_id: 'default', path: 'repeat.txt', expected_sha256: sha('first\nsecond\n'), patch: '--- a/repeat.txt\n+++ b/repeat.txt\n@@ -1 +1 @@\n-second\n+changed\n', idempotency_key: 'offset' }), errorCode('PATCH_CONFLICT'));
  const patch = createPatch('repeat.txt', 'first\nsecond\n', 'first\ninsert\nsecond\n');
  await files.applyPatch({ workspace_id: 'default', path: 'repeat.txt', expected_sha256: sha('first\nsecond\n'), patch, idempotency_key: 'insert' });
  assert.equal(await fs.readFile(path.join(root, 'repeat.txt'), 'utf8'), 'first\ninsert\nsecond\n');
});

test('restoring creation deletes only its version and restoring that deletion recreates original bytes', async t => {
  const { files, root } = await fixture(t);
  const created = await files.write({ workspace_id: 'default', path: 'new.txt', content: 'text', expected_sha256: null, idempotency_key: 'create' });
  const removed = await files.restore({ workspace_id: 'default', change_id: created.change_id!, expected_sha256: created.sha256, idempotency_key: 'undo-create' });
  assert.equal(removed.sha256, null);
  await assert.rejects(fs.stat(path.join(root, 'new.txt')), errorCode('ENOENT'));
  const recreated = await files.restore({ workspace_id: 'default', change_id: removed.change_id!, expected_sha256: null, idempotency_key: 'undo-delete' });
  assert.equal(recreated.sha256, created.sha256);
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'text');
});

test('binary and invalid encoding are rejected; ranges and truncation remain bounded', async t => {
  const { files, root } = await fixture(t, { readMaxBytes: 256, writeMaxBytes: 1024 });
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([1, 0, 3, 4]));
  await assert.rejects(files.read({ workspace_id: 'default', path: 'binary.bin' }), errorCode('BINARY_FILE'));
  await assert.rejects(files.write({ workspace_id: 'default', path: 'binary.bin', content: 'replace', expected_sha256: sha(Buffer.from([1, 0, 3, 4])), idempotency_key: 'binary' }), errorCode('BINARY_FILE'));
  await fs.writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xff, 0x81, 0xc0]));
  await assert.rejects(files.read({ workspace_id: 'default', path: 'invalid.txt' }), errorCode('UNSUPPORTED_ENCODING'));
  const long = '中文'.repeat(80) + '\nnext\n';
  await fs.writeFile(path.join(root, 'long.txt'), long);
  const read = await files.read({ workspace_id: 'default', path: 'long.txt' });
  assert.ok(Buffer.byteLength(read.content) <= 256);
  assert.ok(!read.content.includes('\ufffd'));
  assert.equal(read.sha256, sha(long));
  assert.equal(read.truncated, true);
  assert.equal(read.line_cut, true);
  assert.equal(read.next_start_line, 1);
  assert.equal((await files.read({ workspace_id: 'default', path: 'long.txt', start_line: 2 })).content, 'next\n');
  await assert.rejects(files.read({ workspace_id: 'default', path: 'long.txt', start_line: 3 }), errorCode('INVALID_RANGE'));
  await assert.rejects(files.read({ workspace_id: 'default', path: 'long.txt', start_line: 2, end_line: 1 }), errorCode('INVALID_ARGUMENT'));
  await fs.writeFile(path.join(root, 'oversized.txt'), 'x'.repeat(1025));
  await assert.rejects(files.read({ workspace_id: 'default', path: 'oversized.txt' }), errorCode('FILE_TOO_LARGE'));
});

test('lists and searches exclude control paths; search caps matches and diagnoses missing rg', async t => {
  const { files, root, config } = await fixture(t);
  await fs.mkdir(path.join(root, '.webcodex'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, '.webcodex', 'secret.txt'), 'needle secret');
  await fs.writeFile(path.join(root, '.env'), 'needle secret');
  await fs.writeFile(path.join(root, 'node_modules', 'generated.txt'), 'needle generated');
  await fs.writeFile(path.join(root, 'a.txt'), 'needle first\nneedle second\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'needle third\n');
  const listing = await files.list({ workspace_id: 'default', limit: 1 });
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.next_cursor, 1);
  const full = await files.list({ workspace_id: 'default' });
  assert.ok(!full.entries.some(entry => entry.name === '.env' || entry.name === '.webcodex'));
  const search = await files.search({ workspace_id: 'default', query: 'needle', max_results: 1 });
  assert.equal(search.matches.length, 1);
  assert.equal(search.truncated, true);
  const all = await files.search({ workspace_id: 'default', query: 'needle', max_results: 20 });
  assert.equal(all.matches.length, 3);
  assert.ok(all.matches.every(match => match.path === 'a.txt' || match.path === 'b.txt'));
  await assert.rejects(files.search({ workspace_id: 'default', query: '[', regex: true }), errorCode('SEARCH_FAILED'));
  config.rgPath = path.join(root, 'nonexistent-rg.exe');
  await assert.rejects(files.search({ workspace_id: 'default', query: 'needle' }), errorCode('RIPGREP_NOT_FOUND'));
});

test('mkdir is idempotent, requires an existing parent, and obeys read-only policy', async t => {
  const { files, config, root } = await fixture(t);
  const request = { workspace_id: 'default', path: 'sub', idempotency_key: 'mkdir' };
  const created = await files.mkdir(request);
  assert.deepEqual(await files.mkdir(request), created);
  await files.write({ workspace_id: 'default', path: 'sub/new.txt', content: 'hello', expected_sha256: null, idempotency_key: 'nested' });
  assert.equal(await fs.readFile(path.join(root, 'sub', 'new.txt'), 'utf8'), 'hello');
  await assert.rejects(files.mkdir({ ...request, path: 'missing/child', idempotency_key: 'parent' }), errorCode('ENOENT'));
  config.workspaces[0].readOnly = true;
  await assert.rejects(files.mkdir({ ...request, path: 'denied', idempotency_key: 'readonly' }), errorCode('READ_ONLY'));
});
