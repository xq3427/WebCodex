import { randomUUID, createHash } from 'node:crypto';
import { AppError, errorResult } from './errors.js';
import { BinaryInputService } from './binary-input.js';
import { binaryChunkLimits } from './binary-limits.js';
import { FileService, hash } from './filesystem.js';
import { fileOperations } from './file-operations.js';
import { initializeIdentity } from './identity.js';
import { canonical } from './store.js';
import type { ServiceContext, Store } from './types.js';

export type BinaryChunkInput = { workspace_id: string; path: string; content_base64: string; chunk_sha256: string; offset_bytes: number; content_sha256: string; size_bytes: number; expected_sha256: string | null; idempotency_key: string };
type Session = { id: string; workspace_id: string; workspace_binding: string; operation_key: string; digest: string; path: string; content_sha256: string; size_bytes: number; expected_sha256: string | null; next_offset: number; stage: 'receiving' | 'finalizing' | 'unknown' | 'failed'; error_code: string | null; expires_at: number };
type Active = { digest: string; promise: Promise<any> };
const activeStores = new WeakMap<Store, Map<string, Active>>();
const shaPattern = /^[a-f0-9]{64}$/i;
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const validKey = (value: string) => { if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) throw new AppError('INVALID_IDEMPOTENCY_KEY', 'Use a 1–128 character stable operation ID.'); };

/** Durable bounded staging. Only a completely verified file reaches the ordinary writer. */
export class BinaryChunkService {
  private active: Map<string, Active>;
  constructor(private ctx: ServiceContext, private files: FileService, private binaryInputs: BinaryInputService) {
    ctx.store.db.exec(`CREATE TABLE IF NOT EXISTS binary_input_sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_binding TEXT NOT NULL,
      operation_key TEXT NOT NULL, digest TEXT NOT NULL, path TEXT NOT NULL,
      content_sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, expected_sha256 TEXT,
      next_offset INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL, error_code TEXT, expires_at INTEGER NOT NULL,
      UNIQUE(workspace_binding,operation_key)
    ); CREATE TABLE IF NOT EXISTS binary_input_chunks (
      session_id TEXT NOT NULL REFERENCES binary_input_sessions(id) ON DELETE CASCADE,
      offset_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY(session_id,offset_bytes)
    );`);
    let active = activeStores.get(ctx.store);
    if (!active) {
      ctx.store.db.exec("UPDATE binary_input_sessions SET stage='unknown' WHERE stage='finalizing'");
      active = new Map(); activeStores.set(ctx.store, active);
    }
    this.active = active;
  }

  private limits() { return binaryChunkLimits(this.ctx.config); }
  private chunkLimit() { return this.limits().chunkMaxBytes; }
  private session(binding: string, key: string) { return this.ctx.store.db.prepare('SELECT * FROM binary_input_sessions WHERE workspace_binding=? AND operation_key=?').get(binding, key) as Session | undefined; }
  private activeKey(binding: string, key: string) { return canonical([binding, key]); }
  private remove(id: string) { this.ctx.store.db.prepare('DELETE FROM binary_input_sessions WHERE id=?').run(id); }
  private prune() {
    const expired = this.ctx.store.db.prepare("SELECT id,workspace_binding,operation_key FROM binary_input_sessions s WHERE expires_at<=? OR EXISTS(SELECT 1 FROM file_operations o WHERE o.workspace_binding=s.workspace_binding AND o.operation_key=s.operation_key AND o.tool='fs_write_binary' AND o.stage='done' AND o.digest=s.digest)").all(Date.now());
    for (const row of expired) if (!this.active.has(this.activeKey(String(row.workspace_binding), String(row.operation_key)))) this.remove(String(row.id));
  }
  private progress(row: Session) {
    const finalChunk = row.stage === 'receiving' && row.next_offset === row.size_bytes
      ? this.ctx.store.db.prepare('SELECT offset_bytes,length(bytes) AS byte_count FROM binary_input_chunks WHERE session_id=? ORDER BY offset_bytes DESC LIMIT 1').get(row.id) : undefined;
    const chunkLimit = this.chunkLimit(), fileLimit = this.limits().fileMaxBytes;
    const blocked = row.stage === 'receiving' && (row.size_bytes > fileLimit || finalChunk !== undefined && Number(finalChunk.byte_count) > chunkLimit);
    return { workspace_id: row.workspace_id, idempotency_key: row.operation_key, path: row.path, status: blocked ? 'blocked' as const : row.stage,
      next_offset: row.next_offset, received_bytes: row.next_offset, total_bytes: row.size_bytes, content_sha256: row.content_sha256,
      chunk_max_bytes: chunkLimit, policy_blocked: blocked,
      ...(blocked ? { recorded_status: row.stage, resume_action: 'inspect_local_limits' as const, error_code: 'BINARY_INPUT_TOO_LARGE',
        policy: { file_limit_bytes: fileLimit, chunk_limit_bytes: chunkLimit, required_file_bytes: row.size_bytes, required_recovery_chunk_bytes: finalChunk ? Number(finalChunk.byte_count) : null },
        recovery: 'Current local limits prevent continuing this retained transfer. Inspect the intended local policy; this status does not write a file or authorize changing limits. Do not split the stored recovery chunk or replay an uncertain write.' }
        : finalChunk ? { resume_action: 'repeat_last_chunk' as const, retry_chunk_offset: Number(finalChunk.offset_bytes), retry_chunk_bytes: Number(finalChunk.byte_count) } : {}),
      whole_file_verified: false, ...(row.error_code ? { error_code: row.error_code } : {}), expires_at: new Date(row.expires_at).toISOString() };
  }
  private saved(receipt: any, operation?: unknown) {
    return { ...receipt, status: 'saved' as const, next_offset: receipt.size_bytes, total_bytes: receipt.size_bytes,
      chunk_max_bytes: this.chunkLimit(), whole_file_verified: true, receipt, ...(operation ? { operation } : {}) };
  }

  async append(input: BinaryChunkInput) {
    validKey(input.idempotency_key);
    if (typeof input.content_base64 !== 'string' || !Number.isSafeInteger(input.offset_bytes) || input.offset_bytes < 0 ||
      !Number.isSafeInteger(input.size_bytes) || input.size_bytes < 0 || typeof input.content_sha256 !== 'string' || !shaPattern.test(input.content_sha256) ||
      typeof input.chunk_sha256 !== 'string' || !shaPattern.test(input.chunk_sha256) ||
      input.expected_sha256 !== null && (typeof input.expected_sha256 !== 'string' || !shaPattern.test(input.expected_sha256))) throw new AppError('BINARY_CHUNK_INVALID', 'Provide a valid byte offset, complete-file size/SHA-256, chunk SHA-256, canonical Base64, and the existing SHA-256 or null.');
    const limits = this.limits(), fullLimit = limits.fileMaxBytes, chunkLimit = limits.chunkMaxBytes;
    if (input.size_bytes > fullLimit || input.content_base64.length > Math.ceil(chunkLimit / 3) * 4) throw new AppError('BINARY_INPUT_TOO_LARGE', 'The file or chunk exceeds its configured binary input limit.', { file_limit_bytes: fullLimit, chunk_limit_bytes: chunkLimit });
    if (input.content_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content_base64)) throw new AppError('BINARY_CHUNK_INVALID', 'Chunk bytes require canonical standard Base64 without whitespace or a data URL.');
    const bytes = Buffer.from(input.content_base64, 'base64');
    if (bytes.toString('base64') !== input.content_base64) throw new AppError('BINARY_CHUNK_INVALID', 'Chunk Base64 is not canonical.');
    if (bytes.length > chunkLimit) throw new AppError('BINARY_INPUT_TOO_LARGE', 'The chunk exceeds its configured byte limit.', { chunk_limit_bytes: chunkLimit });
    if ((!bytes.length && input.size_bytes !== 0) || input.offset_bytes + bytes.length > input.size_bytes) throw new AppError('BINARY_CHUNK_INVALID', 'The chunk must be nonempty and fit within the declared complete file; only an empty file uses an empty chunk.');
    const chunkHash = hash(bytes);
    if (chunkHash !== input.chunk_sha256.toLowerCase()) throw new AppError('BINARY_CHUNK_INTEGRITY_ERROR', 'The decoded chunk does not match chunk_sha256. No chunk or destination file was written.');
    const request = { workspace_id: input.workspace_id, path: input.path, content_sha256: input.content_sha256.toLowerCase(), size_bytes: input.size_bytes,
      expected_sha256: input.expected_sha256?.toLowerCase() ?? null, idempotency_key: input.idempotency_key, offset_bytes: input.offset_bytes };
    await this.ctx.paths.resolve(request.workspace_id, request.path, { write: true, allowMissing: true });
    const binding = initializeIdentity(this.ctx).workspaceIdentity(request.workspace_id), key = this.activeKey(binding, request.idempotency_key);
    const payload = { workspace_id: request.workspace_id, path: request.path, expected_sha256: request.expected_sha256, content_sha256: request.content_sha256, size_bytes: request.size_bytes };
    const requestHash = fingerprint({ ...payload, offset_bytes: request.offset_bytes, chunk_sha256: chunkHash, chunk_size: bytes.length });
    const active = this.active.get(key);
    if (active) {
      if (active.digest !== requestHash) throw new AppError('BINARY_CHUNK_BUSY', 'Another chunk for this operation is active. Wait for its response before sending the next offset.');
      return active.promise;
    }
    const promise = Promise.resolve().then(async () => {
      // Path checks yield to other work. Re-read local policy before reserving
      // staging so a concurrently tightened limit cannot admit the old chunk.
      const limits = this.limits(), chunkLimit = limits.chunkMaxBytes;
      if (request.size_bytes > limits.fileMaxBytes || bytes.length > chunkLimit) throw new AppError('BINARY_INPUT_TOO_LARGE', 'The file or chunk exceeds its current configured binary input limit.', { file_limit_bytes: limits.fileMaxBytes, chunk_limit_bytes: chunkLimit });
      const journal = fileOperations(this.ctx), priorOperation = journal.status({ workspace_id: request.workspace_id, tool: 'fs_write_binary', idempotency_key: request.idempotency_key });
      if (priorOperation.found) {
        // Existing final operations own the key. This verifies the stable payload
        // before returning a historical receipt, or refuses a failed/unknown replay.
        const receipt = await journal.run({ workspace_id: request.workspace_id, tool: 'fs_write_binary', idempotency_key: request.idempotency_key, path: request.path, payload }, async () => { throw new AppError('EXECUTION_UNKNOWN', 'Inspect the existing binary operation; chunk staging cannot restart it.'); });
        const staged = this.session(binding, request.idempotency_key); if (staged) this.remove(staged.id);
        return this.saved(receipt);
      }
      let row = this.session(binding, request.idempotency_key);
      if (row && row.expires_at <= Date.now()) { this.remove(row.id); throw new AppError('BINARY_CHUNK_EXPIRED', 'This incomplete staging session expired. No destination write is reported; inspect status before starting another transfer.'); }
      this.prune();
      const metadataHash = fingerprint(payload);
      if (row && row.digest !== metadataHash) throw new AppError('BINARY_CHUNK_CONFLICT', 'This operation key is bound to a different file, path, size, or expected version.');
      if (row && row.stage !== 'receiving') throw new AppError(row.stage === 'failed' ? row.error_code ?? 'BINARY_CHUNK_INTEGRITY_ERROR' : 'EXECUTION_UNKNOWN', 'This staging session cannot be resumed automatically. Inspect binary transfer and operation status.');
      if (!row) {
        if (request.offset_bytes !== 0) throw new AppError('BINARY_CHUNK_ORDER', 'No active session exists; its first chunk must start at byte zero.', { next_offset: 0 });
        if (bytes.length !== Math.min(chunkLimit, request.size_bytes)) throw new AppError('BINARY_CHUNK_INVALID', 'Each new chunk must contain chunk_max_bytes bytes, except the shorter final chunk. Use the returned next_offset and chunk_max_bytes.');
        const reserved = this.ctx.store.db.prepare('SELECT count(*) AS sessions,coalesce(sum(size_bytes),0) AS bytes FROM binary_input_sessions').get()!;
        if (Number(reserved.sessions) >= limits.maxSessions || Number(reserved.bytes) + request.size_bytes > limits.maxCacheBytes) throw new AppError('BINARY_CHUNK_CAPACITY', 'The bounded staging cache is full. Inspect active transfers and allow incomplete expired staging to clear before starting another.');
        const id = randomUUID();
        this.ctx.store.db.prepare("INSERT INTO binary_input_sessions(id,workspace_id,workspace_binding,operation_key,digest,path,content_sha256,size_bytes,expected_sha256,stage,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'receiving',?)").run(id, request.workspace_id, binding, request.idempotency_key, metadataHash, request.path, request.content_sha256, request.size_bytes, request.expected_sha256, Date.now() + limits.ttlMs);
        row = this.session(binding, request.idempotency_key)!;
      }
      const previous = this.ctx.store.db.prepare('SELECT sha256,bytes FROM binary_input_chunks WHERE session_id=? AND offset_bytes=?').get(row.id, request.offset_bytes);
      if (previous || request.offset_bytes < row.next_offset) {
        if (!previous || previous.sha256 !== chunkHash || !Buffer.from(previous.bytes as Uint8Array).equals(bytes)) throw new AppError('BINARY_CHUNK_CONFLICT', 'A repeated offset must contain exactly the previously accepted chunk bytes.');
        if (row.next_offset < row.size_bytes) return this.progress(row);
      } else {
        if (request.offset_bytes !== row.next_offset) throw new AppError('BINARY_CHUNK_ORDER', 'Send the next contiguous chunk at the returned next_offset.', { next_offset: row.next_offset });
        if (bytes.length !== Math.min(chunkLimit, request.size_bytes - request.offset_bytes)) throw new AppError('BINARY_CHUNK_INVALID', 'Each new chunk must contain chunk_max_bytes bytes, except the shorter final chunk. Exact previously accepted duplicates are allowed within the current limit.');
        this.ctx.store.db.exec('SAVEPOINT append_binary_chunk');
        try {
          this.ctx.store.db.prepare('INSERT INTO binary_input_chunks(session_id,offset_bytes,sha256,bytes) VALUES(?,?,?,?)').run(row.id, request.offset_bytes, chunkHash, bytes);
          this.ctx.store.db.prepare('UPDATE binary_input_sessions SET next_offset=?,expires_at=? WHERE id=?').run(request.offset_bytes + bytes.length, Date.now() + limits.ttlMs, row.id);
          this.ctx.store.db.exec('RELEASE append_binary_chunk');
        } catch (error) { this.ctx.store.db.exec('ROLLBACK TO append_binary_chunk; RELEASE append_binary_chunk'); throw error; }
      }
      row = this.session(binding, request.idempotency_key)!;
      if (row.next_offset < row.size_bytes) return this.progress(row);
      const chunks = this.ctx.store.db.prepare('SELECT offset_bytes,sha256,bytes FROM binary_input_chunks WHERE session_id=? ORDER BY offset_bytes').all(row.id);
      let offset = 0; const parts: Buffer[] = [];
      for (const chunk of chunks) {
        const part = Buffer.from(chunk.bytes as Uint8Array);
        if (chunk.offset_bytes !== offset || hash(part) !== chunk.sha256 || offset + part.length > row.size_bytes) return this.integrityFailure(row);
        parts.push(part); offset += part.length;
      }
      const complete = Buffer.concat(parts);
      if (offset !== row.size_bytes || hash(complete) !== row.content_sha256) return this.integrityFailure(row);
      this.ctx.store.db.prepare("UPDATE binary_input_sessions SET stage='finalizing' WHERE id=?").run(row.id);
      try {
        const receipt = await this.binaryInputs.writeVerifiedBytes({ workspace_id: request.workspace_id, path: request.path,
          content_sha256: request.content_sha256, size_bytes: request.size_bytes, expected_sha256: request.expected_sha256, idempotency_key: request.idempotency_key }, complete);
        if (!receipt.verified || receipt.sha256 !== request.content_sha256 || receipt.size_bytes !== request.size_bytes) throw new AppError('EXECUTION_UNKNOWN', 'The final writer did not return the expected verified receipt. Inspect operation_status before any further write.');
        this.remove(row.id);
        return this.saved(receipt);
      } catch (error) {
        const recorded = journal.status({ workspace_id: request.workspace_id, tool: 'fs_write_binary', idempotency_key: request.idempotency_key });
        this.ctx.store.db.prepare('UPDATE binary_input_sessions SET stage=?,error_code=? WHERE id=?').run(recorded.found && recorded.stage === 'unknown' ? 'unknown' : 'failed', errorResult(error).error.code, row.id);
        throw error;
      }
    }).finally(() => this.active.delete(key));
    this.active.set(key, { digest: requestHash, promise });
    return promise;
  }

  private integrityFailure(row: Session): never {
    this.ctx.store.db.prepare("UPDATE binary_input_sessions SET stage='failed',error_code='BINARY_CHUNK_INTEGRITY_ERROR' WHERE id=?").run(row.id);
    throw new AppError('BINARY_CHUNK_INTEGRITY_ERROR', 'The complete staged file failed its byte-length or SHA-256 check. No destination file was written.');
  }

  async status(input: { workspace_id: string; idempotency_key: string }) {
    validKey(input.idempotency_key);
    await this.ctx.paths.resolve(input.workspace_id, '.', { directory: true });
    const binding = initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id), row = this.session(binding, input.idempotency_key);
    const operation = await this.files.operationStatus({ ...input, tool: 'fs_write_binary' });
    if (operation.found) {
      if (operation.stage === 'done') {
        if (row && (row.path !== operation.path || row.content_sha256 !== operation.receipt.sha256 || row.size_bytes !== operation.receipt.size_bytes)) return { ...input, status: 'conflict', error_code: 'BINARY_CHUNK_CONFLICT', staging: this.progress(row), operation };
        return this.saved(operation.receipt, operation);
      }
      return { ...input, status: operation.stage, operation, next_offset: row?.next_offset ?? null, total_bytes: row?.size_bytes ?? null, chunk_max_bytes: this.chunkLimit() };
    }
    if (row) {
      await this.ctx.paths.resolve(input.workspace_id, row.path, { allowMissing: true });
      if (row.expires_at <= Date.now() && !this.active.has(this.activeKey(binding, input.idempotency_key))) return { ...input, status: 'expired', next_offset: 0, total_bytes: row.size_bytes, chunk_max_bytes: this.chunkLimit(), operation };
      return { ...this.progress(row), operation };
    }
    return { ...input, status: 'not_found', next_offset: 0, total_bytes: null, chunk_max_bytes: this.chunkLimit(), operation };
  }
}
