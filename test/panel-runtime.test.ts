import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, writeFile, readFile, rm, access, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { defaultConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { PanelRuntime, inspectPanelRuntime, runPanelHttp, type PanelRuntimeInspection } from '../src/panel-runtime.js';
import { runTunnel, type TunnelRunOptions, type TunnelRunResult } from '../src/tunnel.js';

const revisionA = 'a'.repeat(64), revisionB = 'b'.repeat(64);
const result: TunnelRunResult = { doctor_only: false, exit_code: 0, health_url_file: '', client_source: 'configured_sha256' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(options: { shutdownTimeoutMs?: number; abortDelay?: number } = {}) {
  const configPath = path.join(tmpdir(), 'synthetic-runtime-config.json');
  const config = { ...defaultConfig(tmpdir(), configPath), configPath };
  let revision = revisionA, started = 0, stopped = 0, simultaneous = 0, maxSimultaneous = 0;
  let inspection: PanelRuntimeInspection = { external: false, activeJobs: 0 };
  let onAbort: (() => void) | undefined;
  const observed: string[] = [];
  const runtime = new PanelRuntime(configPath, {
    load: async () => ({ config, revision }), inspect: async () => inspection,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    run: async (loaded, opts) => {
      assert.notEqual(loaded, config); assert.equal(opts.registerSignalHandlers, false);
      started++; simultaneous++; maxSimultaneous = Math.max(maxSimultaneous, simultaneous);
      observed.push(loaded.device?.name ?? 'default');
      opts.onProgress?.({ type: 'phase', phase: 'doctor' });
      await tick();
      opts.onProgress?.({ type: 'phase', phase: 'starting' });
      return new Promise<TunnelRunResult>((resolve, reject) => {
        onAbort = () => {
          opts.signal?.removeEventListener('abort', aborted);
          stopped++; simultaneous--;
          reject(new AppError('TUNNEL_CANCELLED', 'synthetic secret should never appear'));
        };
        const aborted = () => { if (options.abortDelay === undefined) onAbort!(); else setTimeout(() => onAbort!(), options.abortDelay); };
        opts.signal?.addEventListener('abort', aborted, { once: true });
        if (opts.signal?.aborted) aborted();
      });
    },
  });
  return { runtime, config, observed, counters: () => ({ started, stopped, simultaneous, maxSimultaneous }),
    setRevision: (value: string) => { revision = value; }, setInspection: (value: PanelRuntimeInspection) => { inspection = value; },
    finish: () => onAbort?.() };
}

test('panel runtime serializes and coalesces concurrent restart without overlapping owned clients', async () => {
  const h = harness({ abortDelay: 20 });
  try {
    await h.runtime.action({ action: 'start', expected_revision: revisionA });
    await tick();
    h.setRevision(revisionB);
    assert.equal((await h.runtime.status()).restart_required, true);
    const first = h.runtime.action({ action: 'restart', expected_revision: revisionB });
    const second = h.runtime.action({ action: 'restart', expected_revision: revisionB });
    assert.equal(first, second);
    const receipt = await first;
    assert.equal(receipt.ok, true);
    assert.equal(receipt.status.loaded_revision, revisionB);
    assert.equal(receipt.status.restart_required, false);
    assert.deepEqual(h.counters(), { started: 2, stopped: 1, simultaneous: 1, maxSimultaneous: 1 });
    await h.runtime.action({ action: 'stop' });
    assert.equal((await h.runtime.status()).state, 'stopped');
  } finally { await h.runtime.close(); }
});

test('panel runtime never controls an existing external launcher, including after a failed run', async () => {
  const h = harness();
  h.setInspection({ external: true, activeJobs: 0, connected: true });
  for (const action of ['start', 'stop', 'restart'] as const) await assert.rejects(h.runtime.action({ action }), { code: 'PANEL_EXTERNAL_SERVICE' });
  const status = await h.runtime.status();
  assert.equal(status.state, 'external'); assert.equal(status.managed, false);
  assert.equal(status.needs_one_time_handoff, true); assert.equal(status.connected, true);
  await h.runtime.close();
  assert.equal(h.counters().started, 0);

  let external = false;
  const failed = new PanelRuntime('synthetic', {
    load: async () => ({ config: h.config, revision: revisionA }),
    inspect: async () => ({ external, activeJobs: 0 }),
    run: async () => { throw new Error('synthetic-api-key-in-raw-error'); },
  });
  await failed.action({ action: 'start' }); await tick();
  const failure = await failed.status();
  assert.equal(failure.state, 'failed'); assert.equal(failure.error_code, 'PANEL_RUNTIME_FAILED');
  assert.equal(JSON.stringify(failure).includes('synthetic-api-key'), false);
  external = true;
  assert.equal((await failed.status()).state, 'external');
  external = false;
  await failed.close();
});

test('active and unverifiable jobs prevent stop, restart and close without signalling the run', async () => {
  const h = harness();
  await h.runtime.action({ action: 'start' }); await tick();
  try {
    for (const count of [2, null]) {
      h.setInspection({ external: true, activeJobs: count });
      const code = count === null ? 'PANEL_JOBS_UNVERIFIED' : 'PANEL_JOBS_ACTIVE';
      await assert.rejects(h.runtime.action({ action: 'stop' }), { code });
      await assert.rejects(h.runtime.action({ action: 'restart' }), { code });
      await assert.rejects(h.runtime.close(), { code });
      assert.equal(h.counters().stopped, 0);
      assert.equal((await h.runtime.status()).managed, true);
    }
  } finally { h.setInspection({ external: true, activeJobs: 0 }); await h.runtime.close(); }
  assert.equal(h.counters().stopped, 1);
  await assert.rejects(h.runtime.action({ action: 'start' }), { code: 'PANEL_CLOSED' });
});

test('stale configuration revisions never stop the owned service', async () => {
  const h = harness();
  try {
    await h.runtime.action({ action: 'start' }); await tick();
    h.setRevision(revisionB);
    await assert.rejects(h.runtime.action({ action: 'restart', expected_revision: revisionA }), { code: 'CONFIG_CONFLICT' });
    assert.equal(h.counters().stopped, 0);
  } finally { await h.runtime.close(); }
});

test('stopping an owned run still works after an invalid manual config edit, and loader errors are sanitized', async () => {
  const config = { ...defaultConfig(tmpdir(), path.join(tmpdir(), 'config.json')), configPath: path.join(tmpdir(), 'config.json') };
  let invalid = false, stops = 0;
  const runtime = new PanelRuntime(config.configPath, {
    load: async () => { if (invalid) throw new Error('synthetic-private-config-value'); return { config, revision: revisionA }; },
    inspect: async () => ({ external: false, activeJobs: 0 }),
    run: async (_config, options) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => { stops++; reject(new AppError('TUNNEL_CANCELLED', 'cancelled')); }, { once: true });
    }),
  });
  try {
    await runtime.action({ action: 'start' }); invalid = true;
    await assert.rejects(runtime.action({ action: 'restart' }), (error: unknown) => error instanceof AppError &&
      error.code === 'PANEL_RUNTIME_FAILED' && !error.message.includes('synthetic-private-config-value'));
    const stopped = await runtime.action({ action: 'stop' });
    assert.equal(stopped.ok, true); assert.equal(stopped.status.managed, false); assert.equal(stops, 1);
  } finally { await runtime.close(); }
});

test('configuration changes during shutdown leave the service stopped until a new restart request', async () => {
  const h = harness({ abortDelay: 30 });
  try {
    await h.runtime.action({ action: 'start' }); await tick();
    const restart = h.runtime.action({ action: 'restart', expected_revision: revisionA });
    await tick(); h.setRevision(revisionB);
    await assert.rejects(restart, { code: 'CONFIG_CONFLICT' });
    assert.equal(h.counters().started, 1); assert.equal(h.counters().stopped, 1);
    assert.equal((await h.runtime.status()).state, 'stopped');
  } finally { await h.runtime.close(); }
});

test('shutdown timeout retains ownership and never starts a replacement client', async () => {
  const h = harness({ shutdownTimeoutMs: 5, abortDelay: 80 });
  try {
    await h.runtime.action({ action: 'start' }); await tick();
    await assert.rejects(h.runtime.action({ action: 'restart' }), { code: 'PANEL_STOP_TIMEOUT' });
    const status = await h.runtime.status();
    assert.equal(status.state, 'stopping'); assert.equal(status.managed, true);
    assert.equal(h.counters().started, 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await h.runtime.status()).state, 'stopped');
  } finally { await h.runtime.close(); }
});

test('runtime inspection reads all active job counts without modifying SQLite, locks, or recovery state', async () => {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'webcodex-runtime-readonly-'));
  try {
    const config = { ...defaultConfig(base, path.join(base, 'config.json')), configPath: path.join(base, 'config.json'), stateDir: path.join(base, 'state') };
    await mkdir(path.join(config.stateDir, 'tunnel'), { recursive: true });
    const lock = path.join(config.stateDir, 'tunnel', 'launcher.lock');
    await writeFile(lock, 'synthetic-external-lock');
    const database = path.join(config.stateDir, 'webcodex.sqlite');
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE webcodex_jobs(status TEXT); INSERT INTO webcodex_jobs VALUES('running'),('queued'),('finished');"); db.close();
    const before = await readFile(database);
    const observation = await inspectPanelRuntime(config);
    assert.equal(observation.external, true); assert.equal(observation.activeJobs, 2);
    assert.deepEqual(await readFile(database), before);
    assert.equal(await readFile(lock, 'utf8'), 'synthetic-external-lock');
    await assert.rejects(access(path.join(config.stateDir, 'owner.sqlite')), { code: 'ENOENT' });
    await rm(lock);
    const daemonLock = path.join(config.stateDir, 'daemon.lock');
    await writeFile(daemonLock, 'synthetic-independent-daemon-lock');
    const directDaemon = await inspectPanelRuntime(config);
    assert.equal(directDaemon.external, true);
    assert.equal(await readFile(daemonLock, 'utf8'), 'synthetic-independent-daemon-lock');
    await writeFile(database, 'incompatible database');
    assert.equal((await inspectPanelRuntime(config)).activeJobs, null);
  } finally { assert.match(path.basename(base), /^webcodex-runtime-readonly-/); await rm(base, { recursive: true, force: true }); }
});

async function nativeFixture() {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'webcodex-runtime-child-'));
  const configPath = path.join(base, 'config.json');
  const client = path.join(base, process.platform === 'win32' ? 'synthetic-client.exe' : 'synthetic-client');
  await copyFile(process.execPath, client);
  const config = { ...defaultConfig(base, configPath), configPath, stateDir: path.join(base, 'state'), nodePath: process.execPath,
    server: { transport: 'stdio' as const }, tunnel: { enabled: true, id: 'tunnel_synthetic_cancel_test', apiKey: 'synthetic-key', proxyUrl: '',
      clientPath: client, clientVersion: 'auto', clientSha256: createHash('sha256').update(await readFile(client)).digest('hex') } };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(base, 'package.json'), '{"type":"commonjs"}');
  const program = `const fs=require('node:fs');const path=require('node:path');const phase=path.basename(process.argv[1]);fs.appendFileSync(path.join(__dirname,'started.log'),phase+'\\n');if(fs.readFileSync(path.join(__dirname,'block-phase'),'utf8')===phase){setInterval(()=>fs.appendFileSync(path.join(__dirname,'pulse.log'),phase+'\\n'),15);}else{process.exit(0);}`;
  await writeFile(path.join(base, 'doctor'), program); await writeFile(path.join(base, 'run'), program);
  return { base, config, clean: async () => { assert.match(path.basename(base), /^webcodex-runtime-child-/); await rm(base, { recursive: true, force: true }); } };
}

async function waitForFileText(file: string, text: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await readFile(file, 'utf8')).includes(text)) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('synthetic child did not reach the expected phase');
}

test('AbortSignal terminates the verified synthetic child in doctor and run and releases only its own lock', async () => {
  const f = await nativeFixture();
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  try {
    for (const phase of ['doctor', 'run']) {
      await writeFile(path.join(f.base, 'started.log'), ''); await writeFile(path.join(f.base, 'pulse.log'), '');
      await writeFile(path.join(f.base, 'block-phase'), phase);
      const controller = new AbortController();
      const running = runTunnel(f.config, { signal: controller.signal, registerSignalHandlers: false });
      const rejected = assert.rejects(running, { code: 'TUNNEL_CANCELLED' });
      try {
        await waitForFileText(path.join(f.base, 'pulse.log'), phase);
        assert.equal(process.listenerCount('SIGINT'), beforeInt); assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
      } finally { controller.abort(); }
      await rejected;
      const pulse = await readFile(path.join(f.base, 'pulse.log'), 'utf8');
      await new Promise(resolve => setTimeout(resolve, 70));
      assert.equal(await readFile(path.join(f.base, 'pulse.log'), 'utf8'), pulse, 'owned child must have stopped writing');
      await assert.rejects(access(path.join(f.config.stateDir, 'tunnel', 'launcher.lock')), { code: 'ENOENT' });
      if (phase === 'doctor') assert.equal(await readFile(path.join(f.base, 'started.log'), 'utf8'), 'doctor\n');
    }
    const preAborted = new AbortController(); preAborted.abort();
    const before = await readFile(path.join(f.base, 'started.log'), 'utf8');
    await assert.rejects(runTunnel(f.config, { signal: preAborted.signal, registerSignalHandlers: false }), { code: 'TUNNEL_CANCELLED' });
    assert.equal(await readFile(path.join(f.base, 'started.log'), 'utf8'), before);
    const beforeDoctor = new AbortController();
    await assert.rejects(runTunnel(f.config, { signal: beforeDoctor.signal, registerSignalHandlers: false,
      onProgress: event => { if (event.type === 'phase' && event.phase === 'doctor') beforeDoctor.abort(); } }), { code: 'TUNNEL_CANCELLED' });
    assert.equal(await readFile(path.join(f.base, 'started.log'), 'utf8'), before, 'abort before spawn must not launch doctor');
    await assert.rejects(access(path.join(f.config.stateDir, 'tunnel', 'launcher.lock')), { code: 'ENOENT' });
    await writeFile(path.join(f.base, 'started.log'), '');
    await writeFile(path.join(f.base, 'block-phase'), 'none');
    const revision = createHash('sha256').update(await readFile(f.config.configPath)).digest('hex');
    await assert.rejects(runTunnel(f.config, { expectedConfigRevision: revision, registerSignalHandlers: false,
      onProgress: event => { if (event.type === 'phase' && event.phase === 'starting') appendFileSync(f.config.configPath, ' '); } }), { code: 'CONFIG_CONFLICT' });
    assert.equal(await readFile(path.join(f.base, 'started.log'), 'utf8'), 'doctor\n', 'changed configuration must not reach the run child');
    await assert.rejects(access(path.join(f.config.stateDir, 'tunnel', 'launcher.lock')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('managed HTTP child cooperatively exits over private IPC, including stop before ready, with no credential environment', async () => {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'webcodex-runtime-http-'));
  try {
    const configPath = path.join(base, 'config.json');
    const config = { ...defaultConfig(base, configPath), configPath, stateDir: path.join(base, 'state'), server: { transport: 'http' as const } };
    await mkdir(config.stateDir); await writeFile(configPath, JSON.stringify(config));
    await writeFile(path.join(base, 'package.json'), '{"type":"commonjs"}');
    const entryPoint = path.join(base, 'synthetic-http.js');
    await writeFile(entryPoint, `const fs=require('node:fs');const path=require('node:path');const root=__dirname;
      const lock=path.join(root,'state','daemon.lock');fs.writeFileSync(lock,'synthetic-owned');
      fs.writeFileSync(path.join(root,'child-check.json'),JSON.stringify({hasIpc:process.connected,hasLegacyKey:Boolean(process.env.OPENAI_API_KEY||process.env.CONTROL_PLANE_API_KEY),revision:process.env.WEBCODEX_PANEL_CONFIG_REVISION,args:process.argv.slice(2)}));
      process.on('message',message=>{if(message&&message.type==='webcodex_panel_shutdown'){fs.writeFileSync(path.join(root,'cooperative-stop'),'done');fs.unlinkSync(lock);process.disconnect();}});
      process.on('disconnect',()=>{try{fs.unlinkSync(lock);}catch{}});
      setTimeout(()=>process.send({type:'webcodex_panel_ready'}),60);`);
    const revision = createHash('sha256').update(await readFile(configPath)).digest('hex');
    const controller = new AbortController();
    const running = runPanelHttp(config, { entryPoint, expectedConfigRevision: revision, signal: controller.signal });
    const rejected = assert.rejects(running, { code: 'TUNNEL_CANCELLED' });
    try {
      await waitForFileText(path.join(base, 'child-check.json'), 'hasIpc');
      controller.abort(); await rejected;
    } finally { controller.abort(); }
    const observed = JSON.parse(await readFile(path.join(base, 'child-check.json'), 'utf8'));
    assert.equal(observed.hasIpc, true); assert.equal(observed.hasLegacyKey, false); assert.equal(observed.revision, revision);
    assert.deepEqual(observed.args, ['serve', '--config', configPath, '--transport', 'http']);
    assert.equal(await readFile(path.join(base, 'cooperative-stop'), 'utf8'), 'done');
    await assert.rejects(access(path.join(config.stateDir, 'daemon.lock')), { code: 'ENOENT' });
  } finally { assert.match(path.basename(base), /^webcodex-runtime-http-/); await rm(base, { recursive: true, force: true }); }
});
