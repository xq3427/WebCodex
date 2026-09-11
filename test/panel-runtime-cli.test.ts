import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { PanelRuntime, type PanelRuntimeStatus } from '../src/panel-runtime.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function fixture() {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'webcodex-panel-cli-'));
  const root = path.join(base, 'project'); await mkdir(root);
  const configPath = path.join(base, 'config.json');
  const defaults = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic panel device' });
  const raw = { ...defaults, execution: { ...defaults.execution, mode: 'trusted-host' as const },
    server: { transport: 'http' as const }, http: { port: await freePort(), bearerToken: 'synthetic-http-token-for-private-panel-tests-only' } };
  await writeFile(configPath, JSON.stringify(raw), { mode: 0o600 });
  const revision = () => readFile(configPath).then(bytes => createHash('sha256').update(bytes).digest('hex'));
  return { base, configPath, raw, revision, config: await loadConfig(configPath),
    clean: async () => { assert.match(path.basename(base), /^webcodex-panel-cli-/); await rm(base, { recursive: true, force: true }); } };
}

async function waitFor(manager: PanelRuntime, condition: (status: PanelRuntimeStatus) => boolean) {
  let status = await manager.status();
  const deadline = Date.now() + 15000;
  while (!condition(status) && Date.now() < deadline) { await delay(40); status = await manager.status(); }
  assert.ok(condition(status), 'Expected managed service state: ' + JSON.stringify(status));
  return status;
}

function data(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.notEqual(result.isError, true, 'synthetic MCP tool must succeed');
  const content = result.structuredContent as { ok?: boolean; data?: Record<string, any> } | undefined;
  assert.equal(content?.ok, true); assert.ok(content?.data);
  return content.data;
}

test('actual CLI HTTP service starts, rejects active-job restart, reloads the saved revision, and releases its state lease', async () => {
  const f = await fixture(), manager = new PanelRuntime(f.configPath);
  const client = new Client({ name: 'panel-runtime-real-cli', version: '1' });
  let jobId: string | undefined;
  const finishJob = async () => {
    if (!jobId) return;
    data(await client.callTool({ name: 'exec_write_stdin', arguments: { workspace_id: 'default', expected_device_id: f.raw.device.id,
      job_id: jobId, end: true, idempotency_key: 'finish-synthetic-panel-job' } }));
    for (let attempt = 0; attempt < 100; attempt++) {
      const polled = data(await client.callTool({ name: 'exec_poll', arguments: { workspace_id: 'default', job_id: jobId } }));
      if (!['queued', 'running'].includes(polled.status)) { assert.equal(polled.exit_code, 0); jobId = undefined; return; }
      await delay(20);
    }
    assert.fail('Synthetic stdin job did not finish');
  };
  try {
    const original = await f.revision();
    await manager.action({ action: 'start', expected_revision: original });
    const ready = await waitFor(manager, status => status.managed && status.connected && status.state === 'running');
    assert.equal(ready.transport, 'http'); assert.equal(ready.loaded_revision, original);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.raw.http.port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer ' + f.raw.http.bearerToken } },
    }));
    const started = data(await client.callTool({ name: 'exec_start', arguments: { workspace_id: 'default', expected_device_id: f.raw.device.id,
      executable: 'node', args: ['-e', "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));"], stdin: 'pipe', timeout_ms: 20000,
      idempotency_key: 'synthetic-panel-job' } }));
    jobId = String(started.job_id);
    await waitFor(manager, status => status.active_jobs === 1);
    await assert.rejects(manager.action({ action: 'restart', expected_revision: original }), { code: 'PANEL_JOBS_ACTIVE' });
    assert.equal((await manager.status()).connected, true);
    await finishJob(); await client.close();
    f.raw.device.name = 'Synthetic restarted device'; await writeFile(f.configPath, JSON.stringify(f.raw));
    const updated = await f.revision();
    assert.equal((await manager.status()).restart_required, true);
    await manager.action({ action: 'restart', expected_revision: updated });
    const restarted = await waitFor(manager, status => status.managed && status.connected && status.loaded_revision === updated);
    assert.equal(restarted.restart_required, false);
    await manager.action({ action: 'stop' });
    const stopped = await manager.status(); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.managed, false);
    await assert.rejects(access(path.join(f.config.stateDir, 'daemon.lock')), { code: 'ENOENT' });
    const lease = new DatabaseSync(path.join(f.config.stateDir, 'owner.sqlite'));
    try { lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK;'); } finally { lease.close(); }
  } finally {
    try { await finishJob(); } finally { await client.close(); await manager.close(); await f.clean(); }
  }
});

test('actual CLI HTTP startup failure exits its IPC child instead of leaving a stuck managed process', async () => {
  const f = await fixture();
  const occupied = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen(f.raw.http.port, '127.0.0.1', resolve); });
  const manager = new PanelRuntime(f.configPath);
  try {
    await manager.action({ action: 'start', expected_revision: await f.revision() });
    const failure = await waitFor(manager, status => status.state === 'failed' && !status.managed);
    assert.ok(['HTTP_START_FAILED', 'PANEL_RUNTIME_FAILED', 'PANEL_SERVICE_EXITED'].includes(failure.error_code ?? ''));
    await assert.rejects(access(path.join(f.config.stateDir, 'daemon.lock')), { code: 'ENOENT' });
  } finally { await manager.close(); await new Promise<void>(resolve => occupied.close(() => resolve())); await f.clean(); }
});

test('actual CLI rejects a mismatched IPC configuration revision and closes before serving', async () => {
  const f = await fixture();
  try {
    const outcome = await new Promise<{ code: number | null; messages: unknown[] }>((resolve, reject) => {
      const allowed = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ']);
      const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())));
      const child = spawn(process.execPath, [cliPath, 'serve', '--config', f.configPath, '--transport', 'http'], {
        cwd: f.base, env: { ...childEnvironment, WEBCODEX_PANEL_CONFIG_REVISION: '0'.repeat(64) }, shell: false, windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const messages: unknown[] = [];
      const timer = setTimeout(() => { if (child.connected) child.disconnect(); reject(new Error('Synthetic IPC failure did not exit')); }, 15000);
      child.on('message', message => messages.push(message));
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, messages }); });
    });
    assert.equal(outcome.code, 1);
    assert.deepEqual(outcome.messages, [{ type: 'webcodex_panel_failed', code: 'CONFIG_CONFLICT' }]);
    await assert.rejects(access(path.join(f.config.stateDir, 'daemon.lock')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});
