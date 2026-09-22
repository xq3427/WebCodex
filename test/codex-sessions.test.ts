import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig, loadConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { VERSION } from '../src/version.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ARCHIVED = '33333333-3333-4333-8333-333333333333';
const SUFFIX = '44444444-4444-4444-8444-444444444444';
const SECRET = 'sk-proj-' + 'A'.repeat(32);
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('');
const record = (ordinal: number, type: string, payload: unknown) => ({ ordinal, timestamp: '2026-09-08T00:00:00Z', type, payload });
const message = (ordinal: number, role: string, text: string, extra: Record<string, unknown> = {}) => record(ordinal, 'response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra });

async function fixture(t: TestContext, enabled = true) {
  const parent = await realpath(os.tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-session-service-'));
  const root = path.join(base, 'project');
  const home = path.join(root, 'local-history');
  const sessions = path.join(home, 'sessions', '2026', '09', '08');
  const archived = path.join(home, 'archived_sessions');
  await mkdir(sessions, { recursive: true });
  await mkdir(archived);
  const configPath = path.join(base, 'config.json');
  const raw = defaultConfig(root, configPath);
  raw.codexSessions = { enabled, home };
  await writeFile(configPath, JSON.stringify(raw));
  await writeFile(path.join(home, 'auth.json'), '{"access_token":"synthetic-local-auth-never-export"}');
  await writeFile(path.join(root, 'README.md'), 'Current project guidance; verify files before resuming.\n');
  const current = path.join(sessions, `rollout-2026-09-08T00-00-00-${ID}_${SUFFIX}.jsonl`);
  const older = path.join(sessions, `rollout-2026-09-08T00-00-00-${ID}.jsonl`);
  const meta = (id: string, cwd: string, ordinal = 0, extra: Record<string, unknown> = {}) => record(ordinal, 'session_meta', { id, cwd, timestamp: '2026-09-08T00:00:00Z', base_instructions: 'PRIVATE-POLICY', ...extra });
  const prefix = jsonl(meta(ID, root), message(1, 'user', 'first objective'), message(2, 'assistant', 'first result', { phase: 'final_answer' }));
  await writeFile(older, prefix + jsonl(message(3, 'user', 'STALE-NOT-IN-BASE')));
  await writeFile(current, jsonl(
    meta(ID, root, 3, { history_base: { thread_id: ID, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(prefix) } }),
    message(4, 'system', 'PRIVATE-SYSTEM'), message(5, 'developer', 'PRIVATE-DEVELOPER'),
    record(6, 'response_item', { type: 'reasoning', summary: [{ text: 'PRIVATE-REASONING' }] }),
    message(7, 'assistant', 'PRIVATE-ANALYSIS', { channel: 'analysis' }),
    message(8, 'user', 'continue objective ' + SECRET),
    record(9, 'event_msg', { type: 'user_message', message: 'continue objective ' + SECRET }),
    record(10, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'call_fixture', arguments: '{"cmd":"create must-not-execute.txt","api_key":"' + SECRET + '"}' }),
    record(11, 'response_item', { type: 'function_call_output', call_id: 'call_fixture', output: 'Historical test exit_code=0; password="synthetic-secret-password"' }),
    message(12, 'assistant', 'latest result', { phase: 'final_answer' }),
  ));
  const outside = path.join(base, 'unapproved-project');
  const otherFile = path.join(sessions, `rollout-2026-09-08T00-00-00-${OTHER}.jsonl`);
  const archivedFile = path.join(archived, `rollout-2026-09-08T00-00-00-${ARCHIVED}.jsonl`);
  await writeFile(otherFile, jsonl(meta(OTHER, outside), message(1, 'user', 'other task')));
  await writeFile(archivedFile, jsonl(meta(ARCHIVED, root), message(1, 'user', 'archived task')));
  const database = path.join(home, 'state_5.sqlite');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)');
  insert.run(ID, current, root, 'Emergency project ' + SECRET, 1700000000, 1700000030, 0);
  insert.run(OTHER, otherFile, outside, 'Other project', 1700000000, 1700000020, 0);
  insert.run(ARCHIVED, archivedFile, root, 'Archived project', 1700000000, 1700000010, 1);
  db.close();
  const app = new App(await loadConfig(configPath));
  t.after(async () => {
    await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-session-service-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { base, root, home, current, older, app, configPath, database };
}

test('Codex session tools require local enablement and ordinary file tools still reject configured history home', async t => {
  const f = await fixture(t, false);
  await assert.rejects(f.app.codex.list({}), { code: 'CODEX_SESSIONS_DISABLED' });
  await assert.rejects(f.app.codex.read({ session_id: ID }), { code: 'CODEX_SESSIONS_DISABLED' });
  assert.equal(f.app.status().codex_sessions.enabled, false);
  await assert.rejects(f.app.files.read({ workspace_id: 'default', path: 'local-history/auth.json' }), { code: 'PATH_DENIED' });
  await assert.rejects(f.app.files.write({ workspace_id: 'default', path: 'local-history/auth.json', content: 'bad', expected_sha256: null, idempotency_key: 'denied-auth-change' }), { code: 'PATH_DENIED' });
  assert.ok((await f.app.files.list({ workspace_id: 'default' })).entries.every(entry => entry.name !== 'local-history'));
});

test('Codex session discovery filters titles/workspaces and paginates archives without returning private data', async t => {
  const f = await fixture(t);
  const first = await f.app.codex.list({ limit: 1 });
  assert.equal(first.sessions[0].session_id, ID);
  assert.match(first.sessions[0].title, /\[REDACTED\]/);
  assert.equal(first.sessions[0].workspace_id, 'default');
  const second = await f.app.codex.list({ limit: 1, cursor: first.next_cursor! });
  assert.equal(second.sessions[0].session_id, OTHER);
  assert.equal(second.sessions[0].workspace_id, null);
  assert.equal(second.next_cursor, null);
  assert.equal((await f.app.codex.list({ include_archived: true })).sessions.length, 3);
  assert.deepEqual((await f.app.codex.list({ workspace_id: 'default' })).sessions.map(session => session.session_id), [ID]);
  assert.deepEqual((await f.app.codex.list({ query: 'other' })).sessions.map(session => session.session_id), [OTHER]);
  await assert.rejects(f.app.codex.list({ cursor: first.next_cursor!, query: 'changed' }), { code: 'INVALID_CURSOR' });
  assert.doesNotMatch(JSON.stringify(first), new RegExp(SECRET + '|PRIVATE-|synthetic-local-auth'));
});

test('Codex transcript pagination crosses verified history segments without event duplication or private messages', async t => {
  const f = await fixture(t);
  const originals = await Promise.all([f.current, f.older, f.database].map(file => readFile(file)));
  let cursor: string | undefined;
  const newestFirst: string[] = [];
  for (let page = 0; page < 10; page++) {
    const result = await f.app.codex.read({ session_id: ID, limit: 1, cursor });
    for (const entry of [...result.entries].reverse()) newestFirst.push(entry.text);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|STALE-NOT-IN-BASE|sk-proj-|synthetic-secret-password|must-not-execute/);
    assert.equal(result.unread_older_history, false);
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
    assert.ok(page < 9, 'pagination must terminate');
  }
  assert.deepEqual(newestFirst, ['latest result', 'continue objective [REDACTED]', 'first result', 'first objective']);
  const withTools = await f.app.codex.read({ session_id: ID, include_tools: true, limit: 100 });
  assert.equal(withTools.entries.filter(entry => entry.kind === 'tool_call').length, 1);
  assert.match(withTools.entries.find(entry => entry.kind === 'tool_result')!.text, /exit_code=0/);
  assert.doesNotMatch(JSON.stringify(withTools), /synthetic-secret-password|sk-proj-/);
  await assert.rejects(access(path.join(f.root, 'must-not-execute.txt')));
  const after = await Promise.all([f.current, f.older, f.database].map(file => readFile(file)));
  after.forEach((bytes, index) => assert.deepEqual(bytes, originals[index]));
});

test('Codex list cursors reject an index reordered by active sessions', async t => {
  const f = await fixture(t);
  const first = await f.app.codex.list({ limit: 1 });
  const db = new DatabaseSync(f.database);
  db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(1700000100, OTHER);
  db.close();
  await assert.rejects(f.app.codex.list({ cursor: first.next_cursor!, limit: 1 }), { code: 'HISTORY_INDEX_CHANGED' });
  assert.equal((await f.app.codex.list({ limit: 1 })).sessions[0].session_id, OTHER);
});

test('Codex cursors cannot be forged, reused across sessions or reused with different tool visibility', async t => {
  const f = await fixture(t);
  const page = await f.app.codex.read({ session_id: ID, limit: 1 });
  assert.ok(page.next_cursor);
  const cursor = page.next_cursor!;
  await assert.rejects(f.app.codex.read({ session_id: ID, cursor: cursor.slice(0, -3) + 'AAA' }), { code: 'INVALID_CURSOR' });
  await assert.rejects(f.app.codex.read({ session_id: OTHER, cursor }), { code: 'INVALID_CURSOR' });
  await assert.rejects(f.app.codex.read({ session_id: ID, cursor, include_tools: true }), { code: 'INVALID_CURSOR' });
  await assert.rejects(f.app.codex.read({ session_id: '../auth.json' }), { code: 'INVALID_ARGUMENT' });
});

test('Codex handoff joins current authorized project context without granting access to another project', async t => {
  const f = await fixture(t);
  const handoff = await f.app.codex.handoff({ session_id: ID });
  assert.equal(handoff.workspace_authorized, true);
  assert.equal(handoff.execution_mode, 'disabled');
  assert.match(JSON.stringify(handoff.workspace), /Current project guidance/);
  assert.equal(handoff.transcript.include_tools, false);
  assert.match(handoff.next_steps.join('\n'), /never|Do not|cannot/);
  const outside = await f.app.codex.handoff({ session_id: OTHER });
  assert.equal(outside.workspace_authorized, false);
  assert.equal(outside.workspace, null);
  assert.equal(f.app.listWorkspaces().workspaces.length, 1);
});

test('handoff does not treat a protected subdirectory as an authorized project', async t => {
  const f = await fixture(t);
  const firstLine = JSON.parse((await readFile(f.current, 'utf8')).split('\n')[0]);
  firstLine.payload.cwd = path.join(f.home, 'worktrees', 'protected-checkout');
  await writeFile(f.current, jsonl(firstLine, message(4, 'user', 'continue worktree task')));
  const handoff = await f.app.codex.handoff({ session_id: ID });
  assert.equal(handoff.workspace_authorized, false);
  assert.equal(handoff.workspace, null);
});

test('long Codex text and title are redacted before applying UTF-8 budgets', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.database);
  db.prepare('UPDATE threads SET title=? WHERE id=?').run('x'.repeat(286) + ' ' + SECRET, ID);
  db.close();
  const firstLine = (await readFile(f.current, 'utf8')).split('\n')[0];
  await writeFile(f.current, firstLine + '\n' + jsonl(message(4, 'user', '中'.repeat(70) + ' api_key="' + SECRET + '" ' + '尾'.repeat(90))));
  const result = await f.app.codex.read({ session_id: ID, max_bytes: 256 });
  assert.ok(result.content_bytes <= 256);
  assert.equal(result.truncated, true);
  assert.ok(result.redactions > 0);
  assert.doesNotMatch(JSON.stringify(result), /sk-proj-|�/);
});

test('handoff guidance redacts before preview truncation and omits an incomplete final line', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'README.md'), 'x'.repeat(4082) + ' ' + SECRET);
  const preview = await f.app.codex.handoff({ session_id: ID });
  assert.doesNotMatch(JSON.stringify(preview.workspace), /sk-proj-/);
  await writeFile(path.join(f.root, 'README.md'), 'x'.repeat(f.app.config.limits.readMaxBytes - 12) + ' ' + SECRET);
  const long = await f.app.codex.handoff({ session_id: ID });
  assert.doesNotMatch(JSON.stringify(long.workspace), /sk-proj-/);
});

test('real stdio MCP client can discover, read and prepare local Codex continuation context', async t => {
  const f = await fixture(t);
  // A separate state directory is essential: this protocol client must not share the fixture App's lease.
  const cliConfigPath = path.join(f.base, 'mcp-config.json');
  const raw = JSON.parse(await readFile(f.configPath, 'utf8'));
  raw.stateDir = path.join(f.base, 'mcp-state');
  await writeFile(cliConfigPath, JSON.stringify(raw));
  const client = new Client({ name: 'history-integration-fixture', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve', '--config', cliConfigPath], stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, VERSION);
    assert.equal((await client.listTools()).tools.length,72);
    for (const name of ['codex_session_list', 'codex_session_read', 'codex_session_handoff']) {
      const result = await client.callTool({ name, arguments: name === 'codex_session_list' ? {} : { session_id: ID } });
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as any).ok, true);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|sk-proj-|synthetic-local-auth/);
    }
    const found = await client.callTool({ name: 'codex_session_search', arguments: { session_id: ID, query: 'objective' } });
    assert.equal(found.isError, undefined);
    const data = (found.structuredContent as any).data;
    assert.equal(data.matches.length, 2);
    const located = await client.callTool({ name: 'codex_session_read', arguments: { session_id: ID, cursor: data.matches[0].context_cursor, limit: 1 } });
    assert.equal(located.isError, undefined);
    assert.match((located.structuredContent as any).data.entries[0].text, /objective/);
  } finally { await client.close(); }
});
