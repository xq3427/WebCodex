import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { applyPatch as applyUnifiedPatch, createTwoFilesPatch, parsePatch } from 'diff';
import { AppError, errorResult } from './errors.js';
import type { ServiceContext, Store } from './types.js';
import { redactSessionText } from './codex-redaction.js';
import { addRecordBinding, assertRecordBinding, initializeIdentity } from './identity.js';
import { assertPatchInputSize } from './patch-limits.js';
import { fileOperations, type FileOperationAttempt, type FileOperationTool } from './file-operations.js';

type FileInput = { workspace_id: string; path: string };
type ReadInput = FileInput & { start_line?: number; end_line?: number };
type WriteInput = FileInput & { content: string; expected_sha256: string | null; idempotency_key: string };
export type WriteBytesInput = FileInput & { bytes: Buffer; expected_sha256: string | null; idempotency_key: string };
type WriteBytesGuards = { additionalLockedPaths?: string[]; beforeCommit?: () => Promise<void> };
type ChangeRow = { id: string; workspace_id: string; workspace_binding: string | null; path: string; before_blob: Uint8Array | null; before_sha256: string | null; after_sha256: string | null; before_mode: number | null; after_mode: number | null; status: string; created_at: string; restores_id: string | null; write_kind: 'text' | 'bytes' | null };
type ChangeModes = { beforeMode?: number | null; afterMode?: number | null };
export type TextFormat = { encoding: 'utf8' | 'utf16le' | 'utf16be'; bom: boolean; newline: 'lf' | 'crlf' | 'mixed' | 'none' };
export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const integer = (value: number, min: number, max: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new AppError('INVALID_ARGUMENT', `${label} must be an integer between ${min} and ${max}.`);
  return value;
};
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const initializedFileStores = new WeakSet<Store>();
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && (a.dev === b.dev || process.platform === 'win32' && (a.dev === 0n || b.dev === 0n));
const validateHash = (value: string | null) => {
  if (value !== null && !/^[a-f0-9]{64}$/i.test(value)) throw new AppError('INVALID_ARGUMENT', 'expected_sha256 must be a SHA-256 hex string or null for an absent file.');
};

export function decode(bytes: Buffer): { text: string; format: TextFormat } {
  let encoding: TextFormat['encoding'] = 'utf8';
  let offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf16le'; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf16be'; offset = 2; }
  else if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) offset = 3;
  let text: string;
  try { text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset)); }
  catch { throw new AppError('UNSUPPORTED_ENCODING', 'Only valid UTF-8 and BOM-marked UTF-16 text files are supported.'); }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new AppError('BINARY_FILE', 'This file contains binary control characters.');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  const newline = !lf ? 'none' : crlf === lf ? 'crlf' : crlf === 0 ? 'lf' : 'mixed';
  return { text, format: { encoding, bom: offset > 0, newline } };
}

export function encode(text: string, format: TextFormat): Buffer {
  // A write preserves the file's established newline convention; mixed files are left literal.
  if (format.newline === 'crlf') text = text.replace(/\r?\n/g, '\r\n');
  else if (format.newline === 'lf') text = text.replace(/\r\n/g, '\n');
  let bytes = Buffer.from(text, format.encoding === 'utf8' ? 'utf8' : 'utf16le');
  if (format.encoding === 'utf16be') bytes = bytes.swap16();
  if (format.bom) bytes = Buffer.concat([Buffer.from(format.encoding === 'utf8' ? [0xef, 0xbb, 0xbf] : format.encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]), bytes]);
  decode(bytes);
  return bytes;
}

export function capText(text: string, byteLimit: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= byteLimit) return { text, truncated: false };
  let end = byteLimit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/** Pure patch preparation shared by individual writes and multi-file previews. */
export function preparePatchedBytes(relative: string, before: Buffer, patch: string): Buffer {
  let patches;
  try { patches = parsePatch(patch); } catch { throw new AppError('INVALID_PATCH', 'Malformed unified diff.'); }
  if (patches.length !== 1 || !patches[0].hunks.length) throw new AppError('INVALID_PATCH', 'Provide exactly one nonempty unified diff for the requested file.');
  const matchesPath = (name: string | undefined) => { const normalized = name?.replace(/\\/g, '/').replace(/^\.\//, ''); return normalized === relative || normalized?.replace(/^[ab]\//, '') === relative; };
  if (!matchesPath(patches[0].oldFileName) || !matchesPath(patches[0].newFileName)) throw new AppError('PATCH_PATH_MISMATCH', 'Both patch filenames must match the requested workspace-relative file path.');
  const decoded = decode(before);
  // Reject jsdiff's relocation of a matching hunk to another occurrence.
  const originalLines = decoded.text.replace(/\r\n/g, '\n').split('\n');
  if (originalLines.at(-1) === '') originalLines.pop();
  let previousEnd = 0;
  let delta = 0;
  for (const hunk of patches[0].hunks) {
    if (![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(Number.isSafeInteger) || hunk.oldStart < 1 || hunk.newStart < 1 || hunk.oldLines < 0 || hunk.newLines < 0 || hunk.oldStart - 1 < previousEnd || hunk.newStart !== hunk.oldStart + delta) throw new AppError('INVALID_PATCH', 'Invalid or overlapping hunk ranges.');
    let index = hunk.oldStart - 1;
    if (index > originalLines.length) throw new AppError('PATCH_CONFLICT', 'Patch line range is beyond the file.');
    for (const line of hunk.lines) {
      if (line[0] !== ' ' && line[0] !== '-') continue;
      if (originalLines[index++] !== line.slice(1).replace(/\r$/, '')) throw new AppError('PATCH_CONFLICT', 'Patch context does not match its declared line range.');
    }
    previousEnd = index;
    delta += hunk.newLines - hunk.oldLines;
  }
  const result = applyUnifiedPatch(decoded.text, patches[0], { fuzzFactor: 0, autoConvertLineEndings: true });
  if (result === false) throw new AppError('PATCH_CONFLICT', 'Patch context does not match the current file.');
  return encode(result, decoded.format);
}

/** File mutations are serialized within this service. This is not an OS-wide CAS lock. */
export class FileService {
  private locks = new Map<string, Promise<void>>();

  constructor(private ctx: ServiceContext) {
    initializeIdentity(ctx);
    ctx.store.db.exec(`CREATE TABLE IF NOT EXISTS file_changes (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL,
      before_blob BLOB, before_sha256 TEXT, after_sha256 TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, restores_id TEXT, error TEXT
    ); CREATE INDEX IF NOT EXISTS file_changes_workspace ON file_changes(workspace_id, created_at);`);
    addRecordBinding(ctx.store, 'file_changes');
    const columns = new Set(ctx.store.db.prepare('PRAGMA table_info(file_changes)').all().map(row => row.name));
    for (const column of ['before_mode', 'after_mode']) if (!columns.has(column)) ctx.store.db.exec(`ALTER TABLE file_changes ADD COLUMN ${column} INTEGER`);
    if (!columns.has('write_kind')) ctx.store.db.exec('ALTER TABLE file_changes ADD COLUMN write_kind TEXT');
    if (!initializedFileStores.has(ctx.store)) {
      ctx.store.db.exec("UPDATE file_changes SET status='unknown' WHERE status='pending'");
      initializedFileStores.add(ctx.store);
    }
    fileOperations(ctx);
  }

  private relative(workspaceId: string, absolute: string) { return path.relative(this.ctx.paths.get(workspaceId).root, absolute).split(path.sep).join('/') || '.'; }
  private binaryLimit() { return this.ctx.config.limits.binaryWriteMaxBytes ?? 33_554_432; }
  private snapshotLimit() { return Math.max(this.ctx.config.limits.writeMaxBytes, this.binaryLimit()); }
  private changeLimit(row: ChangeRow) {
    if (row.write_kind !== null && row.write_kind !== 'bytes' && row.write_kind !== 'text') throw new AppError('CHANGE_CORRUPT', 'Saved file write kind is invalid.');
    return row.write_kind === 'bytes' ? this.snapshotLimit() : this.ctx.config.limits.writeMaxBytes;
  }

  private async lockKey(key: string) {
    // Include filesystem aliases (for example Windows short names) in the same lock.
    try { key = await fs.realpath(key); }
    catch (error) { if (!isMissing(error)) throw error; key = path.join(await fs.realpath(path.dirname(key)), path.basename(key)); }
    if (process.platform === 'win32') key = key.toLowerCase();
    return key;
  }

  private async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    key = await this.lockKey(key);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => held);
    this.locks.set(key, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (this.locks.get(key) === tail) this.locks.delete(key); }
  }

  /** Internal multi-file coordination. Callers must resolve paths before entering. */
  async withPathsLocked<T>(paths: string[], action: () => Promise<T>): Promise<T> {
    const keys = [...new Set(await Promise.all(paths.map(value => this.lockKey(value))))].sort();
    const next = (index: number): Promise<T> => index === keys.length ? action() : this.locked(keys[index], () => next(index + 1));
    return next(0);
  }

  /** Internal byte snapshot shared with batches; policy must be checked by the caller. */
  async snapshotForBatch(absolute: string, maxBytes?: number, writeKind: 'text' | 'bytes' = 'text') {
    const limit = writeKind === 'bytes' ? this.binaryLimit() : this.ctx.config.limits.writeMaxBytes;
    return this.snapshot(absolute, Math.min(maxBytes ?? limit, limit), true);
  }

  /** Permission bits only: ownership, ACLs, and special set-ID bits are not copied. */
  async modeForBatch(absolute: string): Promise<number | null> {
    try {
      const info = await fs.lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new AppError('PATH_DENIED', 'File mode observations require a regular file without links.');
      return info.mode & 0o777;
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }

  private async snapshot(absolute: string, maxBytes: number, missing = false): Promise<Buffer | null> {
    let file;
    let entry;
    try {
      entry = await fs.lstat(absolute, { bigint: true });
      if (entry.isSymbolicLink() || entry.nlink > 1n) throw new AppError('PATH_DENIED', 'Links are not supported.');
      if (!entry.isFile()) throw new AppError('NOT_A_FILE', 'The requested path is not a regular file.');
      file = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    }
    catch (error) { if (missing && isMissing(error)) return null; throw error; }
    try {
      const stat = await file.stat({ bigint: true });
      if (!sameIdentity(entry, stat) || stat.nlink > 1n) throw new AppError('FILE_CHANGED', 'The file identity changed during reading.');
      if (!stat.isFile()) throw new AppError('NOT_A_FILE', 'The requested path is not a regular file.');
      if (stat.size > BigInt(maxBytes)) throw new AppError('FILE_TOO_LARGE', `The file exceeds the ${maxBytes} byte limit.`, { size: Number(stat.size), limit: maxBytes });
      // Keep raw IO within the initial bounded size; final metadata catches growth.
      const bytes = Buffer.alloc(Number(stat.size));
      let count = 0;
      while (count < bytes.length) {
        const read = await file.read(bytes, count, bytes.length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      const final = await fs.lstat(absolute, { bigint: true });
      if (count > maxBytes || after.size > BigInt(maxBytes)) throw new AppError('FILE_TOO_LARGE', `The file exceeds the ${maxBytes} byte limit.`);
      if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs || BigInt(count) !== after.size || final.isSymbolicLink() || final.nlink > 1n || !sameIdentity(final, stat) || final.mtimeNs !== stat.mtimeNs || final.ctimeNs !== stat.ctimeNs) throw new AppError('FILE_CHANGED', 'The file changed during reading; read it again.');
      return bytes.subarray(0, count);
    } finally { await file.close(); }
  }

  async list(input: { workspace_id: string; path?: string; cursor?: number; limit?: number }) {
    const absolute = await this.ctx.paths.resolve(input.workspace_id, input.path ?? '.', { directory: true });
    const cursor = integer(input.cursor ?? 0, 0, Number.MAX_SAFE_INTEGER, 'cursor');
    const limit = integer(input.limit ?? Math.min(100, this.ctx.config.limits.listMaxEntries), 1, this.ctx.config.limits.listMaxEntries, 'limit');
    const entries: { name: string; path: string; type: string }[] = [];
    let scanned = 0;
    const directory = await fs.opendir(absolute);
    for await (const entry of directory) {
      if (++scanned > 50_000) throw new AppError('DIRECTORY_TOO_LARGE', 'Directory enumeration exceeded 50,000 entries; select a smaller directory.');
      const relative = this.relative(input.workspace_id, path.join(absolute, entry.name));
      try {
        const allowed = await this.ctx.paths.resolve(input.workspace_id, relative);
        const stat = await fs.stat(allowed);
        if (!stat.isFile() && !stat.isDirectory()) continue;
        entries.push({ name: entry.name, path: relative, type: stat.isDirectory() ? 'directory' : 'file' });
      } catch (error) { if (!(error instanceof AppError) && !isMissing(error)) throw error; }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    this.ctx.store.audit('fs_list', input.workspace_id, { path: this.relative(input.workspace_id, absolute), cursor, limit });
    return { workspace_id: input.workspace_id, path: this.relative(input.workspace_id, absolute), entries: entries.slice(cursor, cursor + limit), next_cursor: cursor + limit < entries.length ? cursor + limit : null, total_entries: entries.length };
  }

  async read(input: ReadInput) {
    return this.readBounded(input, this.ctx.config.limits.readMaxBytes);
  }

  /** Observe exact bytes and a CAS hash without decoding or returning file contents. */
  async stat(input: FileInput) {
    const absolute = await this.ctx.paths.resolve(input.workspace_id, input.path);
    const bytes = (await this.snapshot(absolute, this.snapshotLimit()))!;
    await this.ctx.paths.resolve(input.workspace_id, input.path);
    initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    const relative = this.relative(input.workspace_id, absolute);
    this.ctx.store.audit('fs_stat', input.workspace_id, { path: relative, size_bytes: bytes.length });
    return { workspace_id: input.workspace_id, path: relative, kind: 'file' as const, size_bytes: bytes.length, sha256: hash(bytes) };
  }

  async operationStatus(input: { workspace_id: string; tool: FileOperationTool; idempotency_key: string }) {
    await this.ctx.paths.resolve(input.workspace_id, '.', { directory: true });
    const recorded = fileOperations(this.ctx).status(input);
    let observation: Record<string, unknown> | null = null;
    if (recorded.path) {
      try {
        if (input.tool === 'fs_mkdir') {
          await this.ctx.paths.resolve(input.workspace_id, recorded.path, { directory: true });
          initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
          observation = { status: 'available', kind: 'directory', path: recorded.path };
        } else observation = { status: 'available', ...(await this.stat({ workspace_id: input.workspace_id, path: recorded.path })) };
      }
      catch (error) { observation = { status: isMissing(error) ? 'absent' : 'unavailable', error_code: errorResult(error).error.code }; }
    }
    return { ...recorded, current_observation: observation };
  }

  /** Scrub the complete decoded text before imposing response limits; preserve its raw-byte hash. */
  async readRedacted(input: ReadInput) {
    return this.readBounded(input, this.ctx.config.limits.readMaxBytes, true);
  }

  private async readBounded(input: ReadInput, contentLimit: number, redact = false) {
    const start = integer(input.start_line ?? 1, 1, Number.MAX_SAFE_INTEGER, 'start_line');
    if (input.end_line !== undefined) integer(input.end_line, start, Number.MAX_SAFE_INTEGER, 'end_line');
    const absolute = await this.ctx.paths.resolve(input.workspace_id, input.path);
    const bytes = (await this.snapshot(absolute, Math.max(this.ctx.config.limits.readMaxBytes, this.ctx.config.limits.writeMaxBytes)))!;
    initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    const decoded = decode(bytes);
    const safe = redact ? redactSessionText(decoded.text) : undefined;
    if (safe) decoded.text = safe.text;
    const lines = decoded.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (start > Math.max(1, lines.length)) throw new AppError('INVALID_RANGE', 'start_line is beyond the end of the file.', { total_lines: lines.length });
    const end = Math.min(input.end_line ?? lines.length, lines.length);
    const output = capText(lines.slice(start - 1, end).join(''), contentLimit);
    const shownLines = output.text ? (output.text.match(/\n/g) ?? []).length + (output.text.endsWith('\n') ? 0 : 1) : 0;
    const lineCut = output.truncated && !output.text.endsWith('\n');
    this.ctx.store.audit('fs_read', input.workspace_id, { path: this.relative(input.workspace_id, absolute), start_line: start, end_line: end, truncated: output.truncated });
    return { workspace_id: input.workspace_id, path: this.relative(input.workspace_id, absolute), content: output.text, sha256: hash(bytes), size_bytes: bytes.length, ...decoded.format, ...(safe ? { redactions: safe.redactions, line_numbers: 'redacted_text' } : {}), start_line: start, end_line: shownLines ? start + shownLines - 1 : 0, total_lines: lines.length, truncated: output.truncated, line_cut: lineCut, next_start_line: output.truncated ? Math.max(start, start + shownLines - (lineCut ? 1 : 0)) : end < lines.length ? end + 1 : null };
  }

  async readMany(input: { workspace_id: string; files: { path: string; start_line?: number; end_line?: number }[]; max_total_bytes?: number }) {
    this.ctx.paths.get(input.workspace_id);
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 16) throw new AppError('INVALID_ARGUMENT', 'files must contain between 1 and 16 file requests.');
    const max = integer(input.max_total_bytes ?? this.ctx.config.limits.readMaxBytes, 1, this.ctx.config.limits.readMaxBytes, 'max_total_bytes');
    type Result = { index: number; ok: true; data: Awaited<ReturnType<FileService['read']>> } | ({ index: number; omitted?: true } & ReturnType<typeof errorResult>);
    const results: Result[] = [];
    let used = 0;
    let truncated = false;
    for (const [index, request] of input.files.entries()) {
      try {
        if (used === max) throw new AppError('READ_BUDGET_EXHAUSTED', 'No shared content budget remains for this file. Retry omitted entries in another request.');
        const data = await this.readBounded({ ...request, workspace_id: input.workspace_id }, max - used);
        if (data.truncated && !data.content) throw new AppError('READ_BUDGET_EXHAUSTED', 'The remaining shared content budget cannot fit the next UTF-8 character. Retry this file with a larger budget.');
        used += Buffer.byteLength(data.content, 'utf8');
        truncated ||= data.truncated;
        results.push({ index, ok: true, data });
      } catch (error) {
        const result = errorResult(error);
        const omitted = result.error.code === 'READ_BUDGET_EXHAUSTED';
        truncated ||= omitted;
        results.push({ index, ...result, ...(omitted ? { omitted: true as const } : {}) });
      }
    }
    this.ctx.store.audit('fs_read_many', input.workspace_id, { requested_files: input.files.length, returned_files: results.filter(result => result.ok).length, content_bytes: used, truncated });
    return { workspace_id: input.workspace_id, results, content_bytes: used, max_total_bytes: max, truncated };
  }

  private async searchFiles(workspaceId: string, absolute: string, deadline: number) {
    const pending = [absolute];
    const visited = new Set<string>();
    const files: string[] = [];
    let count = 0;
    while (pending.length) {
      if (Date.now() > deadline) throw new AppError('SEARCH_TIMEOUT', 'File enumeration exceeded the search time limit. Narrow the search path.');
      const candidate = pending.pop()!;
      const relative = this.relative(workspaceId, candidate);
      let allowed: string;
      try { allowed = await this.ctx.paths.resolve(workspaceId, relative); }
      catch (error) { if (error instanceof AppError || isMissing(error)) continue; throw error; }
      const real = await fs.realpath(allowed);
      const visitKey = process.platform === 'win32' ? real.toLowerCase() : real;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      if (++count > 50_000) throw new AppError('SEARCH_TOO_LARGE', 'Search covers more than 50,000 entries; narrow the search path.');
      const stat = await fs.stat(allowed);
      if (stat.isFile()) { files.push(allowed); continue; }
      if (!stat.isDirectory()) continue;
      for await (const entry of await fs.opendir(allowed)) {
        if (['node_modules', 'dist', '.venv', 'venv', '__pycache__'].includes(entry.name) || (path.basename(allowed) === 'research' && entry.name === 'sources')) continue;
        pending.push(path.join(allowed, entry.name));
        if (pending.length + count > 50_000) throw new AppError('SEARCH_TOO_LARGE', 'Search covers more than 50,000 entries; narrow the search path.');
      }
    }
    return files.sort();
  }

  async search(input: { workspace_id: string; query: string; path?: string; regex?: boolean; case_sensitive?: boolean; max_results?: number }) {
    if (!input.query || input.query.length > 4096 || input.query.includes('\0')) throw new AppError('INVALID_ARGUMENT', 'query must contain 1 to 4096 characters and no NUL.');
    const max = integer(input.max_results ?? Math.min(100, this.ctx.config.limits.searchMaxResults), 1, this.ctx.config.limits.searchMaxResults, 'max_results');
    const absolute = await this.ctx.paths.resolve(input.workspace_id, input.path ?? '.');
    const deadline = Date.now() + 15_000;
    const files = await this.searchFiles(input.workspace_id, absolute, deadline);
    const matches: { path: string; line: number; column: number; text: string; line_truncated: boolean }[] = [];
    let truncated = false;
    let usedBytes = 0;
    let searched = 0;
    for (let offset = 0; offset < files.length && !truncated;) {
      // Keep the command line comfortably below Windows' 32K UTF-16 limit.
      const batch: string[] = [];
      let argvLength = 1024 + input.query.length;
      while (offset < files.length && batch.length < 100 && argvLength + files[offset].length < 24_000) { argvLength += files[offset].length + 3; batch.push(files[offset++]); }
      if (!batch.length) throw new AppError('PATH_TOO_LONG', 'A file path is too long to pass safely to ripgrep.');
      const args = ['--json', '--no-config', '--no-messages', '--color', 'never', '--max-count', String(max + 1), '--max-columns', '8192', '--max-filesize', String(Math.max(this.ctx.config.limits.readMaxBytes, this.ctx.config.limits.writeMaxBytes))];
      if (!input.regex) args.push('--fixed-strings');
      if (!input.case_sensitive) args.push('--ignore-case');
      args.push('-e', input.query, '--', ...batch);
      const events = await this.runRg(args, Math.max(1, deadline - Date.now()), Math.max(65_536, this.ctx.config.limits.readMaxBytes));
      for (const event of events.lines) {
        if (event.type !== 'match') continue;
        const data = event.data;
        if (typeof data?.path?.text !== 'string' || typeof data?.lines?.text !== 'string') continue;
        const relative = this.relative(input.workspace_id, data.path.text);
        try { await this.ctx.paths.resolve(input.workspace_id, relative); }
        catch (error) { if (error instanceof AppError || isMissing(error)) continue; throw error; }
        if (matches.length === max) { truncated = true; break; }
        const line = capText(data.lines.text.replace(/\r?\n$/, ''), Math.min(8192, this.ctx.config.limits.readMaxBytes));
        usedBytes += Buffer.byteLength(line.text) + Buffer.byteLength(relative) + 96;
        if (usedBytes > this.ctx.config.limits.readMaxBytes) { truncated = true; break; }
        matches.push({ path: relative, line: data.line_number, column: (data.submatches?.[0]?.start ?? 0) + 1, text: line.text, line_truncated: line.truncated });
      }
      searched += batch.length;
      if (events.truncated) truncated = true;
    }
    initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    this.ctx.store.audit('fs_search', input.workspace_id, { path: input.path ?? '.', matches: matches.length, truncated });
    return { workspace_id: input.workspace_id, matches, truncated, files_searched: searched, files_considered: files.length, max_file_bytes: Math.max(this.ctx.config.limits.readMaxBytes, this.ctx.config.limits.writeMaxBytes), note: 'Search excludes denied paths, dependency/build directories, research/sources, and oversized files; ignores binary matches. Columns are UTF-8 byte offsets.' };
  }

  private async runRg(args: string[], timeout: number, maxBytes: number): Promise<{ lines: any[]; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ctx.config.rgPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
      child.stdout.on('data', (chunk: Buffer) => { const remaining = Math.max(0, maxBytes - bytes); if (remaining) chunks.push(chunk.subarray(0, remaining)); bytes += chunk.length; if (bytes > maxBytes) { truncated = true; child.kill(); } });
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length); });
      child.once('error', error => { clearTimeout(timer); reject(new AppError(isMissing(error) ? 'RIPGREP_NOT_FOUND' : 'SEARCH_FAILED', isMissing(error) ? 'ripgrep was not found. Configure rgPath with an installed rg executable.' : 'Could not start ripgrep.')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (timedOut) { reject(new AppError('SEARCH_TIMEOUT', 'Search exceeded 15 seconds. Narrow the search path or simplify the regular expression.')); return; }
        if (!truncated && code !== 0 && code !== 1) { reject(new AppError('SEARCH_FAILED', 'ripgrep rejected the search.', { diagnostic: stderr })); return; }
        const lines: any[] = [];
        for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) { if (!line) continue; try { lines.push(JSON.parse(line)); } catch { if (!truncated) { reject(new AppError('SEARCH_FAILED', 'ripgrep returned malformed output.')); return; } } }
        resolve({ lines, truncated });
      });
    });
  }

  private idempotent<T>(workspaceId: string, tool: FileOperationTool, key: string, payload: unknown, action: (operation: FileOperationAttempt) => Promise<T>, operationPath?: string) {
    if (!key || key.length > 200) throw new AppError('INVALID_ARGUMENT', 'idempotency_key must contain 1 to 200 characters.');
    return fileOperations(this.ctx).run({ workspace_id: workspaceId, tool, idempotency_key: key, payload, path: operationPath ?? (payload as { path?: string }).path ?? '' }, action);
  }

  private assertVersion(before: Buffer | null, expected: string | null) {
    validateHash(expected);
    const actual = before === null ? null : hash(before);
    if (actual !== expected?.toLowerCase() && !(actual === null && expected === null)) throw new AppError('VERSION_CONFLICT', 'The current file version differs from expected_sha256. Read the file again before editing.', { expected_sha256: expected, actual_sha256: actual });
  }

  private savedVersion(row: ChangeRow, forRestore = true): Buffer | null {
    const maxBytes = forRestore && row.write_kind === 'bytes' ? this.binaryLimit() : this.changeLimit(row);
    if (row.before_blob !== null && row.before_blob.length > maxBytes) throw new AppError('FILE_TOO_LARGE', 'The saved version exceeds its current write limit.');
    const bytes = row.before_blob === null ? null : Buffer.from(row.before_blob);
    if ((bytes === null ? null : hash(bytes)) !== row.before_sha256) throw new AppError('CHANGE_CORRUPT', 'The saved file version does not match its recorded hash. Review local change history.');
    return bytes;
  }

  /** Internal: persist a before-image without touching the project. Batch preparation calls this for every path first. */
  prepareBatchChange(workspaceId: string, relative: string, before: Buffer | null, after: Buffer | null, modes: ChangeModes = {}, writeKind: 'text' | 'bytes' = 'text') {
    const binding = initializeIdentity(this.ctx).workspaceIdentity(workspaceId);
    const beforeHash = before === null ? null : hash(before);
    const afterHash = after === null ? null : hash(after);
    if (beforeHash === afterHash) return null;
    const id = randomUUID();
    this.ctx.store.db.prepare('INSERT INTO file_changes(id,workspace_id,workspace_binding,path,before_blob,before_sha256,after_sha256,before_mode,after_mode,status,created_at,restores_id,write_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, workspaceId, binding, relative, before, beforeHash, afterHash, modes.beforeMode ?? null, modes.afterMode ?? null, 'pending', new Date().toISOString(), null, writeKind);
    return id;
  }

  /** Internal: caller holds every affected path lock and has already checked its policy. */
  commitForBatch(workspaceId: string, relative: string, absolute: string, before: Buffer | null, after: Buffer | null, preparedId?: string | null, restoresId: string | null = null, modes: ChangeModes = {}, writeKind: 'text' | 'bytes' = 'text') {
    return this.commit(workspaceId, relative, absolute, before, after, restoresId, preparedId, modes, writeKind === 'bytes', writeKind === 'bytes' ? this.binaryLimit() : this.ctx.config.limits.writeMaxBytes, writeKind);
  }

  private async commit(workspaceId: string, relative: string, absolute: string, before: Buffer | null, after: Buffer | null, restoresId: string | null = null, preparedId?: string | null, modes: ChangeModes = {}, verifyBytes = false, maxBytes = this.ctx.config.limits.writeMaxBytes, writeKind: 'text' | 'bytes' = 'text', operation?: FileOperationAttempt, beforeCommit?: () => Promise<void>) {
    const binding = initializeIdentity(this.ctx).workspaceIdentity(workspaceId);
    const beforeHash = before === null ? null : hash(before);
    const afterHash = after === null ? null : hash(after);
    if (after !== null) operation?.content(afterHash!, after.length);
    await beforeCommit?.();
    if (beforeHash === afterHash) return { workspace_id: workspaceId, path: relative, changed: false, change_id: null, sha256: afterHash };
    const beforeMode = modes.beforeMode !== undefined ? modes.beforeMode : await this.modeForBatch(absolute);
    const afterMode = after === null ? null : modes.afterMode ?? beforeMode ?? (process.platform === 'win32' ? 0o666 : 0o600);
    for (const mode of [beforeMode, afterMode]) if (mode !== null && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777)) throw new AppError('CHANGE_CORRUPT', 'Saved permission bits are invalid.');
    const id = preparedId ?? this.prepareBatchChange(workspaceId, relative, before, after, { beforeMode, afterMode }, writeKind)!;
    const saved = this.ctx.store.db.prepare('SELECT * FROM file_changes WHERE id=?').get(id) as ChangeRow | undefined;
    if (!saved || saved.workspace_id !== workspaceId || saved.workspace_binding !== binding || saved.path !== relative || saved.status !== 'pending' || saved.before_sha256 !== beforeHash || saved.after_sha256 !== afterHash || saved.before_mode !== beforeMode || saved.after_mode !== afterMode || (saved.write_kind ?? 'text') !== writeKind) throw new AppError('CHANGE_CORRUPT', 'Prepared change metadata no longer matches this file operation.');
    this.savedVersion(saved, false);
    operation?.linkChange(id);
    if (restoresId) this.ctx.store.db.prepare('UPDATE file_changes SET restores_id=? WHERE id=?').run(restoresId, id);
    let temporary: string | null = null;
    let replaced = false;
    try {
      if (after !== null) {
        if (after.length > maxBytes) throw new AppError('FILE_TOO_LARGE', `The output exceeds the ${maxBytes} byte write limit.`);
        temporary = path.join(path.dirname(absolute), `.webcodex-write-${id}.tmp`);
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(after); await handle.chmod(afterMode!); await handle.sync(); } finally { await handle.close(); }
      }
      await beforeCommit?.();
      await this.ctx.paths.resolve(workspaceId, relative, { write: true, allowMissing: before === null });
      initializeIdentity(this.ctx).workspaceIdentity(workspaceId);
      this.assertVersion(await this.snapshot(absolute, maxBytes, true), beforeHash);
      if (await this.modeForBatch(absolute) !== beforeMode) throw new AppError('VERSION_CONFLICT', 'The file permissions changed before this operation.');
      if (after === null) { await fs.unlink(absolute); replaced = true; }
      else if (before === null) { await fs.link(temporary!, absolute); replaced = true; await fs.unlink(temporary!); temporary = null; }
      else { await fs.rename(temporary!, absolute); replaced = true; temporary = null; }
      if (verifyBytes) {
        await this.ctx.paths.resolve(workspaceId, relative, { write: true, allowMissing: after === null });
        initializeIdentity(this.ctx).workspaceIdentity(workspaceId);
        const savedBytes = await this.snapshot(absolute, maxBytes, true);
        if ((savedBytes === null ? null : hash(savedBytes)) !== afterHash || savedBytes?.length !== after?.length) {
          throw new AppError('FILE_WRITE_VERIFICATION_FAILED', 'The destination bytes changed before save verification completed. Inspect the current file and change history before any further write.', { change_id: id });
        }
      }
      this.ctx.store.db.prepare("UPDATE file_changes SET status='applied' WHERE id=?").run(id);
      if (restoresId) this.ctx.store.db.prepare("UPDATE file_changes SET status='restored' WHERE id=?").run(restoresId);
      this.ctx.store.audit('file_change', workspaceId, { change_id: id, path: relative, before_sha256: beforeHash, after_sha256: afterHash, restores_id: restoresId });
      return { workspace_id: workspaceId, path: relative, changed: true, change_id: id, sha256: afterHash };
    } catch (error) {
      this.ctx.store.db.prepare('UPDATE file_changes SET status=?,error=? WHERE id=?').run(replaced ? 'unknown' : 'failed', error instanceof AppError ? error.code : (error as NodeJS.ErrnoException).code ?? 'INTERNAL_ERROR', id);
      if (!replaced) operation?.noMutation();
      throw error;
    } finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
  }

  async write(input: WriteInput) {
    validateHash(input.expected_sha256);
    if (Buffer.byteLength(input.content) > this.ctx.config.limits.writeMaxBytes) throw new AppError('FILE_TOO_LARGE', 'The supplied text exceeds the write limit.');
    const absolute = await this.ctx.paths.resolve(input.workspace_id, input.path, { write: true, allowMissing: true });
    return this.idempotent(input.workspace_id, 'fs_write', input.idempotency_key, input, operation => this.locked(absolute, async () => {
      await this.ctx.paths.resolve(input.workspace_id, input.path, { write: true, allowMissing: true });
      initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
      const before = await this.snapshot(absolute, this.ctx.config.limits.writeMaxBytes, true);
      this.assertVersion(before, input.expected_sha256);
      const format: TextFormat = before === null ? { encoding: 'utf8', bom: false, newline: 'none' } : decode(before).format;
      const after = encode(input.content, format);
      if (after.length > this.ctx.config.limits.writeMaxBytes) throw new AppError('FILE_TOO_LARGE', 'Encoded output exceeds the write limit.');
      return this.commit(input.workspace_id, this.relative(input.workspace_id, absolute), absolute, before, after, null, undefined, {}, false, this.ctx.config.limits.writeMaxBytes, 'text', operation);
    }));
  }

  /** Save exact bytes without text conversion; receipts describe verification at commit time. */
  async writeBytes(input: WriteBytesInput, parentOperation?: FileOperationAttempt, guards: WriteBytesGuards = {}) {
    validateHash(input.expected_sha256);
    if (!Buffer.isBuffer(input.bytes)) throw new AppError('INVALID_ARGUMENT', 'bytes must be a Buffer containing the complete file.');
    const maxBytes = this.snapshotLimit();
    if (input.bytes.length > this.binaryLimit()) throw new AppError('FILE_TOO_LARGE', 'The supplied file exceeds the binary write limit.');
    // Own the payload before awaiting path checks: callers may reuse their input buffer.
    const bytes = Buffer.from(input.bytes);
    const request = { workspace_id: input.workspace_id, path: input.path, expected_sha256: input.expected_sha256, idempotency_key: input.idempotency_key, size_bytes: bytes.length, content_sha256: hash(bytes) };
    const absolute = await this.ctx.paths.resolve(request.workspace_id, request.path, { write: true, allowMissing: true });
    const write = (operation: FileOperationAttempt) => this.withPathsLocked([absolute, ...(guards.additionalLockedPaths ?? [])], async () => {
      await this.ctx.paths.resolve(request.workspace_id, request.path, { write: true, allowMissing: true });
      initializeIdentity(this.ctx).workspaceIdentity(request.workspace_id);
      const before = await this.snapshot(absolute, maxBytes, true);
      this.assertVersion(before, request.expected_sha256);
      const result = await this.commit(request.workspace_id, this.relative(request.workspace_id, absolute), absolute, before, bytes, null, undefined, {}, true, maxBytes, 'bytes', operation, guards.beforeCommit);
      return { ...result, size_bytes: bytes.length, verified: true as const };
    });
    return parentOperation ? write(parentOperation) : this.idempotent(request.workspace_id, 'fs_write_bytes', request.idempotency_key, request, write);
  }

  async applyPatch(input: FileInput & { patch: string; expected_sha256: string; idempotency_key: string; dry_run?: boolean }) {
    validateHash(input.expected_sha256);
    if (!input.expected_sha256) throw new AppError('INVALID_ARGUMENT', 'A patch requires an existing file SHA-256.');
    assertPatchInputSize(input.patch, this.ctx.config.limits.writeMaxBytes);
    const absolute = await this.ctx.paths.resolve(input.workspace_id, input.path, { write: true });
    return this.idempotent(input.workspace_id, 'fs_apply_patch', input.idempotency_key, input, operation => this.locked(absolute, async () => {
      await this.ctx.paths.resolve(input.workspace_id, input.path, { write: true });
      initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
      const before = (await this.snapshot(absolute, this.ctx.config.limits.writeMaxBytes))!;
      this.assertVersion(before, input.expected_sha256);
      const relative = this.relative(input.workspace_id, absolute);
      const after = preparePatchedBytes(relative, before, input.patch);
      if (after.length > this.ctx.config.limits.writeMaxBytes) throw new AppError('FILE_TOO_LARGE', 'Patched file exceeds the write limit.');
      if (input.dry_run) return { workspace_id: input.workspace_id, path: relative, dry_run: true, changed: !before.equals(after), sha256: hash(after), previous_sha256: hash(before), change_id: null };
      return this.commit(input.workspace_id, relative, absolute, before, after, null, undefined, {}, false, this.ctx.config.limits.writeMaxBytes, 'text', operation);
    }));
  }

  async changesList(input: { workspace_id: string; limit?: number; cursor?: number }) {
    await this.ctx.paths.resolve(input.workspace_id, '.', { directory: true });
    const binding = initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    const limit = integer(input.limit ?? 50, 1, 200, 'limit');
    const cursor = integer(input.cursor ?? 0, 0, Number.MAX_SAFE_INTEGER, 'cursor');
    const rows = this.ctx.store.db.prepare('SELECT id, workspace_id, path, before_sha256, after_sha256, status, created_at, restores_id FROM file_changes WHERE workspace_id=? AND workspace_binding=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(input.workspace_id, binding, limit + 1, cursor);
    return { workspace_id: input.workspace_id, changes: rows.slice(0, limit), next_cursor: rows.length > limit ? cursor + limit : null };
  }

  async changeDiff(input: { workspace_id: string; change_id: string; context_lines?: number; max_bytes?: number }) {
    await this.ctx.paths.resolve(input.workspace_id, '.', { directory: true });
    const binding = initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    const context = integer(input.context_lines ?? 3, 0, 20, 'context_lines');
    const max = integer(input.max_bytes ?? this.ctx.config.limits.readMaxBytes, 1, this.ctx.config.limits.readMaxBytes, 'max_bytes');
    const row = this.ctx.store.db.prepare('SELECT * FROM file_changes WHERE id=? AND workspace_id=?').get(input.change_id, input.workspace_id) as ChangeRow | undefined;
    if (!row) throw new AppError('CHANGE_NOT_FOUND', 'No change with this ID exists in this workspace.');
    assertRecordBinding(row, binding, 'CHANGE_NOT_FOUND');
    const absolute = await this.ctx.paths.resolve(input.workspace_id, row.path, { allowMissing: true });
    return this.locked(absolute, async () => {
      const currentRow = this.ctx.store.db.prepare('SELECT status FROM file_changes WHERE id=?').get(row.id);
      if (currentRow?.status !== 'applied') throw new AppError('CHANGE_NOT_RESTORABLE', 'Only a confirmed, applied change can be previewed for restoration. Pending, restored, or unknown records require local review.');
      await this.ctx.paths.resolve(input.workspace_id, row.path, { allowMissing: true });
      initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
      const current = await this.snapshot(absolute, this.changeLimit(row), true);
      // History stores the before-image only. Never reconstruct an old after-image from
      // a newer file version, since that would describe a restore that is not permitted.
      this.assertVersion(current, row.after_sha256);
      const target = this.savedVersion(row);
      const relative = this.relative(input.workspace_id, absolute);
      const operation = current === null ? 'create' as const : target === null ? 'delete' as const : 'modify' as const;
      let currentText: ReturnType<typeof decode> | null = null;
      let targetText: ReturnType<typeof decode> | null = null;
      // Exact-byte imports may be large ASCII PDFs or encoded files; preview metadata
      // without interpreting the document format or running a large text diff.
      let binary = row.write_kind === 'bytes';
      if (!binary) try {
        currentText = current === null ? null : decode(current);
        targetText = target === null ? null : decode(target);
      } catch (error) {
        if (!(error instanceof AppError) || !['BINARY_FILE', 'UNSUPPORTED_ENCODING'].includes(error.code)) throw error;
        binary = true;
      }
      if (binary) {
        this.ctx.store.audit('changes_preview', input.workspace_id, { change_id: row.id, path: relative, direction: 'restore', operation, diff_kind: 'binary', truncated: false });
        return { workspace_id: input.workspace_id, change_id: row.id, path: relative, direction: 'restore' as const, operation, current_sha256: row.after_sha256, restore_sha256: row.before_sha256, current_size_bytes: current?.length ?? null, restore_size_bytes: target?.length ?? null, current_format: null, restore_format: null, diff_kind: 'binary' as const, diff: '', truncated: false, diff_bytes: 0, returned_bytes: 0, max_bytes: max, context_lines: context, note: 'This restoration changes exact file bytes. Byte imports and binary or unsupported-encoding files are previewed using sizes and SHA-256 values instead of a text diff.' };
      }
      const patch = createTwoFilesPatch(current === null ? '/dev/null' : `a/${relative}`, target === null ? '/dev/null' : `b/${relative}`, currentText?.text ?? '', targetText?.text ?? '', undefined, undefined, { context, timeout: 1000, maxEditLength: 20_000 });
      if (patch === undefined) throw new AppError('DIFF_TOO_COMPLEX', 'The restoration diff exceeded its computation limit. Inspect the file and change metadata locally.');
      const output = capText(patch, max);
      this.ctx.store.audit('changes_preview', input.workspace_id, { change_id: row.id, path: relative, direction: 'restore', operation, truncated: output.truncated });
      return { workspace_id: input.workspace_id, change_id: row.id, path: relative, direction: 'restore' as const, operation, current_sha256: row.after_sha256, restore_sha256: row.before_sha256, current_size_bytes: current?.length ?? null, restore_size_bytes: target?.length ?? null, current_format: currentText?.format ?? null, restore_format: targetText?.format ?? null, diff_kind: 'text' as const, diff: output.text, truncated: output.truncated, diff_bytes: Buffer.byteLength(patch, 'utf8'), returned_bytes: Buffer.byteLength(output.text, 'utf8'), max_bytes: max, context_lines: context };
    });
  }

  async mkdir(input: FileInput & { idempotency_key: string }) {
    const absolute = await this.ctx.paths.resolve(input.workspace_id, input.path, { write: true, allowMissing: true });
    return this.idempotent(input.workspace_id, 'fs_mkdir', input.idempotency_key, input, operation => this.locked(absolute, async () => {
      await this.ctx.paths.resolve(input.workspace_id, input.path, { write: true, allowMissing: true });
      initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
      operation.mutationStarted();
      try { await fs.mkdir(absolute); }
      catch (error) { if (['EEXIST', 'ENOENT', 'ENOTDIR', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) operation.noMutation(); throw error; }
      const relative = this.relative(input.workspace_id, absolute);
      this.ctx.store.audit('fs_mkdir', input.workspace_id, { path: relative });
      return { workspace_id: input.workspace_id, path: relative, created: true };
    }));
  }

  async restore(input: { workspace_id: string; change_id: string; expected_sha256: string | null; idempotency_key: string }) {
    validateHash(input.expected_sha256);
    await this.ctx.paths.resolve(input.workspace_id, '.', { directory: true, write: true });
    const binding = initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    const row = this.ctx.store.db.prepare('SELECT * FROM file_changes WHERE id=? AND workspace_id=?').get(input.change_id, input.workspace_id) as ChangeRow | undefined;
    if (!row) throw new AppError('CHANGE_NOT_FOUND', 'No change with this ID exists in this workspace.');
    assertRecordBinding(row, binding, 'CHANGE_NOT_FOUND');
    const absolute = await this.ctx.paths.resolve(input.workspace_id, row.path, { write: true, allowMissing: true });
    return this.idempotent(input.workspace_id, 'changes_restore', input.idempotency_key, input, async operation => {
      return this.locked(absolute, async () => {
        const currentRow = this.ctx.store.db.prepare('SELECT status FROM file_changes WHERE id=?').get(row.id);
        if (currentRow?.status !== 'applied') throw new AppError('CHANGE_NOT_RESTORABLE', 'Only a confirmed, applied change can be restored. Pending or unknown records require local review.');
        if ((input.expected_sha256?.toLowerCase() ?? null) !== row.after_sha256) throw new AppError('VERSION_CONFLICT', 'Restore requires the exact file version produced by this change.', { required_sha256: row.after_sha256 });
        await this.ctx.paths.resolve(input.workspace_id, row.path, { write: true, allowMissing: true });
        const maxBytes = this.changeLimit(row);
        const before = await this.snapshot(absolute, maxBytes, true);
        this.assertVersion(before, input.expected_sha256);
        const after = this.savedVersion(row);
        const result = await this.commit(input.workspace_id, row.path, absolute, before, after, row.id, undefined, { afterMode: row.before_mode ?? undefined }, true, maxBytes, row.write_kind ?? 'text', operation);
        return { ...result, size_bytes: after?.length ?? null, verified: true as const };
      });
    }, row.path);
  }
}
