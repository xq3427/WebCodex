import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { AppError } from './errors.js';
import { validateConfig } from './config.js';
import { assertTunnelConfigRevision, readTunnelStatus, runTunnel, type TunnelProgressEvent, type TunnelRunOptions } from './tunnel.js';
import type { AppConfig } from './types.js';

export interface PanelRuntimeSnapshot { config: AppConfig; revision: string }
export interface PanelRuntimeInspection { external: boolean; connected?: boolean; activeJobs: number | null }
export interface PanelRuntimeStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' | 'external';
  managed: boolean;
  connected: boolean;
  active_jobs: number | null;
  restart_required: boolean;
  transport?: 'stdio' | 'http';
  phase?: 'checking' | 'doctor' | 'starting' | 'validated' | 'stopped';
  error_code?: string;
  started_at?: string;
  loaded_revision?: string;
  needs_one_time_handoff?: boolean;
}
export interface PanelRuntimeAction { action: 'start' | 'stop' | 'restart'; expected_revision?: string }
export interface PanelRuntimeOptions {
  load?: (configPath: string) => Promise<PanelRuntimeSnapshot>;
  run?: (config: AppConfig, options: TunnelRunOptions) => Promise<{ exit_code: number }>;
  inspect?: (config: AppConfig) => Promise<PanelRuntimeInspection>;
  shutdownTimeoutMs?: number;
}

const fail = (code: string) => new AppError(code, ({
  PANEL_EXTERNAL_SERVICE: 'An external launcher owns this connection. Stop it in its original terminal once before starting it from this panel.',
  PANEL_JOBS_ACTIVE: 'Wait for active jobs to finish before stopping or restarting the service.',
  PANEL_JOBS_UNVERIFIED: 'Active job status could not be verified. The owned service was left running.',
  PANEL_STOP_TIMEOUT: 'The owned service has not exited yet. No replacement service was started.',
  PANEL_CLOSED: 'This local service controller has been closed.',
  CONFIG_CONFLICT: 'The configuration changed. Reload the current revision before restarting.',
  PANEL_STATE_UNAVAILABLE: 'Local service ownership or recorded job state could not be verified.',
} as Record<string, string>)[code] ?? 'The local service action could not be completed.');
const knownCodes = new Set(['CONFIG_ERROR', 'CONFIG_CONFLICT', 'CONFIG_PATH_DENIED', 'TUNNEL_DISABLED', 'TUNNEL_TRANSPORT_INVALID',
  'TUNNEL_CONFIG_INVALID', 'TUNNEL_CLIENT_INVALID', 'TUNNEL_PATH_INVALID', 'TUNNEL_ALREADY_RUNNING', 'TUNNEL_CONTROL_UNAVAILABLE',
  'TUNNEL_START_FAILED', 'TUNNEL_DOCTOR_TIMEOUT', 'TUNNEL_DOCTOR_FAILED', 'TUNNEL_EXITED', 'TUNNEL_FAILED', 'TUNNEL_CANCELLED',
  'PANEL_SERVICE_START_FAILED', 'PANEL_SERVICE_EXITED', 'HTTP_START_FAILED',
  'PANEL_EXTERNAL_SERVICE', 'PANEL_JOBS_ACTIVE', 'PANEL_JOBS_UNVERIFIED', 'PANEL_STOP_TIMEOUT', 'PANEL_CLOSED', 'PANEL_STATE_UNAVAILABLE', 'INVALID_ARGUMENT']);
const codeOf = (error: unknown) => error instanceof AppError && knownCodes.has(error.code) ? error.code : 'PANEL_RUNTIME_FAILED';
const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.birthtimeNs === b.birthtimeNs &&
  (a.dev === b.dev || process.platform === 'win32' && (a.dev === 0n || b.dev === 0n));

async function noLinkedParents(target: string) {
  if (!path.isAbsolute(target)) throw fail('PANEL_STATE_UNAVAILABLE');
  let current = path.parse(target).root;
  for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('PANEL_STATE_UNAVAILABLE');
  }
}

async function httpReady(config: AppConfig): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false, bytes = 0, text = '';
    const finish = (ready: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ready); } };
    const req = request({ host: '127.0.0.1', port: config.http.port, path: '/healthz', method: 'GET', agent: false }, response => {
      if (response.statusCode !== 200) { response.resume(); finish(false); return; }
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024) { req.destroy(); finish(false); } else text += chunk.toString('utf8');
      });
      response.once('end', () => { try { const value = JSON.parse(text); finish(value?.ok === true && value?.service === 'webcodex-mcp'); } catch { finish(false); } });
      response.once('error', () => finish(false));
    });
    const timer = setTimeout(() => { req.destroy(); finish(false); }, 1500);
    req.once('error', () => finish(false)); req.end();
  });
}

/** HTTP uses a private parent-child IPC channel so Windows can run normal service cleanup without a forced process kill. */
export async function runPanelHttp(config: AppConfig, options: TunnelRunOptions & { entryPoint?: string } = {}): Promise<{ exit_code: number }> {
  const cancelled = () => fail('TUNNEL_CANCELLED');
  if (options.signal?.aborted) throw cancelled();
  if (config.server?.transport !== 'http') throw fail('INVALID_ARGUMENT');
  const entryPoint = options.entryPoint ?? fileURLToPath(new URL('./cli.js', import.meta.url));
  await noLinkedParents(path.dirname(entryPoint));
  const entry = await lstat(entryPoint);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw fail('PANEL_SERVICE_START_FAILED');
  let executable: string;
  try {
    const selected = config.nodePath || process.execPath;
    if (!path.isAbsolute(selected) || /\.(?:cmd|bat|ps1)$/i.test(selected) || /[\x00-\x1f\x7f]/.test(selected)) throw fail('PANEL_SERVICE_START_FAILED');
    executable = await realpath(selected);
    if (!(await lstat(executable)).isFile()) throw fail('PANEL_SERVICE_START_FAILED');
    await access(executable, constants.X_OK);
  } catch { throw fail('PANEL_SERVICE_START_FAILED'); }
  await assertTunnelConfigRevision(config.configPath, options.expectedConfigRevision);
  if (options.signal?.aborted) throw cancelled();
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ']);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (allowed.has(name.toUpperCase()) && value !== undefined) environment[name] = value;
  if (options.expectedConfigRevision) environment.WEBCODEX_PANEL_CONFIG_REVISION = options.expectedConfigRevision;
  return new Promise((resolve, reject) => {
    let ready = false, stopSent = false, settled = false, reportedFailure: string | undefined;
    const child = spawn(executable, [entryPoint, 'serve', '--config', config.configPath, '--transport', 'http'], {
      cwd: path.dirname(config.configPath), env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const stop = () => {
      if (stopSent || !child.connected) return;
      stopSent = true;
      // Sending failure never forfeits ownership. stopOwned times out while retaining this run until the child actually exits.
      child.send({ type: 'webcodex_panel_shutdown' }, () => {});
    };
    const cleanup = () => { options.signal?.removeEventListener('abort', stop); };
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const notice = message as { type?: unknown; code?: unknown };
      if (notice.type === 'webcodex_panel_failed') {
        reportedFailure = typeof notice.code === 'string' && ['CONFIG_CONFLICT', 'CONFIG_ERROR', 'HTTP_START_FAILED', 'PANEL_RUNTIME_FAILED'].includes(notice.code)
          ? notice.code : 'PANEL_RUNTIME_FAILED';
        return;
      }
      if (notice.type !== 'webcodex_panel_ready') return;
      ready = true;
      // The first cancellation can arrive before the child's entry module installed its listener; repeat once at readiness.
      if (options.signal?.aborted) { stopSent = false; stop(); }
      else {
        try {
          options.onProgress?.({ type: 'phase', phase: 'starting' });
          options.onProgress?.({ type: 'status', status: { state: 'local_http_ready', connected: true, exit_code: 0 } });
        } catch { /* A status observer cannot control the managed process. */ }
      }
    });
    child.once('error', () => {
      if (settled || child.pid !== undefined) return;
      settled = true; cleanup(); reject(fail('PANEL_SERVICE_START_FAILED'));
    });
    child.once('close', code => {
      if (settled) return;
      settled = true; cleanup();
      if (options.signal?.aborted) reject(cancelled());
      else if (reportedFailure || code !== 0) reject(fail(reportedFailure ?? 'PANEL_SERVICE_EXITED'));
      else resolve({ exit_code: 0 });
    });
  });
}

/** Reads only the existence of a lock and aggregate job counts. No lease, migration, or job recovery is performed. */
export async function inspectPanelRuntime(config: AppConfig): Promise<PanelRuntimeInspection> {
  try { await noLinkedParents(config.stateDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { external: false, activeJobs: 0 };
    throw fail('PANEL_STATE_UNAVAILABLE');
  }
  let external = false;
  try {
    await noLinkedParents(path.join(config.stateDir, 'tunnel'));
    // Even an abandoned or unreadable lock needs local inspection; never remove or take it over here.
    await lstat(path.join(config.stateDir, 'tunnel', 'launcher.lock'));
    external = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fail('PANEL_STATE_UNAVAILABLE');
  }
  try {
    await lstat(path.join(config.stateDir, 'daemon.lock'));
    // A directly launched HTTP or stdio daemon also owns the state; no PID from this record is ever signalled.
    external = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fail('PANEL_STATE_UNAVAILABLE');
  }
  let activeJobs: number | null = null;
  const database = path.join(config.stateDir, 'webcodex.sqlite');
  try {
    const before = await lstat(database, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw fail('PANEL_STATE_UNAVAILABLE');
    // Open with O_NOFOLLOW where available and confirm identity before the read-only SQLite connection.
    const handle = await open(database, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(before, await handle.stat({ bigint: true }))) throw fail('PANEL_STATE_UNAVAILABLE');
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
        if (config.device && db.prepare("SELECT 1 FROM sqlite_master WHERE name='webcodex_state_identity'").get()) {
          const identity = db.prepare('SELECT device_id FROM webcodex_state_identity WHERE singleton=1').get();
          if (identity?.device_id !== config.device.id) throw fail('PANEL_STATE_UNAVAILABLE');
        }
        const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='webcodex_jobs'").get();
        const count = table ? Number(db.prepare("SELECT COUNT(*) AS count FROM webcodex_jobs WHERE status IN ('queued','running')").get()?.count) : 0;
        if (!Number.isSafeInteger(count) || count < 0 || !sameFile(before, await lstat(database, { bigint: true }))) throw fail('PANEL_STATE_UNAVAILABLE');
        activeJobs = count;
      } finally { db.close(); }
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') activeJobs = 0;
    // A linked, changed, busy, or incompatible database must never become a false zero.
  }
  let connected = false;
  if (external) {
    try { connected = config.server?.transport === 'http' ? await httpReady(config) : (await readTunnelStatus(config, { timeoutMs: 1500 })).connected === true; }
    catch { /* Ownership remains external even when its health is unavailable. */ }
  }
  return { external, connected, activeJobs };
}

type OwnedRun = {
  config: AppConfig; revision: string; controller: AbortController; done: Promise<void>;
  state: PanelRuntimeStatus['state']; phase: PanelRuntimeStatus['phase']; connected: boolean; startedAt: string;
};

/** A local panel owns only runs it created; an existing CLI launcher is never signalled or adopted. */
export class PanelRuntime {
  private readonly load: NonNullable<PanelRuntimeOptions['load']>;
  private readonly run: NonNullable<PanelRuntimeOptions['run']>;
  private readonly inspect: NonNullable<PanelRuntimeOptions['inspect']>;
  private readonly shutdownTimeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingActions = new Map<string, Promise<{ ok: true; action: PanelRuntimeAction['action']; status: PanelRuntimeStatus }>>();
  private owned?: OwnedRun;
  private state: PanelRuntimeStatus['state'] = 'stopped';
  private errorCode?: string;
  private closed = false;

  constructor(private readonly configPath: string, options: PanelRuntimeOptions = {}) {
    this.load = options.load ?? loadPanelRuntimeSnapshot;
    this.run = options.run ?? ((config, launch) => config.server?.transport === 'http' ? runPanelHttp(config, launch) : runTunnel(config, launch));
    this.inspect = options.inspect ?? inspectPanelRuntime;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10000;
    if (!Number.isInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 1 || this.shutdownTimeoutMs > 60000) throw fail('INVALID_ARGUMENT');
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async status(): Promise<PanelRuntimeStatus> {
    const owned = this.owned;
    const base: PanelRuntimeStatus = { state: owned?.state ?? this.state, managed: Boolean(owned), connected: owned?.connected ?? false,
      active_jobs: null, restart_required: false, ...(this.errorCode ? { error_code: this.errorCode } : {}),
      ...(owned ? { phase: owned.phase, started_at: owned.startedAt, loaded_revision: owned.revision, transport: owned.config.server?.transport ?? 'stdio' } : {}) };
    try {
      const latest = await this.load(this.configPath);
      if (!owned) base.transport = latest.config.server?.transport ?? 'stdio';
      const inspection = await this.inspect(owned?.config ?? latest.config);
      // This observation started before the old run ended; use a fresh snapshot instead of reporting it as managed.
      if (owned !== this.owned) return this.status();
      base.active_jobs = inspection.activeJobs;
      if (owned) {
        base.state = owned.state; base.phase = owned.phase;
        base.restart_required = latest.revision !== owned.revision;
        if (inspection.connected !== undefined && owned.state !== 'stopping') owned.connected = inspection.connected;
        base.connected = owned.state === 'stopping' ? false : owned.connected;
      } else if (inspection.external) {
        base.state = 'external'; base.connected = inspection.connected ?? false; base.needs_one_time_handoff = true;
        delete base.error_code;
      } else if (base.state === 'external') {
        base.state = 'stopped'; this.state = 'stopped';
        delete base.error_code; this.errorCode = undefined;
      }
    } catch (error) {
      base.error_code = codeOf(error);
      if (!owned) base.state = 'failed';
    }
    return base;
  }

  action(input: PanelRuntimeAction): Promise<{ ok: true; action: PanelRuntimeAction['action']; status: PanelRuntimeStatus }> {
    if (!input || !['start', 'stop', 'restart'].includes(input.action) ||
      (input.expected_revision !== undefined && !/^[a-f0-9]{64}$/.test(input.expected_revision))) return Promise.reject(fail('INVALID_ARGUMENT'));
    const key = `${input.action}:${input.expected_revision ?? ''}`;
    const pending = this.pendingActions.get(key);
    if (pending) return pending;
    const operation = this.serialize(async () => {
      if (this.closed) throw fail('PANEL_CLOSED');
      // An unrelated invalid edit must not prevent stopping the already-owned run with its original job configuration.
      if (input.action === 'stop' && this.owned && input.expected_revision === undefined) {
        await this.stopOwned();
        return { ok: true as const, action: input.action, status: await this.status() };
      }
      const latest = await this.load(this.configPath);
      this.assertRevision(input.expected_revision, latest.revision);
      if (input.action === 'start') {
        if (!this.owned) await this.start(latest);
      } else if (input.action === 'stop') {
        if (this.owned) await this.stopOwned();
        else await this.requireNoExternal(latest.config);
      } else {
        if (this.owned) await this.stopOwned();
        else await this.requireNoExternal(latest.config);
        const fresh = await this.load(this.configPath);
        // A configuration edited during shutdown needs a new explicit restart, even if no revision was supplied.
        this.assertRevision(latest.revision, fresh.revision);
        await this.start(fresh);
      }
      return { ok: true as const, action: input.action, status: await this.status() };
    }).catch(error => { throw fail(codeOf(error)); });
    this.pendingActions.set(key, operation);
    void operation.finally(() => { if (this.pendingActions.get(key) === operation) this.pendingActions.delete(key); }).catch(() => {});
    return operation;
  }

  private assertRevision(expected: string | undefined, actual: string) {
    if (expected !== undefined && expected !== actual) throw fail('CONFIG_CONFLICT');
  }

  private async requireNoExternal(config: AppConfig) {
    if ((await this.inspect(config)).external) { this.state = 'external'; throw fail('PANEL_EXTERNAL_SERVICE'); }
  }

  private async start(snapshot: PanelRuntimeSnapshot) {
    await this.requireNoExternal(snapshot.config);
    const owned: OwnedRun = { config: structuredClone(snapshot.config), revision: snapshot.revision, controller: new AbortController(),
      done: Promise.resolve(), state: 'starting', phase: 'checking', connected: false, startedAt: new Date().toISOString() };
    this.owned = owned; this.state = 'starting'; this.errorCode = undefined;
    const progress = (event: TunnelProgressEvent) => {
      if (this.owned !== owned || owned.controller.signal.aborted) return;
      if (event.type === 'phase') {
        owned.phase = event.phase;
        if (event.phase === 'starting') owned.state = 'running';
      } else owned.connected = event.status.connected === true;
    };
    owned.done = Promise.resolve().then(() => this.run(owned.config, { signal: owned.controller.signal, registerSignalHandlers: false,
      expectedConfigRevision: owned.revision, onProgress: progress }))
      .then(() => { if (this.owned === owned) { this.state = 'stopped'; this.errorCode = undefined; } })
      .catch(error => {
        if (this.owned !== owned) return;
        const code = codeOf(error);
        if (owned.controller.signal.aborted && code === 'TUNNEL_CANCELLED') { this.state = 'stopped'; this.errorCode = undefined; }
        else { this.state = code === 'TUNNEL_ALREADY_RUNNING' ? 'external' : 'failed'; this.errorCode = code; }
      }).finally(() => { if (this.owned === owned) this.owned = undefined; });
  }

  private async stopOwned() {
    const owned = this.owned;
    if (!owned) return;
    if (!owned.controller.signal.aborted) {
      const inspection = await this.inspect(owned.config);
      if (this.owned !== owned) return;
      if (inspection.activeJobs === null) throw fail('PANEL_JOBS_UNVERIFIED');
      if (inspection.activeJobs > 0) throw fail('PANEL_JOBS_ACTIVE');
      owned.state = 'stopping'; owned.connected = false;
      owned.controller.abort();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([owned.done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(fail('PANEL_STOP_TIMEOUT')), this.shutdownTimeoutMs); })]);
    } finally { clearTimeout(timer); }
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return;
      await this.stopOwned();
      this.closed = true;
    });
  }
}

async function loadPanelRuntimeSnapshot(configPath: string): Promise<PanelRuntimeSnapshot> {
  // The configuration editor provides the same bounded, validated snapshot used for save/restart CAS.
  const { readConfigDocument } = await import('./config-admin.js');
  const document = await readConfigDocument(configPath);
  return { config: await validateConfig(document.raw, document.fullPath), revision: document.revision };
}
