import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ServiceContext } from './types.js';
import { AppError } from './errors.js';
import { executableDefinition } from './config.js';
import { addRecordBinding, assertRecordBinding, boundOperation, initializeIdentity } from './identity.js';
import { executionEnvironment } from './execution-env.js';
import { effectiveWorkspaceExecution } from './execution-profiles.js';
import { canonical } from './store.js';

type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'unknown';
type StopReason = 'cancelled' | 'timed_out';
type StreamName = 'stdout' | 'stderr';
interface JobRow {
  job_id: string; workspace_id: string; workspace_binding: string | null; executable_alias: string; args_json: string; cwd: string;
  status: JobStatus; created_at: string; started_at: string | null; ended_at: string | null;
  timeout_ms: number; pid: number | null; exit_code: number | null; signal: string | null;
  output_bytes: number; output_truncated: number; error: string | null;
  stdin_mode: 'closed' | 'pipe'; stdin_state: 'closed' | 'open' | 'ended' | 'unknown'; stdin_bytes_attempted: number;
  execution_profile: string | null; execution_context_sha256: string | null;
}
interface ChunkRow { start_cursor: number; end_cursor: number; stream: StreamName; text: string }
interface StartInput { workspace_id: string; executable: string; args?: string[]; cwd?: string; timeout_ms?: number; stdin?: 'closed' | 'pipe'; idempotency_key: string }
interface StdinInput { workspace_id:string; job_id:string; content?:string; end?:boolean; idempotency_key:string }
interface ActiveJob {
  id: string; workspaceId: string; child: ChildProcess; decoders: Record<StreamName, StringDecoder>;
  outputBytes: number; truncated: boolean; finished: boolean; timer?: NodeJS.Timeout;
  stopReason?: StopReason; stopping?: Promise<void>; spawnError?: string;
  done: Promise<void>; resolveDone: () => void;
}

const terminal = new Set<JobStatus>(['succeeded', 'failed', 'cancelled', 'timed_out', 'unknown']);

/** cmd parses its command text itself; CRT backslash-escaping changes quoted paths. */
function nativeSpawnArguments(executable: string, args: string[]) {
  if (process.platform === 'win32' && path.win32.basename(executable).toLowerCase() === 'cmd.exe') {
    const commandIndex = args.findIndex(arg => /^\/[ck]$/i.test(arg));
    if (commandIndex >= 0 && commandIndex === args.length - 2
      && args.slice(0, commandIndex).every(arg => /^\/[a-z0-9:]+$/i.test(arg))) {
      // Match cmd's /s quote contract: remove one outer pair, leaving the supplied
      // shell text (including its path quotes) intact. No other program uses this.
      const options = args.slice(0, commandIndex).filter(arg => arg.toLowerCase() !== '/s');
      return { args: [...options, '/s', args[commandIndex]!, `"${args[commandIndex + 1]!}"`], windowsVerbatimArguments: true };
    }
  }
  return { args, windowsVerbatimArguments: false };
}

/** Resolve once to an absolute native file, excluding cwd-dependent PATH entries and shell wrappers. */
function unrestrictedExecutable(name: string, environment: NodeJS.ProcessEnv): string {
  if (!name || name.length > 4096 || /[\x00-\x1f\x7f]/.test(name) || /\.(?:bat|cmd)$/i.test(name)) {
    throw new AppError('INVALID_EXECUTABLE', 'Use a native program name or absolute executable path, with arguments in args. Run scripts through an explicit interpreter or configured preset.');
  }
  const absolute = path.isAbsolute(name);
  if (!absolute && (!/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/.test(name) || name === '.' || name === '..')) {
    throw new AppError('INVALID_EXECUTABLE', 'Program names cannot include paths, shell syntax or arguments; use an absolute path when needed.');
  }
  const inheritedPath = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const directories = absolute ? [''] : inheritedPath.split(path.delimiter).filter(directory => path.isAbsolute(directory) && !/[\x00-\x1f\x7f]/.test(directory));
  const suffixes = process.platform === 'win32' && !/\.(?:exe|com)$/i.test(name) ? ['.exe', '.com'] : [''];
  for (const directory of directories) for (const suffix of suffixes) {
    const candidate = absolute ? name + suffix : path.join(directory, name + suffix);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      const resolved = realpathSync(candidate);
      if (process.platform === 'win32' && !/\.(?:exe|com)$/i.test(resolved)) continue;
      // Validate the target, but preserve the selected entry path: Python virtualenvs can
      // use a symlink to a shared interpreter whose own real path selects a different env.
      return path.resolve(candidate);
    } catch { /* Try the next absolute PATH entry; never fall back to a shell or cwd. */ }
  }
  throw new AppError('EXECUTABLE_NOT_FOUND', 'The native program was not found in the host PATH or at the requested absolute path. Use its installed executable path or an explicit interpreter preset.');
}

function integer(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError('INVALID_ARGUMENT', `${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** Largest valid UTF-8 prefix fitting the byte limit, for text already normalized by StringDecoder. */
function prefixLength(buffer: Buffer, limit: number): number {
  let end = Math.min(buffer.length, limit);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return end;
}

export class JobService {
  private readonly active = new Map<string, ActiveJob>();
  private readonly starting = new Set<Promise<unknown>>();
  private readonly observers = new Map<string,Set<()=>void>>();
  private readonly inputLocks = new Map<string,Promise<void>>();
  private readonly inputs = new Set<Promise<unknown>>();
  private closing = false;

  constructor(private readonly ctx: ServiceContext) {
    initializeIdentity(ctx);
    ctx.store.db.exec(`
      CREATE TABLE IF NOT EXISTS webcodex_jobs (
        job_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, executable_alias TEXT NOT NULL,
        args_json TEXT NOT NULL, cwd TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, timeout_ms INTEGER NOT NULL,
        pid INTEGER, exit_code INTEGER, signal TEXT, output_bytes INTEGER NOT NULL DEFAULT 0,
        output_truncated INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS webcodex_jobs_workspace ON webcodex_jobs(workspace_id, created_at);
      CREATE TABLE IF NOT EXISTS webcodex_job_chunks (
        job_id TEXT NOT NULL, start_cursor INTEGER NOT NULL, end_cursor INTEGER NOT NULL,
        stream TEXT NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(job_id, start_cursor),
        FOREIGN KEY(job_id) REFERENCES webcodex_jobs(job_id)
      );
    `);
    addRecordBinding(ctx.store, 'webcodex_jobs');
    const columns = new Set(ctx.store.db.prepare('PRAGMA table_info(webcodex_jobs)').all().map(row => row.name));
    for (const [name, definition] of [['stdin_mode', "TEXT NOT NULL DEFAULT 'closed'"], ['stdin_state', "TEXT NOT NULL DEFAULT 'closed'"], ['stdin_bytes_attempted', 'INTEGER NOT NULL DEFAULT 0'], ['execution_profile', 'TEXT'], ['execution_context_sha256', 'TEXT']]) {
      if (!columns.has(name)) ctx.store.db.exec(`ALTER TABLE webcodex_jobs ADD COLUMN ${name} ${definition}`);
    }
    // A recorded PID is never sufficient proof of ownership after restart (PIDs can be reused).
    const stale = ctx.store.db.prepare("SELECT job_id, workspace_id FROM webcodex_jobs WHERE status IN ('queued', 'running')").all();
    ctx.store.db.prepare("UPDATE webcodex_jobs SET stdin_state='unknown' WHERE stdin_mode='pipe' AND status IN ('queued','running')").run();
    ctx.store.db.prepare("UPDATE webcodex_jobs SET status = 'unknown', ended_at = ?, error = ? WHERE status IN ('queued', 'running')")
      .run(new Date().toISOString(), 'Service restarted; the previous process outcome is unknown.');
    for (const job of stale) ctx.store.audit('exec.recovered_unknown', String(job.workspace_id), { job_id: job.job_id });
  }

  private executionSelection(workspaceId: string, alias: string) {
    const effective = effectiveWorkspaceExecution(this.ctx.config, workspaceId);
    const preset = typeof alias === 'string' && Object.hasOwn(effective.allowedExecutables, alias);
    if (typeof alias !== 'string' || !preset && effective.commandPolicy !== 'all') {
      throw new AppError('EXECUTABLE_NOT_ALLOWED', 'Use an executable alias authorized by this workspace execution profile or global configuration.');
    }
    const { command, args } = preset ? executableDefinition(effective.allowedExecutables[alias]!)
      : { command: unrestrictedExecutable(alias, executionEnvironment(effective.env)), args: [] };
    if (typeof command !== 'string' || !path.isAbsolute(command) || /\.(?:bat|cmd)$/i.test(command) || command.includes('\0')) {
      throw new AppError('INVALID_EXECUTABLE', 'Configured executables must be absolute native executable paths. .cmd and .bat files are unsupported.');
    }
    if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 128 * 1024)) {
      throw new AppError('INVALID_ARGUMENT', 'Configured arguments must contain at most 256 strings without null bytes, each at most 128 KiB.');
    }
    const env = executionEnvironment(effective.env, command);
    // Keep legacy allowlist hashes stable; switching to all must still invalidate an old receipt.
    const contextSha256 = createHash('sha256').update(canonical({ profile: effective.profile, alias, command, args, env, ...(effective.commandPolicy === 'all' ? { commandPolicy: 'all' } : {}) })).digest('hex');
    return { profile: effective.profile, commandPolicy: effective.commandPolicy, command, args, env, contextSha256 };
  }

  /** Preserve old no-profile receipts/errors; a stored operation can never cause a new launch here. */
  private legacyPayload(workspaceId: string, tool: string, key: string, payload: unknown): boolean {
    const binding = initializeIdentity(this.ctx).workspaceIdentity(workspaceId);
    const prior = this.ctx.store.db.prepare('SELECT digest FROM operations WHERE scope=? AND op_key=?').get('workspace:' + binding + '/' + tool, key);
    return prior?.digest === createHash('sha256').update(canonical(payload)).digest('hex');
  }

  private stdinExecution(row: JobRow) {
    const selected = this.executionSelection(row.workspace_id, row.executable_alias);
    if (row.execution_context_sha256 !== null && row.execution_context_sha256 !== selected.contextSha256 || row.execution_context_sha256 === null && (selected.profile !== null || selected.commandPolicy !== 'allowlist')) {
      throw new AppError('EXECUTION_PROFILE_CHANGED', 'The current execution profile, executable or environment differs from this job. Restore its original configuration before sending input.');
    }
    return selected;
  }

  async start(input: StartInput) {
    const pending = this.startImpl(input);
    this.starting.add(pending);
    try { return await pending; }
    finally { this.starting.delete(pending); }
  }

  private async startImpl(input: StartInput) {
    this.ctx.paths.get(input.workspace_id);
    if (this.closing) throw new AppError('SERVICE_CLOSING', 'The service is shutting down.');
    if (this.ctx.config.execution.mode !== 'trusted-host') {
      throw new AppError('EXECUTION_DISABLED', 'Command execution is disabled. Enable trusted-host execution in the local configuration first.');
    }
    const selected = this.executionSelection(input.workspace_id, input.executable);
    const { command: executablePath, args: prefixArgs } = selected;
    const userArgs = input.args ?? [];
    if (!Array.isArray(userArgs) || !Array.isArray(prefixArgs) || prefixArgs.length + userArgs.length > 256 || [...prefixArgs, ...userArgs].some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 128 * 1024)) {
      throw new AppError('INVALID_ARGUMENT', 'args must contain at most 256 strings without null bytes, each at most 128 KiB.');
    }
    const args = [...prefixArgs, ...userArgs];
    if (typeof input.idempotency_key !== 'string' || !input.idempotency_key.trim() || input.idempotency_key.length > 200) {
      throw new AppError('INVALID_ARGUMENT', 'idempotency_key is required and must be at most 200 characters.');
    }
    const defaultTimeout = (this.ctx.config.execution as ServiceContext['config']['execution'] & { defaultTimeoutMs?: number }).defaultTimeoutMs ?? 60_000;
    const timeout = integer(input.timeout_ms ?? Math.min(defaultTimeout, this.ctx.config.execution.maxTimeoutMs), 1, this.ctx.config.execution.maxTimeoutMs, 'timeout_ms');
    const stdin = input.stdin ?? 'closed';
    if (!['closed','pipe'].includes(stdin)) throw new AppError('INVALID_ARGUMENT', 'stdin must be closed or pipe.');
    const relativeCwd = input.cwd ?? '.';
    // Recheck current path/read-only policy even when the operation will return a cached job.
    await this.ctx.paths.resolve(input.workspace_id, relativeCwd, { directory: true, write: true });
    const binding = initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    if (this.executionSelection(input.workspace_id, input.executable).contextSha256 !== selected.contextSha256) throw new AppError('EXECUTION_PROFILE_CHANGED', 'Execution configuration changed during authorization. Retry using the current local settings.');
    const legacy = { workspace_id: input.workspace_id, executable: input.executable, args: userArgs, cwd: relativeCwd, timeout_ms: timeout, ...(stdin === 'pipe' ? { stdin } : {}) };
    const payload = selected.profile === null && selected.commandPolicy === 'allowlist' && this.legacyPayload(input.workspace_id, 'exec_start', input.idempotency_key, legacy)
      ? legacy : { ...legacy, execution_context_sha256: selected.contextSha256 };
    const saved = await boundOperation(this.ctx, input.workspace_id, 'exec_start', input.idempotency_key, payload, async () => {
      const cwd = await this.ctx.paths.resolve(input.workspace_id, relativeCwd, { directory: true, write: true });
      initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
      if (this.closing) throw new AppError('SERVICE_CLOSING', 'The service is shutting down.');
      if (this.ctx.paths.get(input.workspace_id).readOnly) throw new AppError('READ_ONLY', 'This workspace is read-only.');
      if (this.ctx.config.execution.mode !== 'trusted-host') throw new AppError('EXECUTION_DISABLED', 'Command execution is disabled.');
      if (this.executionSelection(input.workspace_id, input.executable).contextSha256 !== selected.contextSha256) throw new AppError('EXECUTION_PROFILE_CHANGED', 'Execution configuration changed before launch. Start from the current local settings.');
      if (this.active.size >= this.ctx.config.execution.maxConcurrent) {
        throw new AppError('CONCURRENCY_LIMIT', 'The maximum number of concurrent jobs has been reached. Poll or cancel an existing job first.');
      }
      const id = randomUUID();
      this.ctx.store.db.prepare(`INSERT INTO webcodex_jobs
        (job_id, workspace_id, workspace_binding, executable_alias, args_json, cwd, status, created_at, timeout_ms, stdin_mode, stdin_state, execution_profile, execution_context_sha256)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`).run(id, input.workspace_id, binding, input.executable, JSON.stringify(args), relativeCwd, new Date().toISOString(), timeout, stdin, stdin === 'pipe' ? 'open' : 'closed', selected.profile, selected.contextSha256);
      this.ctx.store.audit('exec.start', input.workspace_id, { job_id: id, executable: input.executable, command: executablePath, args, cwd: relativeCwd, timeout_ms: timeout, execution_mode: 'trusted-host' });
      let child: ChildProcess;
      try {
        const spawnInput = nativeSpawnArguments(executablePath, args);
        child = spawn(executablePath, spawnInput.args, {
          cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
          windowsVerbatimArguments: spawnInput.windowsVerbatimArguments,
          stdio: [stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: selected.env,
        });
      } catch (error) {
        this.ctx.store.db.prepare("UPDATE webcodex_jobs SET status = 'failed', ended_at = ?, error = ? WHERE job_id = ?")
          .run(new Date().toISOString(), String(error instanceof Error ? error.message : error), id);
        this.ctx.store.audit('exec.end', input.workspace_id, { job_id: id, status: 'failed', reason: 'spawn_failed' });
        return { job_id: id };
      }
      let resolveDone!: () => void;
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      const job: ActiveJob = {
        id, workspaceId: input.workspace_id, child, decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
        outputBytes: 0, truncated: false, finished: false, done, resolveDone,
      };
      this.active.set(id, job);
      child.stdin?.on('error', () => {
        if (!job.finished) this.ctx.store.db.prepare("UPDATE webcodex_jobs SET stdin_state='unknown' WHERE job_id=?").run(id);
      });
      child.stdout!.on('data', (data: Buffer) => this.capture(job, 'stdout', job.decoders.stdout.write(data)));
      child.stderr!.on('data', (data: Buffer) => this.capture(job, 'stderr', job.decoders.stderr.write(data)));
      child.once('error', error => { job.spawnError = error.message; });
      child.once('close', (code, signal) => {
        this.capture(job, 'stdout', job.decoders.stdout.end());
        this.capture(job, 'stderr', job.decoders.stderr.end());
        this.finish(job, job.spawnError ? 'failed' : job.stopReason ?? (code === 0 ? 'succeeded' : 'failed'), code, signal, job.spawnError);
      });
      // Resolve start only after spawn has either succeeded or failed; never report a nonexistent process as running.
      await new Promise<void>(resolve => {
        child.once('spawn', () => {
          this.ctx.store.db.prepare("UPDATE webcodex_jobs SET status = 'running', started_at = ?, pid = ? WHERE job_id = ?")
            .run(new Date().toISOString(), child.pid ?? null, id);
          job.timer = setTimeout(() => { void this.stop(job, 'timed_out').catch(() => undefined); }, timeout);
          job.timer.unref();
          resolve();
        });
        child.once('error', () => { void done.then(resolve); });
      });
      return { job_id: id };
    }, [`exec.start:${input.workspace_id}`]);
    return this.summary(this.row(input.workspace_id, saved.job_id));
  }

  poll(input: { workspace_id: string; job_id: string; cursor?: number; max_bytes?: number }) {
    const row = this.row(input.workspace_id, input.job_id);
    const cursor = integer(input.cursor ?? 0, 0, row.output_bytes, 'cursor');
    const maxBytes = integer(input.max_bytes ?? 64 * 1024, 4, 1024 * 1024, 'max_bytes');
    const chunks = this.ctx.store.db.prepare(`SELECT start_cursor, end_cursor, stream, text FROM webcodex_job_chunks
      WHERE job_id = ? AND end_cursor > ? AND start_cursor < ? ORDER BY start_cursor`).all(input.job_id, cursor, cursor + maxBytes) as unknown as ChunkRow[];
    const output: Array<{ stream: StreamName; text: string; start_cursor: number; end_cursor: number }> = [];
    let nextCursor = cursor;
    let remaining = maxBytes;
    for (const chunk of chunks) {
      const bytes = Buffer.from(chunk.text, 'utf8');
      const start = Math.max(0, nextCursor - chunk.start_cursor);
      if (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
        throw new AppError('INVALID_CURSOR', 'cursor must be a UTF-8 boundary returned as next_cursor by an earlier poll.');
      }
      const available = bytes.subarray(start);
      const size = prefixLength(available, remaining);
      if (!size) break;
      const text = available.subarray(0, size).toString('utf8');
      output.push({ stream: chunk.stream, text, start_cursor: nextCursor, end_cursor: nextCursor + size });
      nextCursor += size;
      remaining -= size;
      if (size < available.length || !remaining) break;
    }
    return { ...this.summary(row), output, next_cursor: nextCursor, has_more: nextCursor < row.output_bytes };
  }

  async writeStdin(input:StdinInput) {
    const pending = this.writeStdinImpl(input);
    this.inputs.add(pending);
    try { return await pending; } finally { this.inputs.delete(pending); }
  }

  private async writeStdinImpl(input:StdinInput) {
    if (this.closing) throw new AppError('SERVICE_CLOSING','The service is shutting down.');
    if (this.ctx.config.execution.mode !== 'trusted-host') throw new AppError('EXECUTION_DISABLED','Command input requires locally enabled trusted-host execution.');
    const content = input.content ?? '', end = input.end ?? false;
    if (typeof content !== 'string' || typeof end !== 'boolean' || Buffer.from(content).toString('utf8') !== content || !content && !end) throw new AppError('INVALID_ARGUMENT','Supply valid Unicode text and/or end=true to close stdin.');
    const bytes = Buffer.from(content);
    const perWrite = this.ctx.config.execution.stdinMaxBytes ?? 65536;
    if (bytes.length > perWrite) throw new AppError('STDIN_LIMIT_EXCEEDED','Input exceeds execution.stdinMaxBytes.');
    await this.ctx.paths.resolve(input.workspace_id,'.',{directory:true,write:true});
    const authorizedRow = this.row(input.workspace_id,input.job_id);
    const selected = this.stdinExecution(authorizedRow);
    const legacy = {job_id:input.job_id,content,end};
    const payload = selected.profile === null && this.legacyPayload(input.workspace_id, 'exec_write_stdin', input.idempotency_key, legacy)
      ? legacy : {...legacy, execution_context_sha256: selected.contextSha256};
    // Only the payload digest is persisted; neither input text nor a prefix is audited.
    return boundOperation(this.ctx,input.workspace_id,'exec_write_stdin',input.idempotency_key,payload,async()=>{
      const previous = this.inputLocks.get(input.job_id) ?? Promise.resolve();
      let release!:()=>void;
      const held = new Promise<void>(resolve=>{release=resolve;});
      const tail = previous.then(()=>held);
      this.inputLocks.set(input.job_id,tail);
      await previous;
      try {
        if (this.closing) throw new AppError('SERVICE_CLOSING','The service is shutting down.');
        if (this.ctx.config.execution.mode !== 'trusted-host') throw new AppError('EXECUTION_DISABLED','Command input requires locally enabled trusted-host execution.');
        await this.ctx.paths.resolve(input.workspace_id,'.',{directory:true,write:true});
        const row = this.row(input.workspace_id,input.job_id), job = this.active.get(input.job_id);
        if (this.ctx.paths.get(input.workspace_id).readOnly) throw new AppError('READ_ONLY', 'This workspace is read-only.');
        if (this.stdinExecution(row).contextSha256 !== selected.contextSha256) throw new AppError('EXECUTION_PROFILE_CHANGED', 'Execution configuration changed while input was waiting.');
        if (row.stdin_mode !== 'pipe') throw new AppError('STDIN_NOT_ENABLED','Start the job with stdin=pipe to send input.');
        if (!job || job.finished || row.status !== 'running') throw new AppError('JOB_NOT_WRITABLE','Only a running process owned by this service can receive input.');
        if (row.stdin_state !== 'open' || !job.child.stdin?.writable || job.child.stdin.destroyed) throw new AppError('STDIN_CLOSED','This job input is closed or its delivery state is unknown.');
        if (row.stdin_bytes_attempted + bytes.length > (this.ctx.config.execution.stdinMaxTotalBytes ?? 1048576)) throw new AppError('STDIN_LIMIT_EXCEEDED','Input exceeds execution.stdinMaxTotalBytes for this job.');
        // Count attempted bytes before touching the pipe. A crash or callback failure
        // cannot establish whether the child consumed the input, so never replay it.
        this.ctx.store.db.prepare('UPDATE webcodex_jobs SET stdin_bytes_attempted=stdin_bytes_attempted+?,stdin_state=? WHERE job_id=?')
          .run(bytes.length,end?'ended':'open',job.id);
        this.ctx.store.audit('exec.stdin_attempt',input.workspace_id,{job_id:job.id,bytes:bytes.length,end});
        await new Promise<void>((resolve,reject)=>{
          let settled = false;
          const finish = (error?:Error|null) => {
            if (settled) return; settled=true; clearTimeout(timer);
            if (error) {
              this.ctx.store.db.prepare("UPDATE webcodex_jobs SET stdin_state='unknown' WHERE job_id=?").run(job.id);
              job.child.stdin?.destroy();
              reject(new AppError('STDIN_DELIVERY_UNKNOWN','Input delivery could not be confirmed. Do not resend it with a new operation ID; inspect job output and decide how to recover.'));
            } else resolve();
          };
          const timer = setTimeout(()=>finish(new Error('timeout')),this.ctx.config.execution.stdinWriteTimeoutMs??5000);
          try { if (end) job.child.stdin!.end(bytes,finish); else job.child.stdin!.write(bytes,finish); }
          catch { finish(new Error('write_failed')); }
        });
        this.row(input.workspace_id,input.job_id); // Recheck binding before returning a completion.
        this.ctx.store.audit('exec.stdin_written',input.workspace_id,{job_id:job.id,bytes:bytes.length,end});
        return {workspace_id:input.workspace_id,job_id:job.id,bytes_written:bytes.length,end,delivery:'written_to_pipe',notice:'The OS pipe accepted these bytes. This does not prove that the program processed them or succeeded. Read job output and exit status. The input text is not retained by this service; the child program may echo or store it.'};
      } finally { release(); if (this.inputLocks.get(input.job_id)===tail) this.inputLocks.delete(input.job_id); }
    });
  }

  /** Wait for output or a terminal observation without repeatedly querying SQLite. */
  async wait(input:{workspace_id:string;job_id:string;cursor?:number;max_bytes?:number;wait_ms?:number}) {
    if(this.closing)throw new AppError('SERVICE_CLOSING','The service is shutting down.');
    const maximum=this.ctx.config.execution.maxWaitMs??20000;
    const waitMs=integer(input.wait_ms??Math.min(this.ctx.config.execution.defaultWaitMs??1000,maximum),0,maximum,'wait_ms');
    const maxBytes=integer(input.max_bytes??Math.min(16384,this.ctx.config.limits.readMaxBytes),4,this.ctx.config.limits.readMaxBytes,'max_bytes');
    const read=()=>this.poll({...input,max_bytes:maxBytes});
    const start=performance.now();const first=read();
    const response=(result:ReturnType<JobService['poll']>,reason:'terminal'|'output'|'timeout')=>({...result,terminal:terminal.has(result.status),wait_reason:reason,waited_ms:Math.round(performance.now()-start)});
    if(terminal.has(first.status))return response(first,'terminal');
    if(first.output.length)return response(first,'output');
    if(waitMs===0)return response(first,'timeout');
    await new Promise<void>(resolve=>{
      const listeners=this.observers.get(input.job_id)??new Set<()=>void>();
      let timer:NodeJS.Timeout;
      const finish=()=>{clearTimeout(timer);listeners.delete(finish);if(!listeners.size)this.observers.delete(input.job_id);resolve();};
      listeners.add(finish);this.observers.set(input.job_id,listeners);
      timer=setTimeout(finish,waitMs);
    });
    if(this.closing)throw new AppError('SERVICE_CLOSING','The service closed while waiting for a job.');
    const result=read(); // Rechecks the current device/workspace binding before output leaves.
    return response(result,terminal.has(result.status)?'terminal':result.output.length?'output':'timeout');
  }

  /** Tail the selected persisted stream; global cursor offsets remain valid for exec_poll. */
  tail(input:{workspace_id:string;job_id:string;max_bytes?:number;stream?:'all'|StreamName}) {
    const row=this.row(input.workspace_id,input.job_id);
    const maxBytes=integer(input.max_bytes??Math.min(16384,this.ctx.config.limits.readMaxBytes),4,this.ctx.config.limits.readMaxBytes,'max_bytes');
    const stream=input.stream??'all';
    if(!['all','stdout','stderr'].includes(stream))throw new AppError('INVALID_ARGUMENT','stream must be all, stdout or stderr.');
    const chunks=this.ctx.store.db.prepare(`SELECT start_cursor,end_cursor,stream,text FROM webcodex_job_chunks
      WHERE job_id=? ${stream==='all'?'':'AND stream=?'} ORDER BY start_cursor DESC LIMIT 257`).iterate(...(stream==='all'?[input.job_id]:[input.job_id,stream])) as unknown as Iterable<ChunkRow>;
    const output:Array<{stream:StreamName;text:string;start_cursor:number;end_cursor:number}>=[];
    let remaining=maxBytes,earlier=false,returned=0,index=0;
    for(const chunk of chunks){
      if(index++===256||remaining===0){earlier=true;break;}
      const bytes=Buffer.from(chunk.text);
      let begin=Math.max(0,bytes.length-remaining);
      while(begin<bytes.length&&(bytes[begin]&0xc0)===0x80)begin++;
      const size=bytes.length-begin;
      if(size){output.push({stream:chunk.stream,text:bytes.subarray(begin).toString('utf8'),start_cursor:chunk.start_cursor+begin,end_cursor:chunk.end_cursor});returned+=size;remaining-=size;}
      if(begin>0){earlier=true;break;}
    }
    output.reverse();
    return {...this.summary(row),output,terminal:terminal.has(row.status),stream,returned_bytes:returned,max_bytes:maxBytes,
      start_cursor:output[0]?.start_cursor??row.output_bytes,next_cursor:row.output_bytes,has_more:false,
      earlier_output_omitted:earlier,other_streams_omitted:stream!=='all',scope:'tail_of_persisted_output',
      notice:'Tail of stored output only. next_cursor continues future unfiltered exec_poll output; use cursor 0 to inspect earlier stored output. output_truncated means the process produced output beyond the storage limit.'};
  }

  async cancel(input: { workspace_id: string; job_id: string }) {
    const row = this.row(input.workspace_id, input.job_id);
    const job = this.active.get(input.job_id);
    if (terminal.has(row.status) && !job) return this.summary(row);
    if (!job) throw new AppError('JOB_NOT_OWNED', 'This process is not managed by the current service; its recorded PID will not be used.');
    await this.stop(job, 'cancelled');
    return this.summary(this.row(input.workspace_id, input.job_id));
  }

  list(input: { workspace_id: string; limit?: number }) {
    const binding = initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    const limit = integer(input.limit ?? 20, 1, 100, 'limit');
    const rows = this.ctx.store.db.prepare('SELECT * FROM webcodex_jobs WHERE workspace_id = ? AND workspace_binding = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(input.workspace_id, binding, limit) as unknown as JobRow[];
    return { jobs: rows.map(row => this.summary(row)) };
  }

  async close(): Promise<void> {
    this.closing = true;
    for(const id of [...this.observers.keys()])this.notify(id);
    await Promise.allSettled([...this.starting]);
    const results = await Promise.allSettled([...this.active.values()].map(job => this.stop(job, 'cancelled')));
    if (results.some(result => result.status === 'rejected')) {
      // Shutdown must not leave asynchronous SQLite writers behind if termination was denied.
      // The still-live process is reported unknown; detaching does not claim it has been killed.
      for (const job of this.active.values()) {
        job.child.stdin?.destroy();
        job.child.stdout?.destroy();
        job.child.stderr?.destroy();
        this.finish(job, 'unknown', job.child.exitCode, job.child.signalCode, 'Service shut down without confirmation of process tree termination.');
        job.child.unref();
      }
      await Promise.allSettled([...this.inputs]);
      throw new AppError('SHUTDOWN_INCOMPLETE', 'One or more process trees could not be confirmed terminated. Check the job status and local audit log.');
    }
    await Promise.allSettled([...this.inputs]);
  }

  private row(workspaceId: string, id: string): JobRow {
    const binding = initializeIdentity(this.ctx).workspaceIdentity(workspaceId);
    const row = this.ctx.store.db.prepare('SELECT * FROM webcodex_jobs WHERE job_id = ? AND workspace_id = ?').get(id, workspaceId) as unknown as JobRow | undefined;
    if (!row) throw new AppError('JOB_NOT_FOUND', 'Job was not found in this workspace.');
    assertRecordBinding(row, binding, 'JOB_NOT_FOUND');
    return row;
  }

  private summary(row: JobRow) {
    return {
      job_id: row.job_id, workspace_id: row.workspace_id, executable: row.executable_alias,
      args: JSON.parse(row.args_json) as string[], cwd: row.cwd, status: row.status,
      created_at: row.created_at, started_at: row.started_at, ended_at: row.ended_at,
      timeout_ms: row.timeout_ms, exit_code: row.exit_code, signal: row.signal,
      output_bytes: row.output_bytes, output_truncated: row.output_truncated === 1, error: row.error,
      ...(row.status === 'failed' && row.exit_code !== null && row.exit_code !== 0 && row.output_bytes === 0 && !row.error ? {
        failure_diagnostics: {
          code: 'PROCESS_EXIT_WITHOUT_OUTPUT',
          message: 'The program exited unsuccessfully without captured stdout or stderr. Its exit code alone does not identify a network, authentication or permission failure. Compare the same executable and arguments in the host environment; try a local version/help command before testing the remote connection. Do not replay remote mutations or change security settings on this evidence alone.',
        },
      } : {}),
      stdin: {mode:row.stdin_mode,state:row.stdin_state,bytes_attempted:row.stdin_bytes_attempted},
      execution_profile: row.execution_profile, execution_context_sha256: row.execution_context_sha256,
    };
  }

  private capture(job: ActiveJob, stream: StreamName, text: string): void {
    if (job.finished || job.truncated || !text) return;
    const bytes = Buffer.from(text, 'utf8');
    const keep = prefixLength(bytes, Math.max(0, this.ctx.config.execution.maxOutputBytes - job.outputBytes));
    this.ctx.store.db.exec('SAVEPOINT capture_output');
    try {
      if (keep) {
        this.ctx.store.db.prepare('INSERT INTO webcodex_job_chunks (job_id, start_cursor, end_cursor, stream, text) VALUES (?, ?, ?, ?, ?)')
          .run(job.id, job.outputBytes, job.outputBytes + keep, stream, bytes.subarray(0, keep).toString('utf8'));
      }
      const truncated = keep < bytes.length;
      this.ctx.store.db.prepare('UPDATE webcodex_jobs SET output_bytes = ?, output_truncated = ? WHERE job_id = ?')
        .run(job.outputBytes + keep, truncated ? 1 : 0, job.id);
      this.ctx.store.db.exec('RELEASE capture_output');
      job.outputBytes += keep;
      job.truncated = truncated;
      this.notify(job.id);
    } catch (error) {
      this.ctx.store.db.exec('ROLLBACK TO capture_output; RELEASE capture_output');
      throw error;
    }
  }

  private finish(job: ActiveJob, status: JobStatus, code: number | null, signal: string | null, error?: string): void {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timer);
    this.ctx.store.db.prepare('UPDATE webcodex_jobs SET status = ?, ended_at = ?, exit_code = ?, signal = ?, error = ? WHERE job_id = ?')
      .run(status, new Date().toISOString(), code, signal, error ?? null, job.id);
    this.ctx.store.db.prepare("UPDATE webcodex_jobs SET stdin_state='closed' WHERE job_id=? AND stdin_state='open'").run(job.id);
    this.active.delete(job.id);
    this.ctx.store.audit('exec.end', job.workspaceId, { job_id: job.id, status, exit_code: code, signal, output_bytes: job.outputBytes, output_truncated: job.truncated, error });
    job.resolveDone();
    this.notify(job.id);
  }

  private notify(id:string) {for(const listener of [...(this.observers.get(id)??[])])listener();}

  private stop(job: ActiveJob, reason: StopReason): Promise<void> {
    if (job.finished) return Promise.resolve();
    if (job.stopping) return job.stopping;
    job.stopReason = reason;
    const stopping = (async () => {
      try {
        const pid = job.child.pid;
        if (!pid || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('The managed child has no valid process ID.');
        if (process.platform === 'win32') {
          const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
          if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('SystemRoot must be an absolute OS-provided path.');
          await new Promise<void>((resolve, reject) => {
            const killer = spawn(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
              shell: false, windowsHide: true, stdio: 'ignore', env: executionEnvironment(),
            });
            const timer = setTimeout(() => { killer.kill(); reject(new Error('taskkill exceeded its time limit.')); }, 5000);
            killer.once('error', error => { clearTimeout(timer); reject(error); });
            killer.once('close', code => {
              clearTimeout(timer);
              if (code === 0 || job.finished) resolve();
              else reject(new Error(`taskkill failed with exit code ${code}.`));
            });
          });
        } else {
          try { process.kill(-pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
        let timer: NodeJS.Timeout | undefined;
        const ended = await Promise.race([
          job.done.then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
        ]);
        clearTimeout(timer);
        if (!ended) throw new Error('The managed process did not report closure after tree termination.');
      } catch (error) {
        // Do not report cancellation as successful when the tree termination could not be confirmed.
        if (!job.finished) {
          clearTimeout(job.timer);
          job.stopReason = undefined;
          this.ctx.store.db.prepare("UPDATE webcodex_jobs SET status = 'unknown', error = ? WHERE job_id = ?")
            .run(String(error instanceof Error ? error.message : error), job.id);
          this.notify(job.id);
          // Retain the live ChildProcess handle and its concurrency slot. A caller may retry
          // cancellation while this service can still prove ownership of the original process.
        }
        this.ctx.store.audit('exec.stop_failed', job.workspaceId, { job_id: job.id, reason, error: String(error) });
        throw new AppError('PROCESS_TERMINATION_UNCONFIRMED', 'Process tree termination could not be confirmed. Inspect the job and local audit log.');
      }
    })();
    job.stopping = stopping;
    void stopping.finally(() => { if (job.stopping === stopping) job.stopping = undefined; }).catch(() => undefined);
    return stopping;
  }
}
