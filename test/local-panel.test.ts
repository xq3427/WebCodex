import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, link, symlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { startLocalPanel } from '../src/local-panel.js';
import { App } from '../src/app.js';
import { CodexHistory } from '../src/codex-history.js';
import { AppError } from '../src/errors.js';
import { VERSION } from '../src/version.js';
import type { AppConfig } from '../src/types.js';

async function fixture(t: TestContext, configure?: (config: AppConfig) => void) {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(path.join(parent, 'webcodex-local-panel-'));
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); const target = await realpath(directory); assert.equal(path.dirname(target), parent); assert.ok(path.basename(target).startsWith('webcodex-local-panel-')); await rm(target, { recursive: true, force: true }); });
  const root = path.join(directory, 'project'), other = path.join(directory, '另一个工作区');
  await mkdir(root); await mkdir(other);
  const configPath = path.join(directory, 'config.json'), raw = defaultUnifiedConfig(root, configPath);
  raw.tunnel.enabled = false; raw.tunnel.apiKey = 'synthetic-private-tunnel-key-must-not-appear'; raw.http.bearerToken = 'synthetic-private-http-key-must-not-appear';
  raw.workspaces.push({ ...raw.workspaces[0], id: 'readonly', uid: 'b79ecb96-76a9-4af9-a427-4c948ca76e55', root: other, name: '论文只读', readOnly: true });
  await writeFile(configPath, JSON.stringify(raw));
  const config = await loadConfig(configPath); configure?.(config); let revealed: string | undefined;
  const panel = await startLocalPanel(config, { port: 0, reveal: async directory => { revealed = directory; } });
  cleanup.push(panel.close);
  const launch = new URL(panel.url), origin = launch.origin, token = new URLSearchParams(launch.hash.slice(1)).get('token')!;
  async function api(endpoint: string, value?: unknown, extra: Record<string, string> = {}) {
    return await fetch(origin + endpoint, { method: value === undefined ? 'GET' : 'POST', headers: {
      Authorization: 'Bearer ' + token, ...(value === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...extra,
    }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  }
  return { directory, root, other, configPath, config, raw, panel, origin, token, api, cleanup, revealed: () => revealed };
}

test('local panel requires a session token and same-origin requests before exposing paths or state', async t => {
  const f = await fixture(t);
  const publicPage = await fetch(f.origin + '/'); assert.equal(publicPage.status, 200);
  const html = await publicPage.text();
  for (const secret of [f.token, f.raw.http.bearerToken, f.raw.tunnel.apiKey, f.configPath]) assert.equal(html.includes(secret), false);
  assert.match(publicPage.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.match(publicPage.headers.get('content-security-policy')!, /script-src 'sha256-/);
  assert.equal(publicPage.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(f.origin + '/api/status')).status, 401);
  assert.equal((await f.api('/api/status', undefined, { Origin: 'https://attacker.example' })).status, 403);
  const wrongHost = await new Promise<number>(resolve => {
    const req = request(f.origin + '/api/status', { headers: { Host: 'attacker.example', Authorization: 'Bearer ' + f.token } }, res => { res.resume(); resolve(res.statusCode!); }); req.end();
  });
  assert.equal(wrongHost, 403);
  const response = await f.api('/api/status'); assert.equal(response.status, 200);
  const status = await response.json() as any;
  assert.equal(status.version, VERSION); assert.equal(status.device.id, f.raw.device.id);
  assert.equal(status.tunnel.state, 'disabled'); assert.equal(status.jobs.available, false);
  assert.equal(status.original_files.automatic_upload, false); assert.equal(status.original_files.model_access, 'unverified');
  assert.equal(JSON.stringify(status).includes(f.raw.tunnel.apiKey), false); assert.equal(JSON.stringify(status).includes(f.raw.http.bearerToken), false);
  await assert.rejects(readdir(f.config.stateDir), { code: 'ENOENT' });
  assert.equal(await readFile(f.configPath, 'utf8'), JSON.stringify(f.raw));
});

test('local panel accepts localhost aliases used by Linux browsers and SSH port forwarding', async t => {
  const f = await fixture(t);
  const localhostOrigin = f.origin.replace('127.0.0.1', 'localhost');

  // A browser opened with localhost sends both Host and Origin using that
  // spelling.  The panel must treat it as the same loopback endpoint.
  const localhost = await new Promise<number>(resolve => {
    const req = request(f.origin + '/api/status', {
      headers: { Host: new URL(localhostOrigin).host, Authorization: 'Bearer ' + f.token },
    }, res => { res.resume(); resolve(res.statusCode!); });
    req.end();
  });
  assert.equal(localhost, 200);

  // With SSH -L, the local listening port may intentionally differ from the
  // remote panel port.  The forwarded request still carries a loopback Host
  // and matching Origin, which is sufficient once the bearer token is valid.
  const forwardedPort = 43210;
  const forwarded = await new Promise<number>(resolve => {
    const req = request(f.origin + '/api/status', {
      headers: { Host: `127.0.0.1:${forwardedPort}`, Origin: `http://localhost:${forwardedPort}`, Authorization: 'Bearer ' + f.token },
    }, res => { res.resume(); resolve(res.statusCode!); });
    req.end();
  });
  assert.equal(forwarded, 200);

  const mismatchedForward = await new Promise<number>(resolve => {
    const req = request(f.origin + '/api/status', {
      headers: { Host: `127.0.0.1:${forwardedPort}`, Origin: `http://localhost:${forwardedPort + 1}`, Authorization: 'Bearer ' + f.token },
    }, res => { res.resume(); resolve(res.statusCode!); });
    req.end();
  });
  assert.equal(mismatchedForward, 403);

  // SSH forwarding/proxies can preserve one spelling in Host while emitting
  // the other in Origin. Both loopback spellings are accepted on the same
  // forwarded port.
  const mixed = await fetch(f.origin + '/api/status', {
    headers: { Authorization: 'Bearer ' + f.token, Origin: localhostOrigin },
  });
  assert.equal(mixed.status, 200);

});

test('local original-file selection preserves UTF-8 names and raw bytes without upload or document parsing', async t => {
  const f = await fixture(t), bytes = Buffer.from('%PDF-1.4\n原文件 \0\xff\n');
  await writeFile(path.join(f.other, '中文 文件.pdf'), bytes);
  const listing = await (await f.api('/api/files?workspace_id=readonly&path=')).json() as any;
  assert.deepEqual(listing.entries.map((e: any) => e.name), ['中文 文件.pdf']);
  const info = await (await f.api('/api/file-info', { workspace_id: 'readonly', path: '中文 文件.pdf' })).json() as any;
  assert.equal(info.absolute_path, path.join(f.other, '中文 文件.pdf')); assert.equal(info.size_bytes, bytes.length);
  assert.equal(info.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(info.mime_type_source, 'extension');
  assert.equal(info.upload_status, 'not_uploaded'); assert.equal(info.model_access, 'unverified');
  assert.equal(JSON.stringify(info).includes(bytes.toString('base64')), false);
  assert.equal((await f.api('/api/reveal', { workspace_id: 'readonly', path: '中文 文件.pdf' })).status, 200);
  assert.equal(f.revealed(), f.other); assert.deepEqual(await readFile(info.absolute_path), bytes);
});

test('large original files remain selectable even when their optional hash exceeds the local budget', async t => {
  const f = await fixture(t, config => { config.limits.fileReadMaxBytes = 4; });
  await writeFile(path.join(f.root, 'large.pdf'), 'synthetic large original');
  const response = await f.api('/api/file-info', { workspace_id: 'default', path: 'large.pdf' });
  assert.equal(response.status, 200); const info = await response.json() as any;
  assert.equal(info.sha256, null); assert.equal(info.hash_status, 'not_computed_size_limit'); assert.equal(info.size_bytes, 24);
});

test('panel rejects protected paths, traversal, hard links and directory links before revealing anything', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'safe.txt'), 'safe');
  await writeFile(path.join(f.root, '.env'), 'SECRET');
  await link(path.join(f.root, 'safe.txt'), path.join(f.root, 'hard.txt'));
  await symlink(f.other, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(f.other, 'outside.txt'), 'private');
  for (const target of ['../config.json', f.configPath, '.env', 'hard.txt', 'linked/outside.txt', '.git/config', '.webcodex/config.json']) {
    const response = await f.api('/api/reveal', { workspace_id: 'default', path: target });
    assert.ok(response.status >= 400); assert.equal(f.revealed(), undefined);
    assert.equal((await response.text()).includes('SECRET'), false);
  }
  const list = await (await f.api('/api/files?workspace_id=default&path=')).json() as any;
  assert.equal(list.entries.length, 0, 'Both hard-linked aliases and protected/link entries are hidden.');
  await rename(f.root, path.join(f.directory, 'previous-project')); await mkdir(f.root);
  assert.equal((await f.api('/api/files?workspace_id=default&path=')).status, 422, 'Replacing the same path cannot silently rebind a running panel.');
});

test('panel rejects malformed requests, duplicate query fields and abandoned bodies without losing capacity', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/files?workspace_id=default&workspace_id=readonly&path=')).status, 400);
  assert.equal((await f.api('/api/file-info', { workspace_id: 'default', path: 'file', extra: 'not allowed' })).status, 400);
  assert.equal((await f.api('/api/file-info', { workspace_id: 'default', path: 'x'.repeat(5000) })).status, 413);
  assert.equal((await f.api('/api/file-info', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.api('/api/codex/sessions?workspace_id=default')).status, 422);
  const abandoned = request(f.origin + '/api/file-info', { method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json', 'Content-Length': 50 } });
  abandoned.on('error', () => {}); abandoned.write('{');
  await new Promise(resolve => setTimeout(resolve, 40)); abandoned.destroy();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await f.api('/api/status')).status, 200);
});

test('panel reads job records alongside the owning App without taking its lease or recovering running jobs', async t => {
  const f = await fixture(t), app = new App(f.config); f.cleanup.push(() => app.close());
  const binding = app.identity.workspaceIdentity('default'), jobId = '564d4149-dcf3-4c5b-bb5c-976070ab0588';
  app.store.db.prepare(`INSERT INTO webcodex_jobs(job_id,workspace_id,workspace_binding,executable_alias,args_json,cwd,status,created_at,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(jobId, 'default', binding, 'node', '["DO_NOT_EXPOSE_ARGUMENTS"]', '.', 'running', new Date().toISOString(), 1000);
  app.store.db.prepare('INSERT INTO webcodex_job_chunks(job_id,start_cursor,end_cursor,stream,text) VALUES(?,?,?,?,?)')
    .run(jobId, 0, 10, 'stdout', 'synthetic output ' + f.config.tunnel!.apiKey);
  const lease = await readFile(path.join(f.config.stateDir, 'daemon.lock'));
  const status = await (await f.api('/api/status')).json() as any;
  assert.equal(status.jobs.available, true); assert.equal(status.jobs.jobs[0].status, 'running');
  assert.equal(status.jobs.recorded_state_only, true); assert.equal(JSON.stringify(status).includes('DO_NOT_EXPOSE_ARGUMENTS'), false);
  const output = await (await f.api('/api/job-output?job_id=' + jobId)).json() as any;
  assert.equal(output.available, true); assert.equal(output.text.includes(f.config.tunnel!.apiKey), false); assert.match(output.text, /synthetic output/);
  assert.equal(app.store.db.prepare('SELECT status FROM webcodex_jobs WHERE job_id=?').get(jobId)!.status, 'running');
  assert.deepEqual(await readFile(path.join(f.config.stateDir, 'daemon.lock')), lease);
  app.store.db.prepare('UPDATE webcodex_workspace_bindings SET workspace_uid=? WHERE binding_id=?').run('9d50b3c9-6348-409e-9a89-6379f701cb36', binding);
  const rebound = await (await f.api('/api/status')).json() as any;
  assert.equal(rebound.jobs.jobs.length, 0);
});

test('panel redacts configured keys across output chunks and clipping boundaries before returning text', async t => {
  const f = await fixture(t), app = new App(f.config); f.cleanup.push(() => app.close());
  const binding = app.identity.workspaceIdentity('default'), jobId = '564d4149-dcf3-4c5b-bb5c-976070ab0588', secret = f.config.tunnel!.apiKey;
  app.store.db.prepare(`INSERT INTO webcodex_jobs(job_id,workspace_id,workspace_binding,executable_alias,args_json,cwd,status,created_at,timeout_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(jobId, 'default', binding, 'node', '[]', '.', 'succeeded', new Date().toISOString(), 1000);
  const put = app.store.db.prepare('INSERT INTO webcodex_job_chunks(job_id,start_cursor,end_cursor,stream,text) VALUES(?,?,?,?,?)');
  put.run(jobId, 0, 10, 'stdout', 'start ' + secret.slice(0, 15)); put.run(jobId, 10, 20, 'stdout', secret.slice(15) + ' end');
  let output = await (await f.api('/api/job-output?job_id=' + jobId)).json() as any;
  assert.equal(output.text, 'start [REDACTED] end');
  app.store.db.prepare('DELETE FROM webcodex_job_chunks WHERE job_id=?').run(jobId);
  put.run(jobId, 0, 32768, 'stdout', 'x'.repeat(16370) + secret + ' end');
  output = await (await f.api('/api/job-output?job_id=' + jobId)).json() as any;
  assert.equal(output.text.includes(secret.slice(0, 10)), false);
  app.store.db.prepare('DELETE FROM webcodex_job_chunks WHERE job_id=?').run(jobId);
  put.run(jobId, 0, 100000, 'stdout', 'x'.repeat(32755) + secret + ' hidden remainder');
  put.run(jobId, 100000, 100010, 'stdout', 'do not join noncontiguous output');
  output = await (await f.api('/api/job-output?job_id=' + jobId)).json() as any;
  assert.equal(output.text.includes(secret.slice(0, 10)), false);
  assert.equal(output.text.includes('noncontiguous'), false);
});

test('a panel session token cannot be reused with another instance and shutdown closes its listener', async t => {
  const f = await fixture(t), other = await startLocalPanel(f.config, { port: 0 }); f.cleanup.push(other.close);
  assert.equal((await fetch(new URL(other.url).origin + '/api/status', { headers: { Authorization: 'Bearer ' + f.token } })).status, 401);
  await f.panel.close(); await f.panel.close(); await assert.rejects(fetch(f.origin + '/api/status'));
});

test('panel uses one history window for unmatched workspaces and preserves signed-cursor consistency', async t => {
  const f = await fixture(t, config => { config.codexSessions = { ...config.codexSessions, enabled: true, home: path.join(path.dirname(config.configPath), 'codex-history'), maxWindowsPerRequest: 4 }; });
  let calls = 0, revision = 'snapshot-a';
  const mock = t.mock.method(CodexHistory.prototype, 'list', async () => {
    calls++;
    return { sessions: [{ id: 'a3afc7e0-523a-4ad1-8df0-59118e1e065a', title: 'Only another workspace', cwd: f.root,
      createdAt: null, updatedAt: null, archived: false, source: 'sqlite', historyMode: null, historyBase: null }],
      nextOffset: calls * 20, source: 'sqlite', indexRevision: revision, warnings: [] };
  });
  try {
    const first = await f.api('/api/codex/sessions?workspace_id=readonly');
    assert.equal(first.status, 200); const partial = await first.json() as any;
    assert.deepEqual(partial.sessions, []); assert.equal(typeof partial.next_cursor, 'string');
    assert.ok(partial.warnings.includes('filtered_scan_limit_follow_next_cursor'));
    assert.equal(calls, 1, 'The panel must not inspect a second independently changing snapshot in one response.');
    assert.equal(f.config.codexSessions.maxWindowsPerRequest, 4, 'The MCP and user configuration keep their existing scan budget.');
    revision = 'snapshot-b';
    const next = await f.api('/api/codex/sessions?' + new URLSearchParams({ workspace_id: 'readonly', cursor: partial.next_cursor }));
    assert.equal(next.status, 409);
    assert.deepEqual(await next.json(), { ok: false, error: { code: 'HISTORY_INDEX_CHANGED' }, recovery: 'refresh_sessions' });
    assert.equal(calls, 2);
    const refreshed = await f.api('/api/codex/sessions?workspace_id=readonly'); assert.equal(refreshed.status, 200);
    assert.equal(calls, 3);
    await assert.rejects(readdir(f.config.stateDir), { code: 'ENOENT' });
  } finally { mock.mock.restore(); }
});

test('panel still returns twenty matching history entries and a terminal empty list without errors', async t => {
  const f = await fixture(t, config => { config.codexSessions = { ...config.codexSessions, enabled: true, home: path.join(path.dirname(config.configPath), 'codex-history') }; });
  let empty = false, calls = 0;
  const mock = t.mock.method(CodexHistory.prototype, 'list', async (input: { limit?: number }) => {
    calls++; assert.equal(input.limit, 20);
    return { sessions: empty ? [] : Array.from({ length: 20 }, (_, index) => ({ id: 'a3afc7e0-523a-4ad1-8df0-' + String(index).padStart(12, '0'), title: 'Synthetic indexed session', cwd: f.root,
      createdAt: null, updatedAt: null, archived: false, source: 'sqlite', historyMode: null, historyBase: null })),
      nextOffset: null, source: 'sqlite', indexRevision: 'stable-snapshot', warnings: [] };
  });
  try {
    const populated = await (await f.api('/api/codex/sessions?workspace_id=default')).json() as any;
    assert.equal(populated.sessions.length, 20); assert.equal(populated.next_cursor, null); assert.equal(calls, 1);
    empty = true;
    const response = await f.api('/api/codex/sessions?workspace_id=readonly'); assert.equal(response.status, 200);
    const value = await response.json() as any; assert.deepEqual(value.sessions, []); assert.equal(value.next_cursor, null); assert.equal(calls, 2);
  } finally { mock.mock.restore(); }
});

test('panel session errors expose only safe codes and preserve initial workspace identity bindings', async t => {
  const f = await fixture(t, config => { config.codexSessions = { ...config.codexSessions, enabled: true, home: path.join(path.dirname(config.configPath), 'codex-history') }; });
  const mock = t.mock.method(CodexHistory.prototype, 'list', async () => { throw new AppError('HISTORY_PATH_DENIED', 'PRIVATE_SOURCE_PATH and ' + f.raw.tunnel.apiKey); });
  const denied = await f.api('/api/codex/sessions?workspace_id=default'); assert.equal(denied.status, 422);
  assert.deepEqual(await denied.json(), { ok: false, error: { code: 'HISTORY_PATH_DENIED' }, recovery: 'check_codex_config' });
  const invalid = await f.api('/api/codex/sessions?workspace_id=default&cursor=invalid'); assert.equal(invalid.status, 409);
  assert.deepEqual(await invalid.json(), { ok: false, error: { code: 'INVALID_CURSOR' }, recovery: 'refresh_sessions' });
  mock.mock.restore();
  const replacement = t.mock.method(CodexHistory.prototype, 'list', async () => ({ sessions: [{ id: 'a3afc7e0-523a-4ad1-8df0-59118e1e065a', title: 'Old workspace session', cwd: f.root,
    createdAt: null, updatedAt: null, archived: false, source: 'sqlite', historyMode: null, historyBase: null }], nextOffset: null, source: 'sqlite', indexRevision: 'stable', warnings: [] }));
  try {
    await rename(f.root, path.join(f.directory, 'old-workspace')); await mkdir(f.root);
    const response = await f.api('/api/codex/sessions?workspace_id=default'); assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as any).sessions, [], 'The copied one-window configuration must retain the original workspace identity.');
  } finally { replacement.mock.restore(); }
});
