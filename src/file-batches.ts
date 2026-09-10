import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { AppError, errorResult } from './errors.js';
import { capText, decode, encode, FileService, hash, preparePatchedBytes } from './filesystem.js';
import { boundOperation, initializeIdentity } from './identity.js';
import { canonical } from './store.js';
import { redactSessionText } from './codex-redaction.js';
import type { ServiceContext } from './types.js';
import { assertPatchInputSize } from './patch-limits.js';

export type FileBatchChange =
  | { op: 'write'; path: string; content: string; expected_sha256: string | null }
  | { op: 'patch'; path: string; patch: string; expected_sha256: string }
  | { op: 'delete'; path: string; expected_sha256: string }
  | { op: 'move'; path: string; to: string; expected_sha256: string };
type BatchInput = { workspace_id: string; changes: FileBatchChange[] };
type Step = { index: number; change_index: number; path: string; absolute: string; before: Buffer | null; after: Buffer | null; before_mode: number | null; after_mode: number | null; change_id: string | null };
type BatchRow = { id: string; workspace_id: string; workspace_binding: string; operation_key: string; plan_sha256: string; status: string; summary: string; result: string | null; created_at: string; finished_at: string | null };
type StepRow = { step_index: number; change_index: number; path: string; before_sha256: string | null; after_sha256: string | null; before_mode: number | null; after_mode: number | null; change_id: string | null; status: string; error_code: string | null; rollback_change_id: string | null };
const sha = (bytes: Buffer | null) => bytes === null ? null : hash(bytes);
const stateNote = 'Files are changed sequentially with precondition checks and conditional rollback. This is not an OS-atomic transaction; unrelated processes do not share the service locks.';
const validSha = (value: unknown, absent = false) => (absent && value === null) || (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value));
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const integer = (value: number, min: number, max: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new AppError('INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}.`);
  return value;
};

/** A bounded, journaled sequence of file changes; deliberately not a filesystem transaction. */
export class FileBatchService {
  constructor(private ctx: ServiceContext, private files: FileService) {
    initializeIdentity(ctx);
    ctx.store.db.exec(`CREATE TABLE IF NOT EXISTS file_batches (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_binding TEXT NOT NULL,
      operation_key TEXT NOT NULL, plan_sha256 TEXT NOT NULL, status TEXT NOT NULL,
      summary TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, finished_at TEXT,
      UNIQUE(workspace_binding,operation_key)
    ); CREATE TABLE IF NOT EXISTS file_batch_steps (
      batch_id TEXT NOT NULL REFERENCES file_batches(id), step_index INTEGER NOT NULL,
      change_index INTEGER NOT NULL, path TEXT NOT NULL, before_sha256 TEXT, after_sha256 TEXT,
      change_id TEXT, status TEXT NOT NULL, error_code TEXT, rollback_change_id TEXT,
      PRIMARY KEY(batch_id,step_index)
    );
    UPDATE file_changes SET status='unknown' WHERE status='pending' AND id IN (
      SELECT change_id FROM file_batch_steps WHERE batch_id IN (
        SELECT id FROM file_batches WHERE status IN ('prepared','applying','rolling_back')
      )
    );
    UPDATE file_batches SET status='unknown' WHERE status IN ('prepared','applying','rolling_back');`);
    const columns = new Set(ctx.store.db.prepare('PRAGMA table_info(file_batch_steps)').all().map(row => row.name));
    for (const column of ['before_mode', 'after_mode']) if (!columns.has(column)) ctx.store.db.exec(`ALTER TABLE file_batch_steps ADD COLUMN ${column} INTEGER`);
  }

  private limits() {
    return this.ctx.config.fileBatches ?? { maxFiles: 20, maxTotalBytes: 4_194_304 };
  }

  private relative(workspaceId: string, absolute: string) {
    return path.relative(this.ctx.paths.get(workspaceId).root, absolute).split(path.sep).join('/');
  }

  private async canonicalPath(absolute: string) {
    try { return await fs.realpath(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute)); }
  }

  private async resolve(input: BatchInput, write: boolean) {
    const limit = this.limits();
    if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > limit.maxFiles) throw new AppError('INVALID_ARGUMENT', `changes must contain 1 to ${limit.maxFiles} operations.`);
    const paths = new Set<string>();
    const items: { change: FileBatchChange; absolute: string; relative: string; destination?: string; to?: string }[] = [];
    for (const change of input.changes) {
      if (!change || !['write', 'patch', 'delete', 'move'].includes(change.op) || !validSha(change.expected_sha256, change.op === 'write')) throw new AppError('INVALID_ARGUMENT', 'Each change requires a supported op and an original file SHA-256; only write may use null for an absent file.');
      if (change.op === 'write' && (typeof change.content !== 'string' || Buffer.byteLength(change.content) > this.ctx.config.limits.writeMaxBytes)) throw new AppError('FILE_TOO_LARGE', 'A write content exceeds its byte limit or is not text.');
      if (change.op === 'patch') assertPatchInputSize(change.patch, this.ctx.config.limits.writeMaxBytes);
      // Missing sources are checked by SHA during preparation. Allow resolution here so
      // a completed delete/move can replay its idempotent receipt after the source is gone.
      const absolute = await this.canonicalPath(await this.ctx.paths.resolve(input.workspace_id, change.path, { allowMissing: true, write }));
      const destination = change.op === 'move' ? await this.canonicalPath(await this.ctx.paths.resolve(input.workspace_id, change.to, { allowMissing: true, write })) : undefined;
      for (const name of [absolute, ...(destination ? [destination] : [])]) {
        if (paths.has(key(name))) throw new AppError('BATCH_PATH_CONFLICT', 'Each normalized path may appear only once, including move sources and destinations; chained changes are not supported.');
        paths.add(key(name));
      }
      if (paths.size > limit.maxFiles) throw new AppError('BATCH_TOO_LARGE', 'The batch exceeds the configured path count; a move counts as two paths.');
      items.push({ change, absolute, relative: this.relative(input.workspace_id, absolute), destination, to: destination ? this.relative(input.workspace_id, destination) : undefined });
    }
    return { items, paths: items.flatMap(item => [item.absolute, ...(item.destination ? [item.destination] : [])]) };
  }

  private assertHash(bytes: Buffer | null, expected: string | null, relative: string) {
    if (sha(bytes) !== (expected?.toLowerCase() ?? null)) throw new AppError('VERSION_CONFLICT', 'A batch file no longer matches its expected SHA-256.', { path: relative, expected_sha256: expected, actual_sha256: sha(bytes) });
  }

  private async prepare(input: BatchInput, write: boolean) {
    const resolved = await this.resolve(input, write);
    const identity = initializeIdentity(this.ctx);
    const binding = identity.workspaceIdentity(input.workspace_id);
    const steps: Step[] = [];
    const items = [];
    let total = 0;
    for (const [index, item] of resolved.items.entries()) {
      const { change, absolute, relative, destination, to } = item;
      const before = await this.files.snapshotForBatch(absolute);
      this.assertHash(before, change.expected_sha256, relative);
      const beforeMode = await this.files.modeForBatch(absolute);
      let after: Buffer | null;
      if (change.op === 'write') after = encode(change.content, before === null ? { encoding: 'utf8', bom: false, newline: 'none' } : decode(before).format);
      else if (change.op === 'patch') after = preparePatchedBytes(relative, before!, change.patch);
      else if (change.op === 'move') after = before;
      else after = null;
      const afterMode = after === null ? null : beforeMode ?? (process.platform === 'win32' ? 0o666 : 0o600);
      if ((after?.length ?? 0) > this.ctx.config.limits.writeMaxBytes) throw new AppError('FILE_TOO_LARGE', 'Encoded output exceeds the per-file write limit.');
      // Count every retained before-image and planned after-image, including both move paths.
      total += (before?.length ?? 0) + (after?.length ?? 0);
      if (total > this.limits().maxTotalBytes) throw new AppError('BATCH_TOO_LARGE', 'The batch before-images and after-images exceed maxTotalBytes.', { total_bytes: total, limit: this.limits().maxTotalBytes });
      if (destination) {
        this.assertHash(await this.files.snapshotForBatch(destination), null, to!);
        steps.push({ index: steps.length, change_index: index, path: to!, absolute: destination, before: null, after, before_mode: null, after_mode: afterMode, change_id: null });
        steps.push({ index: steps.length, change_index: index, path: relative, absolute, before, after: null, before_mode: beforeMode, after_mode: null, change_id: null });
      } else steps.push({ index: steps.length, change_index: index, path: relative, absolute, before, after, before_mode: beforeMode, after_mode: afterMode, change_id: null });
      items.push({ index, op: change.op, path: relative, ...(to ? { to } : {}), before_sha256: sha(before), after_sha256: sha(after), before_mode: beforeMode, after_mode: afterMode, before_bytes: before?.length ?? 0, after_bytes: after?.length ?? 0, changed: change.op === 'move' || sha(before) !== sha(after), before, after });
    }
    // Validate all original images again before returning a plan or persisting backups.
    await this.recheck(input.workspace_id, binding, steps, write);
    const summaries = items.map(({ before: _before, after: _after, ...summary }) => summary);
    const requests = resolved.items.map(item => ({ op: item.change.op, path: item.relative, to: item.to, expected_sha256: item.change.expected_sha256?.toLowerCase() ?? null, ...(item.change.op === 'write' ? { content_sha256: hash(Buffer.from(item.change.content)) } : item.change.op === 'patch' ? { patch_sha256: hash(Buffer.from(item.change.patch)) } : {}) }));
    const planHash = hash(Buffer.from(canonical({ version: 1, device_id: identity.deviceId, workspace_binding: binding, requests, changes: summaries })));
    return { binding, steps, items, summaries, planHash, total };
  }

  private async recheck(workspaceId: string, binding: string, steps: Step[], write: boolean) {
    if (initializeIdentity(this.ctx).workspaceIdentity(workspaceId) !== binding) throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'The workspace identity changed.');
    for (const step of steps) {
      const absolute = await this.ctx.paths.resolve(workspaceId, step.path, { allowMissing: true, write });
      this.assertHash(await this.files.snapshotForBatch(absolute), sha(step.before), step.path);
      if (await this.files.modeForBatch(absolute) !== step.before_mode) throw new AppError('VERSION_CONFLICT', 'A file permission mode changed during batch preparation.', { path: step.path });
    }
  }

  async preview(input: BatchInput & { max_bytes?: number }) {
    const max = integer(input.max_bytes ?? this.ctx.config.limits.readMaxBytes, 1, this.ctx.config.limits.readMaxBytes, 'max_bytes');
    const resolved = await this.resolve(input, false);
    return this.files.withPathsLocked(resolved.paths, async () => {
      const plan = await this.prepare(input, false);
      let remaining = max;
      const changes = plan.items.map(({ before, after, ...item }) => {
        let diff: string | undefined;
        let reason: string | null = null;
        let redactions = 0;
        try {
          if (item.op === 'move') diff = `Move ${item.path} to ${item.to}; file bytes unchanged.\n`;
          else {
            const oldText = redactSessionText(before === null ? '' : decode(before).text);
            const newText = redactSessionText(after === null ? '' : decode(after).text);
            redactions = oldText.redactions + newText.redactions;
            diff = createTwoFilesPatch(before === null ? '/dev/null' : `a/${item.path}`, after === null ? '/dev/null' : `b/${item.path}`, oldText.text, newText.text, undefined, undefined, { context: 3, timeout: 1000, maxEditLength: 20_000 });
          }
          if (diff === undefined) reason = 'DIFF_TOO_COMPLEX';
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          reason = error.code;
        }
        const output = diff === undefined ? { text: '', truncated: true } : capText(diff, remaining);
        remaining -= Buffer.byteLength(output.text);
        return { ...item, diff: output.text, diff_redacted: redactions > 0, redactions, diff_bytes: diff === undefined ? null : Buffer.byteLength(diff), diff_truncated: output.truncated, diff_omission: reason ?? (output.truncated ? 'RESPONSE_BUDGET' : null) };
      });
      return { workspace_id: input.workspace_id, plan_sha256: plan.planHash, changes, total_bytes: plan.total, path_count: plan.steps.length, returned_diff_bytes: max - remaining, max_bytes: max, truncated: changes.some(item => item.diff_truncated), persisted: false, atomic: false, note: stateNote };
    });
  }

  async apply(input: BatchInput & { expected_plan_sha256: string; idempotency_key: string }) {
    if (!validSha(input.expected_plan_sha256)) throw new AppError('INVALID_ARGUMENT', 'expected_plan_sha256 must be the SHA-256 returned by fs_batch_preview.');
    // Resolve policy before looking up an idempotent result, including current read-only policy.
    const resolved = await this.resolve(input, true);
    return boundOperation(this.ctx, input.workspace_id, 'fs_batch_apply', input.idempotency_key, input, () => this.files.withPathsLocked(resolved.paths, async () => {
      const plan = await this.prepare(input, true);
      if (plan.planHash !== input.expected_plan_sha256.toLowerCase()) throw new AppError('BATCH_PLAN_CONFLICT', 'The proposed changes do not match the preview. Request a new preview before applying.');
      const id = randomUUID();
      const db = this.ctx.store.db;
      // All backups and the journal exist before the first project-file mutation.
      db.exec('SAVEPOINT prepare_file_batch');
      try {
        db.prepare('INSERT INTO file_batches(id,workspace_id,workspace_binding,operation_key,plan_sha256,status,summary,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, input.workspace_id, plan.binding, input.idempotency_key, plan.planHash, 'prepared', JSON.stringify(plan.summaries), new Date().toISOString());
        for (const step of plan.steps) {
          step.change_id = this.files.prepareBatchChange(input.workspace_id, step.path, step.before, step.after, { beforeMode: step.before_mode, afterMode: step.after_mode });
          db.prepare('INSERT INTO file_batch_steps(batch_id,step_index,change_index,path,before_sha256,after_sha256,before_mode,after_mode,change_id,status) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, step.index, step.change_index, step.path, sha(step.before), sha(step.after), step.before_mode, step.after_mode, step.change_id, step.change_id ? 'prepared' : 'unchanged');
        }
        db.exec('RELEASE prepare_file_batch');
      } catch (error) { db.exec('ROLLBACK TO prepare_file_batch; RELEASE prepare_file_batch'); throw error; }
      db.prepare("UPDATE file_batches SET status='applying' WHERE id=?").run(id);
      let failure: ReturnType<typeof errorResult>['error'] | null = null;
      const completed: Step[] = [];
      for (const step of plan.steps) {
        if (!step.change_id) continue;
        try {
          db.prepare("UPDATE file_batch_steps SET status='applying' WHERE batch_id=? AND step_index=?").run(id, step.index);
          await this.files.commitForBatch(input.workspace_id, step.path, step.absolute, step.before, step.after, step.change_id, null, { beforeMode: step.before_mode, afterMode: step.after_mode });
          completed.push(step);
          db.prepare("UPDATE file_batch_steps SET status='applied' WHERE batch_id=? AND step_index=?").run(id, step.index);
        } catch (error) {
          failure = errorResult(error).error;
          failure = { ...failure, details: failure.details ?? null };
          const saved = db.prepare('SELECT status FROM file_changes WHERE id=?').get(step.change_id);
          const uncertain = saved?.status === 'unknown' || saved?.status === 'applied';
          db.prepare('UPDATE file_batch_steps SET status=?,error_code=? WHERE batch_id=? AND step_index=?').run(uncertain ? 'unknown' : 'failed', failure.code, id, step.index);
          // A commit that reports unknown is not safely reversible from a guessed observation.
          break;
        }
      }
      if (failure) {
        db.prepare("UPDATE file_batches SET status='rolling_back' WHERE id=?").run(id);
        for (const step of completed.reverse()) {
          try {
            await this.ctx.paths.resolve(input.workspace_id, step.path, { write: true, allowMissing: true });
            this.assertHash(await this.files.snapshotForBatch(step.absolute), sha(step.after), step.path);
            const restored = await this.files.commitForBatch(input.workspace_id, step.path, step.absolute, step.after, step.before, undefined, step.change_id, { beforeMode: step.after_mode, afterMode: step.before_mode });
            db.prepare("UPDATE file_batch_steps SET status='rolled_back',rollback_change_id=? WHERE batch_id=? AND step_index=?").run(restored.change_id, id, step.index);
          } catch (error) {
            db.prepare("UPDATE file_batch_steps SET status='rollback_conflict',error_code=? WHERE batch_id=? AND step_index=?").run(errorResult(error).error.code, id, step.index);
          }
        }
        db.prepare("UPDATE file_changes SET status='failed',error='BATCH_ABORTED' WHERE status='pending' AND id IN (SELECT change_id FROM file_batch_steps WHERE batch_id=?)").run(id);
        db.prepare("UPDATE file_batch_steps SET status='not_applied' WHERE batch_id=? AND status='prepared'").run(id);
      }
      const steps = this.rows(id);
      const status = !failure ? 'applied' : steps.some(step => ['unknown', 'rollback_conflict'].includes(step.status)) ? 'partial' : 'rolled_back';
      const result = { workspace_id: input.workspace_id, batch_id: id, plan_sha256: plan.planHash, status, changes: plan.summaries, steps, error: failure, atomic: false, note: stateNote };
      // Save the final result and its idempotency receipt in the same SQLite transaction.
      db.exec('SAVEPOINT finish_file_batch');
      try {
        db.prepare('UPDATE file_batches SET status=?,result=?,finished_at=? WHERE id=?').run(status, JSON.stringify(result), new Date().toISOString(), id);
        db.prepare("UPDATE operations SET status='done',result=? WHERE scope=? AND op_key=?").run(JSON.stringify(result), 'workspace:' + plan.binding + '/fs_batch_apply', input.idempotency_key);
        db.exec('RELEASE finish_file_batch');
      } catch (error) { db.exec('ROLLBACK TO finish_file_batch; RELEASE finish_file_batch'); throw error; }
      this.ctx.store.audit('fs_batch_apply', input.workspace_id, { batch_id: id, status, paths: steps.length });
      return result;
    }));
  }

  private rows(id: string): StepRow[] {
    return this.ctx.store.db.prepare('SELECT step_index,change_index,path,before_sha256,after_sha256,before_mode,after_mode,change_id,status,error_code,rollback_change_id FROM file_batch_steps WHERE batch_id=? ORDER BY step_index').all(id).map(row => ({ ...row })) as StepRow[];
  }

  async status(input: { workspace_id: string; idempotency_key: string }) {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.idempotency_key)) throw new AppError('INVALID_IDEMPOTENCY_KEY', 'Use a 1–128 character stable operation ID.');
    await this.ctx.paths.resolve(input.workspace_id, '.', { directory: true });
    const binding = initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    const row = this.ctx.store.db.prepare('SELECT * FROM file_batches WHERE workspace_binding=? AND operation_key=?').get(binding, input.idempotency_key) as BatchRow | undefined;
    if (!row) return { workspace_id: input.workspace_id, exists: false as const, batch_id: null, status: 'not_found', note: 'No batch journal exists for this operation key in this workspace. An initial precondition failure creates no journal; do not infer whether unrelated file changes occurred.' };
    const steps = this.rows(row.id);
    let observedBytes = 0;
    const observations = [];
    for (const step of steps) {
      try {
        if (observedBytes >= this.limits().maxTotalBytes) throw new AppError('BATCH_TOO_LARGE', 'Current file observations exceeded the batch byte budget.');
        const absolute = await this.ctx.paths.resolve(input.workspace_id, step.path, { allowMissing: true });
        const budget = this.limits().maxTotalBytes - observedBytes;
        // Reserve the remaining budget before IO. On uncertain post-read errors
        // it remains spent; a later path must not reuse an unprovable allowance.
        observedBytes += budget;
        const current = await this.files.snapshotForBatch(absolute, budget);
        observedBytes -= budget;
        observedBytes += current?.length ?? 0;
        if (observedBytes > this.limits().maxTotalBytes) throw new AppError('BATCH_TOO_LARGE', 'Current file observations exceeded the batch byte budget.');
        const currentHash = sha(current);
        const currentMode = await this.files.modeForBatch(absolute);
        observations.push({ step_index: step.step_index, path: step.path, current_sha256: currentHash, current_mode: currentMode, matches: currentHash === step.before_sha256 && currentHash === step.after_sha256 ? 'both' : currentHash === step.before_sha256 ? 'before' : currentHash === step.after_sha256 ? 'after' : 'neither', mode_matches: currentMode === step.before_mode && currentMode === step.after_mode ? 'both' : currentMode === step.before_mode ? 'before' : currentMode === step.after_mode ? 'after' : 'neither', error_code: null });
      } catch (error) { observations.push({ step_index: step.step_index, path: step.path, current_sha256: null, current_mode: null, matches: 'unknown', mode_matches: 'unknown', error_code: errorResult(error).error.code }); }
    }
    initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    return { workspace_id: input.workspace_id, exists: true as const, batch_id: row.id, status: row.status, plan_sha256: row.plan_sha256, changes: JSON.parse(row.summary), steps, recorded_result: row.result ? JSON.parse(row.result) : null, observations, observations_atomic: false, created_at: row.created_at, finished_at: row.finished_at, note: 'Recorded progress and current byte observations are separate facts. Matching hashes do not prove which process wrote a file. Unknown batches are never automatically resumed. ' + stateNote };
  }
}
