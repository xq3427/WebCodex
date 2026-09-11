import { createHash, randomUUID } from 'node:crypto';
import { AppError, errorResult } from './errors.js';
import { canonical } from './store.js';
import { initializeIdentity } from './identity.js';
import type { ServiceContext, Store } from './types.js';

export type FileOperationTool = 'fs_copy' | 'fs_import_file' | 'fs_write_binary' | 'fs_write' | 'fs_write_bytes' | 'fs_apply_patch' | 'fs_mkdir' | 'changes_restore';
type Stage = 'preparing' | 'downloading' | 'committing' | 'done' | 'retryable_failure' | 'failed' | 'unknown';
type OperationRow = { id: string; workspace_id: string; workspace_binding: string; tool: FileOperationTool; operation_key: string; digest: string; path: string; stage: Stage; attempts: number; max_attempts: number; content_sha256: string | null; content_bytes: number | null; mutation_started: number; receipt: string | null; error: string | null; created_at: string; updated_at: string };
type LegacyRow = { digest: string; status: string; result: string | null };
export interface FileOperationAttempt {
  readonly id: string;
  /** Persist the downloaded content identity before entering any local mutation. */
  content(sha256: string, sizeBytes: number): void;
  /** Link the durable before-image to this operation before touching the destination. */
  linkChange(changeId: string): void;
  mutationStarted(): void;
  /** Call only when the mutation implementation proves the destination was untouched. */
  noMutation(): void;
}
type RunInput = { workspace_id: string; tool: FileOperationTool; idempotency_key: string; path: string; payload: unknown; legacyPayload?: unknown; initialStage?: 'preparing' | 'downloading'; maxAttempts?: number; retryableErrors?: string[]; beforeStart?: () => void; afterFinish?: () => void };
const journals = new WeakMap<Store, FileOperationJournal>();
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const validKey = (key: string) => { if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw new AppError('INVALID_IDEMPOTENCY_KEY', 'Use a 1–128 character stable operation ID.'); };

/** Per-file operation journal. It deliberately does not change generic Store retry semantics. */
export class FileOperationJournal {
  private inFlight = new Map<string, Promise<unknown>>();
  constructor(private ctx: ServiceContext) {
    ctx.store.db.exec(`CREATE TABLE IF NOT EXISTS file_operations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_binding TEXT NOT NULL,
      tool TEXT NOT NULL, operation_key TEXT NOT NULL, digest TEXT NOT NULL, path TEXT NOT NULL,
      stage TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      content_sha256 TEXT, content_bytes INTEGER, mutation_started INTEGER NOT NULL DEFAULT 0,
      receipt TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workspace_binding,tool,operation_key)
    ); CREATE TABLE IF NOT EXISTS file_operation_changes (
      operation_id TEXT NOT NULL REFERENCES file_operations(id), change_id TEXT NOT NULL,
      PRIMARY KEY(operation_id,change_id)
    ); UPDATE file_operations SET stage='unknown' WHERE stage IN ('preparing','downloading','committing');`);
  }

  private binding(workspaceId: string) { return initializeIdentity(this.ctx).workspaceIdentity(workspaceId); }
  private row(binding: string, tool: FileOperationTool, key: string) {
    return this.ctx.store.db.prepare('SELECT * FROM file_operations WHERE workspace_binding=? AND tool=? AND operation_key=?').get(binding, tool, key) as OperationRow | undefined;
  }
  private legacy(binding: string, workspaceId: string, tool: FileOperationTool, key: string) {
    if (this.ctx.store.db.prepare('SELECT 1 FROM operations WHERE scope=? AND op_key=?').get(`local-user/${workspaceId}/${tool}`, key)) throw new AppError('LEGACY_OPERATION_UNBOUND', 'This operation key exists in legacy state with unknown workspace ownership. Inspect its original records before another mutation.');
    return this.ctx.store.db.prepare('SELECT digest,status,result FROM operations WHERE scope=? AND op_key=?').get(`workspace:${binding}/${tool}`, key) as LegacyRow | undefined;
  }

  async run<T>(input: RunInput, action: (attempt: FileOperationAttempt) => Promise<T>): Promise<T> {
    validKey(input.idempotency_key);
    const binding = this.binding(input.workspace_id), key = canonical([binding, input.tool, input.idempotency_key]), payloadHash = digest(input.payload);
    const row = this.row(binding, input.tool, input.idempotency_key);
    if (row) {
      if (row.digest !== payloadHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This operation ID was already used with a different destination, file identity, or expected version.');
      if (row.stage === 'done') return JSON.parse(row.receipt!) as T;
      if (this.inFlight.has(key)) return this.inFlight.get(key) as Promise<T>;
      if (row.stage === 'unknown' || ['preparing', 'downloading', 'committing'].includes(row.stage)) throw new AppError('EXECUTION_UNKNOWN', 'A previous file operation may have run. Inspect operation_status using the original tool and operation key; do not replay it with a new key.');
      if (row.stage === 'failed') { const error = JSON.parse(row.error!); throw new AppError(error.code, error.message, error.details); }
      const effectiveMax = Math.min(row.max_attempts, input.maxAttempts ?? row.max_attempts);
      if (effectiveMax < row.max_attempts) this.ctx.store.db.prepare('UPDATE file_operations SET max_attempts=? WHERE id=?').run(effectiveMax, row.id);
      if (row.attempts >= effectiveMax) throw new AppError('FILE_OPERATION_RETRY_LIMIT', 'The bounded retry allowance for this operation is exhausted. Inspect operation_status before any new operation.');
    } else {
      const legacy = this.legacy(binding, input.workspace_id, input.tool, input.idempotency_key);
      if (legacy) {
        if (legacy.digest !== digest(input.legacyPayload ?? input.payload)) throw new AppError('IDEMPOTENCY_CONFLICT', 'This key belongs to an older operation with different recorded arguments. Use operation_status to inspect its historical result; it will not be replayed.');
        if (legacy.status === 'done') return JSON.parse(legacy.result!) as T;
        if (legacy.status === 'failed') { const error = JSON.parse(legacy.result!); throw new AppError(error.code, error.message, error.details); }
        throw new AppError('EXECUTION_UNKNOWN', 'An older attempt may have run. Inspect operation_status before any further write.');
      }
    }
    // Capacity checks happen before consuming an attempt or persisting a failure.
    input.beforeStart?.();
    const id = row?.id ?? randomUUID(), attempts = (row?.attempts ?? 0) + 1, now = new Date().toISOString();
    let mutationStarted = false;
    try {
      if (this.binding(input.workspace_id) !== binding) throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'Workspace identity changed before the file operation started.');
      if (row) this.ctx.store.db.prepare('UPDATE file_operations SET stage=?,attempts=?,max_attempts=?,mutation_started=0,error=NULL,updated_at=? WHERE id=?').run(input.initialStage ?? 'preparing', attempts, Math.min(row.max_attempts, input.maxAttempts ?? row.max_attempts), now, id);
      else this.ctx.store.db.prepare('INSERT INTO file_operations(id,workspace_id,workspace_binding,tool,operation_key,digest,path,stage,attempts,max_attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.workspace_id, binding, input.tool, input.idempotency_key, payloadHash, input.path, input.initialStage ?? 'preparing', attempts, input.maxAttempts ?? 1, now, now);
    } catch (error) { input.afterFinish?.(); throw error; }
    const attempt: FileOperationAttempt = {
      id,
      content: (sha256, sizeBytes) => {
        if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new AppError('FILE_IMPORT_INTEGRITY_ERROR', 'Downloaded content identity is invalid.');
        const existing = this.ctx.store.db.prepare('SELECT content_sha256,content_bytes FROM file_operations WHERE id=?').get(id)!;
        if (existing.content_sha256 !== null && (existing.content_sha256 !== sha256 || existing.content_bytes !== sizeBytes)) throw new AppError('FILE_IMPORT_CONTENT_CHANGED', 'The same file operation received different bytes on a later attempt. The local destination was not changed by this attempt.');
        this.ctx.store.db.prepare('UPDATE file_operations SET content_sha256=?,content_bytes=?,updated_at=? WHERE id=?').run(sha256, sizeBytes, new Date().toISOString(), id);
      },
      mutationStarted: () => { mutationStarted = true; this.ctx.store.db.prepare("UPDATE file_operations SET stage='committing',mutation_started=1,updated_at=? WHERE id=?").run(new Date().toISOString(), id); },
      noMutation: () => { mutationStarted = false; this.ctx.store.db.prepare('UPDATE file_operations SET mutation_started=0,updated_at=? WHERE id=?').run(new Date().toISOString(), id); },
      linkChange: changeId => {
        this.ctx.store.db.prepare('INSERT INTO file_operation_changes(operation_id,change_id) VALUES(?,?)').run(id, changeId);
        attempt.mutationStarted();
      },
    };
    const pending = Promise.resolve().then(() => action(attempt)).then(result => {
      this.ctx.store.db.prepare("UPDATE file_operations SET stage='done',receipt=?,error=NULL,updated_at=? WHERE id=?").run(JSON.stringify(result), new Date().toISOString(), id);
      return result;
    }).catch(error => {
      const safe = errorResult(error).error;
      const stage: Stage = mutationStarted ? 'unknown' : input.retryableErrors?.includes(safe.code) ? 'retryable_failure' : 'failed';
      // Completion receipt persistence can also fail after a successful replacement.
      // Keep that outcome uncertain, even if recording the uncertainty also fails.
      try { this.ctx.store.db.prepare('UPDATE file_operations SET stage=?,error=?,updated_at=? WHERE id=?').run(stage, JSON.stringify(safe), new Date().toISOString(), id); } catch { /* The last durable phase remains available for status inspection. */ }
      throw error;
    }).finally(() => { this.inFlight.delete(key); input.afterFinish?.(); });
    this.inFlight.set(key, pending);
    return pending;
  }

  status(input: { workspace_id: string; tool: FileOperationTool; idempotency_key: string }) {
    validKey(input.idempotency_key);
    const binding = this.binding(input.workspace_id), row = this.row(binding, input.tool, input.idempotency_key);
    if (!row) {
      const legacy = this.legacy(binding, input.workspace_id, input.tool, input.idempotency_key);
      if (!legacy) return { workspace_id: input.workspace_id, tool: input.tool, idempotency_key: input.idempotency_key, found: false as const, stage: 'not_found' as const, path: null, receipt: null, note: 'No durable operation with this key was found. This alone does not prove that no external file changes occurred.' };
      return { workspace_id: input.workspace_id, tool: input.tool, idempotency_key: input.idempotency_key, found: true as const, legacy: true, stage: legacy.status === 'done' ? 'done' : legacy.status === 'failed' ? 'failed' : 'unknown', path: null, receipt: legacy.status === 'done' ? JSON.parse(legacy.result!) : null, error: legacy.status === 'failed' ? JSON.parse(legacy.result!) : null, retryable: false, note: 'Historical legacy record; request path, source content identity and change linkage were not recorded. This status does not retry or migrate it.' };
    }
    const changes = this.ctx.store.db.prepare('SELECT c.id AS change_id,c.path,c.status,c.before_sha256,c.after_sha256 FROM file_changes c JOIN file_operation_changes o ON o.change_id=c.id WHERE o.operation_id=? AND c.workspace_binding=? ORDER BY c.rowid').all(row.id, binding);
    const phase = ['preparing', 'downloading', 'committing'].includes(row.stage) && !this.inFlight.has(canonical([binding, input.tool, input.idempotency_key])) ? 'unknown' : row.stage;
    const maxAttempts = row.tool === 'fs_import_file' ? Math.min(row.max_attempts, this.ctx.config.fileImports?.maxAttempts ?? 3) : row.max_attempts;
    return { workspace_id: input.workspace_id, tool: input.tool, idempotency_key: input.idempotency_key, found: true as const, legacy: false, stage: phase, path: row.path, attempts: row.attempts, max_attempts: maxAttempts, retryable: row.stage === 'retryable_failure' && row.attempts < maxAttempts, content_sha256: row.content_sha256, content_bytes: row.content_bytes, receipt: row.receipt ? JSON.parse(row.receipt) : null, error: row.error ? JSON.parse(row.error) : null, changes, created_at: row.created_at, updated_at: row.updated_at, note: 'Receipt and stage are historical operation records. Current file observations are separate and do not prove which process wrote those bytes. Unknown operations are never automatically resumed.' };
  }
}

export function fileOperations(ctx: ServiceContext) {
  let journal = journals.get(ctx.store);
  if (!journal) { journal = new FileOperationJournal(ctx); journals.set(ctx.store, journal); }
  return journal;
}
