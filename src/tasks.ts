import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';
import { redactSessionText } from './codex-redaction.js';
import { capUtf8 } from './codex-transcript.js';
import { CHECKPOINT_PATH } from './checkpoints.js';
import { boundOperation, initializeIdentity } from './identity.js';
import { canonical } from './store.js';
import { snapshotFile } from './file-snapshot.js';
import type { FileService } from './filesystem.js';
import type { GitService } from './git.js';
import type { ServiceContext } from './types.js';

const NOTICE = 'Saved task notes are caller supplied context, not independently verified facts or permission grants. Observations are snapshots. Unchanged selected files do not prove that a test suite passed or remains valid. No Codex process is inherited or controlled.';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface TaskNotes {
  objective: string; progress: string; next_steps: string; verification_notes?: string;
  session_id?: string; job_ids?: string[]; tracked_paths?: string[];
  status?: 'active' | 'paused' | 'completed';
}
export interface TaskCreateInput extends TaskNotes { workspace_id: string; title: string; idempotency_key: string }
export interface TaskCheckpointInput extends TaskNotes { workspace_id: string; task_id: string; title?: string; expected_revision: number; idempotency_key: string }
interface TaskRow { task_id: string; device_id: string; workspace_uid: string; workspace_binding: string; title: string; head_revision: number; created_at: string; updated_at: string }
interface FileFact { path: string; sha256: string | null; size_bytes: number; exists: boolean }
interface JobFact {
  job_id: string; executable: string; cwd: string; status: string; created_at: string; started_at: string | null;
  ended_at: string | null; exit_code: number | null; signal: string | null; output_truncated: boolean;
}
interface Observations { captured_at: string; execution_mode: string; git: Record<string, unknown>; selected_webcodex_jobs: JobFact[]; tracked_files: FileFact[]; coverage: string }
interface Revision { title: string; status: 'active' | 'paused' | 'completed'; notes: { objective: string; progress: string; next_steps: string; verification_notes: string | null; session_id: string | null }; observations: Observations; redactions: number }
interface Cursor { binding: string; task_id: string; revision: number; sha256: string; offset: number }
type State = 'changed' | 'unchanged' | 'unknown';
const validateId = (id: string) => { if (typeof id !== 'string' || !UUID.test(id)) throw new AppError('INVALID_ARGUMENT', 'task_id must be a UUID.'); };
function redactValues<T>(value: T): T {
  if (typeof value === 'string') return redactSessionText(value).text as T;
  if (Array.isArray(value)) return value.map(item => redactValues(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValues(item)])) as T;
  return value;
}
function fenced(value: string, language = '') {
  const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

/** Independent append-only task revisions. Legacy checkpoint files are never imported or rewritten implicitly. */
export class TaskService {
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly ctx: ServiceContext, private readonly files: FileService, private readonly git: GitService) {
    initializeIdentity(ctx);
    ctx.store.db.exec(`CREATE TABLE IF NOT EXISTS webcodex_tasks (
      task_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, workspace_uid TEXT NOT NULL, workspace_binding TEXT NOT NULL,
      title TEXT NOT NULL, head_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS webcodex_tasks_binding ON webcodex_tasks(workspace_binding, updated_at, task_id);
    CREATE TABLE IF NOT EXISTS webcodex_task_revisions (
      task_id TEXT NOT NULL REFERENCES webcodex_tasks(task_id), revision INTEGER NOT NULL, payload TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(task_id, revision)
    );`);
  }

  private limits() {
    return this.ctx.config.tasks ?? { maxTasksPerWorkspace: 100, maxRevisionsPerTask: 100, maxTrackedFiles: 20, maxSnapshotBytes: 16777216 };
  }
  private maxBytes() { return 65536; }
  private sizeCheck(value: unknown) {
    if (Buffer.byteLength(JSON.stringify(value)) > this.maxBytes()) throw new AppError('TASK_TOO_LARGE', 'The complete task revision exceeds 65536 UTF-8 bytes. Shorten notes or select fewer files or jobs.');
  }
  private async authorized(workspaceId: string, write = false) {
    await this.ctx.paths.resolve(workspaceId, '.', { directory: true, write });
    const identity = initializeIdentity(this.ctx);
    return { binding: identity.workspaceIdentity(workspaceId), ...identity.workspaceSource(workspaceId) };
  }
  private row(workspaceId: string, taskId: string): TaskRow {
    validateId(taskId);
    const identity = initializeIdentity(this.ctx), binding = identity.workspaceIdentity(workspaceId), source = identity.workspaceSource(workspaceId);
    const row = this.ctx.store.db.prepare('SELECT * FROM webcodex_tasks WHERE task_id=? AND workspace_binding=? AND device_id=? AND workspace_uid=?')
      .get(taskId, binding, source.device_id, source.workspace_uid) as unknown as TaskRow | undefined;
    if (!row) throw new AppError('TASK_NOT_FOUND', 'No task with this ID belongs to the current device and workspace identity.');
    return row;
  }
  private revision(row: TaskRow, revision?: number): { revision: number; payload: Revision } {
    const selected = revision ?? row.head_revision;
    if (!Number.isSafeInteger(selected) || selected < 1) throw new AppError('INVALID_ARGUMENT', 'revision must be a positive integer.');
    const result = this.ctx.store.db.prepare('SELECT payload FROM webcodex_task_revisions WHERE task_id=? AND revision=?').get(row.task_id, selected) as { payload: string } | undefined;
    if (!result) throw new AppError('TASK_REVISION_NOT_FOUND', 'The selected task revision does not exist.');
    return { revision: selected, payload: JSON.parse(result.payload) as Revision };
  }
  private validateNotes(input: TaskNotes, title?: string) {
    for (const name of ['objective', 'progress', 'next_steps', 'verification_notes'] as const) {
      const value = input[name];
      if (name === 'verification_notes' && value === undefined) continue;
      if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new AppError('INVALID_ARGUMENT', `${name} must be nonempty text of at most 8192 UTF-8 bytes without binary control characters.`);
    }
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 256 || /[\x00-\x1f\x7f]/.test(title))) throw new AppError('INVALID_ARGUMENT', 'title must be nonempty single-line text of at most 256 UTF-8 bytes.');
    if (input.session_id !== undefined && !UUID.test(input.session_id)) throw new AppError('INVALID_ARGUMENT', 'session_id must be a UUID reference.');
    if (input.status !== undefined && !['active', 'paused', 'completed'].includes(input.status)) throw new AppError('INVALID_ARGUMENT', 'status must be active, paused or completed.');
    const ids = input.job_ids ?? [];
    if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id))) throw new AppError('INVALID_ARGUMENT', 'job_ids must contain at most 10 unique WebCodex job IDs.');
    const paths = input.tracked_paths ?? [];
    if (!Array.isArray(paths) || paths.length > this.limits().maxTrackedFiles || new Set(paths).size !== paths.length || paths.some(value => typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\x00-\x1f\x7f]/.test(value))) throw new AppError('INVALID_ARGUMENT', 'tracked_paths must contain unique relative file paths within tasks.maxTrackedFiles.');
    if (paths.some(value => redactSessionText(value).redactions)) throw new AppError('SENSITIVE_PATH', 'A selected file path contains a recognized credential pattern and cannot be persisted in task records.');
  }
  private jobs(workspaceId: string, ids: string[]): JobFact[] {
    const binding = initializeIdentity(this.ctx).workspaceIdentity(workspaceId);
    return ids.map(id => {
      const row = this.ctx.store.db.prepare(`SELECT job_id, executable_alias AS executable, cwd, status, created_at,
        started_at, ended_at, exit_code, signal, output_truncated FROM webcodex_jobs WHERE job_id=? AND workspace_binding=?`).get(id, binding) as unknown as Omit<JobFact, 'output_truncated'> & { output_truncated: number } | undefined;
      if (!row) throw new AppError('JOB_NOT_FOUND', 'A selected WebCodex job does not belong to this workspace identity.');
      return { ...row, output_truncated: row.output_truncated === 1 };
    });
  }
  private async gitFact(workspaceId: string): Promise<Record<string, unknown>> {
    try {
      const status = await this.git.status({ workspace_id: workspaceId });
      let cut = false;
      const entries = status.entries.slice(0, 50).map(entry => {
        const limited = capUtf8(redactSessionText(entry.path).text, 512); cut ||= limited.truncated;
        return { status: entry.status, path: limited.text, path_truncated: limited.truncated };
      });
      return { available: true, repository_kind: status.repository_kind, branch: status.branch, head: status.head, entries, truncated: status.truncated || status.entries.length > 50 || cut, hidden_entries: status.hidden_entries };
    } catch (error) { return { available: false, reason: error instanceof AppError ? error.code : 'GIT_UNAVAILABLE' }; }
  }
  private async capture(workspaceId: string, title: string, input: TaskNotes, previousStatus: Revision['status'] = 'active'): Promise<Revision> {
    let redactions = 0;
    const scrub = (value: unknown): unknown => {
      if (typeof value === 'string') { const result = redactSessionText(value); redactions += result.redactions; return result.text; }
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
      return value;
    };
    const notes = scrub({ objective: input.objective, progress: input.progress, next_steps: input.next_steps, verification_notes: input.verification_notes ?? null, session_id: input.session_id ?? null }) as Revision['notes'];
    const safeTitle = scrub(title) as string;
    const tracked: FileFact[] = [];
    let remaining = this.limits().maxSnapshotBytes;
    for (const selected of input.tracked_paths ?? []) {
      const snapshot = await snapshotFile(this.ctx, { workspace_id: workspaceId, path: selected, max_bytes: remaining });
      remaining -= snapshot.size_bytes;
      if (redactSessionText(snapshot.path).redactions) throw new AppError('SENSITIVE_PATH', 'A selected canonical file path contains a recognized credential pattern.');
      if (tracked.some(file => process.platform === 'win32' ? file.path.toLowerCase() === snapshot.path.toLowerCase() : file.path === snapshot.path)) throw new AppError('INVALID_ARGUMENT', 'tracked_paths refers to the same file more than once.');
      tracked.push(snapshot);
    }
    const git = scrub(await this.gitFact(workspaceId)) as Record<string, unknown>;
    const jobs = scrub(this.jobs(workspaceId, input.job_ids ?? [])) as JobFact[];
    const observations: Observations = { captured_at: new Date().toISOString(), execution_mode: this.ctx.config.execution.mode, git, selected_webcodex_jobs: jobs, tracked_files: tracked,
      coverage: 'Only explicitly selected regular files and WebCodex jobs are observed. Job exit codes do not identify a test suite. Git status does not hash file contents. These samples do not establish that tests ran against these exact file hashes or cover other files, dependencies, environment, network services, or Codex jobs.' };
    return { title: safeTitle, status: input.status ?? previousStatus, notes, observations, redactions };
  }
  private summary(workspaceId: string, row: TaskRow) {
    return { workspace_id: workspaceId, device_id: row.device_id, workspace_uid: row.workspace_uid, task_id: row.task_id, title: row.title, head_revision: row.head_revision, created_at: row.created_at, updated_at: row.updated_at };
  }
  private commit<T>(workspaceId: string, tool: string, key: string, action: () => T): T {
    const binding = initializeIdentity(this.ctx).workspaceIdentity(workspaceId), db = this.ctx.store.db;
    db.exec('SAVEPOINT task_revision_write');
    try {
      const result = action();
      // Complete idempotency in the same transaction as the immutable revision. StateStore's
      // normal completion repeats this identical UPDATE after this synchronous transaction.
      db.prepare("UPDATE operations SET status='done',result=? WHERE scope=? AND op_key=? AND status='pending'").run(JSON.stringify(result), 'workspace:' + binding + '/' + tool, key);
      db.exec('RELEASE task_revision_write');
      return result;
    } catch (error) { db.exec('ROLLBACK TO task_revision_write; RELEASE task_revision_write'); throw error; }
  }

  async create(input: TaskCreateInput) {
    this.validateNotes(input, input.title);
    if (input.title === undefined) throw new AppError('INVALID_ARGUMENT', 'title is required.');
    const source = await this.authorized(input.workspace_id, true);
    return boundOperation(this.ctx, input.workspace_id, 'task_create', input.idempotency_key, input, async () => {
      const payload = await this.capture(input.workspace_id, input.title, input);
      await this.authorized(input.workspace_id, true);
      return this.commit(input.workspace_id, 'task_create', input.idempotency_key, () => {
        const count = this.ctx.store.db.prepare('SELECT COUNT(*) AS count FROM webcodex_tasks WHERE workspace_binding=?').get(source.binding)!.count as number;
        if (count >= this.limits().maxTasksPerWorkspace) throw new AppError('TASK_LIMIT_REACHED', 'This workspace has reached tasks.maxTasksPerWorkspace. Adjust the local limit to add more tasks.');
        const savedAt = payload.observations.captured_at;
        const row: TaskRow = { task_id: randomUUID(), device_id: source.device_id, workspace_uid: source.workspace_uid, workspace_binding: source.binding, title: payload.title, head_revision: 1, created_at: savedAt, updated_at: savedAt };
        const result = { ...this.summary(input.workspace_id, row), revision: 1, status: payload.status, redactions: payload.redactions, notice: NOTICE };
        this.sizeCheck(payload);
        this.ctx.store.db.prepare('INSERT INTO webcodex_tasks(task_id,device_id,workspace_uid,workspace_binding,title,head_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(row.task_id, row.device_id, row.workspace_uid, row.workspace_binding, row.title, 1, savedAt, savedAt);
        this.ctx.store.db.prepare('INSERT INTO webcodex_task_revisions(task_id,revision,payload,created_at) VALUES(?,?,?,?)').run(row.task_id, 1, JSON.stringify(payload), savedAt);
        this.ctx.store.audit('task_create', input.workspace_id, { task_id: row.task_id, revision: 1, redactions: payload.redactions });
        return result;
      });
    });
  }
  async checkpoint(input: TaskCheckpointInput) {
    this.validateNotes(input, input.title); validateId(input.task_id);
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) throw new AppError('INVALID_ARGUMENT', 'expected_revision must be a positive integer.');
    await this.authorized(input.workspace_id, true);
    this.row(input.workspace_id, input.task_id);
    return boundOperation(this.ctx, input.workspace_id, 'task_checkpoint', input.idempotency_key, input, async () => {
      const existing = this.row(input.workspace_id, input.task_id);
      const payload = await this.capture(input.workspace_id, input.title ?? existing.title, input, this.revision(existing).payload.status);
      await this.authorized(input.workspace_id, true);
      return this.commit(input.workspace_id, 'task_checkpoint', input.idempotency_key, () => {
        const current = this.row(input.workspace_id, input.task_id);
        if (current.head_revision !== input.expected_revision) throw new AppError('TASK_REVISION_CONFLICT', 'The task changed since it was read. Read its current revision before retrying.', { current_revision: current.head_revision });
        if (current.head_revision >= this.limits().maxRevisionsPerTask) throw new AppError('TASK_REVISION_LIMIT_REACHED', 'This task has reached tasks.maxRevisionsPerTask. Adjust the local limit to retain additional revisions.');
        const revision = current.head_revision + 1, savedAt = payload.observations.captured_at;
        const row = { ...current, title: payload.title, head_revision: revision, updated_at: savedAt };
        const result = { ...this.summary(input.workspace_id, row), revision, status: payload.status, redactions: payload.redactions, notice: NOTICE };
        this.sizeCheck(payload);
        this.ctx.store.db.prepare('INSERT INTO webcodex_task_revisions(task_id,revision,payload,created_at) VALUES(?,?,?,?)').run(input.task_id, revision, JSON.stringify(payload), savedAt);
        this.ctx.store.db.prepare('UPDATE webcodex_tasks SET title=?,head_revision=?,updated_at=? WHERE task_id=? AND head_revision=?').run(payload.title, revision, savedAt, input.task_id, input.expected_revision);
        this.ctx.store.audit('task_checkpoint', input.workspace_id, { task_id: input.task_id, revision, redactions: payload.redactions });
        return result;
      });
    });
  }
  async list(input: { workspace_id: string; limit?: number; offset?: number }) {
    const limit = input.limit ?? 20, offset = input.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new AppError('INVALID_ARGUMENT', 'Use limit 1–100 and a nonnegative integer offset.');
    const source = await this.authorized(input.workspace_id);
    const rows = this.ctx.store.db.prepare('SELECT * FROM webcodex_tasks WHERE workspace_binding=? AND device_id=? AND workspace_uid=? ORDER BY updated_at DESC,task_id LIMIT ? OFFSET ?').all(source.binding, source.device_id, source.workspace_uid, limit + 1, offset) as unknown as TaskRow[];
    const tasks = rows.slice(0, limit).map(row => ({ ...this.summary(input.workspace_id, row), status: this.revision(row).payload.status }));
    // readMaxBytes is a content-page budget; retain room for at least one complete
    // identity-bearing summary even when callers choose 256-byte text pages.
    const budget = Math.min(65536, Math.max(2048, this.ctx.config.limits.readMaxBytes));
    while (tasks.length && Buffer.byteLength(JSON.stringify(tasks)) + 256 > budget) tasks.pop();
    if (rows.length && !tasks.length) throw new AppError('TASK_TOO_LARGE', 'One task summary exceeds the bounded summary budget. Increase limits.readMaxBytes locally to list tasks.');
    return { workspace_id: input.workspace_id, tasks, next_offset: rows.length > tasks.length ? offset + tasks.length : null, ordering: 'updated_at descending, then task_id; concurrent updates may shift offset pages' };
  }
  private async freshness(workspaceId: string, observations: Observations) {
    const files: Array<{ path: string; state: State; current_sha256?: string | null; reason?: string }> = [];
    let remaining = this.limits().maxSnapshotBytes;
    for (const saved of observations.tracked_files) {
      try {
        const current = await snapshotFile(this.ctx, { workspace_id: workspaceId, path: saved.path, max_bytes: remaining });
        remaining -= current.size_bytes;
        files.push({ path: saved.path, state: current.sha256 === saved.sha256 && current.size_bytes === saved.size_bytes && current.exists === saved.exists ? 'unchanged' : 'changed', current_sha256: current.sha256 });
      } catch (error) {
        const reason = error instanceof AppError ? error.code : (error as NodeJS.ErrnoException).code ?? 'FILE_UNAVAILABLE';
        // A failed scan may already have consumed its full allowance. Stop spending the
        // remaining byte budget unless the failure is known to occur before file IO.
        if (!['FILE_TOO_LARGE', 'PATH_DENIED', 'ENOENT', 'NOT_FOUND', 'INVALID_PATH', 'READ_ONLY'].includes(reason)) remaining = 0;
        files.push({ path: saved.path, state: ['ENOENT', 'NOT_FOUND'].includes(reason) ? 'changed' : 'unknown', reason });
      }
    }
    const jobs: Array<{ job_id: string; state: State; current?: JobFact; reason?: string }> = [];
    for (const saved of observations.selected_webcodex_jobs) {
      try {
        const current = redactValues(this.jobs(workspaceId, [saved.job_id])[0]);
        jobs.push({ job_id: saved.job_id, state: canonical(current) === canonical(saved) ? 'unchanged' : 'changed', current });
      } catch { jobs.push({ job_id: saved.job_id, state: 'unknown', reason: 'JOB_UNAVAILABLE' }); }
    }
    const currentGit = redactValues(await this.gitFact(workspaceId));
    const gitState: State = !observations.git.available || !currentGit.available || observations.git.truncated || currentGit.truncated || observations.git.hidden_entries || currentGit.hidden_entries ? 'unknown' : canonical(currentGit) === canonical(observations.git) ? 'unchanged' : 'changed';
    const selected = [...files, ...jobs];
    const state: State = selected.some(item => item.state === 'changed') || gitState === 'changed' ? 'changed' : !files.length || selected.some(item => item.state === 'unknown') ? 'unknown' : 'unchanged';
    const fileStates = { changed: 0, unknown: 0, unchanged: 0 };
    for (const file of files) fileStates[file.state]++;
    const priorities = { changed: 0, unknown: 1, unchanged: 2 };
    const details = [...files].sort((a, b) => priorities[a.state] - priorities[b.state]).slice(0, 20);
    return { state, checked_at: new Date().toISOString(), tracked_files: details.map(file => ({ ...file, path: capUtf8(file.path, 512).text })), tracked_file_count: files.length, tracked_file_states: fileStates, tracked_files_order: 'changed, unknown, unchanged; saved path order within each state', tracked_files_truncated: files.length > 20 || files.some(file => Buffer.byteLength(file.path) > 512), selected_webcodex_jobs: jobs, git: { state: gitState, current: { available: currentGit.available, head: currentGit.head, branch: currentGit.branch, truncated: currentGit.truncated, hidden_entries: currentGit.hidden_entries } }, verification_validity: 'unknown', coverage: 'State compares selected files and jobs within tasks.maxSnapshotBytes; an observed Git change also marks changed. Git availability is reported separately. Unchanged requires at least one tracked file and does not prove that a test suite ran against these hashes, passed, or remains valid. Other files, dependencies and environment are not captured.' };
  }
  private encode(cursor: Cursor) {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return body + '.' + createHmac('sha256', this.cursorKey).update(body).digest('base64url');
  }
  private decode(value: string): Cursor {
    try {
      if (typeof value !== 'string' || value.length > 4096) throw 0;
      const parts = value.split('.'); if (parts.length !== 2) throw 0;
      const expected = createHmac('sha256', this.cursorKey).update(parts[0]).digest(), supplied = Buffer.from(parts[1], 'base64url');
      if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) throw 0;
      const cursor = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Cursor;
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.revision) || cursor.revision < 1) throw 0;
      return cursor;
    } catch { throw new AppError('INVALID_CURSOR', 'Invalid task cursor or service restarted. Restart task_read without a cursor.'); }
  }
  async read(input: { workspace_id: string; task_id: string; revision?: number; cursor?: string; max_bytes?: number }) {
    const max = input.max_bytes ?? this.ctx.config.limits.readMaxBytes;
    if (!Number.isSafeInteger(max) || max < 256 || max > this.ctx.config.limits.readMaxBytes) throw new AppError('INVALID_ARGUMENT', 'max_bytes must be between 256 and limits.readMaxBytes.');
    const source = await this.authorized(input.workspace_id), cursor = input.cursor ? this.decode(input.cursor) : undefined;
    if (cursor && (cursor.binding !== source.binding || cursor.task_id !== input.task_id || input.revision !== undefined && cursor.revision !== input.revision)) throw new AppError('INVALID_CURSOR', 'The task cursor belongs to a different task, revision or workspace.');
    const row = this.row(input.workspace_id, input.task_id), saved = this.revision(row, input.revision ?? cursor?.revision);
    const bytes = Buffer.from(JSON.stringify(saved.payload, null, 2)), sha256 = createHash('sha256').update(bytes).digest('hex'), offset = cursor?.offset ?? 0;
    if (cursor && (cursor.sha256 !== sha256 || offset >= bytes.length || (bytes[offset] & 0xc0) === 0x80)) throw new AppError('INVALID_CURSOR', 'The stored task revision no longer matches this cursor. Restart task_read.');
    let end = Math.min(bytes.length, offset + max);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    const freshness = cursor ? null : await this.freshness(input.workspace_id, saved.payload.observations);
    await this.authorized(input.workspace_id);
    return { ...this.summary(input.workspace_id, row), title: saved.payload.title, status: saved.payload.status, revision: saved.revision, content: bytes.subarray(offset, end).toString('utf8'), content_format: 'task_revision_json', sha256, chunk: { offset_bytes: offset, end_bytes: end, total_bytes: bytes.length }, complete: end === bytes.length, next_cursor: end === bytes.length ? null : this.encode({ binding: source.binding, task_id: input.task_id, revision: saved.revision, sha256, offset: end }), freshness, freshness_sampled: !cursor, notice: NOTICE };
  }
  async export(input: { workspace_id: string; task_id: string; revision?: number; expected_sha256: string | null; idempotency_key: string }) {
    await this.authorized(input.workspace_id, true);
    await this.ctx.paths.resolve(input.workspace_id, CHECKPOINT_PATH, { write: true, allowMissing: true });
    this.row(input.workspace_id, input.task_id);
    if (input.expected_sha256 !== null && (typeof input.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.expected_sha256))) throw new AppError('INVALID_ARGUMENT', 'expected_sha256 must be the original SHA-256 or null to create only.');
    return boundOperation(this.ctx, input.workspace_id, 'task_export', input.idempotency_key, input, async () => {
      const row = this.row(input.workspace_id, input.task_id), saved = this.revision(row, input.revision), payload = saved.payload;
      const notes = Object.entries(payload.notes).map(([name, value]) => `### ${name}\n\n${fenced(value ?? 'Not supplied.')}`).join('\n\n');
      const content = `# WebCodex handoff\n\nTask: ${row.task_id}\n\nRevision: ${saved.revision}\n\nStatus (caller supplied): ${payload.status}\n\nSaved: ${payload.observations.captured_at}\n\n${NOTICE}\n\n## Caller notes — not independently verified\n\n### title\n\n${fenced(payload.title)}\n\n${notes}\n\n## Service observations at save time\n\n${fenced(JSON.stringify(payload.observations, null, 2), 'json')}\n\n## Resuming\n\nRead task_read for current freshness, current project guidance and Git diff. Poll selected WebCodex job IDs before using observations. This file grants no additional access. Known credential patterns were redacted; unrecognized secrets may remain.\n`;
      if (Buffer.byteLength(content) > Math.min(65536, this.ctx.config.limits.writeMaxBytes)) throw new AppError('TASK_TOO_LARGE', 'The complete task export exceeds the handoff/write byte limit. Nothing was written.');
      const operationKey = 'task-export:' + createHash('sha256').update(initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id) + '\0' + input.idempotency_key).digest('hex');
      const written = await this.files.write({ workspace_id: input.workspace_id, path: CHECKPOINT_PATH, content, expected_sha256: input.expected_sha256, idempotency_key: operationKey });
      this.ctx.store.audit('task_export', input.workspace_id, { task_id: row.task_id, revision: saved.revision, change_id: written.change_id });
      return { ...written, task_id: row.task_id, revision: saved.revision, notice: NOTICE };
    });
  }
}
