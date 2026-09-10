import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultConfig } from '../src/config.js';
import { CodexSessionService } from '../src/codex-sessions.js';
import { StateStore } from '../src/store.js';
import { WorkspacePaths } from '../src/paths.js';
import type { AppConfig } from '../src/types.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SUFFIX = '33333333-3333-4333-8333-333333333333';
const SECRET = 'sk-proj-' + 'A'.repeat(32);
const record = (ordinal: number, type: string, payload: unknown) => ({ ordinal, timestamp: '2026-09-08T00:00:00Z', type, payload });
const message = (ordinal: number, text: string, role = 'user', extra: Record<string, unknown> = {}) => record(ordinal, 'response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra });
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('');

async function fixture(t: TestContext, enabled = true) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'webcodex-search-test-'));
  const root = path.join(folder, 'project');
  const home = path.join(root, 'codex-history');
  const sessions = path.join(home, 'sessions', '2026', '09', '08');
  await fs.mkdir(sessions, { recursive: true });
  const file = path.join(sessions, `rollout-2026-09-08T00-00-00-${ID}.jsonl`);
  const configPath = path.join(folder, 'config.json');
  const config: AppConfig = { ...defaultConfig(root, configPath), configPath, codexSessions: { enabled, home } };
  const store = new StateStore(config.stateDir);
  const ctx = { config, store, paths: new WorkspacePaths(config) };
  const service = new CodexSessionService(ctx, async () => ({ workspace_id: 'default' }));
  const meta = (ordinal = 0, extra: Record<string, unknown> = {}) => record(ordinal, 'session_meta', { id: ID, cwd: root, timestamp: '2026-09-08T00:00:00Z', ...extra });
  const write = async (rows: unknown[], tail = '') => fs.writeFile(file, jsonl(meta(), ...rows) + tail);
  t.after(async () => {
    store.close();
    const real = await fs.realpath(folder);
    assert.equal(path.dirname(real), parent);
    assert.ok(path.basename(real).startsWith('webcodex-search-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  return { root, home, sessions, file, ctx, service, store, meta, write };
}

test('search matches literal visible text once per entry and excludes policy, reasoning and event mirrors', async t => {
  const f = await fixture(t);
  await f.write([
    message(1, 'a.b original a.b again'), message(2, 'aXb is not a literal match'),
    message(3, 'a.b assistant result', 'assistant', { phase: 'final_answer' }),
    message(4, 'a.b HIDDEN-POLICY', 'developer'), message(5, 'a.b HIDDEN-ANALYSIS', 'assistant', { channel: 'analysis' }),
    record(6, 'response_item', { type: 'reasoning', summary: [{ text: 'a.b HIDDEN-REASONING' }] }),
    record(7, 'event_msg', { type: 'user_message', message: 'a.b EVENT-MIRROR' }),
  ]);
  const result = await f.service.search({ session_id: ID, query: 'a.b' });
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].role, 'assistant');
  assert.equal(result.matches[1].snippet, 'a.b original a.b again');
  assert.equal(result.matches_per_entry, 'first');
  assert.equal(result.case_sensitive, true);
  assert.equal(result.scan_complete, true);
  assert.equal(result.scan_incomplete, false);
  assert.equal(result.next_cursor, null);
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN-|EVENT-MIRROR|aXb/);
  assert.equal((await f.service.search({ session_id: ID, query: 'A.B' })).matches.length, 0);
});

test('search redacts complete fields before matching and makes UTF-8 snippets around distant matches', async t => {
  const f = await fixture(t);
  const text = '中文🙂'.repeat(400) + '命中目标 ' + SECRET + ' 尾巴'.repeat(100);
  await f.write([message(1, text)]);
  const result = await f.service.search({ session_id: ID, query: '命中目标', max_bytes: 256 });
  assert.equal(result.matches.length, 1);
  const match = result.matches[0];
  assert.ok(match.match_offset_utf16 > 256);
  assert.ok(match.snippet_start_utf16 > 0);
  assert.equal(match.snippet.indexOf('命中目标'), match.match_offset_utf16 - match.snippet_start_utf16);
  assert.equal(match.snippet_truncated, true);
  assert.ok(result.content_bytes <= 256);
  assert.equal(result.content_bytes, Buffer.byteLength(match.snippet));
  assert.match(match.snippet, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), /sk-proj-|�/);
  const hidden = await f.service.search({ session_id: ID, query: SECRET });
  assert.equal(hidden.matches.length, 0);
  assert.equal(hidden.scan_complete, true);
  assert.ok(!JSON.stringify(hidden).includes(SECRET));
});

test('search pagination crosses verified history bases and context cursors identify the matching read entry', async t => {
  const f = await fixture(t);
  const prefix = jsonl(f.meta(), message(1, 'needle oldest'), message(2, 'needle older'));
  await fs.writeFile(f.file, prefix + jsonl(message(3, 'needle STALE-EXCLUDED')));
  const current = path.join(f.sessions, `rollout-2026-09-08T01-00-00-${ID}_${SUFFIX}.jsonl`);
  await fs.writeFile(current, jsonl(f.meta(3, { history_base: { thread_id: ID, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(prefix) } }), message(4, 'needle newer'), message(5, 'needle newest')));
  const originals = await Promise.all([f.file, current].map(file => fs.readFile(file)));
  let cursor: string | undefined;
  const found: string[] = [];
  for (let page = 0; page < 10; page++) {
    const result = await f.service.search({ session_id: ID, query: 'needle', limit: 1, cursor });
    for (const match of result.matches) {
      found.push(match.snippet);
      const context = await f.service.read({ session_id: ID, cursor: match.context_cursor, limit: 1 });
      assert.equal(context.entries[0].text, match.snippet);
    }
    assert.equal(result.unread_older_history, false);
    if (!result.next_cursor) { assert.equal(result.scan_complete, true); break; }
    cursor = result.next_cursor;
    assert.ok(page < 9);
  }
  assert.deepEqual(found, ['needle newest', 'needle newer', 'needle older', 'needle oldest']);
  const after = await Promise.all([f.file, current].map(file => fs.readFile(file)));
  assert.deepEqual(after, originals);
});

test('tools require explicit inclusion and audits never contain the query, body or credentials', async t => {
  const f = await fixture(t);
  const query = 'unique-search-query-985';
  await f.write([
    record(1, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'call_test', arguments: JSON.stringify({ command: query + ' BODY-MARKER', api_key: SECRET }) }),
    record(2, 'response_item', { type: 'function_call_output', call_id: 'call_test', output: query + ' password="test-password-private"' }),
  ]);
  assert.equal((await f.service.search({ session_id: ID, query })).matches.length, 0);
  const included = await f.service.search({ session_id: ID, query, include_tools: true });
  assert.deepEqual(included.matches.map(match => match.kind), ['tool_result', 'tool_call']);
  assert.doesNotMatch(JSON.stringify(included), /sk-proj-|test-password-private/);
  const context = await f.service.read({ session_id: ID, include_tools: true, cursor: included.matches[0].context_cursor, limit: 1 });
  assert.equal(context.entries[0].kind, 'tool_result');
  const audits = JSON.stringify(f.store.db.prepare("SELECT details FROM audit_events WHERE event='codex_session_search'").all());
  assert.ok(!audits.includes(query));
  assert.doesNotMatch(audits, /BODY-MARKER|sk-proj-|test-password-private|command/);
});

test('signed search cursors bind query, thread and tool visibility and reject reuse after restart', async t => {
  const f = await fixture(t);
  await f.write([message(1, 'needle older'), message(2, 'needle newer')]);
  const page = await f.service.search({ session_id: ID, query: 'needle', limit: 1 });
  const cursor = page.next_cursor!;
  assert.ok(cursor);
  const decoded = Buffer.from(cursor.split('.')[0], 'base64url').toString('utf8');
  assert.ok(!decoded.includes('needle'));
  for (const changed of [{ query: 'different' }, { session_id: OTHER }, { include_tools: true }, { cursor: cursor.slice(0, -3) + 'AAA' }]) {
    await assert.rejects(f.service.search({ session_id: ID, query: 'needle', cursor, ...changed }), { code: 'INVALID_CURSOR' });
  }
  await assert.rejects(f.service.read({ session_id: ID, cursor }), { code: 'INVALID_CURSOR' });
  const restarted = new CodexSessionService(f.ctx, async () => ({}));
  await assert.rejects(restarted.search({ session_id: ID, query: 'needle', cursor }), { code: 'INVALID_CURSOR' });
  await fs.appendFile(f.file, jsonl(message(3, 'needle appended')));
  const older = await f.service.search({ session_id: ID, query: 'needle', cursor });
  assert.deepEqual(older.matches.map(match => match.snippet), ['needle older']);
});

test('an empty bounded page reports incomplete scanning and resumes to older matches', async t => {
  const f = await fixture(t);
  await f.write([message(1, 'needle old context'), ...Array.from({ length: 22 }, (_, i) => message(i + 2, 'f'.repeat(250_000)))]);
  const first = await f.service.search({ session_id: ID, query: 'needle' });
  assert.equal(first.matches.length, 0);
  assert.equal(first.scan.windows, 4);
  assert.equal(first.scan_complete, false);
  assert.equal(first.scan_incomplete, true);
  assert.ok(first.next_cursor);
  assert.ok(first.warnings.includes('search_window_limit_follow_next_cursor'));
  assert.ok(first.scan.scanned_bytes <= 32 * 1024 * 1024);
  const older = await f.service.search({ session_id: ID, query: 'needle', cursor: first.next_cursor! });
  assert.deepEqual(older.matches.map(match => match.snippet), ['needle old context']);
  assert.equal(older.scan_complete, true);
  assert.equal(older.next_cursor, null);
});

test('omitted corrupt records, oversized lines and incomplete tails prevent complete-scan claims', async t => {
  const f = await fixture(t);
  await f.write([message(1, 'ordinary')], 'bad-json\n{"unfinished":');
  const corrupt = await f.service.search({ session_id: ID, query: 'absent' });
  assert.equal(corrupt.matches.length, 0);
  assert.equal(corrupt.next_cursor, null);
  assert.equal(corrupt.scan_complete, false);
  assert.equal(corrupt.scan.invalid_records, 1);
  assert.ok(corrupt.warnings.includes('incomplete_history_tail_omitted'));
  await f.write([message(1, 'x'.repeat(2 * 1024 * 1024) + 'needle')]);
  const large = await f.service.search({ session_id: ID, query: 'needle' });
  assert.equal(large.matches.length, 0);
  assert.equal(large.scan_complete, false);
  assert.ok(large.scan.skipped_oversized_lines > 0);
  assert.ok(large.warnings.includes('oversized_history_lines_omitted'));
});

test('shared snippet budgets retain the next unreturned match and invalid queries are rejected', async t => {
  const f = await fixture(t);
  const query = 'Q'.repeat(200);
  await f.write([message(1, query), message(2, 'before ' + query + ' end')]);
  const first = await f.service.search({ session_id: ID, query, max_bytes: 256 });
  assert.equal(first.matches.length, 1);
  assert.ok(first.content_bytes <= 256);
  assert.ok(first.warnings.includes('snippet_budget_follow_next_cursor'));
  const second = await f.service.search({ session_id: ID, query, max_bytes: 256, cursor: first.next_cursor! });
  assert.equal(second.matches[0].snippet, query);
  for (const invalid of ['', '  ', 'x'.repeat(201), '\0', '\ud800']) await assert.rejects(f.service.search({ session_id: ID, query: invalid }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.service.search({ session_id: ID, query: '中'.repeat(200), max_bytes: 256 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.service.search({ session_id: ID, query: 'x', limit: 0 }), { code: 'INVALID_ARGUMENT' });
  const disabled = await fixture(t, false);
  await assert.rejects(disabled.service.search({ session_id: ID, query: 'x' }), { code: 'CODEX_SESSIONS_DISABLED' });
});

test('omission warnings survive cursor pages so the last page cannot claim a previously incomplete search was complete', async t => {
  const f = await fixture(t);
  await f.write([message(1, 'needle old'), message(2, 'needle new')], 'bad-json\n');
  const first = await f.service.search({ session_id: ID, query: 'needle', limit: 1 });
  assert.equal(first.scan.invalid_records, 1);
  assert.ok(first.next_cursor);
  const second = await f.service.search({ session_id: ID, query: 'needle', limit: 1, cursor: first.next_cursor! });
  assert.equal(second.scan.invalid_records, 0);
  assert.ok(second.next_cursor);
  const last = await f.service.search({ session_id: ID, query: 'needle', limit: 1, cursor: second.next_cursor! });
  assert.equal(last.next_cursor, null);
  assert.equal(last.scan_complete, false);
  assert.equal(last.scan_incomplete, true);
  assert.ok(last.warnings.includes('previous_search_pages_omitted_content'));
});
