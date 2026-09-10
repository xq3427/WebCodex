import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CodexHistory, normalizeCodexCwd, type CodexHistoryPosition } from '../src/codex-history.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SUFFIX = '33333333-3333-4333-8333-333333333333';
const record = (ordinal: number, type: string, payload: unknown) => ({ ordinal, timestamp: '2026-09-08T00:00:00Z', type, payload });
const meta = (id = ID, ordinal = 0, extra: Record<string, unknown> = {}) => record(ordinal, 'session_meta', { id, cwd: 'C:\\example\\project', timestamp: '2026-09-08T00:00:00Z', history_mode: 'paginated', ...extra });
const message = (ordinal: number, text: string) => record(ordinal, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const encode = (...rows: unknown[]) => Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));

test('configured record limit omits oversized records and reports the omission', async t => {
  const f=await fixture(t);await fs.writeFile(f.filename(),encode(meta(),message(1,'x'.repeat(70000)),message(2,'small')));f.index([{file:f.filename()}]);
  const limited=await new CodexHistory(f.home,{maxRecordBytes:65536}).readWindow({sessionId:ID});
  const normal=await f.history.readWindow({sessionId:ID});
  assert.equal(limited.stats.skippedOversizedLines,1);assert.equal(normal.stats.skippedOversizedLines,0);
  assert.equal(limited.records.some(row=>row.record.ordinal===1),false);assert.equal(limited.records.some(row=>row.record.ordinal===2),true);
});

async function fixture(t: TestContext) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'webcodex-history-test-'));
  const home = path.join(folder, 'codex-home');
  const sessions = path.join(home, 'sessions', '2026', '09', '08');
  const archived = path.join(home, 'archived_sessions');
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(archived);
  const filename = (id = ID, suffix = '') => path.join(sessions, `rollout-2026-09-08T00-00-00-${id}${suffix}.jsonl`);
  t.after(async () => {
    const real = await fs.realpath(folder);
    assert.equal(path.dirname(real), parent);
    assert.ok(path.basename(real).startsWith('webcodex-history-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  const index = (rows: { id?: string; file: string; archived?: number; title?: string }[]) => {
    const database = path.join(home, 'state_5.sqlite');
    const db = new DatabaseSync(database);
    try {
      db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER);');
      for (const row of rows) db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(row.id ?? ID, row.file, 'C:\\example\\project', row.title ?? 'Synthetic test', 1_700_000_000, 1_700_000_100, row.archived ?? 0);
    } finally { db.close(); }
    return database;
  };
  return { folder, home, sessions, archived, filename, index, history: new CodexHistory(home) };
}

test('SQLite selects the current rollout and a verified history base preserves only its referenced prefix', async t => {
  const f = await fixture(t);
  const older = f.filename();
  const current = f.filename(ID, '_' + SUFFIX);
  const prefix = encode(meta(), message(1, 'older-one'), message(2, 'older-two'));
  await fs.writeFile(older, Buffer.concat([prefix, encode(message(3, 'stale-unreferenced-tail'))]));
  const history_base = { thread_id: ID, end_ordinal_exclusive: 3, end_byte_offset: prefix.length };
  await fs.writeFile(current, encode(meta(ID, 3, { history_base }), message(4, 'newest')));
  const database = f.index([{ file: current }]);
  const databaseBefore = await fs.readFile(database);
  const listed = await f.history.list();
  assert.equal(listed.source, 'sqlite');
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].title, 'Synthetic test');
  const newest = await f.history.readWindow({ sessionId: ID });
  assert.deepEqual(newest.records.map(item => item.record.ordinal), [3, 4]);
  assert.equal(newest.unreadOlderHistory, false);
  assert.equal(newest.session.historyBase?.endByteOffset, prefix.length);
  assert.ok(newest.nextBefore);
  const old = await f.history.readWindow({ sessionId: ID, before: newest.nextBefore });
  assert.deepEqual(old.records.map(item => item.record.ordinal), [0, 1, 2]);
  assert.equal(old.windowEnd, prefix.length);
  assert.equal(old.nextBefore, null);
  assert.notEqual(old.fileKey, newest.fileKey);
  assert.ok(old.stats.scannedBytes <= 8 * 1024 * 1024);
  assert.deepEqual(await fs.readFile(database), databaseBefore);
});

test('rollout and database path restrictions reject sensitive paths, links, hard links, and mismatched IDs', async t => {
  const f = await fixture(t);
  const file = f.filename();
  await fs.writeFile(file, encode(meta(OTHER)));
  const database = f.index([{ file }]);
  await assert.rejects(f.history.get(ID), { code: 'HISTORY_SESSION_MISMATCH' });
  const db = new DatabaseSync(database);
  try { db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(path.join(f.home, 'auth.json'), ID); }
  finally { db.close(); }
  await fs.writeFile(path.join(f.home, 'auth.json'), 'must-never-be-opened');
  await assert.rejects(f.history.get(ID), { code: 'HISTORY_PATH_DENIED' });
  const db2 = new DatabaseSync(database);
  try { db2.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(file, ID); }
  finally { db2.close(); }
  await fs.writeFile(file, encode(meta()));
  const hard = path.join(f.folder, 'hard.jsonl');
  await fs.link(file, hard);
  await assert.rejects(f.history.get(ID), { code: 'HISTORY_PATH_DENIED' });
  await fs.unlink(hard);
  const dbHard = path.join(f.folder, 'hard.sqlite');
  await fs.link(database, dbHard);
  await assert.rejects(f.history.list(), { code: 'HISTORY_PATH_DENIED' });
  await fs.unlink(dbHard);
  const outside = path.join(f.folder, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, path.basename(file)), encode(meta()));
  const junction = path.join(f.sessions, 'jump');
  await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const db3 = new DatabaseSync(database);
  try { db3.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(path.join(junction, path.basename(file)), ID); }
  finally { db3.close(); }
  await assert.rejects(f.history.get(ID), { code: 'HISTORY_PATH_DENIED' });
});

test('JSONL fallback groups exact thread metadata and separates archived sessions', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.filename(), encode(meta(), message(1, 'old')));
  await fs.writeFile(f.filename(ID, '_' + SUFFIX), encode(meta(ID, 2), message(3, 'current')));
  await fs.writeFile(path.join(f.archived, path.basename(f.filename(OTHER))), encode(meta(OTHER)));
  const normal = await f.history.list();
  assert.equal(normal.source, 'jsonl');
  assert.equal(normal.sessions.length, 1);
  assert.equal(normal.sessions[0].id, ID);
  assert.equal(normal.sessions[0].archived, false);
  assert.ok(normal.warnings.includes('sqlite_index_unavailable'));
  if (process.platform === 'win32') assert.equal((await new CodexHistory(f.home.toUpperCase()).list()).sessions.length, 1);
  const all = await f.history.list({ includeArchived: true, limit: 1 });
  assert.equal(all.sessions.length, 1);
  assert.notEqual(all.nextOffset, null);
  const next = await f.history.list({ includeArchived: true, offset: all.nextOffset!, limit: 1 });
  assert.equal(next.sessions.length, 1);
  assert.notEqual(next.sessions[0].id, all.sessions[0].id);
  const newest = await f.history.readWindow({ sessionId: ID });
  assert.deepEqual(newest.records.map(row => row.record.ordinal), [2, 3]);
});

test('byte cursors paginate complete Unicode records without duplicates or skipped ordinary lines', async t => {
  const f = await fixture(t);
  const source = encode(meta(), ...Array.from({ length: 30 }, (_, i) => message(i + 1, '中文'.repeat(10) + i)));
  await fs.writeFile(f.filename(), source);
  let before: CodexHistoryPosition | undefined;
  const found: number[] = [];
  let turns = 0;
  do {
    const window = await f.history.readWindow({ sessionId: ID, before, maxBytes: 1024 });
    for (const row of window.records) {
      assert.deepEqual(JSON.parse(source.subarray(row.startByte, row.endByte).toString('utf8')), row.record);
      found.push(row.record.ordinal as number);
    }
    if (before && window.nextBefore?.fileKey === before.fileKey) assert.ok(window.nextBefore.byteOffset < before.byteOffset);
    before = window.nextBefore ?? undefined;
    assert.ok(++turns < 50);
  } while (before);
  assert.deepEqual([...found].sort((a, b) => a - b), Array.from({ length: 31 }, (_, i) => i));
});

test('large lines and incomplete active tails stay bounded and older cursors always progress', async t => {
  const f = await fixture(t);
  const file = f.filename();
  const unfinished = '{"type":"response_item","payload":';
  await fs.writeFile(file, Buffer.concat([encode(meta(), message(1, 'before'), message(2, 'x'.repeat(3 * 1024 * 1024)), message(3, 'after')), Buffer.from(unfinished)]));
  let before: CodexHistoryPosition | undefined;
  const found: number[] = [];
  let skipped = 0, calls = 0;
  do {
    const window = await f.history.readWindow({ sessionId: ID, before, maxBytes: 128 * 1024 });
    assert.ok(window.stats.scannedBytes < 200 * 1024);
    assert.ok(window.windowEnd - window.windowStart <= 128 * 1024);
    found.push(...window.records.map(row => row.record.ordinal as number));
    if (!before) assert.equal(window.stats.skippedIncompleteTail, Buffer.byteLength(unfinished));
    if (before && window.nextBefore) assert.ok(window.nextBefore.byteOffset < before.byteOffset);
    skipped += window.stats.skippedOversizedLines;
    before = window.nextBefore ?? undefined;
    assert.ok(++calls < 40);
  } while (before);
  assert.deepEqual(found.sort((a, b) => a - b), [0, 1, 3]);
  assert.ok(skipped > 0);
});

test('corrupt complete JSONL records are reported and invalid UTF-8 is not repaired into content', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.filename(), Buffer.concat([encode(meta(), message(1, 'valid')), Buffer.from('not json\n'), Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}\npartial')]));
  const result = await f.history.readWindow({ sessionId: ID });
  assert.equal(result.stats.invalidRecords, 2);
  assert.equal(result.stats.skippedIncompleteTail, 7);
  assert.deepEqual(result.records.map(row => row.record.ordinal), [0, 1]);
});

test('ambiguous or missing history bases are reported without guessing an older source', async t => {
  const f = await fixture(t);
  const prefix = encode(meta(), message(1, 'older'));
  await fs.writeFile(f.filename(), prefix);
  await fs.writeFile(f.filename(ID, '_duplicate'), prefix);
  const current = f.filename(ID, '_' + SUFFIX);
  await fs.writeFile(current, encode(meta(ID, 2, { history_base: { thread_id: ID, end_ordinal_exclusive: 2, end_byte_offset: prefix.length } }), message(3, 'current')));
  f.index([{ file: current }]);
  const ambiguous = await f.history.readWindow({ sessionId: ID });
  assert.equal(ambiguous.unreadOlderHistory, true);
  assert.ok(ambiguous.warnings.includes('history_base_ambiguous'));
  assert.equal(ambiguous.nextBefore, null);
  await fs.unlink(f.filename());
  await fs.unlink(f.filename(ID, '_duplicate'));
  const missing = await f.history.readWindow({ sessionId: ID });
  assert.equal(missing.unreadOlderHistory, true);
  assert.ok(missing.warnings.includes('history_base_missing'));
});

test('cursors survive append but reject a replaced file, a foreign key, and invalid inputs', async t => {
  const f = await fixture(t);
  const file = f.filename();
  await fs.writeFile(file, encode(meta(), ...Array.from({ length: 20 }, (_, i) => message(i + 1, 'text' + i))));
  const first = await f.history.readWindow({ sessionId: ID, maxBytes: 1024 });
  assert.ok(first.nextBefore);
  await fs.appendFile(file, encode(message(21, 'appended')));
  const older = await f.history.readWindow({ sessionId: ID, before: first.nextBefore, maxBytes: 1024 });
  assert.equal(older.fileKey, first.fileKey);
  const replacement = file + '.replacement';
  await fs.writeFile(replacement, encode(meta(), message(1, 'replacement')));
  await fs.rename(replacement, file);
  await assert.rejects(f.history.readWindow({ sessionId: ID, before: first.nextBefore }), { code: 'HISTORY_CURSOR_STALE' });
  await assert.rejects(f.history.readWindow({ sessionId: ID, before: { fileKey: '0'.repeat(64), byteOffset: 0 } }), { code: 'HISTORY_CURSOR_STALE' });
  await assert.rejects(f.history.get('../auth.json'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.history.readWindow({ sessionId: ID, maxBytes: 1024 * 1024 + 1 }), { code: 'INVALID_ARGUMENT' });
});

test('unavailable SQLite schemas and missing WAL shared-memory files fall back without creating sidecars', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.filename(), encode(meta(), message(1, 'fallback')));
  const database = f.index([{ file: f.filename() }]);
  const before = await fs.readFile(database);
  await fs.writeFile(database + '-wal', Buffer.alloc(0));
  const fallback = await f.history.list();
  assert.equal(fallback.source, 'jsonl');
  assert.deepEqual(await fs.readFile(database), before);
  await assert.rejects(fs.stat(database + '-shm'), { code: 'ENOENT' });
  await fs.unlink(database + '-wal');
  const db = new DatabaseSync(database);
  try { db.exec('DROP TABLE threads;'); }
  finally { db.close(); }
  assert.equal((await f.history.list()).source, 'jsonl');
  assert.equal(normalizeCodexCwd('\\\\?\\C:\\example\\project'), path.normalize('C:\\example\\project'));
});

test('metadata retains complete bounded titles for redaction and omits oversized values instead of cutting credentials', async t => {
  const f = await fixture(t);
  const title = 'x'.repeat(286) + ' sk-proj-' + 'A'.repeat(32);
  const tooLarge = 'x'.repeat(16_380) + ' sk-proj-' + 'B'.repeat(32);
  await fs.writeFile(f.filename(), encode(meta()));
  await fs.writeFile(f.filename(OTHER), encode(meta(OTHER)));
  f.index([{ file: f.filename(), title }, { id: OTHER, file: f.filename(OTHER), title: tooLarge }]);
  assert.equal((await f.history.get(ID)).title, title);
  assert.equal((await f.history.get(OTHER)).title, '[Oversized title omitted]');
  await fs.writeFile(f.filename(), encode(meta(ID, 0, { cwd: 'x'.repeat(4090) + ' sk-proj-' + 'C'.repeat(32) })));
  await assert.rejects(f.history.get(ID), { code: 'HISTORY_SESSION_MISMATCH' });
});

test('list revisions detect reordered SQLite indexes before callers accept another offset page', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.filename(), encode(meta()));
  await fs.writeFile(f.filename(OTHER), encode(meta(OTHER)));
  const database = f.index([{ file: f.filename() }, { id: OTHER, file: f.filename(OTHER) }]);
  const first = await f.history.list({ limit: 1 });
  const stable = await f.history.list({ offset: first.nextOffset!, limit: 1 });
  assert.equal(first.sessions[0].id, ID);
  assert.equal(stable.sessions[0].id, OTHER);
  assert.match(first.indexRevision, /^[a-f0-9]{64}$/);
  assert.equal(stable.indexRevision, first.indexRevision);
  const db = new DatabaseSync(database);
  try { db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(1_800_000_000, OTHER); }
  finally { db.close(); }
  const changed = await f.history.list({ offset: first.nextOffset!, limit: 1 });
  assert.equal(changed.sessions[0].id, ID);
  assert.notEqual(changed.indexRevision, first.indexRevision);
});

test('fallback revisions reflect candidate changes and stay stable across unchanged offset pages', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.filename(), encode(meta()));
  await fs.writeFile(f.filename(OTHER), encode(meta(OTHER)));
  const first = await f.history.list({ limit: 1 });
  const stable = await f.history.list({ offset: first.nextOffset!, limit: 1 });
  assert.equal(stable.indexRevision, first.indexRevision);
  await fs.utimes(f.filename(), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
  const changed = await f.history.list({ offset: first.nextOffset!, limit: 1 });
  assert.notEqual(changed.indexRevision, first.indexRevision);
});
