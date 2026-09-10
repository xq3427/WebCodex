import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultConfig } from '../src/config.js';
import { CodexSessionService } from '../src/codex-sessions.js';
import { redactSessionText } from '../src/codex-redaction.js';
import { StateStore } from '../src/store.js';
import { WorkspacePaths } from '../src/paths.js';
import type { AppConfig } from '../src/types.js';

const ID = '11111111-1111-4111-8111-111111111111';
const SUFFIX = '22222222-2222-4222-8222-222222222222';
const SECRET = 'sk-proj-' + 'A'.repeat(32);
const row = (ordinal: number, type: string, payload: unknown) => ({ ordinal, timestamp: '2026-09-08T00:00:00Z', type, payload });
const message = (ordinal: number, text: string, extra = {}) => row(ordinal, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }], ...extra });
const jsonl = (...rows: unknown[]) => rows.map(value => JSON.stringify(value) + '\n').join('');

async function fixture(t: TestContext, maxRecordBytes = 1024 * 1024) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'webcodex-continuation-test-'));
  const root = path.join(folder, 'project');
  const home = path.join(folder, 'history');
  const sessions = path.join(home, 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(root);
  const file = path.join(sessions, `rollout-${ID}.jsonl`);
  const configPath = path.join(folder, 'config.json');
  const config: AppConfig = { ...defaultConfig(root, configPath), configPath, codexSessions: { enabled: true, home, maxRecordBytes } };
  const store = new StateStore(config.stateDir);
  const ctx = { config, store, paths: new WorkspacePaths(config) };
  const service = new CodexSessionService(ctx, async () => ({ workspace_id: 'default' }));
  const meta = (ordinal = 0, extra = {}) => row(ordinal, 'session_meta', { id: ID, cwd: root, ...extra });
  const write = (rows: unknown[], tail = '') => fs.writeFile(file, jsonl(meta(), ...rows) + tail);
  t.after(async () => {
    store.close();
    const real = await fs.realpath(folder);
    assert.equal(path.dirname(real), parent);
    assert.ok(path.basename(real).startsWith('webcodex-continuation-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  return { root, home, sessions, file, config, ctx, store, service, meta, write };
}

async function collect(service: CodexSessionService, options: { include_tools?: boolean; max_bytes?: number } = {}) {
  const grouped = new Map<string, { text: string; bytes: number; total: number; kind: string }>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let final: Awaited<ReturnType<CodexSessionService['read']>> | undefined;
  for (let pageNumber = 0; pageNumber < 400; pageNumber++) {
    const page = await service.read({ session_id: ID, cursor, max_bytes: 8192, ...options });
    assert.equal(page.order, 'chronological_within_page');
    assert.equal(page.content_bytes, page.entries.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0));
    assert.ok(page.content_bytes <= (options.max_bytes ?? 8192));
    assert.doesNotMatch(JSON.stringify(page), /sk-proj-|SYNTHETIC-PRIVATE-|�/);
    for (const entry of [...page.entries].reverse()) {
      const prior = grouped.get(entry.entry_id) ?? { text: '', bytes: 0, total: entry.chunk.total_bytes, kind: entry.kind };
      assert.equal(entry.chunk.offset_bytes, prior.bytes, 'next cursor must continue exactly after the prior safe UTF-8 chunk');
      assert.equal(entry.chunk.total_bytes, prior.total);
      assert.equal(entry.chunk.end_bytes - entry.chunk.offset_bytes, Buffer.byteLength(entry.text));
      prior.text += entry.text;
      prior.bytes += Buffer.byteLength(entry.text);
      assert.equal(entry.chunk.has_more, prior.bytes < prior.total);
      assert.equal(entry.text_truncated, entry.chunk.has_more);
      grouped.set(entry.entry_id, prior);
    }
    if (!page.next_cursor) { final = page; break; }
    assert.ok(!seenCursors.has(page.next_cursor), 'pagination must always advance');
    seenCursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }
  assert.ok(final, 'bounded fixture must finish pagination');
  for (const entry of grouped.values()) assert.equal(entry.bytes, entry.total, 'each projected message must be complete');
  return { entries: [...grouped.values()], final, pages: seenCursors.size + 1 };
}

test('read reconstructs 200 KiB+ Chinese and emoji messages exactly across UTF-8 chunks before visiting older entries', async t => {
  const f = await fixture(t);
  const long = '中文🙂'.repeat(24_000) + ' 末尾-重要需求';
  assert.ok(Buffer.byteLength(long) >= 200 * 1024);
  await f.write([message(1, 'old objective'), message(2, long), message(3, 'newest summary')]);
  const result = await collect(f.service);
  assert.deepEqual(result.entries.map(entry => entry.text), ['newest summary', long, 'old objective']);
  assert.ok(result.pages > 20);
  assert.equal(result.final.scan_complete, true);
  assert.equal(result.final.omitted_content, false);
});

test('tool results and arguments remain complete when opted in, with full-field redaction before any chunk', async t => {
  const f = await fixture(t);
  const args = JSON.stringify({ command: '中文'.repeat(38_000), api_key: SECRET, password: 'SYNTHETIC-PRIVATE-ARGUMENT' });
  const output = 'x'.repeat(250) + ' api_key="' + SECRET + '" ' + '中文🙂'.repeat(25_000) + ' password="SYNTHETIC-PRIVATE-TAIL"';
  await f.write([
    row(1, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'call_long', arguments: args }),
    row(2, 'response_item', { type: 'function_call_output', call_id: 'call_long', output }),
    row(3, 'response_item', { type: 'reasoning', summary: [{ text: 'SYNTHETIC-PRIVATE-REASONING' }] }),
    message(4, 'SYNTHETIC-PRIVATE-ANALYSIS', { role: 'assistant', channel: 'analysis' }),
  ]);
  const hidden = await f.service.read({ session_id: ID });
  assert.equal(hidden.entries.length, 0);
  assert.equal(hidden.next_cursor, null);
  const result = await collect(f.service, { include_tools: true });
  assert.deepEqual(result.entries.map(entry => entry.kind), ['tool_result', 'tool_call']);
  assert.deepEqual(result.entries.map(entry => entry.text), [redactSessionText(output).text, redactSessionText(args).text]);
  assert.equal(result.final.scan_complete, true);
});

test('credential bytes straddling a 256-byte response boundary never escape in any continued page', async t => {
  const f = await fixture(t);
  const original = 'a'.repeat(244) + ' api_key="' + SECRET + '" ' + '中'.repeat(250) + ' password="SYNTHETIC-PRIVATE-PASSWORD" ending';
  await f.write([message(1, original)]);
  const result = await collect(f.service, { max_bytes: 256 });
  assert.deepEqual(result.entries.map(entry => entry.text), [redactSessionText(original).text]);
  assert.ok(result.pages > 3);
});

test('continuation retries are deterministic, page budget may change, append is tolerated, and old cursor ignores new messages', async t => {
  const f = await fixture(t);
  const long = '中文🙂'.repeat(1000);
  await f.write([message(1, long)]);
  const first = await f.service.read({ session_id: ID, max_bytes: 256 });
  assert.ok(first.next_cursor);
  await fs.appendFile(f.file, jsonl(message(2, 'new appended message')));
  const next = await f.service.read({ session_id: ID, cursor: first.next_cursor!, max_bytes: 1024 });
  const retry = await f.service.read({ session_id: ID, cursor: first.next_cursor!, max_bytes: 1024 });
  assert.deepEqual(next, retry);
  assert.equal(next.entries[0].entry_id, first.entries[0].entry_id);
  assert.equal(next.entries[0].chunk.offset_bytes, first.entries[0].chunk.end_bytes);
  assert.equal(Buffer.from(long).subarray(next.entries[0].chunk.offset_bytes, next.entries[0].chunk.end_bytes).toString('utf8'), next.entries[0].text);
  assert.doesNotMatch(JSON.stringify(next), /new appended message/);
});

test('signed continuation detects mutation of unseen tail, full-record anchors, replacement, truncation and cursor tampering', async t => {
  const f = await fixture(t);
  const long = 'a'.repeat(1200) + 'original-tail';
  await f.write([message(1, 'older'), message(2, long)]);
  const first = await f.service.read({ session_id: ID, max_bytes: 256 });
  await f.write([message(1, 'older'), message(2, long.replace('original-tail', 'modified-tail'))]);
  await assert.rejects(f.service.read({ session_id: ID, cursor: first.next_cursor! }), { code: 'HISTORY_CURSOR_STALE' });
  const full = await f.service.read({ session_id: ID, limit: 1 });
  await f.write([message(1, 'older'), message(2, long)]);
  await assert.rejects(f.service.read({ session_id: ID, cursor: full.next_cursor! }), { code: 'HISTORY_CURSOR_STALE' });
  const replacement = f.file + '.replacement';
  await fs.writeFile(replacement, await fs.readFile(f.file));
  await fs.rename(replacement, f.file);
  await assert.rejects(f.service.read({ session_id: ID, cursor: first.next_cursor! }), { code: 'HISTORY_CURSOR_STALE' });
  const page = await f.service.read({ session_id: ID, max_bytes: 256 });
  await f.write([message(1, 'short')]);
  await assert.rejects(f.service.read({ session_id: ID, cursor: page.next_cursor! }), { code: 'HISTORY_CURSOR_STALE' });
  await fs.writeFile(f.file, 'broken replacement header\n');
  await assert.rejects(f.service.read({ session_id: ID, cursor: page.next_cursor! }), { code: 'HISTORY_CURSOR_STALE' });
  await assert.rejects(f.service.read({ session_id: ID, cursor: page.next_cursor!.slice(0, -3) + 'AAA' }), { code: 'INVALID_CURSOR' });
});

test('long messages across verified history_base segments reconstruct fully and exclude unreferenced old tails', async t => {
  const f = await fixture(t);
  const older = '旧🙂'.repeat(35_000);
  const newer = '新中文'.repeat(28_000);
  const prefix = jsonl(f.meta(), message(1, older));
  await fs.writeFile(f.file, prefix + jsonl(message(2, 'UNREFERENCED-TAIL')));
  const current = path.join(f.sessions, `rollout-${ID}_${SUFFIX}.jsonl`);
  await fs.writeFile(current, jsonl(f.meta(2, { history_base: { thread_id: ID, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(prefix) } }), message(3, newer)));
  const result = await collect(f.service);
  assert.deepEqual(result.entries.map(entry => entry.text), [newer, older]);
  assert.equal(result.final.scan_complete, true);
  assert.equal(result.final.unread_older_history, false);
});

test('record-limit, corrupt-line and tail omissions expose bounded ranges and survive to the last read page', async t => {
  const f = await fixture(t, 65536);
  await f.write([message(1, 'old'), message(2, 'x'.repeat(80_000)), message(3, 'new')], 'invalid json\n{"unfinished":');
  const first = await f.service.read({ session_id: ID, limit: 1 });
  assert.equal(first.omitted_content, true);
  assert.equal(first.scan_complete, false);
  assert.ok(first.omissions.some(item => item.reason === 'record_limit' && item.record_count === 1));
  assert.ok(first.omissions.some(item => item.reason === 'invalid_record' && item.record_count === 1));
  assert.ok(first.omissions.some(item => item.reason === 'incomplete_tail'));
  const source = await fs.readFile(f.file);
  for (const omission of first.omissions) {
    assert.match(omission.file_key, /^[a-f0-9]{64}$/);
    assert.ok(omission.start_byte >= 0 && omission.end_byte > omission.start_byte && omission.end_byte <= source.length);
    if (omission.reason === 'record_limit') assert.equal(JSON.parse(source.subarray(omission.start_byte, omission.end_byte).toString('utf8')).ordinal, 2);
  }
  let page = first;
  for (let calls = 0; page.next_cursor && calls < 10; calls++) page = await f.service.read({ session_id: ID, cursor: page.next_cursor!, limit: 1 });
  assert.equal(page.next_cursor, null);
  assert.equal(page.omitted_content, true);
  assert.equal(page.scan_complete, false);
  assert.ok(page.warnings.includes('previous_read_pages_omitted_content'));
});

test('window-limited oversized fragments have traceable omissions and cannot produce a complete-history claim', async t => {
  const f = await fixture(t);
  await f.write([message(1, 'older'), message(2, 'x'.repeat(3 * 1024 * 1024)), message(3, 'newer')]);
  const result = await collect(f.service);
  assert.deepEqual(result.entries.map(entry => entry.text), ['newer', 'older']);
  assert.equal(result.final.scan_complete, false);
  assert.equal(result.final.omitted_content, true);
  assert.ok(result.final.omissions.some(item => item.reason === 'window_fragment'));
});

test('a search context cursor returns the whole long matched entry by continuation and detects changes before it is followed', async t => {
  const f = await fixture(t);
  const long = '中文'.repeat(38_000) + ' distant target';
  await f.write([message(1, long)]);
  const found = await f.service.search({ session_id: ID, query: 'target' });
  const first = await f.service.read({ session_id: ID, cursor: found.matches[0].context_cursor, max_bytes: 256 });
  assert.equal(first.entries[0].chunk.offset_bytes, 0);
  assert.equal(first.entries[0].chunk.total_bytes, Buffer.byteLength(long));
  assert.ok(first.next_cursor);
  await f.write([message(1, long.replace('target', 'edited'))]);
  await assert.rejects(f.service.read({ session_id: ID, cursor: found.matches[0].context_cursor }), { code: 'HISTORY_CURSOR_STALE' });
});

test('omission metadata stays bounded for many separated corrupt records without losing the enclosing range or count', async t => {
  const f = await fixture(t);
  const corrupt = Array.from({ length: 1000 }, (_, index) => 'invalid json\n' + jsonl(row(index + 1, 'event_msg', { type: 'ignored' }))).join('');
  await fs.writeFile(f.file, jsonl(f.meta()) + corrupt);
  const result = await f.service.read({ session_id: ID });
  assert.equal(result.entries.length, 0);
  assert.equal(result.scan.invalid_records, 1000);
  assert.equal(result.omissions.length, 64);
  assert.equal(result.omissions.reduce((sum, item) => sum + (item.record_count ?? 0), 0), 1000);
  assert.equal(result.omissions.at(-1)!.reason, 'additional_omissions');
  assert.equal(result.omissions.at(-1)!.range_kind, 'enclosing');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 24 * 1024);
  assert.equal(result.scan_complete, false);
});

test('historical cwd only matches an existing real directory under an authorized workspace', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, jsonl(f.meta(0, { cwd: path.join(f.root, 'missing') }), message(1, 'context')));
  assert.equal((await f.service.handoff({ session_id: ID })).workspace_authorized, false);
  const outside = path.join(path.dirname(f.root), 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(f.file, jsonl(f.meta(0, { cwd: path.join(f.root, 'alias') }), message(1, 'context')));
  assert.equal((await f.service.handoff({ session_id: ID })).workspace_authorized, false);
  await fs.mkdir(path.join(f.root, 'src'));
  await fs.writeFile(f.file, jsonl(f.meta(0, { cwd: path.join(f.root, 'src') }), message(1, 'context')));
  assert.equal((await f.service.handoff({ session_id: ID })).workspace_authorized, true);
});
