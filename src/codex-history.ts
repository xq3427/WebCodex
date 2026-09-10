import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';

export interface CodexHistoryBase { threadId: string; endOrdinalExclusive: number; endByteOffset: number }
export interface CodexSessionMetadata {
  id: string; title: string; cwd: string; createdAt: string | null; updatedAt: string | null; archived: boolean;
  source: 'sqlite' | 'jsonl'; historyMode: string | null; historyBase: CodexHistoryBase | null;
}
export interface CodexHistoryPosition { fileKey: string; byteOffset: number }
export interface CodexHistoryRecord { startByte: number; endByte: number; sha256: string; record: Record<string, unknown> }
export interface CodexHistoryAnchor { fileKey: string; startByte: number; endByte: number; sha256: string }
export interface CodexHistoryOmission {
  file_key: string; start_byte: number; end_byte: number;
  reason: 'record_limit' | 'window_fragment' | 'incomplete_tail' | 'invalid_record' | 'additional_omissions';
  range_kind: 'exact' | 'enclosing';
  /** A fragment can belong to a line spanning several windows, so its line count is unknown. */
  record_count: number | null;
}
export interface CodexHistoryWindow {
  session: CodexSessionMetadata; records: CodexHistoryRecord[];
  snapshotBytes: number; windowStart: number; windowEnd: number; fileKey: string;
  nextBefore: CodexHistoryPosition | null; historyBase: CodexHistoryBase | null;
  unreadOlderHistory: boolean; warnings: string[]; omissions: CodexHistoryOmission[];
  stats: { scannedBytes: number; skippedLeadingFragment: number; skippedIncompleteTail: number; skippedOversizedLines: number; invalidRecords: number };
}
export interface CodexHistoryList {
  sessions: CodexSessionMetadata[]; nextOffset: number | null; source: 'sqlite' | 'jsonl'; indexRevision: string; warnings: string[];
}

// This module reads only rollout files and selected thread-index metadata. It never launches Codex.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_LIMIT = 8 * 1024 * 1024;
const HEADER_LIMIT = 512 * 1024;
const WINDOW_LIMIT = 1024 * 1024;
const CANDIDATE_LIMIT = 32;
const CHAIN_LIMIT = 8;
type Budget = { used: number; limit?: number };
type IndexRow = { id: string; rollout_path: string; cwd: string; title: string; created_at: number | null; updated_at: number | null; archived: number };
type Candidate = { file: string; idHint: string; modified: number; archived: boolean };
type Segment = { file: string; key: string; size: number; end: number; ordinal: number | null; metadata: CodexSessionMetadata };
const integer = (value: number, min: number, max: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new AppError('INVALID_ARGUMENT', `${label} must be an integer between ${min} and ${max}.`);
  return value;
};
const within = (root: string, target: string) => { const rel = path.relative(root, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && (a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n)));
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const warn = (warnings: string[], warning: string) => { if (!warnings.includes(warning)) warnings.push(warning); };
const isoTime = (value: unknown): string | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  const millis = typeof value === 'number' && number < 1e12 ? number * 1000 : number;
  if (!Number.isFinite(millis)) return null;
  try { return new Date(millis).toISOString(); } catch { return null; }
};

/** Normalize stored Windows extended paths without accessing or authorizing the working directory. */
export function normalizeCodexCwd(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) value = '\\\\' + value.slice(8);
  else if (value.startsWith('\\\\?\\')) value = value.slice(4);
  return path.normalize(value);
}

/** Read-only access to Codex's local thread index and bounded, complete JSONL records. */
export class CodexHistory {
  private readonly home: string;
  constructor(home: string, private readonly options: { maxRecordBytes?: number } = {}) {
    if (typeof home !== 'string' || !path.isAbsolute(home) || home.includes('\0')) throw new AppError('HISTORY_PATH_DENIED', 'Codex home must be a locally configured absolute directory.');
    this.home = path.resolve(normalizeCodexCwd(home));
  }

  private validateId(id: string) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new AppError('INVALID_ARGUMENT', 'sessionId must be a Codex thread UUID.');
  }

  private async noLinks(target: string) {
    let current = path.parse(target).root;
    for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new AppError('HISTORY_PATH_DENIED', 'Codex history paths cannot traverse links or junctions.');
    }
  }

  private async homePath() {
    await this.noLinks(this.home);
    const info = await lstat(this.home);
    if (!info.isDirectory()) throw new AppError('HISTORY_PATH_DENIED', 'Codex home must be a real directory.');
    return normalizeCodexCwd(await realpath(this.home));
  }

  private async checkedPath(target: string, kind: 'rollout' | 'database' | 'index' | 'companion') {
    const home = await this.homePath();
    const absolute = path.resolve(normalizeCodexCwd(target));
    const relative = path.relative(home, absolute);
    const parts = relative.split(path.sep);
    const permitted = kind === 'rollout'
      ? parts.length >= 2 && ['sessions', 'archived_sessions'].includes(parts[0]) && path.extname(absolute) === '.jsonl'
      : parts.length === 1 && (kind === 'index' ? relative === 'session_index.jsonl' : kind === 'database' ? /^state_\d+\.sqlite$/.test(relative) : /^state_\d+\.sqlite-(?:wal|shm)$/.test(relative));
    if (!within(home, absolute) || !permitted) throw new AppError('HISTORY_PATH_DENIED', 'History access is restricted to session rollouts and the thread index.');
    await this.noLinks(absolute);
    const info = await lstat(absolute, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n) throw new AppError('HISTORY_PATH_DENIED', 'History files must be regular files without hard links.');
    const canonical = normalizeCodexCwd(await realpath(absolute));
    if (!within(home, canonical)) throw new AppError('HISTORY_PATH_DENIED', 'Resolved history file is outside Codex home.');
    return { file: canonical, info };
  }

  private async withFile<T>(target: string, action: (file: FileHandle, info: BigIntStats, canonical: string) => Promise<T>): Promise<T> {
    const checked = await this.checkedPath(target, 'rollout');
    const file = await open(checked.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat({ bigint: true });
      if (!sameFile(info, checked.info) || !info.isFile() || info.nlink !== 1n) throw new AppError('HISTORY_CHANGED', 'History file changed while opening. Retry the request.');
      const result = await action(file, info, checked.file);
      const after = await file.stat({ bigint: true });
      const current = await lstat(checked.file, { bigint: true });
      if (!sameFile(info, after) || !sameFile(info, current) || after.size < info.size || after.nlink !== 1n || current.nlink !== 1n) throw new AppError('HISTORY_CHANGED', 'History file was replaced or truncated while reading. Retry the request.');
      return result;
    } finally { await file.close(); }
  }

  private async bytes(file: FileHandle, position: number, length: number, budget: Budget) {
    if (budget.used + length > (budget.limit ?? SCAN_LIMIT)) throw new AppError('HISTORY_SCAN_LIMIT', 'This history request reached its bounded scan limit.');
    budget.used += length;
    const bytes = Buffer.alloc(length);
    let count = 0;
    while (count < length) {
      const result = await file.read(bytes, count, length - count, position + count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count !== length) throw new AppError('HISTORY_CHANGED', 'History file changed while reading. Retry the request.');
    return bytes;
  }

  private async inspect(target: string, expectedId: string, budget: Budget, row?: IndexRow): Promise<Segment> {
    return this.withFile(target, async (file, info, canonical) => {
      const size = Number(info.size);
      if (!Number.isSafeInteger(size)) throw new AppError('HISTORY_TOO_LARGE', 'History file size is not supported.');
      const chunks: Buffer[] = [];
      let position = 0, newline = -1;
      while (position < Math.min(size, HEADER_LIMIT) && newline === -1) {
        const chunk = await this.bytes(file, position, Math.min(16 * 1024, size - position, HEADER_LIMIT - position), budget);
        newline = chunk.indexOf(10);
        chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
        position += chunk.length;
      }
      if (newline === -1) throw new AppError('HISTORY_HEADER_INVALID', 'History must begin with a bounded, complete session metadata record.');
      let record: any;
      try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, '')); }
      catch { throw new AppError('HISTORY_HEADER_INVALID', 'History session metadata is invalid.'); }
      if (record?.type !== 'session_meta' || record.payload?.id !== expectedId || typeof record.payload?.cwd !== 'string' || !record.payload.cwd || record.payload.cwd.length > 4096 || record.payload.cwd.includes('\0')) throw new AppError('HISTORY_SESSION_MISMATCH', 'History metadata does not match the requested thread.');
      const payload = record.payload;
      let historyBase: CodexHistoryBase | null = null;
      if (payload.history_base !== undefined && payload.history_base !== null) {
        const base = payload.history_base;
        if (!UUID.test(base.thread_id ?? '') || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive < 0 || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 0) throw new AppError('HISTORY_HEADER_INVALID', 'History base metadata is invalid.');
        historyBase = { threadId: base.thread_id, endOrdinalExclusive: base.end_ordinal_exclusive, endByteOffset: base.end_byte_offset };
      }
      const relative = path.relative(await this.homePath(), canonical);
      const metadata: CodexSessionMetadata = {
        id: expectedId, title: typeof row?.title === 'string' ? row.title : '', cwd: normalizeCodexCwd(payload.cwd),
        createdAt: isoTime(row?.created_at) ?? isoTime(payload.timestamp), updatedAt: isoTime(row?.updated_at) ?? new Date(Number(info.mtimeMs)).toISOString(),
        archived: Boolean(row?.archived) || relative.split(path.sep)[0] === 'archived_sessions', source: row ? 'sqlite' : 'jsonl',
        historyMode: typeof payload.history_mode === 'string' && payload.history_mode.length <= 64 ? payload.history_mode : null, historyBase,
      };
      const key = createHash('sha256').update([canonical, info.dev, info.ino, info.birthtimeNs].join('\0')).digest('hex');
      return { file: canonical, key, size, end: size, ordinal: Number.isSafeInteger(record.ordinal) && record.ordinal >= 0 ? record.ordinal : null, metadata };
    });
  }

  private async indexRows(id?: string): Promise<IndexRow[] | null> {
    const home = await this.homePath();
    const names = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    for (const name of names.slice(0, 8)) {
      const target = path.join(home, name);
      await this.checkedPath(target, 'database');
      let hasWal = false, hasShm = false;
      for (const suffix of ['-wal', '-shm']) {
        try { await this.checkedPath(target + suffix, 'companion'); if (suffix === '-wal') hasWal = true; else hasShm = true; }
        catch (error) { if (!missing(error)) throw error; }
      }
      // A read-only WAL connection must not create a missing shared-memory sidecar.
      if (hasWal && !hasShm) continue;
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(target, { readOnly: true });
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
        const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
        if (!['id', 'rollout_path', 'cwd'].every(name => columns.has(name))) continue;
        const optional = (name: string, fallback: string) => columns.has(name) ? name : `${fallback} AS ${name}`;
        const query = `SELECT id,rollout_path,cwd,${columns.has('title') ? "CASE WHEN length(title)<=16384 THEN title ELSE '[Oversized title omitted]' END AS title" : "'' AS title"},${optional('created_at', 'NULL')},${optional('updated_at', 'NULL')},${optional('archived', '0')} FROM threads${id ? ' WHERE id=?' : ''} ORDER BY ${columns.has('updated_at') ? 'updated_at DESC,' : ''}id LIMIT 5001`;
        const rows = (id ? db.prepare(query).all(id) : db.prepare(query).all()) as IndexRow[];
        return rows;
      } catch { /* An unsupported or unavailable index falls back to read-only rollout metadata. */ }
      finally { db?.close(); }
    }
    return null;
  }

  private async candidates(): Promise<Candidate[]> {
    const home = await this.homePath();
    const results: Candidate[] = [];
    const pending = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
    let entries = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      try { await this.noLinks(directory); }
      catch (error) { if (missing(error)) continue; throw error; }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 20_000) throw new AppError('HISTORY_SCAN_LIMIT', 'History directory enumeration exceeded its entry limit.');
        if (entry.isSymbolicLink()) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) { pending.push(target); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const idHint = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
        if (!idHint) continue;
        const stat = await lstat(target);
        results.push({ file: target, idHint, modified: stat.mtimeMs, archived: path.relative(home, target).split(path.sep)[0] === 'archived_sessions' });
      }
    }
    return results.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
  }

  private async chooseFallback(id: string, candidates: Candidate[], budget: Budget): Promise<Segment> {
    const choices = candidates.filter(candidate => candidate.idHint.toLowerCase() === id.toLowerCase());
    if (choices.length > CANDIDATE_LIMIT) throw new AppError('HISTORY_SCAN_LIMIT', 'Too many rollout candidates share this thread ID.');
    const segments: Segment[] = [];
    for (const candidate of choices) {
      try { segments.push(await this.inspect(candidate.file, id, budget)); }
      catch (error) { if ((error as AppError).code === 'HISTORY_SCAN_LIMIT') throw error; }
    }
    if (!segments.length) throw new AppError('HISTORY_SESSION_NOT_FOUND', 'No readable local history exists for this thread ID.');
    segments.sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0));
    if (segments.length > 1 && (segments[0].ordinal ?? 0) === (segments[1].ordinal ?? 0)) throw new AppError('HISTORY_AMBIGUOUS', 'Several rollout files match this thread without an unambiguous current segment.');
    return segments[0];
  }

  private async resolve(id: string, budget: Budget): Promise<Segment> {
    this.validateId(id);
    id = id.toLowerCase();
    const rows = await this.indexRows(id);
    if (rows?.length) return this.inspect(rows[0].rollout_path, id, budget, rows[0]);
    return this.chooseFallback(id, await this.candidates(), budget);
  }

  async get(sessionId: string): Promise<CodexSessionMetadata> {
    return (await this.resolve(sessionId, { used: 0 })).metadata;
  }

  async list(input: { offset?: number; limit?: number; includeArchived?: boolean } = {}): Promise<CodexHistoryList> {
    const offset = integer(input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const limit = integer(input.limit ?? 20, 1, 100, 'limit');
    const budget: Budget = { used: 0 };
    const warnings: string[] = [];
    const sessions: CodexSessionMetadata[] = [];
    const rows = await this.indexRows();
    if (rows !== null) {
      const indexRevision = createHash('sha256').update(JSON.stringify(rows.map(row => [row.id, row.rollout_path, row.title, row.cwd, row.updated_at, row.archived]))).digest('hex');
      if (rows.length > 5000) warn(warnings, 'index_row_limit');
      const filtered = rows.slice(0, 5000).filter(row => input.includeArchived || !row.archived);
      let cursor = offset;
      while (cursor < filtered.length && sessions.length < limit) {
        const row = filtered[cursor++];
        try { this.validateId(row.id); const metadata = (await this.inspect(row.rollout_path, row.id, budget, row)).metadata; if (input.includeArchived || !metadata.archived) sessions.push(metadata); }
        catch (error) {
          warn(warnings, 'unreadable_index_entry');
          if ((error as AppError).code === 'HISTORY_SCAN_LIMIT') { if (sessions.length) cursor--; warn(warnings, 'scan_limit'); break; }
        }
      }
      return { sessions, nextOffset: cursor < filtered.length ? cursor : null, source: 'sqlite', indexRevision, warnings };
    }
    warn(warnings, 'sqlite_index_unavailable');
    const allCandidates = await this.candidates();
    const indexRevision = createHash('sha256').update(JSON.stringify(allCandidates.map(candidate => [candidate.file, candidate.idHint, candidate.modified, candidate.archived]))).digest('hex');
    const candidates = allCandidates.filter(candidate => input.includeArchived || !candidate.archived);
    const ids = [...new Set(candidates.map(candidate => candidate.idHint))];
    let cursor = offset;
    while (cursor < ids.length && sessions.length < limit) {
      const id = ids[cursor++];
      try { sessions.push((await this.chooseFallback(id, candidates, budget)).metadata); }
      catch (error) {
        warn(warnings, 'unreadable_or_ambiguous_rollout');
        if ((error as AppError).code === 'HISTORY_SCAN_LIMIT') { if (sessions.length) cursor--; warn(warnings, 'scan_limit'); break; }
      }
    }
    return { sessions, nextOffset: cursor < ids.length ? cursor : null, source: 'jsonl', indexRevision, warnings };
  }

  private async boundaryMatches(segment: Segment, base: CodexHistoryBase, budget: Budget) {
    if (segment.size < base.endByteOffset || base.endByteOffset === 0 || (segment.ordinal !== null && segment.ordinal >= base.endOrdinalExclusive)) return false;
    return this.withFile(segment.file, async file => {
      const start = Math.max(0, base.endByteOffset - WINDOW_LIMIT);
      const bytes = await this.bytes(file, start, base.endByteOffset - start, budget);
      if (bytes.at(-1) !== 10) return false;
      const previous = bytes.lastIndexOf(10, bytes.length - 2);
      if (previous === -1 && start !== 0) return false;
      try {
        const record = JSON.parse(bytes.subarray(previous + 1, bytes.length - 1).toString('utf8'));
        return record.ordinal === base.endOrdinalExclusive - 1;
      } catch { return false; }
    });
  }

  private async chain(current: Segment, budget: Budget) {
    const segments = [current];
    const warnings: string[] = [];
    let unreadOlderHistory = false;
    let candidates: Candidate[] | undefined;
    while (segments.at(-1)!.metadata.historyBase) {
      if (segments.length >= CHAIN_LIMIT) { warn(warnings, 'history_chain_limit'); unreadOlderHistory = true; break; }
      const base = segments.at(-1)!.metadata.historyBase!;
      if (base.endByteOffset === 0 && base.endOrdinalExclusive === 0) break;
      try {
        candidates ??= await this.candidates();
        const choices = candidates.filter(candidate => candidate.idHint.toLowerCase() === base.threadId.toLowerCase());
        if (choices.length > CANDIDATE_LIMIT) throw new AppError('HISTORY_SCAN_LIMIT', 'History base candidate limit exceeded.');
        const matches: Segment[] = [];
        for (const candidate of choices) {
          if (segments.some(segment => segment.file === candidate.file)) continue;
          let inspected: Segment;
          try { inspected = await this.inspect(candidate.file, base.threadId, budget); }
          catch (error) { if ((error as AppError).code === 'HISTORY_SCAN_LIMIT') throw error; continue; }
          if (segments.some(segment => segment.key === inspected.key)) continue;
          if (await this.boundaryMatches(inspected, base, budget)) matches.push({ ...inspected, end: base.endByteOffset });
        }
        if (matches.length !== 1) { unreadOlderHistory = true; warn(warnings, matches.length ? 'history_base_ambiguous' : 'history_base_missing'); break; }
        segments.push(matches[0]);
      } catch (error) {
        unreadOlderHistory = true;
        warn(warnings, (error as AppError).code === 'HISTORY_SCAN_LIMIT' ? 'history_chain_scan_limit' : 'history_base_unreadable');
        break;
      }
    }
    return { segments, warnings, unreadOlderHistory };
  }

  async readWindow(input: { sessionId: string; before?: CodexHistoryPosition; maxBytes?: number }): Promise<CodexHistoryWindow> {
    const max = integer(input.maxBytes ?? WINDOW_LIMIT, 1, WINDOW_LIMIT, 'maxBytes');
    const budget: Budget = { used: 0 };
    const current = await this.resolve(input.sessionId, budget);
    const chainBudget: Budget = { used: budget.used, limit: SCAN_LIMIT - max - 1 };
    const chain = await this.chain(current, chainBudget);
    budget.used = chainBudget.used;
    const position = input.before;
    if (position && (typeof position.fileKey !== 'string' || !/^[a-f0-9]{64}$/.test(position.fileKey))) throw new AppError('INVALID_ARGUMENT', 'Invalid history cursor file key.');
    const segmentIndex = position ? chain.segments.findIndex(segment => segment.key === position.fileKey) : 0;
    if (segmentIndex < 0) throw new AppError('HISTORY_CURSOR_STALE', 'History cursor no longer identifies a segment of this thread. Start from the latest window.');
    const segment = chain.segments[segmentIndex];
    if (position && position.byteOffset > segment.end) throw new AppError('HISTORY_CURSOR_STALE', 'History was truncated below the saved cursor. Restart the read.');
    const end = position ? integer(position.byteOffset, 0, segment.end, 'byteOffset') : segment.end;
    const start = Math.max(0, end - max);
    const records: CodexHistoryRecord[] = [];
    const omissions: CodexHistoryOmission[] = [];
    const omit = (startByte: number, endByte: number, reason: CodexHistoryOmission['reason'], count: number | null) => {
      if (endByte <= startByte) return;
      const previous = omissions.at(-1);
      if (previous && previous.reason === reason && previous.end_byte === startByte) {
        previous.end_byte = endByte;
        previous.record_count = previous.record_count === null || count === null ? null : previous.record_count + count;
      } else if (omissions.length >= 64) {
        const summary = omissions[63];
        summary.start_byte = Math.min(summary.start_byte, startByte);
        summary.end_byte = Math.max(summary.end_byte, endByte);
        summary.reason = 'additional_omissions';
        summary.range_kind = 'enclosing';
        summary.record_count = summary.record_count === null || count === null ? null : summary.record_count + count;
      } else omissions.push({ file_key: segment.key, start_byte: startByte, end_byte: endByte, reason, record_count: count, range_kind: 'exact' });
    };
    const stats = { scannedBytes: 0, skippedLeadingFragment: 0, skippedIncompleteTail: 0, skippedOversizedLines: 0, invalidRecords: 0 };
    let effectiveStart = start;
    await this.withFile(segment.file, async (file, info, canonical) => {
      const key = createHash('sha256').update([canonical, info.dev, info.ino, info.birthtimeNs].join('\0')).digest('hex');
      if (key !== segment.key || Number(info.size) < segment.end) throw new AppError('HISTORY_CHANGED', 'History segment changed before reading its window.');
      const probeStart = Math.max(0, start - 1);
      const bytes = await this.bytes(file, probeStart, end - probeStart, budget);
      let begin = start - probeStart;
      if (start > 0 && bytes[begin - 1] !== 10) {
        const newline = bytes.indexOf(10, begin);
        const skipTo = newline === -1 ? bytes.length : newline + 1;
        stats.skippedLeadingFragment = skipTo - begin;
        begin = skipTo;
        if (begin === bytes.length) {
          stats.skippedOversizedLines++;
          // This cursor advances into the line. Unlike deferred leading fragments,
          // these bytes cannot be recovered on the next window and must be reported.
          omit(start, end, 'window_fragment', null);
        }
      }
      effectiveStart = probeStart + begin;
      const lastNewline = bytes.lastIndexOf(10);
      const completeEnd = lastNewline < begin ? begin : lastNewline + 1;
      stats.skippedIncompleteTail = bytes.length - completeEnd;
      if (completeEnd < bytes.length) omit(probeStart + completeEnd, end, end === segment.size ? 'incomplete_tail' : 'window_fragment', null);
      for (let cursor = begin; cursor < completeEnd;) {
        const newline = bytes.indexOf(10, cursor);
        const line = bytes.subarray(cursor, newline);
        if (line.length > (this.options.maxRecordBytes ?? WINDOW_LIMIT)) { stats.skippedOversizedLines++; omit(probeStart + cursor, probeStart + newline + 1, 'record_limit', 1); cursor = newline + 1; continue; }
        if (line.length) {
          try {
            const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line).replace(/^\uFEFF/, ''));
            if (record && typeof record === 'object' && !Array.isArray(record)) records.push({ startByte: probeStart + cursor, endByte: probeStart + newline + 1, sha256: createHash('sha256').update(bytes.subarray(cursor, newline + 1)).digest('hex'), record: record as Record<string, unknown> });
            else { stats.invalidRecords++; omit(probeStart + cursor, probeStart + newline + 1, 'invalid_record', 1); }
          } catch { stats.invalidRecords++; omit(probeStart + cursor, probeStart + newline + 1, 'invalid_record', 1); }
        }
        cursor = newline + 1;
      }
    });
    let nextBefore: CodexHistoryPosition | null = null;
    if (start > 0) nextBefore = { fileKey: segment.key, byteOffset: effectiveStart < end ? effectiveStart : start };
    else if (segmentIndex + 1 < chain.segments.length) { const older = chain.segments[segmentIndex + 1]; nextBefore = { fileKey: older.key, byteOffset: older.end }; }
    stats.scannedBytes = budget.used;
    return { session: current.metadata, records, snapshotBytes: segment.size, windowStart: start, windowEnd: end, fileKey: segment.key, nextBefore, historyBase: segment.metadata.historyBase, unreadOlderHistory: chain.unreadOlderHistory, warnings: chain.warnings, omissions, stats };
  }

  /** Re-read one bounded complete record. Signed service cursors supply the anchor;
   * exact content and file identity checks allow appends, but never mix old/new text. */
  async readRecord(input: { sessionId: string; anchor: CodexHistoryAnchor }) {
    const { anchor } = input;
    const stale = () => new AppError('HISTORY_CURSOR_STALE', 'The saved history record was replaced, changed, or is no longer part of this thread. Restart the read.');
    if (!anchor || !/^[a-f0-9]{64}$/.test(anchor.fileKey) || !/^[a-f0-9]{64}$/.test(anchor.sha256)
      || !Number.isSafeInteger(anchor.startByte) || !Number.isSafeInteger(anchor.endByte) || anchor.startByte < 0
      || anchor.endByte <= anchor.startByte || anchor.endByte - anchor.startByte > (this.options.maxRecordBytes ?? WINDOW_LIMIT) + 1) throw stale();
    const budget: Budget = { used: 0 };
    let current: Segment;
    try { current = await this.resolve(input.sessionId, budget); }
    catch (error) {
      if (['HISTORY_HEADER_INVALID', 'HISTORY_SESSION_MISMATCH', 'HISTORY_SESSION_NOT_FOUND', 'HISTORY_CHANGED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw stale();
      throw error;
    }
    const chainBudget: Budget = { used: budget.used, limit: SCAN_LIMIT - (anchor.endByte - anchor.startByte) - 1 };
    const chain = await this.chain(current, chainBudget);
    budget.used = chainBudget.used;
    const segment = chain.segments.find(candidate => candidate.key === anchor.fileKey);
    if (!segment || anchor.endByte > segment.end) throw stale();
    const record = await this.withFile(segment.file, async (file, info, canonical) => {
      const key = createHash('sha256').update([canonical, info.dev, info.ino, info.birthtimeNs].join('\0')).digest('hex');
      if (key !== anchor.fileKey || Number(info.size) < anchor.endByte) throw stale();
      const start = Math.max(0, anchor.startByte - 1);
      const data = await this.bytes(file, start, anchor.endByte - start, budget);
      const bytes = data.subarray(anchor.startByte - start);
      if ((anchor.startByte > 0 && data[0] !== 10) || bytes.at(-1) !== 10 || bytes.indexOf(10) !== bytes.length - 1
        || createHash('sha256').update(bytes).digest('hex') !== anchor.sha256) throw stale();
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw stale();
        return { startByte: anchor.startByte, endByte: anchor.endByte, sha256: anchor.sha256, record: value as Record<string, unknown> };
      } catch { throw stale(); }
    });
    return { session: current.metadata, record, warnings: chain.warnings, unreadOlderHistory: chain.unreadOlderHistory, scannedBytes: budget.used };
  }
}
