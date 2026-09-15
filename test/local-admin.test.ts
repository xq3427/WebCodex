import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { PanelConfigService } from '../src/panel-config.js';
import type { PanelRuntime } from '../src/panel-runtime.js';
import { startLocalPanel } from '../src/local-panel.js';

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-admin-http-'));
  const root = path.join(base, '工作区 with spaces'); await mkdir(root);
  const configPath = path.join(base, 'config.json'), raw = defaultUnifiedConfig(root, configPath);
  raw.tunnel.apiKey = 'synthetic-panel-tunnel-secret'; raw.http.bearerToken = 'synthetic-panel-http-secret';
  await writeFile(configPath, JSON.stringify(raw)); const config = await loadConfig(configPath);
  const calls: unknown[] = [];
  const runtime = { status: async () => ({ state: 'stopped', managed: false, connected: false }), action: async (input: unknown) => { calls.push(input); return { ok: true, status: { state: 'starting', managed: true, connected: false } }; } } as unknown as PanelRuntime;
  const panel = await startLocalPanel(config, { port: 0, management: { config: new PanelConfigService(configPath), runtime } });
  const launch = new URL(panel.url), origin = launch.origin, token = new URLSearchParams(launch.hash.slice(1)).get('token')!;
  t.after(async () => { await panel.close(); const target = await realpath(base); assert.equal(path.dirname(target), parent); assert.ok(path.basename(target).startsWith('webcodex-admin-http-')); await rm(target, { recursive: true, force: true }); });
  const request = (route: string, value?: unknown, headers: Record<string, string> = {}) => fetch(origin + route, {
    method: value === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(value === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return { base, root, config, configPath, raw, origin, token, panel, calls, request };
}

test('dashboard HTML is public static content while configuration remains authenticated and write-only secrets never return', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/'), html = await response.text(); assert.equal(response.status, 200);
  assert.match(html, /WebCodex/); assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.doesNotMatch(response.headers.get('content-security-policy')!, /unsafe-inline|unsafe-eval/);
  for (const secret of [f.token, f.raw.tunnel.apiKey, f.raw.http.bearerToken, f.configPath]) assert.equal(html.includes(secret), false);
  assert.equal((await fetch(f.origin + '/api/config')).status, 401);
  const config = await (await f.request('/api/config')).json() as any;
  assert.match(config.revision, /^[a-f0-9]{64}$/); assert.equal(config.secrets.tunnelApiKey, true);
  assert.equal(config.secrets.httpBearerToken, true);
  for (const secret of [f.raw.tunnel.apiKey, f.raw.http.bearerToken]) assert.equal(JSON.stringify(config).includes(secret), false);
  assert.equal((await fetch(f.origin + '/files')).status, 200);
  await assert.rejects(access(f.config.stateDir), { code: 'ENOENT' });
});

test('administrative writes require same-origin JSON even with a valid bearer token', async t => {
  const f = await fixture(t), old = await readFile(f.configPath);
  const current = await (await f.request('/api/config')).json() as any;
  const payload = { expected_revision: current.revision, patch: { device: { name: 'Should not save' } } };
  for (const route of ['/api/config/save', '/api/config/validate', '/api/runtime', '/api/access-check']) {
    const data = route === '/api/runtime' ? { action: 'restart' } : payload;
    assert.equal((await fetch(f.origin + route, { method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).status, 403);
    assert.equal((await f.request(route, data, { Origin: 'https://unrelated.invalid' })).status, 403);
    assert.equal((await f.request(route, data, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await f.request(route, data, { 'Content-Type': 'text/plain' })).status, 415);
  }
  assert.deepEqual(await readFile(f.configPath), old); assert.deepEqual(f.calls, []);
});

test('authenticated access check proves real write-read-delete capability without leaving a file behind', async t => {
  const f = await fixture(t), before = await readFile(f.configPath);
  const response = await f.request('/api/access-check', {}); assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as any;
  assert.equal(result.execution.status, 'disabled');
  assert.equal(result.workspaces[0].status, 'passed');
  assert.equal(result.workspaces[0].write_probe, 'created-read-verified-deleted');
  assert.equal(result.ok, true); assert.equal(result.full_access_ready, false, 'The file probe passes, but full access also requires command execution.');
  assert.deepEqual(await readFile(f.configPath), before);
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('webcodex-access-check-')), []);
  assert.equal((await f.request('/api/access-check', { unexpected: true })).status, 400);
});

test('administrative writes accept localhost Origin when the panel is reached through a loopback alias', async t => {
  const f = await fixture(t);
  const localhostOrigin = f.origin.replace('127.0.0.1', 'localhost');
  const before = await readFile(f.configPath);
  const current = await (await f.request('/api/config')).json() as any;
  const payload = { expected_revision: current.revision, patch: { device: { name: 'localhost 管理页面' } } };
  const response = await fetch(f.origin + '/api/config/validate', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + f.token,
      Origin: localhostOrigin,
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await readFile(f.configPath), before, 'Validation remains write-free.');
});

test('dashboard validates without writing, saves with CAS, retains secrets, and refreshes the local viewing snapshot', async t => {
  const f = await fixture(t), old = await readFile(f.configPath);
  const current = await (await f.request('/api/config')).json() as any;
  const payload = { expected_revision: current.revision, patch: { device: { name: '实验室 · 工作电脑' } } };
  const validation = await f.request('/api/config/validate', payload); assert.equal(validation.status, 200, await validation.clone().text());
  assert.deepEqual(await readFile(f.configPath), old);
  const response = await f.request('/api/config/save', payload); assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json() as any; assert.equal(saved.restart_required, true); assert.equal(saved.viewer_refreshed, true);
  assert.notEqual(saved.revision, current.revision);
  const raw = JSON.parse(await readFile(f.configPath, 'utf8')); assert.equal(raw.device.name, '实验室 · 工作电脑');
  assert.equal(raw.tunnel.apiKey, f.raw.tunnel.apiKey); assert.equal(raw.http.bearerToken, f.raw.http.bearerToken);
  const status = await (await f.request('/api/status')).json() as any; assert.equal(status.device.name, raw.device.name);
  assert.equal(status.settings_snapshot, 'saved_local_config_not_running_service');
  assert.equal((await f.request('/api/config/save', payload)).status, 409);
  assert.deepEqual(f.calls, [], 'Saving configuration alone does not restart or broaden a live service.');
});

test('secret replacement stays out of success/error responses and logs', async t => {
  const f = await fixture(t), current = await (await f.request('/api/config')).json() as any;
  const replacement = 'synthetic-new-private-panel-key';
  const response = await f.request('/api/config/save', { expected_revision: current.revision, patch: {}, secrets: { tunnelApiKey: replacement } });
  assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.text()).includes(replacement), false);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).tunnel.apiKey, replacement);
  const bad = await f.request('/api/config/save', { expected_revision: current.revision, patch: {}, secrets: { tunnelApiKey: replacement + '\n' } });
  assert.notEqual(bad.status, 200); const output = await bad.text(); assert.equal(output.includes(replacement), false); assert.doesNotMatch(output, /stack|arguments/);
});

test('runtime route passes only enumerated actions with expected revision, rejects shell-like and unknown inputs', async t => {
  const f = await fixture(t), current = await (await f.request('/api/config')).json() as any;
  assert.equal((await f.request('/api/runtime')).status, 200);
  const action = { action: 'start', expected_revision: current.revision };
  assert.equal((await f.request('/api/runtime', action)).status, 200); assert.deepEqual(f.calls, [action]);
  for (const bad of [{ action: 'start; whoami' }, { action: 'restart', command: 'anything' }, { action: 'stop', expected_revision: 'stale' }]) assert.equal((await f.request('/api/runtime', bad)).status, 400);
  assert.deepEqual(f.calls, [action]);
  assert.equal((await f.request('/api/runtime?extra=1', { action: 'stop' })).status, 404);
});

test('configuration API rejects oversized input and privileged identity/path overrides without modifying selected file', async t => {
  const f = await fixture(t), current = await (await f.request('/api/config')).json() as any, before = await readFile(f.configPath);
  const large = await f.request('/api/config/save', { expected_revision: current.revision, patch: { device: { name: 'x'.repeat(262144) } } }); assert.equal(large.status, 413);
  for (const patch of [{ stateDir: f.root }, { device: { id: 'changed' } }, { configPath: '/unrelated' }, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    const response = await f.request('/api/config/save', { expected_revision: current.revision, patch }); assert.notEqual(response.status, 200);
  }
  assert.deepEqual(await readFile(f.configPath), before); assert.equal(({} as any).polluted, undefined);
});

test('configuration API returns actionable fields and safe Chinese reasons from both request and complete config validation',async t=>{
  const f=await fixture(t),current=await(await f.request('/api/config')).json() as any,before=await readFile(f.configPath);
  for(const route of ['/api/config/validate','/api/config/save']) {
    const response=await f.request(route,{expected_revision:current.revision,patch:{localPanel:{port:80},tunnel:{clientSha256:'synthetic-private-invalid-hash'}}});
    assert.equal(response.status,422);const invalid=await response.json() as any;
    // Request-shape errors are specific even when other fields must await full validation.
    assert.deepEqual(invalid.error.fields,['tunnel.clientSha256']);
    assert.equal(invalid.error.issues[0].field,'tunnel.clientSha256');assert.match(invalid.error.issues[0].message,/64/);
    assert.equal(JSON.stringify(invalid).includes('synthetic-private'),false);
    const range=await f.request(route,{expected_revision:current.revision,patch:{localPanel:{port:80}}});
    const bounds=await range.json() as any;assert.deepEqual(bounds.error.fields,['localPanel.port']);assert.match(bounds.error.issues[0].message,/1024–65535/);
    const auth=await f.request(route,{expected_revision:current.revision,patch:{server:{transport:'http'}}});
    const required=await auth.json() as any;assert.equal(required.error.code,'CONFIG_ERROR');assert.deepEqual(required.error.fields,['secrets.httpBearerToken']);assert.match(required.error.issues[0].message,/32/);
    const badKey=await f.request(route,{expected_revision:current.revision,patch:{tunnel:{'synthetic-private-property':'synthetic-private-value'}}});
    const unknown=await badKey.json() as any;assert.deepEqual(unknown.error.fields,['tunnel']);assert.equal(JSON.stringify(unknown).includes('synthetic-private'),false);
  }
  assert.deepEqual(await readFile(f.configPath),before);assert.deepEqual(f.calls,[]);
});
