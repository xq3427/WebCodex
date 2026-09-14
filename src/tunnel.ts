import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import type { AppConfig } from './types.js';
import { AppError } from './errors.js';
import type { TunnelProgressPhase } from './tunnel-progress.js';

type TunnelSettings = {
  enabled: boolean; id: string; apiKey: string; proxyUrl: string;
  clientPath: string; clientVersion: string; clientSha256?: string;
};
type TunnelConfig = AppConfig & {
  tunnel?: TunnelSettings; toolsDir?: string; nodePath?: string; server?: { transport: string };
};
export interface TunnelRunResult {
  doctor_only: boolean; exit_code: number; health_url_file: string;
  client_source: 'official_release_record' | 'configured_sha256';
}
export interface TunnelStatus {
  state: string; connected: boolean; exit_code: number; health_url_file?: string;
  launcher_alive?: boolean; process_identity_verified?: boolean; live?: boolean; mcp_ready?: boolean;
  poll_age_seconds?: number | null; poll_fresh?: boolean; route_mode?: string;
  successful_tool_calls?: number; last_error_category?: string;
}
export type TunnelProgressEvent = { type:'phase'; phase:TunnelProgressPhase } | { type:'status'; status:TunnelStatus };
export interface TunnelRunOptions {
  doctorOnly?: boolean;
  onProgress?: (event: TunnelProgressEvent) => void;
  /** Cancellation targets only the child owned by this invocation. */
  signal?: AbortSignal;
  /** Embedded launchers own application signals instead of installing per-child handlers. */
  registerSignalHandlers?: boolean;
  /** An embedded manager can bind startup to the saved configuration it displays. */
  expectedConfigRevision?: string;
}
const safeError = (code: string, message: string) => new AppError(code, message);
const cancelled = () => safeError('TUNNEL_CANCELLED', 'The locally owned tunnel launch was cancelled.');
function checkCancelled(signal?: AbortSignal) { if (signal?.aborted) throw cancelled(); }
export async function assertTunnelConfigRevision(configPath: string, expected?: string) {
  if (expected === undefined) return;
  const conflict = () => safeError('CONFIG_CONFLICT', 'The saved configuration changed during service startup. Reload its current revision and start again.');
  if (!/^[a-f0-9]{64}$/.test(expected)) throw conflict();
  try {
    await plainPath(configPath, 'file');
    const before = await lstat(configPath, { bigint: true });
    if (before.size > 1048576n) throw conflict();
    const handle = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.ino !== before.ino || opened.mtimeNs !== before.mtimeNs || opened.size !== before.size) throw conflict();
      const bytes = await handle.readFile();
      const after = await lstat(configPath, { bigint: true });
      if (after.isSymbolicLink() || after.nlink !== 1n || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || createHash('sha256').update(bytes).digest('hex') !== expected) throw conflict();
    } finally { await handle.close(); }
  } catch { throw conflict(); }
}
const invalid = () => safeError('TUNNEL_CONFIG_INVALID', 'Configure the tunnel ID, API key, proxy and client in the unified local configuration. Legacy credential files and environment fallback are not used.');
const denied = () => safeError('TUNNEL_CLIENT_INVALID', 'The tunnel client path, installation source or SHA-256 could not be verified. Reinstall the official client or configure an explicit clientPath and clientSha256.');
const unsafePath = () => safeError('TUNNEL_PATH_INVALID', 'Tunnel control paths must be absolute, ordinary local paths without links, quotes or control characters.');
const versionPattern = /^v\d+\.\d+\.\d+$/;

/**
 * Recover only a lock whose recorded owner is definitely gone.  A malformed
 * lock or a live PID remains untouched because it may belong to another
 * launcher, and every recovered lock is retained for local diagnosis.
 */
async function archiveAbandonedLauncherLock(controlDirectory: string, lockFile: string): Promise<boolean> {
  let owner: { pid?: number };
  try {
    const info = await lstat(lockFile);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) return false;
    owner = JSON.parse(await readFile(lockFile, 'utf8')) as { pid?: number };
    if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) return false;
  } catch { return false; }
  try { process.kill(owner.pid!, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + owner.pid;
  const archived = path.join(controlDirectory, `launcher.abandoned-${suffix}.json`);
  try { await rename(lockFile, archived); return true; }
  catch { return false; }
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function absolutePath(value: string): string {
  // The official client tokenizes mcp.command; it does not receive a shell script.
  // Reject ambiguous substitutions/quoting, while preserving ordinary spaces and apostrophes.
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f"`$]/.test(value)) throw unsafePath();
  return path.resolve(value);
}

async function plainPath(value: string, kind: 'file' | 'directory', create = false): Promise<string> {
  const full = absolutePath(value);
  let current = path.parse(full).root;
  const parts = full.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT' || kind !== 'directory') throw unsafePath();
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafePath(); }
      info = await lstat(current);
    }
    const last = index === parts.length - 1;
    if (info.isSymbolicLink() || (last && kind === 'file' ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) throw unsafePath();
  }
  return full;
}

async function digestFile(file: string): Promise<string> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 512n * 1024n * 1024n) throw denied();
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const after = await lstat(file, { bigint: true });
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || after.isSymbolicLink()) throw denied();
  return digest.digest('hex');
}

async function verifiedClient(config: TunnelConfig, settings: TunnelSettings) {
  let client: string;
  let expectedHash: unknown;
  let source: TunnelRunResult['client_source'];
  try {
    if (settings.clientPath && settings.clientPath !== 'auto') {
      client = await plainPath(settings.clientPath, 'file');
      expectedHash = settings.clientSha256;
      source = 'configured_sha256';
    } else {
      const toolsRoot = absolutePath(config.toolsDir || path.join(path.dirname(config.configPath), 'tools'));
      const clientRoot = await plainPath(path.join(toolsRoot, 'tunnel-client'), 'directory');
      const recordPath = await plainPath(path.join(clientRoot, 'install.json'), 'file');
      if ((await lstat(recordPath)).size > 65536) throw denied();
      const record = JSON.parse((await readFile(recordPath, 'utf8')).replace(/^\uFEFF/, '')) as Record<string, unknown>;
      if (typeof record.version !== 'string' || !versionPattern.test(record.version) ||
          record.releaseUrl !== `https://github.com/openai/tunnel-client/releases/tag/${record.version}` ||
          typeof record.executable !== 'string') throw denied();
      if (settings.clientVersion && settings.clientVersion !== 'auto' && settings.clientVersion !== record.version) throw denied();
      const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
      if (record.architecture !== undefined && record.architecture !== architecture && record.architecture !== process.arch) throw denied();
      if (record.platform !== undefined && record.platform !== process.platform && !(process.platform === 'win32' && record.platform === 'windows')) throw denied();
      client = absolutePath(path.isAbsolute(record.executable) ? record.executable : path.resolve(clientRoot, record.executable));
      if (!contains(clientRoot, client)) throw denied();
      client = await plainPath(client, 'file');
      expectedHash = record.executableSha256;
      source = 'official_release_record';
    }
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash) || /\.(?:cmd|bat|ps1)$/i.test(client)) throw denied();
    if (process.platform === 'win32' && !/\.exe$/i.test(client)) throw denied();
    if (await digestFile(client) !== expectedHash.toLowerCase()) throw denied();
    await access(client, constants.X_OK);
    return { client, expectedHash: expectedHash.toLowerCase(), source };
  } catch { throw denied(); }
}

/** Minimal runtime environment: no legacy tunnel profiles, credentials or proxy variables. */
function childEnvironment(key?: string): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ']);
  // Keep the Windows OpenSSH prerequisite through launcher -> MCP -> job.
  if (process.platform === 'win32') allowed.add('PROGRAMDATA');
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (allowed.has(name.toUpperCase()) && value !== undefined) environment[name] = value;
  if (key !== undefined) environment.CONTROL_PLANE_API_KEY = key;
  return environment;
}

function commandArgument(value: string): string {
  const safe = absolutePath(value);
  if (process.platform === 'win32') return `"${safe.replace(/\\/g, '/')}"`;
  return `"${safe.replace(/\\/g, '\\\\')}"`;
}

async function execute(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  timeoutMs?: number, captureVersion = false, options: TunnelRunOptions = {}): Promise<{ code: number; output: string }> {
  checkCancelled(options.signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let interruption: NodeJS.Signals | undefined;
    let aborted = false;
    let output = '';
    // Raw diagnostics can contain credentials supplied by a remote error response.
    // Only --version is captured (without credentials); doctor/run output is discarded.
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', captureVersion ? 'pipe' : 'ignore', 'ignore'] });
    const stop = (signal: NodeJS.Signals) => {
      interruption = signal;
      try { child.kill(signal); } catch { /* The exit/error event settles the operation. */ }
    };
    const onInt = () => stop('SIGINT');
    const onTerm = () => stop('SIGTERM');
    const onAbort = () => { aborted = true; stop('SIGTERM'); };
    if (options.registerSignalHandlers !== false) {
      process.on('SIGINT', onInt);
      process.on('SIGTERM', onTerm);
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); options.signal?.removeEventListener('abort', onAbort); };
    child.stdout?.on('data', (buffer: Buffer) => { if (output.length < 8192) output += buffer.toString('utf8').slice(0, 8192 - output.length); });
    child.once('error', () => {
      if (settled) return;
      settled = true; cleanup();
      reject(aborted ? cancelled() : safeError('TUNNEL_START_FAILED', 'The verified tunnel client could not be started. Check its platform and local executable permissions.'));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true; cleanup();
      if (aborted) reject(cancelled());
      else if (timedOut) reject(safeError('TUNNEL_DOCTOR_TIMEOUT', 'The local tunnel client validation timed out.'));
      else resolve({ code: interruption === 'SIGINT' ? 130 : interruption === 'SIGTERM' ? 143 : code ?? (signal === 'SIGINT' ? 130 : 1), output });
    });
  });
}

/** Launch only from the unified config; this function never opens a WebCodex SQLite store. */
export async function runTunnel(config: TunnelConfig, options: TunnelRunOptions = {}): Promise<TunnelRunResult> {
  checkCancelled(options.signal);
  const report = (event:TunnelProgressEvent) => {try{options.onProgress?.(event);}catch{/* An observer cannot alter the tunnel lifecycle. */}};
  report({type:'phase',phase:'checking'});
  const settings = config.tunnel;
  if (!settings?.enabled) throw safeError('TUNNEL_DISABLED', 'Enable tunnel in the unified local configuration before connecting.');
  if (config.server?.transport !== 'stdio') throw safeError('TUNNEL_TRANSPORT_INVALID', 'Set server.transport to stdio in the unified configuration before connecting the tunnel.');
  if (!/^tunnel_[A-Za-z0-9_-]{1,200}$/.test(settings.id) || typeof settings.apiKey !== 'string' ||
      settings.apiKey.length < 1 || settings.apiKey.length > 4096 || /[\s\p{Cc}\p{Cf}]/u.test(settings.apiKey) ||
      typeof settings.proxyUrl !== 'string' || (settings.clientVersion && settings.clientVersion !== 'auto' && !versionPattern.test(settings.clientVersion))) throw invalid();
  if (settings.proxyUrl) {
    try {
      const proxy = new URL(settings.proxyUrl);
      if (/[\x00-\x20\x7f]/.test(settings.proxyUrl) || !['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname ||
          proxy.username || proxy.password || proxy.search || proxy.hash || (proxy.pathname && proxy.pathname !== '/')) throw invalid();
    } catch { throw invalid(); }
  }
  let configPath: string;
  let node: string;
  let cliPath: string;
  let controlDirectory: string;
  try {
    configPath = await plainPath(config.configPath, 'file');
    node = absolutePath(await realpath(absolutePath(config.nodePath || process.execPath)));
    if (!(await lstat(node)).isFile() || /\.(?:cmd|bat|ps1)$/i.test(node)) throw unsafePath();
    await access(node, constants.X_OK);
    cliPath = await plainPath(fileURLToPath(new URL('./cli.js', import.meta.url)), 'file');
    controlDirectory = path.join(absolutePath(config.stateDir), 'tunnel');
  } catch { throw unsafePath(); }
  const installed = await verifiedClient(config, settings);
  await plainPath(controlDirectory, 'directory', true);
  const healthFile = path.join(controlDirectory, 'health.url');
  try { await plainPath(healthFile, 'file'); }
  catch (error) {
    try { await lstat(healthFile); throw unsafePath(); }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const lockFile = path.join(controlDirectory, 'launcher.lock');
  checkCancelled(options.signal);
  let lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { lock = await open(lockFile, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw safeError('TUNNEL_CONTROL_UNAVAILABLE', 'The tunnel launcher lock could not be created. Check the local control directory, filesystem availability and write permissions.');
      }
      if (attempt === 0 && await archiveAbandonedLauncherLock(controlDirectory, lockFile)) continue;
      throw safeError('TUNNEL_ALREADY_RUNNING', 'A launcher lock already exists; it may belong to an existing connection or remain after an interrupted launch. Run tunnel status with the same --config selection before inspecting the lock locally.');
    }
  }
  if (!lock) throw safeError('TUNNEL_CONTROL_UNAVAILABLE', 'The tunnel launcher lock could not be created. Check the local control directory, filesystem availability and write permissions.');
  const owner = randomUUID();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, owner, started_at: new Date().toISOString() }) + '\n');
    checkCancelled(options.signal);
    if (options.expectedConfigRevision !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedConfigRevision)) {
      throw safeError('CONFIG_CONFLICT', 'Reload the current saved configuration revision before starting.');
    }
    const command = [commandArgument(node), commandArgument(cliPath), 'serve', '--config', commandArgument(configPath), '--transport', 'stdio',
      ...(options.expectedConfigRevision ? ['--expected-config-revision', options.expectedConfigRevision] : [])].join(' ');
    const args = [
      '--control-plane.base-url', 'https://api.openai.com', '--control-plane.tunnel-id', settings.id,
      '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY', '--mcp.command', command,
      '--mcp.stdio-send-initialized-notification', '--health.listen-addr', '127.0.0.1:0',
      '--health.url-file', healthFile, '--allow-remote-ui=false', '--log.http-raw-unsafe=false',
    ];
    if (settings.proxyUrl) args.push('--control-plane.http-proxy', settings.proxyUrl);
    const cwd = path.dirname(configPath);
    if (installed.source === 'configured_sha256' && settings.clientVersion && settings.clientVersion !== 'auto') {
      const version = await execute(installed.client, ['--version'], cwd, childEnvironment(), 10_000, true, options);
      const observed = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:[+\s]|$)/.exec(version.output);
      if (version.code !== 0 || !observed || `v${observed[1]}` !== settings.clientVersion) throw denied();
    }
    const result = { doctor_only: !!options.doctorOnly, exit_code: 0, health_url_file: healthFile, client_source: installed.source };
    report({type:'phase',phase:'doctor'});
    await assertTunnelConfigRevision(configPath, options.expectedConfigRevision);
    const doctor = await execute(installed.client, ['doctor', ...args, '--explain'], cwd, childEnvironment(settings.apiKey), 30_000, false, options);
    if (doctor.code === 130 || doctor.code === 143) return { ...result, exit_code: doctor.code };
    if (doctor.code !== 0) throw safeError('TUNNEL_DOCTOR_FAILED', 'The tunnel client configuration check failed. Verify the unified configuration and client compatibility; no raw diagnostics were printed.');
    if (options.doctorOnly) {report({type:'phase',phase:'validated'});return result;}
    // Check again after doctor: an executable changed during validation must not be run.
    if (await digestFile(installed.client) !== installed.expectedHash) throw denied();
    report({type:'phase',phase:'starting'});
    let active=true;
    let timer:NodeJS.Timeout|undefined;
    let pending:Promise<void>|undefined;
    // Startup feedback uses the existing bounded, redacted loopback reader.
    // Stop after the first confirmed connection; later diagnosis is `tunnel status`.
    const poll = () => {
      pending=(async()=>{
        let connected=false;
        try {
          const status=await readTunnelStatus(config,{timeoutMs:1500});
          connected=status.connected;
          if(active)report({type:'status',status});
        } catch {if(active)report({type:'status',status:{state:'diagnostics_unavailable',connected:false,exit_code:4}});}
        if(active&&!connected)timer=setTimeout(poll,5000);
      })();
    };
    if(options.onProgress)timer=setTimeout(poll,1000);
    let running:{code:number;output:string};
    try {
      await assertTunnelConfigRevision(configPath, options.expectedConfigRevision);
      running=await execute(installed.client, ['run', ...args], cwd, childEnvironment(settings.apiKey), undefined, false, options);
    }
    finally {active=false;clearTimeout(timer);await pending;}
    if (running.code !== 0 && running.code !== 130 && running.code !== 143) throw safeError('TUNNEL_EXITED', 'The tunnel client exited unsuccessfully. Inspect local health status and the unified configuration.');
    report({type:'phase',phase:'stopped'});
    return { ...result, exit_code: running.code };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw safeError('TUNNEL_FAILED', 'The tunnel operation could not be completed. No credential or raw diagnostic was emitted.');
  } finally {
    await lock.close();
    try {
      const current = JSON.parse(await readFile(lockFile, 'utf8')) as { owner?: string };
      if (current.owner === owner) await unlink(lockFile);
    } catch { /* Never remove a replaced or unrecognized lock file. */ }
  }
}

function metric(text: string, name: string, labels: Record<string, string> = {}, sum = false): number | null {
  const values: number[] = [];
  for (const line of text.split('\n')) {
    const match = new RegExp(`^${name}(?:\\{([^\\r\\n]*)\\})?\\s+([+\\-0-9.eE]+)\\s*$`).exec(line.trim());
    if (!match || Object.entries(labels).some(([key, value]) => !(new RegExp(`(?:^|,)${key}="${value}"(?:,|$)`)).test(match[1] ?? ''))) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values.length ? (sum ? values.reduce((a, b) => a + b, 0) : Math.max(...values)) : null;
}

async function localProbe(base: URL, endpoint: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = request(new URL(endpoint, base), { method: 'GET', agent: false }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        finish({ status: response.statusCode ?? 0, body: '' });
        return;
      }
      const buffers: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512 * 1024) { req.destroy(); fail(); }
        else buffers.push(chunk);
      });
      response.once('end', () => finish({ status: 200, body: Buffer.concat(buffers).toString('utf8') }));
      response.once('error', fail);
    });
    const timer = setTimeout(() => { req.destroy(); fail(); }, timeoutMs);
    function finish(result: { status: number; body: string }) { if (settled) return; settled = true; clearTimeout(timer); resolve(result); }
    function fail() { if (settled) return; settled = true; clearTimeout(timer); reject(safeError('TUNNEL_HEALTH_UNAVAILABLE', 'The bounded local health probe could not complete.')); }
    req.once('error', fail);
    req.end();
  });
}

/** Read loopback health only. A live launcher PID is not proof of socket/process identity. */
export async function readTunnelStatus(config: TunnelConfig, options: { timeoutMs?: number } = {}): Promise<TunnelStatus> {
  const unavailable = (state: string, exit = 3): TunnelStatus => ({ state, connected: false, exit_code: exit });
  if (!config.tunnel?.enabled) return unavailable('disabled', 2);
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw safeError('INVALID_ARGUMENT', 'timeoutMs must be an integer from 1 through 30000.');
  let healthFile: string;
  let base: URL;
  let startedAt: number;
  try {
    await verifiedClient(config, config.tunnel);
    const control = await plainPath(path.join(absolutePath(config.stateDir), 'tunnel'), 'directory');
    const lock = await plainPath(path.join(control, 'launcher.lock'), 'file');
    if ((await lstat(lock)).size > 4096) return unavailable('invalid_control_file', 2);
    const owner = JSON.parse(await readFile(lock, 'utf8')) as { pid?: number; started_at?: string };
    if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || typeof owner.started_at !== 'string') return unavailable('invalid_control_file', 2);
    startedAt = Date.parse(owner.started_at) / 1000;
    if (!Number.isFinite(startedAt) || startedAt > Date.now() / 1000 + 5) return unavailable('invalid_control_file', 2);
    try { process.kill(owner.pid!, 0); }
    catch (error) { return unavailable((error as NodeJS.ErrnoException).code === 'ESRCH' ? 'not_running' : 'launcher_unverified'); }
    healthFile = await plainPath(path.join(control, 'health.url'), 'file');
    const info = await lstat(healthFile);
    if (info.size > 2048 || info.mtimeMs / 1000 < startedAt - 5) return unavailable('stale_health_file');
    const raw = (await readFile(healthFile, 'utf8')).trim();
    const literal = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):(\d{1,5})\/?$/.exec(raw);
    if (!literal || Number(literal[1]) < 1 || Number(literal[1]) > 65535) return unavailable('unsafe_health_url', 2);
    base = new URL(raw);
  } catch (error) {
    return unavailable(error instanceof AppError && error.code === 'TUNNEL_CLIENT_INVALID' ? 'client_unverified' : 'not_running');
  }
  const observation = { health_url_file: healthFile, launcher_alive: true, process_identity_verified: false };
  try {
    // http.request makes direct loopback requests, does not follow redirects and
    // does not apply HTTP_PROXY or a global fetch dispatcher from the parent.
    const [health, ready, statusResponse, metrics] = await Promise.all(['/healthz', '/readyz', '/api/status', '/metrics'].map(endpoint => localProbe(base, endpoint, timeout)));
    if (statusResponse.status !== 200 || metrics.status !== 200) return { ...unavailable('diagnostics_unavailable', 4), ...observation };
    const status = JSON.parse(statusResponse.body) as Record<string, any>;
    const daemonStarted = typeof status.started_at === 'string' ? Date.parse(status.started_at) / 1000 : NaN;
    if (status.control_plane_tunnel_id !== config.tunnel.id || !Number.isFinite(daemonStarted) || daemonStarted < startedAt - 5) return { ...unavailable('endpoint_mismatch', 4), ...observation };
    const route = ['proxy', 'direct'].includes(status.control_plane_route?.route_mode) ? status.control_plane_route.route_mode as string : 'unknown';
    const live = health.status === 200 && health.body.trim() === 'live';
    const mcpReady = ready.status === 200 && ready.body.trim() === 'ready' && Array.isArray(status.channels) && status.channels.some(channel => channel?.name === 'main' && channel?.enabled === true && channel?.probe_status === 'ok');
    const last = metric(metrics.body, 'commands_poll_last_successful_timestamp_seconds');
    const age = last && last > 0 ? Date.now() / 1000 - last : null;
    const fresh = age !== null && age >= -5 && age <= 120 && last! >= startedAt - 5;
    const details = { ...observation, live, mcp_ready: mcpReady, route_mode: route, poll_age_seconds: age === null ? null : Math.round(age * 10) / 10, poll_fresh: fresh };
    if (!live) return { ...unavailable('local_unhealthy'), ...details };
    const knownErrors = ['tunnel_metadata_error', 'control_plane_error', 'last_error', 'error'].map(key => typeof status[key] === 'string' ? (status[key] as string).slice(0, 8192) : '').join(' ');
    const category = /\b(?:401|403|unauthorized|forbidden|permission.denied|access.denied)\b/i.test(knownErrors) ? 'authentication_or_permission' : /timed?\s*out|timeout|deadline exceeded/i.test(knownErrors) ? 'network_timeout' : 'none_observed';
    if (!fresh) return { ...unavailable(category === 'none_observed' ? 'poll_not_fresh' : category, 5), ...details, last_error_category: category };
    if (!mcpReady || metric(metrics.body, 'liveness') !== 1 || metric(metrics.body, 'readiness') !== 1) return { ...unavailable('mcp_not_ready', 6), ...details };
    const calls = metric(metrics.body, 'command_end_to_end_latency_milliseconds_count', { latency_type: 'enqueue_to_response', request_method: 'tools/call', tunnel_service_status: '200' }, true) ?? 0;
    return { state: calls > 0 ? 'connected_tools_called' : 'connected_no_tool_calls', connected: true, exit_code: 0, ...details, successful_tool_calls: calls, last_error_category: category };
  } catch { return { ...unavailable('diagnostics_unavailable', 4), ...observation }; }
}
