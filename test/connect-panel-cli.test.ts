import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { PanelRuntime } from '../src/panel-runtime.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function occupy(port = 0) {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: (server.address() as { port: number }).port, connections: () => connections, listening: () => server.listening,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function freePort() { const listener = await occupy(); const port = listener.port; await listener.close(); return port; }
async function fixture() {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-connect-panel-'));
  const root = path.join(base, '中文 project'); await mkdir(root);
  const configPath = path.join(base, 'config.json');
  const raw = { ...defaultUnifiedConfig(root, configPath), server: { transport: 'http' as const } };
  raw.nodePath = process.execPath;
  raw.http.port = await freePort(); raw.localPanel.port = await freePort();
  raw.http.bearerToken = 'synthetic-connect-panel-http-token-123456789'; raw.tunnel.apiKey = 'synthetic-connect-panel-tunnel-key';
  const save = () => writeFile(configPath, JSON.stringify(raw), { mode: 0o600 }); await save();
  return { base, configPath, raw, save, clean: async () => {
    const target = await realpath(base); assert.equal(path.dirname(target), parent); assert.match(path.basename(target), /^webcodex-connect-panel-/);
    await rm(target, { recursive: true, force: true });
  } };
}
async function start(configPath: string) {
  // Simulated terminal Ctrl+C stays portable without forcibly killing a healthy Windows child.
  const bootstrap = "import { pathToFileURL } from 'node:url'; const target=process.argv.splice(1,1)[0]; process.stdin.once('data',()=>{process.stdin.pause();process.emit('SIGINT');}); await import(pathToFileURL(target).href);";
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap, '--', cli, 'connect', '--config', configPath],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', bytes => { out += bytes.toString(); }); child.stderr.on('data', bytes => { err += bytes.toString(); });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try {
    const deadline = Date.now() + 15000;
    let match: RegExpMatchArray | null = null;
    while (!(match = err.match(/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/m)) && Date.now() < deadline) {
      assert.equal(child.exitCode, null, 'connect must remain available until its private link is reported'); await delay(30);
    }
    assert.ok(match, 'connect must print a standalone private local URL');
    const url = new URL(match[0]), token = new URLSearchParams(url.hash.slice(1)).get('token')!;
    const api = async (route: string, body?: unknown) => {
      const response = await fetch(url.origin + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { Origin: url.origin, 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    const waitRuntime = async (predicate: (status: any) => boolean) => {
      const until = Date.now() + 15000; let status;
      do { status = (await api('/api/runtime')).body; if (predicate(status)) return status; await delay(40); } while (Date.now() < until);
      assert.fail('Managed runtime failed to reach expected state: ' + JSON.stringify(status));
    };
    return { url, api, waitRuntime, output: () => out + err, stdout: () => out, stop: async () => {
      child.stdin.end('stop'); const timer = setTimeout(() => child.kill(), 15000);
      try { assert.equal(await closed, 0, 'connect should shut down normally'); } finally { clearTimeout(timer); }
    } };
  } catch (error) { child.kill(); await closed; throw error; }
}

test('connect prints an authenticated link and manages the same HTTP service across save/restart and shutdown', async () => {
  const f = await fixture(); let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    // A shared configured port must not let the page steal the MCP listener.
    f.raw.localPanel.port = f.raw.http.port; await f.save();
    running = await start(f.configPath);
    assert.notEqual(running.url.port, String(f.raw.http.port));
    assert.equal((await fetch(running.url.origin + '/api/config')).status, 401);
    const ready = await running.waitRuntime(s => s.managed && s.connected && s.transport === 'http');
    const config = (await running.api('/api/config')).body; assert.equal(config.revision, ready.loaded_revision);
    assert.equal(JSON.stringify(config).includes(f.raw.tunnel.apiKey), false);
    assert.equal(JSON.stringify(config).includes(f.raw.http.bearerToken), false);
    const saved = await running.api('/api/config/save', { expected_revision: config.revision, patch: { device: { name: 'Saved through connect dashboard' } } });
    assert.equal(saved.status, 200);
    const updated = (await running.api('/api/config')).body;
    assert.notEqual(updated.revision, config.revision);
    assert.equal((await running.api('/api/runtime', { action: 'restart', expected_revision: updated.revision })).status, 200);
    await running.waitRuntime(s => s.managed && s.connected && s.loaded_revision === updated.revision);
    assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).device.name, 'Saved through connect dashboard');
    assert.equal((await fetch(`http://127.0.0.1:${f.raw.http.port}/healthz`)).status, 200);
    assert.equal((running.output().match(/^http:\/\/127\.0\.0\.1:\d+\/#token=/gm) ?? []).length, 1);
    assert.equal(running.stdout(), '');
    assert.doesNotMatch(running.output(), /OpenAI polling is current|synthetic-connect-panel-(?:http|tunnel)/);
    await running.stop(); running = undefined;
    const configAfter = await loadConfig(f.configPath);
    await assert.rejects(access(path.join(configAfter.stateDir, 'daemon.lock')), { code: 'ENOENT' });
  } finally { if (running) await running.stop(); await f.clean(); }
});

test('connect chooses a free local panel port without touching the occupied listener or saved configuration', async () => {
  const f = await fixture(), occupied = await occupy(); let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    f.raw.localPanel.port = occupied.port; await f.save(); const before = await readFile(f.configPath, 'utf8');
    running = await start(f.configPath); assert.notEqual(running.url.port, String(occupied.port));
    await running.waitRuntime(s => s.managed && s.connected);
    assert.equal(occupied.listening(), true); assert.equal(occupied.connections(), 0);
    assert.equal(await readFile(f.configPath, 'utf8'), before);
  } finally { if (running) await running.stop(); await occupied.close(); await f.clean(); }
});

test('connect preserves the authenticated dashboard after startup failure and supports a later successful retry', async () => {
  const f = await fixture(), occupied = await occupy(f.raw.http.port); let occupiedOpen = true;
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    running = await start(f.configPath);
    const failed = await running.waitRuntime(s => s.state === 'failed' && !s.managed);
    assert.equal(failed.connected, false); assert.ok(failed.error_code);
    assert.equal((await running.api('/api/config')).status, 200);
    await occupied.close(); occupiedOpen = false;
    const config = (await running.api('/api/config')).body;
    assert.equal((await running.api('/api/runtime', { action: 'start', expected_revision: config.revision })).status, 200);
    await running.waitRuntime(s => s.managed && s.connected);
    assert.equal((running.output().match(/^http:\/\/127\.0\.0\.1:\d+\/#token=/gm) ?? []).length, 1);
  } finally { if (running) await running.stop(); if (occupiedOpen) await occupied.close(); await f.clean(); }
});

test('connect gives a useful link when an external service exists and never takes control of it', async () => {
  const f = await fixture(), external = new PanelRuntime(f.configPath); let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    await external.action({ action: 'start' });
    const deadline = Date.now() + 15000;
    while (!(await external.status()).connected && Date.now() < deadline) await delay(40);
    assert.equal((await external.status()).connected, true);
    running = await start(f.configPath);
    const status = await running.waitRuntime(s => s.state === 'external'); assert.equal(status.managed, false);
    assert.equal((await running.api('/api/runtime', { action: 'stop' })).body.ok, false);
    await running.stop(); running = undefined;
    assert.equal((await external.status()).connected, true);
  } finally { if (running) await running.stop(); await external.close(); await f.clean(); }
});
