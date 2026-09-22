import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { redactSessionText } from './codex-redaction.js';
import { assertWorkspaceRoot, isWorkspaceTargetAllowed } from './worktree-policy.js';
import type { AppConfig, ServiceContext, WebSessionConfig } from './types.js';
import type { IdentityRegistry } from './identity.js';

type SessionExtra = { _meta?: Record<string, unknown>; sessionId?: string } | undefined;
type SessionContext = { workspaceId: string; sessionKey: string; workspaceUid: string; binding: string };
type EventInput = { tool: string; workspaceId: string; openaiSession?: string; sessionKey?: string; input?: unknown; outcome: 'success' | 'error'; errorCode?: string; result?: unknown; durationMs?: number };
export type JournalState = 'unbound' | 'clean' | 'pending' | 'committed' | 'stale_pending' | 'unavailable';
export type JournalStatus = {
  pending: boolean;
  state: JournalState;
  workspace_id?: string;
  session_key?: string;
  activity_epoch_id?: string;
  tool_calls_since_commit?: number;
  last_activity_at?: string | null;
  committed_at?: string | null;
  required_before_final_reply: boolean;
  required_tool?: 'web_session_turn';
  instruction_code: 'SELECT_WORKSPACE' | 'BIND_SESSION' | 'COMMIT_BEFORE_FINAL_REPLY' | 'SEND_FINAL_REPLY_NOW' | 'JOURNAL_UNAVAILABLE';
  error_code?: string;
};

const DEFAULTS: WebSessionConfig = {
  enabled: true, directory: '.webcodex/sessions', retentionDays: 90, maxEvents: 2000, maxBytes: 33554432,
  recordToolArguments: 'redacted', recordToolResults: 'summary', remindBeforeFinalReply: true, journalStatusInToolResults: true, stalePendingMinutes: 30,
};
const SAFE_KEY = /^[a-f0-9]{32}$/;
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 2048 || path.isAbsolute(value) || value.includes('\0')) return false;
  const parts = value.replace(/\\/g, '/').split('/');
  return parts.every(part => part && part !== '.' && part !== '..');
}

/** Workspace-local journal for MCP tool activity and explicit recovery checkpoints. */
export class WebSessionService {
  private readonly databases = new Map<string, DatabaseSync>();
  private readonly readOnlyDatabases = new Set<string>();
  private readonly inFlight = new Map<string, number>();
  private readonly config: WebSessionConfig;
  constructor(private readonly ctx: ServiceContext, private readonly identity: IdentityRegistry) {
    this.config = { ...DEFAULTS, ...(ctx.config as AppConfig).sessions };
  }

  private workspace(workspaceId: string, write = false) {
    const workspace = this.ctx.paths.get(workspaceId);
    this.identity.workspaceIdentity(workspaceId);
    assertWorkspaceRoot(this.ctx.config, workspace);
    if (write && workspace.readOnly) throw new AppError('READ_ONLY', 'This workspace is read-only; WebCodex cannot save its session journal.');
    return workspace;
  }

  private relativeDirectory(): string[] {
    const value = this.config.directory;
    if (!value || path.isAbsolute(value) || value.includes('\0')) throw new AppError('SESSION_STORE_INVALID', 'The session directory must be a relative path inside the workspace.');
    const parts = value.split(/[\\/]+/).filter(Boolean);
    if (!parts.length || parts.some(part => part === '..' || part === '.' || /[<>:"|?*]/.test(part))) throw new AppError('SESSION_STORE_INVALID', 'The session directory contains an unsupported component.');
    return parts;
  }

  private async directory(workspaceId: string, write: boolean): Promise<string | undefined> {
    const workspace = this.workspace(workspaceId, write);
    const parts = this.relativeDirectory();
    const target = path.resolve(workspace.root, ...parts);
    const rel = path.relative(workspace.root, target);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep) || !isWorkspaceTargetAllowed(this.ctx.config, workspace, target)) {
      throw new AppError('PATH_DENIED', 'The session directory must stay inside the selected workspace.');
    }
    let current = workspace.root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError('PATH_DENIED', 'The session directory cannot contain links or special filesystem objects.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (!write) return undefined;
          await mkdir(target, { recursive: true });
          break;
        }
        throw error;
      }
    }
    const finalInfo = await lstat(target);
    if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory()) throw new AppError('PATH_DENIED', 'The session directory is not a regular directory.');
    if (!samePath(await realpath(target), target)) throw new AppError('PATH_DENIED', 'The session directory resolves outside its configured path.');
    return target;
  }

  private async database(workspaceId: string, write: boolean): Promise<DatabaseSync | undefined> {
    if (!this.config.enabled) return undefined;
    const cached = this.databases.get(workspaceId);
    if (cached && (!write || !this.readOnlyDatabases.has(workspaceId))) return cached;
    if (cached && write && this.readOnlyDatabases.has(workspaceId)) {
      try { cached.close(); } catch {}
      this.databases.delete(workspaceId);
      this.readOnlyDatabases.delete(workspaceId);
    }
    const directory = await this.directory(workspaceId, write);
    if (!directory) return undefined;
    const databasePath = path.join(directory, 'sessions.sqlite');
    let exists = true;
    try { await access(databasePath); } catch { exists = false; }
    if (!exists && !write) return undefined;
    const database = new DatabaseSync(databasePath, write ? {} : { readOnly: true });
    if (!write) this.readOnlyDatabases.add(workspaceId); else this.readOnlyDatabases.delete(workspaceId);
    if (write) {
      database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      database.exec(`CREATE TABLE IF NOT EXISTS web_sessions (
        session_key TEXT PRIMARY KEY, workspace_uid TEXT NOT NULL, workspace_binding TEXT NOT NULL,
        device_id TEXT NOT NULL, title TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        tool_call_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', last_checkpoint_id TEXT
      );
      CREATE TABLE IF NOT EXISTS web_session_events (
        event_id TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES web_sessions(session_key) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, activity_epoch_id TEXT, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, error_code TEXT,
        relative_paths TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL, duration_ms INTEGER,
        UNIQUE(session_key, sequence)
      );
      CREATE TABLE IF NOT EXISTS web_session_activity_epochs (
        epoch_id TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES web_sessions(session_key) ON DELETE CASCADE,
        status TEXT NOT NULL, first_sequence INTEGER NOT NULL, last_sequence INTEGER,
        tool_call_count INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
        committed_at TEXT, committed_turn_id TEXT
      );
      CREATE TABLE IF NOT EXISTS web_session_checkpoints (
        checkpoint_id TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES web_sessions(session_key) ON DELETE CASCADE,
        idempotency_key TEXT UNIQUE NOT NULL, request_hash TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_session_operations (
        operation_key TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES web_sessions(session_key) ON DELETE CASCADE,
        operation TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_session_turns (
        turn_id TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES web_sessions(session_key) ON DELETE CASCADE,
        activity_epoch_id TEXT, idempotency_key TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL,
        user_message TEXT NOT NULL, assistant_reply TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS web_sessions_recent ON web_sessions(workspace_uid,last_seen DESC);
      CREATE INDEX IF NOT EXISTS web_session_events_recent ON web_session_events(session_key,sequence DESC);
      CREATE INDEX IF NOT EXISTS web_session_epochs_recent ON web_session_activity_epochs(session_key,last_activity_at DESC);`);
      try { database.exec('ALTER TABLE web_session_events ADD COLUMN activity_epoch_id TEXT'); } catch {}
      try { database.exec('ALTER TABLE web_session_turns ADD COLUMN activity_epoch_id TEXT'); } catch {}
      // Preview releases may reopen a journal created before request_hash was added.
      try { database.exec('ALTER TABLE web_session_checkpoints ADD COLUMN request_hash TEXT'); } catch {}
    }
    this.databases.set(workspaceId, database);
    return database;
  }

  private sessionKey(workspaceId: string, openaiSession: string): string {
    const source = this.identity.source();
    return createHash('sha256').update(source.device_id + '\0' + this.workspaceUid(workspaceId) + '\0' + openaiSession).digest('hex').slice(0, 32);
  }

  private async contextFor(workspaceId: string, extra: SessionExtra, write = true): Promise<SessionContext | undefined> {
    const handle = this.sessionHandle(extra);
    if (!handle) return undefined;
    return this.ensureSession(workspaceId, handle);
  }

  private async ensureEpoch(context: SessionContext, db: DatabaseSync, now = new Date().toISOString(), allowStale = false): Promise<{ epochId: string; toolCount: number; lastActivityAt: string | null; committedAt: string | null }> {
    const current = db.prepare(`SELECT epoch_id,status,tool_call_count,last_activity_at,committed_at
      FROM web_session_activity_epochs WHERE session_key=? ORDER BY started_at DESC LIMIT 1`).get(context.sessionKey) as { epoch_id:string; status:string; tool_call_count:number; last_activity_at:string; committed_at:string|null } | undefined;
    const staleAt = Date.now() - (this.config.stalePendingMinutes ?? 30) * 60000;
    const currentIsPending = current?.status === 'pending' && (allowStale || Date.parse(current.last_activity_at) >= staleAt);
    if (current && currentIsPending) return { epochId: current.epoch_id, toolCount: Number(current.tool_call_count), lastActivityAt: current.last_activity_at, committedAt: current.committed_at };
    const epochId = randomUUID();
    const sequence = Number((db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM web_session_events WHERE session_key=?').get(context.sessionKey) as { sequence:number }).sequence);
    db.prepare(`INSERT INTO web_session_activity_epochs(epoch_id,session_key,status,first_sequence,last_sequence,tool_call_count,started_at,last_activity_at)
      VALUES(?,?,?, ?,NULL,0,?,?)`).run(epochId, context.sessionKey, 'pending', sequence, now, now);
    return { epochId, toolCount: 0, lastActivityAt: now, committedAt: null };
  }

  private async statusFor(workspaceId: string, sessionKey: string, stateHint?: JournalState): Promise<JournalStatus> {
    const db = await this.database(workspaceId, false);
    if (!db) return { pending: false, state: stateHint ?? 'unavailable', workspace_id: workspaceId, session_key: sessionKey, required_before_final_reply: false, instruction_code: 'JOURNAL_UNAVAILABLE', error_code: 'SESSION_NOT_FOUND' };
    const row = db.prepare(`SELECT epoch_id,status,tool_call_count,last_activity_at,committed_at
      FROM web_session_activity_epochs WHERE session_key=? ORDER BY started_at DESC LIMIT 1`).get(sessionKey) as { epoch_id:string; status:string; tool_call_count:number; last_activity_at:string; committed_at:string|null } | undefined;
    if (!row) return { pending: false, state: stateHint ?? 'clean', workspace_id: workspaceId, session_key: sessionKey, required_before_final_reply: false, instruction_code: 'SEND_FINAL_REPLY_NOW' };
    const stale = row.status === 'pending' && Date.parse(row.last_activity_at) < Date.now() - (this.config.stalePendingMinutes ?? 30) * 60000;
    const state: JournalState = row.status === 'pending' ? stale ? 'stale_pending' : 'pending' : row.status === 'committed' ? 'committed' : 'clean';
    const pending = state === 'pending' || state === 'stale_pending';
    return { pending, state, workspace_id: workspaceId, session_key: sessionKey, activity_epoch_id: row.epoch_id, tool_calls_since_commit: Number(row.tool_call_count), last_activity_at: row.last_activity_at, committed_at: row.committed_at, required_before_final_reply: pending && (this.config.remindBeforeFinalReply ?? true), ...(pending ? { required_tool: 'web_session_turn' as const, instruction_code: 'COMMIT_BEFORE_FINAL_REPLY' as const } : { instruction_code: 'SEND_FINAL_REPLY_NOW' as const }) };
  }

  private unavailableStatus(workspaceId: string | undefined, code = 'SESSION_JOURNAL_UNAVAILABLE'): JournalStatus | undefined {
    if (!workspaceId) return undefined;
    return { pending: false, state: 'unavailable', workspace_id: workspaceId, required_before_final_reply: false, instruction_code: 'JOURNAL_UNAVAILABLE', error_code: code };
  }

  unboundStatus(): JournalStatus {
    if (!this.config.enabled) return { pending: false, state: 'unavailable', required_before_final_reply: false, instruction_code: 'JOURNAL_UNAVAILABLE', error_code: 'SESSION_STORE_DISABLED' };
    return { pending: false, state: 'unbound', required_before_final_reply: false, instruction_code: 'SELECT_WORKSPACE' };
  }

  /** Read only the documented anonymous OpenAI session metadata; never persist the raw value. */
  openAiSession(extra: SessionExtra): string | undefined {
    const value = extra?._meta?.['openai/session'];
    return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
  }

  /** Use the MCP transport session only as an in-memory fallback; the raw value is never persisted. */
  sessionHandle(extra: SessionExtra): string | undefined {
    const openai = this.openAiSession(extra);
    if (openai) return openai;
    const transport = extra?.sessionId;
    return typeof transport === 'string' && transport.length > 0 && transport.length <= 512 ? `mcp:${transport}` : undefined;
  }

  private keyFor(workspaceId: string, extra: SessionExtra): string | undefined {
    const handle = this.sessionHandle(extra);
    return handle ? this.sessionKey(workspaceId, handle) : undefined;
  }

  /** Mark a model-visible tool as in flight so a commit cannot race an unfinished call. */
  beginTool(workspaceId: string | undefined, extra: SessionExtra, tool: string): void {
    if (!workspaceId || this.isJournalTool(tool)) return;
    const key = this.keyFor(workspaceId, extra);
    if (!key) return;
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
  }

  endTool(workspaceId: string | undefined, extra: SessionExtra, tool: string): void {
    if (!workspaceId || this.isJournalTool(tool)) return;
    const key = this.keyFor(workspaceId, extra);
    if (!key) return;
    const remaining = (this.inFlight.get(key) ?? 1) - 1;
    if (remaining > 0) this.inFlight.set(key, remaining); else this.inFlight.delete(key);
  }

  private isJournalTool(tool: string): boolean {
    return ['web_session_list', 'web_session_read', 'web_session_resume_context', 'web_session_bind', 'web_session_checkpoint', 'web_session_turn'].includes(tool);
  }

  private workspaceUid(workspaceId: string) { return this.identity.workspaceSource(workspaceId).workspace_uid; }

  private async ensureSession(workspaceId: string, openaiSession: string, title?: string): Promise<SessionContext> {
    const workspace = this.workspace(workspaceId, true);
    const db = await this.database(workspaceId, true);
    if (!db) throw new AppError('SESSION_STORE_DISABLED', 'Workspace session storage is disabled in local configuration.');
    const workspaceUid = this.workspaceUid(workspaceId);
    const binding = this.identity.workspaceIdentity(workspaceId);
    const sessionKey = this.sessionKey(workspaceId, openaiSession);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO web_sessions(session_key,workspace_uid,workspace_binding,device_id,title,first_seen,last_seen)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_key) DO UPDATE SET last_seen=excluded.last_seen,
      title=COALESCE(excluded.title,web_sessions.title)`).run(sessionKey, workspaceUid, binding, this.identity.source().device_id, title ?? null, now, now);
    return { workspaceId: workspace.id, sessionKey, workspaceUid, binding };
  }

  private async byKey(workspaceId: string, sessionKey: string): Promise<SessionContext> {
    if (!SAFE_KEY.test(sessionKey)) throw new AppError('INVALID_ARGUMENT', 'session_key is invalid or belongs to another format.');
    const workspace = this.workspace(workspaceId);
    const db = await this.database(workspaceId, false);
    if (!db) throw new AppError('SESSION_NOT_FOUND', 'No session journal exists for this workspace.');
    const binding = this.identity.workspaceIdentity(workspaceId);
    const workspaceUid = this.workspaceUid(workspaceId);
    const row = db.prepare('SELECT session_key,workspace_uid,workspace_binding,device_id FROM web_sessions WHERE session_key=?').get(sessionKey) as { session_key:string; workspace_uid:string; workspace_binding:string; device_id:string } | undefined;
    if (!row || row.workspace_binding !== binding || row.workspace_uid !== workspaceUid || row.device_id !== this.identity.source().device_id) throw new AppError('SESSION_NOT_FOUND', 'No session with this key belongs to the selected workspace identity.');
    return { workspaceId: workspace.id, sessionKey, workspaceUid, binding };
  }

  private extractPaths(input: unknown): string[] {
    const paths: string[] = [];
    const add = (value: unknown) => { if (typeof value === 'string' && value.length <= 2048 && !path.isAbsolute(value) && !value.includes('\0')) paths.push(value.replace(/\\/g, '/')); };
    const walk = (value: unknown, key = '') => {
      if (Array.isArray(value)) { for (const item of value) walk(item, key); return; }
      if (!value || typeof value !== 'object') { if (key === 'path' || key === 'source_path' || key === 'tracked_paths' || key === 'important_files') add(value); return; }
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        if (['path','source_path','tracked_paths','important_files'].includes(childKey)) Array.isArray(child) ? child.forEach(add) : add(child);
      }
    };
    walk(input);
    return [...new Set(paths)].slice(0, 32);
  }

  private summarize(tool: string, outcome: 'success' | 'error', errorCode?: string, result?: unknown): string {
    if (outcome === 'error') return errorCode ? `工具调用失败，错误码 ${errorCode}` : '工具调用失败';
    if (this.config.recordToolResults === 'none') return '工具调用成功';
    if (result && typeof result === 'object') {
      const object = result as Record<string, unknown>;
      const status = typeof object.status === 'string' ? object.status : typeof object.phase === 'string' ? object.phase : undefined;
      return status ? `${tool} 已完成，状态 ${status}` : `${tool} 调用成功`;
    }
    return `${tool} 调用成功`;
  }

  private redacted(value: string, max = 8192) { return redactSessionText(value.slice(0, max)).text; }

  async recordCall(input: EventInput): Promise<JournalStatus | undefined> {
    if (!this.config.enabled || !input.workspaceId) return undefined;
    const handle = input.openaiSession;
    if (!handle && !input.sessionKey) return this.unavailableStatus(input.workspaceId, 'SESSION_UNBOUND');
    try {
      const context = input.sessionKey ? await this.byKey(input.workspaceId, input.sessionKey) : await this.ensureSession(input.workspaceId, handle!);
      const db = await this.database(input.workspaceId, true);
      if (!db) return this.unavailableStatus(input.workspaceId);
      const now = new Date().toISOString();
      // web_session_turn commits the current epoch in appendTurn; recording it as a
      // new event here would immediately reopen a pending epoch.
      if (input.tool === 'web_session_turn' && input.outcome === 'success') return await this.statusFor(input.workspaceId, context.sessionKey);
      const epoch = await this.ensureEpoch(context, db, now);
      const next = db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM web_session_events WHERE session_key=?').get(context.sessionKey) as { sequence:number };
      const summary = this.summarize(input.tool, input.outcome, input.errorCode, input.result);
      const paths = JSON.stringify(this.config.recordToolArguments === 'none' ? [] : this.extractPaths(input.input));
      db.prepare(`INSERT INTO web_session_events(event_id,session_key,sequence,activity_epoch_id,tool_name,outcome,error_code,relative_paths,summary,created_at,duration_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), context.sessionKey, next.sequence, epoch.epochId, input.tool, input.outcome, input.errorCode ?? null, paths, summary, now, input.durationMs ?? null);
      db.prepare('UPDATE web_session_activity_epochs SET last_sequence=?,tool_call_count=tool_call_count+1,last_activity_at=? WHERE epoch_id=?').run(next.sequence, now, epoch.epochId);
      db.prepare('UPDATE web_sessions SET last_seen=?,tool_call_count=tool_call_count+1 WHERE session_key=?').run(now, context.sessionKey);
      this.prune(input.workspaceId, db);
      return await this.statusFor(input.workspaceId, context.sessionKey);
    } catch {
      // A journal failure must never turn a successful MCP operation into an error.
      return this.unavailableStatus(input.workspaceId);
    }
  }

  private prune(workspaceId: string, db: DatabaseSync) {
    const cutoff = new Date(Date.now() - this.config.retentionDays * 86400000).toISOString();
    db.prepare('DELETE FROM web_session_events WHERE created_at<?').run(cutoff);
    db.prepare('DELETE FROM web_session_checkpoints WHERE created_at<?').run(cutoff);
    db.prepare('DELETE FROM web_session_turns WHERE created_at<?').run(cutoff);
    db.prepare("DELETE FROM web_session_activity_epochs WHERE last_activity_at<? AND status<>'pending'").run(cutoff);
    db.prepare('DELETE FROM web_sessions WHERE last_seen<? AND session_key NOT IN (SELECT session_key FROM web_session_checkpoints)').run(cutoff);
    const total = Number((db.prepare('SELECT COUNT(*) AS count FROM web_session_events').get() as { count: number }).count);
    if (total > this.config.maxEvents) db.prepare('DELETE FROM web_session_events WHERE event_id IN (SELECT event_id FROM web_session_events ORDER BY created_at ASC LIMIT ?)').run(total - this.config.maxEvents);
    const turnCount = Number((db.prepare('SELECT COUNT(*) AS count FROM web_session_turns').get() as { count: number }).count);
    if (turnCount > this.config.maxEvents) db.prepare('DELETE FROM web_session_turns WHERE turn_id IN (SELECT turn_id FROM web_session_turns ORDER BY created_at ASC LIMIT ?)').run(turnCount - this.config.maxEvents);
    // Keep the workspace journal bounded even when many short events have small payloads.
    for (let attempt = 0; attempt < 32; attempt++) {
      const pageCount = Number((db.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined)?.page_count ?? 0);
      const pageSize = Number((db.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined)?.page_size ?? 4096);
      if (pageCount * pageSize <= this.config.maxBytes) break;
      const deletedEvents = db.prepare('DELETE FROM web_session_events WHERE event_id IN (SELECT event_id FROM web_session_events ORDER BY created_at ASC LIMIT 100)').run().changes;
      if (deletedEvents) continue;
      const deletedTurns = db.prepare('DELETE FROM web_session_turns WHERE turn_id IN (SELECT turn_id FROM web_session_turns ORDER BY created_at ASC LIMIT 20)').run().changes;
      if (!deletedTurns) break;
    }
    void workspaceId;
  }

  async list(input: { workspace_id:string; limit?:number; cursor?:string; include_archived?:boolean }) {
    const workspace = this.workspace(input.workspace_id);
    if (!this.config.enabled) return { workspace_id: workspace.id, enabled: false, sessions: [], next_cursor: null, journal: this.emptyJournalStats() };
    const db = await this.database(input.workspace_id, false);
    if (!db) return { workspace_id: workspace.id, enabled: true, sessions: [], next_cursor: null, journal: this.emptyJournalStats() };
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError('INVALID_CURSOR', 'The session cursor is invalid.');
    const archivedClause = input.include_archived ? '' : " AND s.status <> 'archived'";
    const rows = db.prepare(`SELECT s.session_key,s.title,s.first_seen,s.last_seen,s.tool_call_count,s.status,s.last_checkpoint_id,
      (SELECT COUNT(*) FROM web_session_events e WHERE e.session_key=s.session_key) AS event_count
      FROM web_sessions s WHERE s.workspace_uid=? AND s.workspace_binding=?${archivedClause} ORDER BY s.last_seen DESC, s.session_key LIMIT ? OFFSET ?`).all(this.workspaceUid(input.workspace_id), this.identity.workspaceIdentity(input.workspace_id), limit + 1, offset) as Array<Record<string, unknown>>;
    const sessions = rows.slice(0, limit);
    return { workspace_id: workspace.id, enabled: true, sessions, next_cursor: rows.length > sessions.length ? String(offset + sessions.length) : null, journal: this.journalStatsFromDb(db, input.workspace_id) };
  }

  private emptyJournalStats() {
    return { committed_epochs: 0, pending_epochs: 0, stale_pending_epochs: 0, submission_coverage: null, metric_scope: 'workspace_mcp_activity_epochs', not_chatgpt_turn_rate: true };
  }

  private journalStatsFromDb(db: DatabaseSync, workspaceId: string) {
    const rows = db.prepare(`SELECT e.status,e.last_activity_at FROM web_session_activity_epochs e
      JOIN web_sessions s ON s.session_key=e.session_key WHERE s.workspace_uid=? AND s.workspace_binding=?`).all(this.workspaceUid(workspaceId), this.identity.workspaceIdentity(workspaceId)) as Array<{status:string;last_activity_at:string}>;
    let committed = 0, pending = 0, stale = 0;
    const staleAt = Date.now() - (this.config.stalePendingMinutes ?? 30) * 60000;
    for (const row of rows) {
      if (row.status === 'committed') committed++;
      else if (row.status === 'pending' && Date.parse(row.last_activity_at) < staleAt) stale++;
      else if (row.status === 'pending') pending++;
    }
    const observed = committed + stale;
    return { committed_epochs: committed, pending_epochs: pending, stale_pending_epochs: stale, submission_coverage: observed ? Number((committed / observed).toFixed(4)) : null, metric_scope: 'workspace_mcp_activity_epochs', not_chatgpt_turn_rate: true };
  }

  async read(input: { workspace_id:string; session_key:string; cursor?:string; limit?:number }) {
    await this.byKey(input.workspace_id, input.session_key);
    const db = await this.database(input.workspace_id, false);
    if (!db) throw new AppError('SESSION_NOT_FOUND', 'No session journal exists for this workspace.');
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError('INVALID_CURSOR', 'The session cursor is invalid.');
    const limit = Math.min(100, Math.max(1, input.limit ?? 50));
    const rows = db.prepare(`SELECT sequence,tool_name,outcome,error_code,relative_paths,summary,created_at,duration_ms
      FROM web_session_events WHERE session_key=? ORDER BY sequence LIMIT ? OFFSET ?`).all(input.session_key, limit + 1, offset) as Array<Record<string, unknown>>;
    const events = rows.slice(0, limit).map(row => ({ ...row, relative_paths: JSON.parse(String(row.relative_paths)) }));
    const checkpoints = db.prepare('SELECT checkpoint_id,payload,created_at FROM web_session_checkpoints WHERE session_key=? ORDER BY created_at DESC LIMIT 20').all(input.session_key) as Array<{checkpoint_id:string; payload:string; created_at:string}>;
    const turns = db.prepare('SELECT turn_id,user_message,assistant_reply,created_at FROM web_session_turns WHERE session_key=? ORDER BY created_at DESC LIMIT 20').all(input.session_key) as Array<{turn_id:string; user_message:string; assistant_reply:string; created_at:string}>;
    return { workspace_id: input.workspace_id, session_key: input.session_key, events, turns, checkpoints: checkpoints.map(row => ({ checkpoint_id: row.checkpoint_id, ...JSON.parse(row.payload), created_at: row.created_at })), next_cursor: rows.length > events.length ? String(offset + events.length) : null, complete: rows.length <= events.length };
  }

  /** Persist one user/assistant turn supplied explicitly by the model. */
  async appendTurn(input: { workspace_id:string; session_key?:string; user_message:string; assistant_reply:string; idempotency_key:string }, extra: SessionExtra) {
    const handle = this.sessionHandle(extra);
    let context: SessionContext;
    if (handle) context = await this.ensureSession(input.workspace_id, handle);
    else if (input.session_key) context = await this.byKey(input.workspace_id, input.session_key);
    else throw new AppError('SESSION_UNBOUND', 'The host did not provide openai/session. Provide session_key from web_session_bind.');
    if ((this.inFlight.get(context.sessionKey) ?? 0) > 0) throw new AppError('SESSION_TURN_BUSY', 'Other WebCodex tool calls are still running for this session. Wait for their results, then retry this same turn with the same idempotency_key.');
    const db = await this.database(input.workspace_id, true);
    if (!db) throw new AppError('SESSION_STORE_DISABLED', 'Workspace session storage is disabled in local configuration.');
    const userMessage = this.redacted(input.user_message, 16384);
    const assistantReply = this.redacted(input.assistant_reply, 16384);
    const requestHash = createHash('sha256').update(JSON.stringify({ userMessage, assistantReply })).digest('hex');
    const existing = db.prepare('SELECT turn_id,session_key,request_hash,user_message,assistant_reply,created_at FROM web_session_turns WHERE idempotency_key=?').get(input.idempotency_key) as { turn_id:string; session_key:string; request_hash:string; user_message:string; assistant_reply:string; created_at:string } | undefined;
    if (existing) {
      if (existing.session_key !== context.sessionKey || existing.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different conversation turn.');
      return { workspace_id: input.workspace_id, session_key: context.sessionKey, turn_id: existing.turn_id, user_message: existing.user_message, assistant_reply: existing.assistant_reply, created_at: existing.created_at, replayed: true, limitation: 'This turn was supplied by the caller; it is not an automatically captured ChatGPT transcript.' };
    }
    const createdAt = new Date().toISOString();
    const turnId = randomUUID();
    const epoch = await this.ensureEpoch(context, db, createdAt, true);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO web_session_turns(turn_id,session_key,activity_epoch_id,idempotency_key,request_hash,user_message,assistant_reply,created_at) VALUES(?,?,?,?,?,?,?,?)').run(turnId, context.sessionKey, epoch.epochId, input.idempotency_key, requestHash, userMessage, assistantReply, createdAt);
      db.prepare(`UPDATE web_session_activity_epochs SET status='committed',committed_at=?,committed_turn_id=?,last_activity_at=? WHERE epoch_id=?`).run(createdAt, turnId, createdAt, epoch.epochId);
      db.prepare('UPDATE web_sessions SET last_seen=?,tool_call_count=tool_call_count+1 WHERE session_key=?').run(createdAt, context.sessionKey);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    this.prune(input.workspace_id, db);
    return { workspace_id: input.workspace_id, session_key: context.sessionKey, activity_epoch_id: epoch.epochId, turn_id: turnId, user_message: userMessage, assistant_reply: assistantReply, created_at: createdAt, replayed: false, journal_state: 'committed', limitation: 'This turn was supplied by the caller; it is not an automatically captured ChatGPT transcript.' };
  }

  async bind(input: { workspace_id:string; title:string; project_label?:string; session_key?:string; idempotency_key:string }, extra: SessionExtra) {
    const handle = this.sessionHandle(extra);
    if (!handle && !input.session_key) throw new AppError('SESSION_UNBOUND', 'The host did not provide a session association. Call this tool with a session_key returned by an earlier bind or continue in a host that provides session metadata.');
    const title = this.redacted(input.title, 256);
    const projectLabel = input.project_label === undefined ? undefined : this.redacted(input.project_label, 256);
    const context = handle ? await this.ensureSession(input.workspace_id, handle, title) : await this.byKey(input.workspace_id, input.session_key!);
    const db = await this.database(input.workspace_id, true);
    if (!db) throw new AppError('SESSION_STORE_DISABLED', 'Workspace session storage is disabled in local configuration.');
    const requestHash = createHash('sha256').update(JSON.stringify({ title, projectLabel })).digest('hex');
    const prior = db.prepare('SELECT session_key,operation,request_hash,response FROM web_session_operations WHERE operation_key=?').get(input.idempotency_key) as { session_key:string; operation:string; request_hash:string; response:string } | undefined;
    if (prior) {
      if (prior.session_key !== context.sessionKey || prior.operation !== 'bind' || prior.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different session binding.');
      return { ...JSON.parse(prior.response), replayed: true };
    }
    const storedTitle = projectLabel ? `${title} · ${projectLabel}` : title;
    db.prepare('UPDATE web_sessions SET title=? WHERE session_key=?').run(storedTitle, context.sessionKey);
    const response = { workspace_id: input.workspace_id, session_key: context.sessionKey, title, project_label: projectLabel ?? null, stored_in: `${this.config.directory}/sessions.sqlite`, limitation: 'This journal stores MCP activity and checkpoints, not the full ChatGPT transcript.' };
    db.prepare('INSERT INTO web_session_operations(operation_key,session_key,operation,request_hash,response,created_at) VALUES(?,?,?,?,?,?)').run(input.idempotency_key, context.sessionKey, 'bind', requestHash, JSON.stringify(response), new Date().toISOString());
    return { ...response, replayed: false };
  }

  async checkpoint(input: { workspace_id:string; session_key?:string; title:string; summary:string; completed?:string[]; next_steps?:string[]; important_files?:string[]; idempotency_key:string }, extra: SessionExtra) {
    const handle = this.sessionHandle(extra);
    let context: SessionContext;
    if (handle) context = await this.ensureSession(input.workspace_id, handle, input.title);
    else if (input.session_key) context = await this.byKey(input.workspace_id, input.session_key);
    else throw new AppError('SESSION_UNBOUND', 'The host did not provide openai/session. Provide session_key from web_session_bind.');
    const db = await this.database(input.workspace_id, true);
    if (!db) throw new AppError('SESSION_STORE_DISABLED', 'Workspace session storage is disabled in local configuration.');
    const payload = { title: this.redacted(input.title, 256), summary: this.redacted(input.summary), completed: (input.completed ?? []).map(value => this.redacted(value, 1024)), next_steps: (input.next_steps ?? []).map(value => this.redacted(value, 1024)), important_files: (input.important_files ?? []).filter(safeRelativePath).slice(0, 50), created_at: new Date().toISOString() };
    const requestHash = createHash('sha256').update(JSON.stringify({ title: payload.title, summary: payload.summary, completed: payload.completed, next_steps: payload.next_steps, important_files: payload.important_files })).digest('hex');
    const existing = db.prepare('SELECT checkpoint_id,session_key,request_hash,payload FROM web_session_checkpoints WHERE idempotency_key=?').get(input.idempotency_key) as { checkpoint_id:string; session_key:string; request_hash:string|null; payload:string } | undefined;
    if (existing) {
      if (existing.session_key !== context.sessionKey || (existing.request_hash && existing.request_hash !== requestHash)) throw new AppError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different checkpoint.');
      return { workspace_id: input.workspace_id, session_key: context.sessionKey, checkpoint_id: existing.checkpoint_id, replayed: true, ...JSON.parse(existing.payload) };
    }
    const checkpointId = randomUUID();
    db.prepare('INSERT INTO web_session_checkpoints(checkpoint_id,session_key,idempotency_key,request_hash,payload,created_at) VALUES(?,?,?,?,?,?)').run(checkpointId, context.sessionKey, input.idempotency_key, requestHash, JSON.stringify(payload), payload.created_at);
    db.prepare('UPDATE web_sessions SET title=COALESCE(title,?),last_checkpoint_id=?,last_seen=? WHERE session_key=?').run(payload.title, checkpointId, payload.created_at, context.sessionKey);
    return { workspace_id: input.workspace_id, session_key: context.sessionKey, checkpoint_id: checkpointId, replayed: false, ...payload, limitation: 'This checkpoint is caller supplied and does not contain hidden ChatGPT messages.' };
  }

  async resume(input: { workspace_id:string; session_key?:string; limit?:number }, extra: SessionExtra) {
    const current = this.sessionHandle(extra);
    const list = await this.list({ workspace_id: input.workspace_id, limit: Math.min(10, input.limit ?? 3) });
    let currentSession: unknown = null;
    if (current) {
      const currentKey = this.sessionKey(input.workspace_id, current);
      const db = await this.database(input.workspace_id, false);
      const session = db?.prepare('SELECT session_key,title,first_seen,last_seen,tool_call_count,last_checkpoint_id FROM web_sessions WHERE session_key=?').get(currentKey) as Record<string, unknown> | undefined;
      const checkpoint = db?.prepare('SELECT checkpoint_id,payload,created_at FROM web_session_checkpoints WHERE session_key=? ORDER BY created_at DESC LIMIT 1').get(currentKey) as { checkpoint_id:string; payload:string; created_at:string } | undefined;
      const turns = db?.prepare('SELECT turn_id,user_message,assistant_reply,created_at FROM web_session_turns WHERE session_key=? ORDER BY created_at DESC LIMIT 10').all(currentKey) as Array<{turn_id:string; user_message:string; assistant_reply:string; created_at:string}> | undefined;
      currentSession = session ? { ...session, turns: turns ?? [], last_checkpoint: checkpoint ? { checkpoint_id: checkpoint.checkpoint_id, ...JSON.parse(checkpoint.payload), created_at: checkpoint.created_at } : null } : { session_key: currentKey, title: null, first_seen: null, last_seen: null, tool_call_count: 0, last_checkpoint_id: null, turns: [], last_checkpoint: null };
    } else if (input.session_key) {
      const context = await this.byKey(input.workspace_id, input.session_key);
      const db = await this.database(input.workspace_id, false);
      if (db) {
        const session = db.prepare('SELECT session_key,title,first_seen,last_seen,tool_call_count,last_checkpoint_id FROM web_sessions WHERE session_key=?').get(context.sessionKey) as Record<string, unknown> | undefined;
        const checkpoint = db.prepare('SELECT checkpoint_id,payload,created_at FROM web_session_checkpoints WHERE session_key=? ORDER BY created_at DESC LIMIT 1').get(context.sessionKey) as { checkpoint_id:string; payload:string; created_at:string } | undefined;
        const turns = db.prepare('SELECT turn_id,user_message,assistant_reply,created_at FROM web_session_turns WHERE session_key=? ORDER BY created_at DESC LIMIT 10').all(context.sessionKey) as Array<{turn_id:string; user_message:string; assistant_reply:string; created_at:string}>;
        currentSession = session ? { ...session, turns, last_checkpoint: checkpoint ? { checkpoint_id: checkpoint.checkpoint_id, ...JSON.parse(checkpoint.payload), created_at: checkpoint.created_at } : null } : null;
      }
    }
    return { workspace_id: input.workspace_id, current_session_detected: Boolean(current), current_session: currentSession, recent_sessions: list.sessions, next_step: 'Use web_session_read for a selected session and web_session_checkpoint after each completed stage.', limitation: 'WebCodex can restore MCP activity and explicit checkpoints, not the full ChatGPT web transcript.' };
  }

  status() {
    return { enabled: this.config.enabled, workspace_scoped: true, directory: this.config.directory, retention_days: this.config.retentionDays, max_events: this.config.maxEvents, max_bytes: this.config.maxBytes, record_tool_arguments: this.config.recordToolArguments, record_tool_results: this.config.recordToolResults, remind_before_final_reply: this.config.remindBeforeFinalReply ?? true, journal_status_in_tool_results: this.config.journalStatusInToolResults ?? true, stale_pending_minutes: this.config.stalePendingMinutes ?? 30, records: 'mcp_tool_activity_explicit_checkpoints_and_caller_supplied_turns', limitation: 'The MCP server cannot automatically receive ordinary ChatGPT messages or replies; use web_session_turn to record them explicitly.' };
  }

  close() { for (const db of this.databases.values()) { try { db.close(); } catch {} } this.databases.clear(); this.readOnlyDatabases.clear(); this.inFlight.clear(); }
}
