import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, errorResult } from './errors.js';
import { FileService, hash } from './filesystem.js';
import { FileImportService } from './file-import.js';
import { fileOperations } from './file-operations.js';
import { initializeIdentity } from './identity.js';
import { canonical } from './store.js';
import type { ServiceContext, Store } from './types.js';

export const FILE_SAVE_FILE_ID_PATTERN = /^file[-_][A-Za-z0-9_-]+$/;
export const FILE_SAVE_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const FILE_SAVE_POLL_LIMIT = 30;
export const FILE_SAVE_STATUS_TOOL = 'fs_save_file_status';
export const FILE_SAVE_HOST_ERRORS = ['HOST_FILE_API_UNAVAILABLE', 'HOST_FILE_REFERENCE_UNAVAILABLE', 'HOST_FILE_RESOLUTION_FAILED', 'FILE_SAVE_TRANSFER_UNCERTAIN'] as const;
export type FileSaveHostError = typeof FILE_SAVE_HOST_ERRORS[number];
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
export const fileSaveInputSchema = z.object({
  workspace_id: z.string().min(1).max(64), path: z.string().min(1).max(2048),
  file_id: z.string().min(1).max(512).regex(FILE_SAVE_FILE_ID_PATTERN),
  size_bytes: z.number().int().min(0).max(134217728), content_sha256: sha256,
  expected_sha256: sha256.nullable(), idempotency_key: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
}).strict();
export type FileSaveInput = z.infer<typeof fileSaveInputSchema>;
export type FileSaveStatusInput = { workspace_id: string; idempotency_key: string };
type Operation = ReturnType<ReturnType<typeof fileOperations>['status']>;
export interface FileSaveStatus extends FileSaveStatusInput {
  status: 'pending' | 'saved' | 'failed' | 'unknown' | 'expired' | 'not_found' | 'blocked';
  path?: string; size_bytes?: number; content_sha256?: string; expires_at?: string;
  phase?: 'awaiting_host_file' | 'importing'; poll_count: number; poll_limit: number; can_poll: boolean;
  polls_remaining: number; retry_after_ms?: number; current_observation?: Record<string, unknown> | null;
  verified?: boolean; sha256?: string; receipt?: unknown; error_code?: string; operation: Operation;
}
export type FileSaveOpenData = Omit<FileSaveStatus, 'status'> & { status: FileSaveStatus['status'] | 'awaiting_host_file'; status_tool: typeof FILE_SAVE_STATUS_TOOL; status_arguments: FileSaveStatusInput };
export interface FileSaveMetadata extends Record<string, unknown> {
  webcodexFileSave: { ticket: string; file_id: string; workspace_id: string; expected_device_id: string; idempotency_key: string; expires_at: string };
}
type Row = {
  workspace_binding: string; workspace_id: string; operation_key: string; digest: string;
  path: string; size_bytes: number; content_sha256: string; created_at: number; expires_at: number;
  stage: 'pending' | 'importing' | 'saved' | 'failed' | 'unknown' | 'expired'; error_code: string | null; poll_count: number;
};
type Session = { request: FileSaveInput; binding: string; device: string; created: number; expires: number; promise?: Promise<FileSaveStatus> };
type Runtime = { tickets: Map<string, Session>; users: number };
const runtimes = new WeakMap<Store, Runtime>();
const fixedErrorCode = (error: unknown) => {
  const code = errorResult(error).error.code;
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'INTERNAL_ERROR';
};

/** Host-file references stay in bounded memory; durable records contain only their digest. */
export class FileSaveService {
  private readonly runtime: Runtime;
  private readonly now: () => number;
  private closed = false;
  constructor(private readonly ctx: ServiceContext, private readonly files: FileService,
    private readonly fileImports: FileImportService, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    ctx.store.db.exec(`CREATE TABLE IF NOT EXISTS file_save_sessions (
      workspace_binding TEXT NOT NULL, workspace_id TEXT NOT NULL, operation_key TEXT NOT NULL, digest TEXT NOT NULL,
      path TEXT NOT NULL, size_bytes INTEGER NOT NULL, content_sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, stage TEXT NOT NULL, error_code TEXT, poll_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(workspace_binding,operation_key)
    )`);
    let runtime = runtimes.get(ctx.store);
    if (!runtime) {
      // Tickets cannot survive restart. Never turn a possibly started write into a fresh attempt.
      ctx.store.db.exec("UPDATE file_save_sessions SET stage='expired',error_code='FILE_SAVE_TICKET_EXPIRED' WHERE stage='pending'; UPDATE file_save_sessions SET stage='unknown',error_code='FILE_SAVE_TRANSFER_UNCERTAIN' WHERE stage='importing'");
      runtime = { tickets: new Map(), users: 0 }; runtimes.set(ctx.store, runtime);
    }
    runtime.users++;
    this.runtime = runtime;
  }
  private timestamp() {
    if (this.closed) throw new AppError('SERVICE_CLOSING', 'The file-save component service is closed.');
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 - 3600000) throw new AppError('INTERNAL_ERROR', 'The file-save clock is unavailable.');
    return now;
  }
  private limits() {
    const maxSessions = this.ctx.config.binaryInputs?.maxSessions ?? 4, ttlMs = this.ctx.config.binaryInputs?.ttlMs ?? 900000;
    const maxBytes = this.ctx.config.limits.binaryWriteMaxBytes ?? 33554432;
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 16 || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 134217728) throw new AppError('CONFIG_ERROR', 'The file-save session or binary size limits are invalid.');
    return { maxSessions, ttlMs, maxBytes };
  }
  private row(binding: string, key: string): Row | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM file_save_sessions WHERE workspace_binding=? AND operation_key=?').get(binding, key) as Row | undefined;
  }
  private update(row: Row, stage: Row['stage'], code: string | null = null) {
    this.ctx.store.db.prepare('UPDATE file_save_sessions SET stage=?,error_code=? WHERE workspace_binding=? AND operation_key=?').run(stage, code, row.workspace_binding, row.operation_key);
  }
  private operation(input: FileSaveStatusInput) { return fileOperations(this.ctx).status({ ...input, tool: 'fs_import_file' }); }
  private expires(session: Session) { return Math.min(session.expires, session.created + this.limits().ttlMs); }
  private prune() {
    const now = this.timestamp();
    for (const [ticket, session] of this.runtime.tickets) if (!session.promise && this.expires(session) <= now) {
      const row = this.row(session.binding, session.request.idempotency_key);
      if (row?.stage === 'pending') this.update(row, 'expired', 'FILE_SAVE_TICKET_EXPIRED');
      this.runtime.tickets.delete(ticket);
    }
  }
  private find(ticket: string) {
    this.timestamp();
    if (typeof ticket !== 'string' || !FILE_SAVE_TICKET_PATTERN.test(ticket)) throw new AppError('FILE_SAVE_TICKET_INVALID', 'The file-save capability ticket is invalid.');
    const session = this.runtime.tickets.get(ticket);
    if (!session) throw new AppError('FILE_SAVE_TICKET_NOT_FOUND', 'This file-save ticket is unavailable or belongs to another service instance. Inspect the original operation status.');
    return session;
  }
  private bound(session: Session) {
    const identity = initializeIdentity(this.ctx);
    if (identity.source().device_id !== session.device) throw new AppError('DEVICE_MISMATCH', 'The file-save session belongs to another device.');
    if (identity.workspaceIdentity(session.request.workspace_id) !== session.binding) throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'The file-save workspace binding changed.');
  }
  private checkLimits(session: Session) {
    const limits = this.limits();
    if (session.request.size_bytes > limits.maxBytes) throw new AppError('FILE_IMPORT_TOO_LARGE', 'The original file exceeds the current binary write limit.');
    const live = [...this.runtime.tickets.values()].filter(value => ['pending', 'importing'].includes(this.row(value.binding, value.request.idempotency_key)?.stage ?? '')).length;
    if (live > limits.maxSessions) throw new AppError('FILE_SAVE_CAPACITY', 'The current file-save session limit prevents starting this download.');
    return limits;
  }
  private async authorized(session: Session, checkDestination: boolean) {
    this.bound(session);
    const limits = this.checkLimits(session);
    if (this.expires(session) <= this.timestamp()) throw new AppError('FILE_SAVE_TICKET_EXPIRED', 'The file-save ticket expired. Inspect status before starting a new operation.');
    const absolute = await this.ctx.paths.resolve(session.request.workspace_id, session.request.path, { write: true, allowMissing: true });
    if (checkDestination) {
      const current = await this.files.snapshotForBatch(absolute, limits.maxBytes, 'bytes');
      if ((current === null ? null : hash(current)) !== session.request.expected_sha256) throw new AppError('VERSION_CONFLICT', 'The destination no longer matches the expected version. No file download was started.');
      await this.ctx.paths.resolve(session.request.workspace_id, session.request.path, { write: true, allowMissing: true });
    }
    this.bound(session);
    this.checkLimits(session);
    if (this.expires(session) <= this.timestamp()) throw new AppError('FILE_SAVE_TICKET_EXPIRED', 'The file-save ticket expired during authorization.');
  }
  private async inspect(input: FileSaveStatusInput, poll: boolean): Promise<FileSaveStatus> {
    this.timestamp();
    const parsed = z.object({ workspace_id: z.string().min(1).max(64), idempotency_key: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/) }).strict().safeParse(input);
    if (!parsed.success) throw new AppError('FILE_SAVE_INVALID_ARGUMENT', 'Provide a workspace and the original operation key.');
    input = parsed.data;
    await this.ctx.paths.resolve(input.workspace_id, '.', { directory: true });
    const binding = initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id), row = this.row(binding, input.idempotency_key);
    const operation = this.operation(input);
    const base: Omit<FileSaveStatus, 'status'> = { ...input, poll_count: row?.poll_count ?? 0, poll_limit: FILE_SAVE_POLL_LIMIT,
      polls_remaining: FILE_SAVE_POLL_LIMIT - (row?.poll_count ?? 0), can_poll: false, operation,
      ...(row ? { path: row.path, size_bytes: row.size_bytes, content_sha256: row.content_sha256, expires_at: new Date(Math.min(row.expires_at, row.created_at + this.limits().ttlMs)).toISOString() } : {}) };
    // A durable import outcome always wins over component failure reports or stale tickets.
    if (operation.found) {
      if (operation.stage === 'done') {
        const receipt = operation.receipt;
        const expectedPath = row?.path.replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/');
        if (!receipt?.verified || row && (receipt.path !== expectedPath || receipt.sha256 !== row.content_sha256 || receipt.size_bytes !== row.size_bytes)) return { ...base, status: 'unknown', error_code: 'FILE_SAVE_TRANSFER_UNCERTAIN' };
        const observed = await this.files.operationStatus({ ...input, tool: 'fs_import_file' });
        return { ...base, status: 'saved', verified: true, sha256: receipt.sha256, size_bytes: receipt.size_bytes, path: receipt.path, receipt,
          current_observation: observed.current_observation };
      }
      if (operation.stage === 'unknown') return { ...base, status: 'unknown', error_code: 'FILE_SAVE_TRANSFER_UNCERTAIN' };
      if (['failed', 'retryable_failure'].includes(operation.stage)) return { ...base, status: 'failed', error_code: operation.error?.code ?? 'FILE_IMPORT_DOWNLOAD_FAILED' };
    }
    if (!row) return { ...base, status: operation.found ? 'unknown' : 'not_found', ...(operation.found ? { error_code: 'FILE_SAVE_TRANSFER_UNCERTAIN' } : {}) };
    if (row.stage === 'saved') return { ...base, status: 'unknown', error_code: 'FILE_SAVE_TRANSFER_UNCERTAIN' };
    if (row.stage === 'failed' || row.stage === 'unknown' || row.stage === 'expired') return { ...base, status: row.stage, error_code: row.error_code ?? undefined };
    const session = [...this.runtime.tickets.values()].find(value => value.binding === binding && value.request.idempotency_key === input.idempotency_key);
    if (!session) return { ...base, status: row.stage === 'importing' || operation.found ? 'unknown' : 'expired', error_code: row.stage === 'importing' || operation.found ? 'FILE_SAVE_TRANSFER_UNCERTAIN' : 'FILE_SAVE_TICKET_EXPIRED' };
    if (!session.promise && this.expires(session) <= this.timestamp()) {
      this.update(row, 'expired', 'FILE_SAVE_TICKET_EXPIRED');
      return { ...base, status: 'expired', error_code: 'FILE_SAVE_TICKET_EXPIRED' };
    }
    if (!session.promise) {
      try { await this.authorized(session, false); }
      catch (error) { return { ...base, status: 'blocked', error_code: fixedErrorCode(error) }; }
    }
    const count = poll ? Math.min(FILE_SAVE_POLL_LIMIT, row.poll_count + 1) : row.poll_count;
    if (count !== row.poll_count) this.ctx.store.db.prepare('UPDATE file_save_sessions SET poll_count=? WHERE workspace_binding=? AND operation_key=?').run(count, binding, input.idempotency_key);
    return { ...base, status: 'pending', phase: row.stage === 'importing' || session.promise ? 'importing' : 'awaiting_host_file', poll_count: count,
      polls_remaining: FILE_SAVE_POLL_LIMIT - count, can_poll: count < FILE_SAVE_POLL_LIMIT, retry_after_ms: 1000 };
  }
  async open(input: FileSaveInput): Promise<{ data: FileSaveOpenData; meta?: FileSaveMetadata }> {
    this.prune();
    const parsed = fileSaveInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('FILE_SAVE_INVALID_ARGUMENT', 'Provide a real file- or file_ host identifier, original SHA-256 and size, destination, expected version and operation key.');
    const request = { ...parsed.data, content_sha256: parsed.data.content_sha256.toLowerCase(), expected_sha256: parsed.data.expected_sha256?.toLowerCase() ?? null };
    const identity = initializeIdentity(this.ctx), binding = identity.workspaceIdentity(request.workspace_id), digest = hash(Buffer.from(canonical(request)));
    const statusInput = { workspace_id: request.workspace_id, idempotency_key: request.idempotency_key };
    const decorate = (status: FileSaveStatus): FileSaveOpenData => ({ ...status, status: status.status === 'pending' && status.phase === 'awaiting_host_file' ? 'awaiting_host_file' : status.status, status_tool: FILE_SAVE_STATUS_TOOL, status_arguments: statusInput });
    const existing = this.row(binding, request.idempotency_key);
    if (existing && existing.digest !== digest) throw new AppError('IDEMPOTENCY_CONFLICT', 'This file-save operation key is bound to different original-file metadata or destination.');
    if (existing) {
      const state = await this.inspect(statusInput, false);
      const entry = [...this.runtime.tickets].find(([, value]) => value.binding === binding && value.request.idempotency_key === request.idempotency_key);
      return { data: decorate(state), ...(state.status === 'pending' && entry ? { meta: this.metadata(entry[0], entry[1]) } : {}) };
    }
    if (this.operation(statusInput).found) throw new AppError('IDEMPOTENCY_CONFLICT', 'This key already belongs to an import operation. Inspect its durable status before another file-save request.');
    const created = this.timestamp(), session: Session = { request, binding, device: identity.source().device_id, created, expires: created + this.limits().ttlMs };
    await this.authorized(session, true);
    // Recheck after async path/snapshot checks. Concurrent opens must share one ticket.
    const raced = this.row(binding, request.idempotency_key);
    if (raced) return this.open(request);
    this.prune();
    for (const [ticket, value] of this.runtime.tickets) {
      const row = this.row(value.binding, value.request.idempotency_key);
      if (!value.promise && row && !['pending', 'importing'].includes(row.stage)) this.runtime.tickets.delete(ticket);
    }
    if (this.runtime.tickets.size >= this.limits().maxSessions) throw new AppError('FILE_SAVE_CAPACITY', 'The bounded file-save session capacity is full. Inspect existing operations or wait for ticket expiry.');
    if (this.operation(statusInput).found) throw new AppError('IDEMPOTENCY_CONFLICT', 'An import acquired this operation key while the file-save request was being prepared.');
    this.ctx.store.db.prepare('INSERT INTO file_save_sessions(workspace_binding,workspace_id,operation_key,digest,path,size_bytes,content_sha256,created_at,expires_at,stage) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(binding, request.workspace_id, request.idempotency_key, digest, request.path, request.size_bytes, request.content_sha256, created, session.expires, 'pending');
    let ticket: string;
    do { ticket = randomBytes(32).toString('base64url'); } while (this.runtime.tickets.has(ticket));
    this.runtime.tickets.set(ticket, session);
    const state = await this.inspect(statusInput, false);
    return { data: decorate(state), ...(state.status === 'pending' ? { meta: this.metadata(ticket, session) } : {}) };
  }
  private metadata(ticket: string, session: Session): FileSaveMetadata {
    return { webcodexFileSave: { ticket, file_id: session.request.file_id, workspace_id: session.request.workspace_id,
      expected_device_id: session.device, idempotency_key: session.request.idempotency_key, expires_at: new Date(this.expires(session)).toISOString() } };
  }
  status(input: FileSaveStatusInput) { return this.inspect(input, true); }
  async complete(input: { ticket: string; download_url: string }): Promise<FileSaveStatus> {
    const session = this.find(input.ticket);
    const downloadUrl = input.download_url;
    this.bound(session);
    if (session.promise) return session.promise;
    const statusInput = { workspace_id: session.request.workspace_id, idempotency_key: session.request.idempotency_key };
    // Assign before the first await, including authorization and status checks.
    const pending = Promise.resolve().then(async () => {
      const previous = await this.inspect(statusInput, false);
      if (previous.status !== 'pending') return previous;
      const row = this.row(session.binding, session.request.idempotency_key)!;
      try {
        await this.authorized(session, true);
        if (typeof downloadUrl !== 'string' || !downloadUrl.length || downloadUrl.length > 16384) throw new AppError('FILE_IMPORT_INVALID_ARGUMENT', 'The host did not provide a bounded download URL.');
        this.update(row, 'importing');
        const request = session.request;
        await this.fileImports.import({ workspace_id: request.workspace_id, path: request.path, file: { file_id: request.file_id, download_url: downloadUrl },
          expected_sha256: request.expected_sha256, idempotency_key: request.idempotency_key,
          expected_source_sha256: request.content_sha256, expected_source_bytes: request.size_bytes });
        this.update(row, 'saved');
      } catch (error) {
        const operation = this.operation(statusInput);
        const unknown = operation.found && !['done', 'failed', 'retryable_failure'].includes(operation.stage);
        const code = fixedErrorCode(error);
        this.update(row, operation.found && operation.stage === 'done' ? 'saved' : unknown ? 'unknown' : code === 'FILE_SAVE_TICKET_EXPIRED' ? 'expired' : 'failed', unknown ? 'FILE_SAVE_TRANSFER_UNCERTAIN' : code);
      }
      return this.inspect(statusInput, false);
    });
    session.promise = pending;
    try { return await pending; } finally { if (session.promise === pending) session.promise = undefined; }
  }
  async fail(input: { ticket: string; error_code: FileSaveHostError }): Promise<FileSaveStatus> {
    const session = this.find(input.ticket);
    this.bound(session);
    const code = input.error_code;
    if (!FILE_SAVE_HOST_ERRORS.includes(code)) throw new AppError('FILE_SAVE_INVALID_ARGUMENT', 'Provide a supported fixed host-file error classification.');
    const statusInput = { workspace_id: session.request.workspace_id, idempotency_key: session.request.idempotency_key };
    const current = await this.inspect(statusInput, false);
    if (current.status !== 'pending' || session.promise || current.operation.found) return current;
    const row = this.row(session.binding, session.request.idempotency_key)!;
    if (row.stage !== 'pending' || this.operation(statusInput).found) return this.inspect(statusInput, false);
    this.update(row, code === 'FILE_SAVE_TRANSFER_UNCERTAIN' ? 'unknown' : 'failed', code);
    return this.inspect(statusInput, false);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (--this.runtime.users === 0) this.runtime.tickets.clear();
  }
}
