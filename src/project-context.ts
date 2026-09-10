import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { redactSessionText } from './codex-redaction.js';
import { AppError, errorResult } from './errors.js';
import { initializeIdentity } from './identity.js';
import type { ServiceContext } from './types.js';

interface Limits { maxDepth: number; maxFileBytes: number; maxTotalBytes: number }
interface Cursor { binding: string; target: string; options: string; chain: string; index: number; offset: number }
interface Omission { source: string; reason: string; size_bytes?: number; limit?: number }
interface Guidance { source: string; applies_to: string; precedence: number; sha256: string; content: string; redactions: number }
interface Probe { source: string; stamp: string; exists: boolean; info?: BigIntStats }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fingerprint = (stat: BigIntStats) => [stat.ino, stat.birthtimeNs, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].join(':');
const same = (a: BigIntStats, b: BigIntStats) => fingerprint(a) === fingerprint(b)
  && (a.dev === b.dev || process.platform === 'win32' && (a.dev === 0n || b.dev === 0n));
const normalized = (value: string) => value.split(path.sep).join('/') || '.';
const stale = () => new AppError('CONTEXT_CURSOR_STALE', 'Project guidance or read options changed. Restart workspace_context without a cursor.');
const changed = () => new AppError('CONTEXT_CHANGED', 'Project guidance changed during reading. Restart workspace_context without a cursor.');
const boundary = (bytes: Buffer, end: number) => { while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; return end; };

function decode(bytes: Buffer): string {
  let encoding = 'utf-8', offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
  else if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) offset = 3;
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset)); }
  catch { throw new AppError('UNSUPPORTED_ENCODING', 'Guidance requires UTF-8 or BOM-marked UTF-16.'); }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new AppError('BINARY_FILE', 'Guidance contains binary control characters.');
  return text;
}

/** Workspace-scoped guidance data only. Never expands workspace authorization or executes file contents. */
export class ProjectContextService {
  private readonly key = randomBytes(32);
  constructor(private readonly ctx: ServiceContext) {}

  private encode(cursor: Cursor): string {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return body + '.' + createHmac('sha256', this.key).update(body).digest('base64url');
  }

  private decode(value: string): Cursor {
    try {
      if (value.length > 4096) throw 0;
      const parts = value.split('.'); if (parts.length !== 2) throw 0;
      const expected = createHmac('sha256', this.key).update(parts[0]).digest(), actual = Buffer.from(parts[1], 'base64url');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw 0;
      const cursor = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Cursor;
      if (!Number.isSafeInteger(cursor.index) || cursor.index < 0 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw 0;
      return cursor;
    } catch { throw new AppError('INVALID_CURSOR', 'Invalid project context cursor or service restarted. Restart workspace_context without a cursor.'); }
  }

  private limits(): Limits {
    const configured = this.ctx.config.projectContext;
    const limits = { maxDepth: configured?.maxDepth ?? 32, maxFileBytes: configured?.maxFileBytes ?? 65536, maxTotalBytes: configured?.maxTotalBytes ?? 262144 };
    if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 128
      || !Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1024 || limits.maxFileBytes > 1048576
      || !Number.isSafeInteger(limits.maxTotalBytes) || limits.maxTotalBytes < limits.maxFileBytes || limits.maxTotalBytes > 4194304) {
      throw new AppError('INVALID_CONFIG', 'Invalid projectContext limits.');
    }
    return limits;
  }

  private async probe(workspaceId: string, source: string): Promise<Probe> {
    // Resolve the parent first, then inspect only the known candidate name without following it.
    const parent = await this.ctx.paths.resolve(workspaceId, normalized(path.dirname(source)), { directory: true });
    try {
      const info = await lstat(path.join(parent, path.basename(source)), { bigint: true });
      return { source, exists: true, stamp: fingerprint(info), info };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { source, exists: false, stamp: 'missing' };
      return { source, exists: true, stamp: 'error:' + errorResult(error).error.code };
    }
  }

  private async readFile(workspaceId: string, probe: Probe): Promise<Buffer> {
    const absolute = await this.ctx.paths.resolve(workspaceId, probe.source);
    if (!probe.info?.isFile() || probe.info.isSymbolicLink() || probe.info.nlink !== 1n) throw new AppError('PATH_DENIED', 'Guidance requires an ordinary file without links.');
    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat({ bigint: true });
      if (!same(probe.info, before) || before.nlink !== 1n) throw changed();
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw changed();
        offset += result.bytesRead;
      }
      if (!same(before, await file.stat({ bigint: true }))) throw changed();
      await this.ctx.paths.resolve(workspaceId, probe.source);
      if (!same(before, await lstat(absolute, { bigint: true }))) throw changed();
      return bytes;
    } finally { await file.close(); }
  }

  async read(input: { workspace_id: string; path?: string; cursor?: string; max_bytes?: number }) {
    const limits = this.limits(), max = input.max_bytes ?? this.ctx.config.limits.readMaxBytes;
    if (!Number.isSafeInteger(max) || max < 256 || max > this.ctx.config.limits.readMaxBytes) throw new AppError('INVALID_ARGUMENT', 'max_bytes must be between 256 and limits.readMaxBytes.');
    const binding = initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id);
    const root = this.ctx.paths.get(input.workspace_id).root;
    const absolute = await this.ctx.paths.resolve(input.workspace_id, input.path ?? '.', { allowMissing: true });
    const target = normalized(path.relative(root, absolute));
    let kind: 'directory' | 'file' | 'missing_file';
    try { kind = (await lstat(absolute)).isDirectory() ? 'directory' : 'file'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; kind = 'missing_file'; }
    const targetKey = digest(process.platform === 'win32' ? target.toLowerCase() : target);
    const options = digest(JSON.stringify({ limits, kind }));
    const cursor = input.cursor ? this.decode(input.cursor) : undefined;
    if (cursor && (cursor.binding !== binding || cursor.target !== targetKey)) throw new AppError('INVALID_CURSOR', 'The context cursor belongs to another workspace or target.');
    if (cursor && cursor.options !== options) throw stale();
    const directory = kind === 'directory' ? target : normalized(path.dirname(target));
    const segments = directory === '.' ? [] : directory.split('/');
    const all: Guidance[] = [], omissions: Omission[] = [], observed: Probe[] = [];
    const manifest: unknown[] = [{ target, kind, limits }];
    let used = 0;
    for (let depth = 0; depth <= Math.min(segments.length, limits.maxDepth); depth++) {
      const appliesTo = segments.slice(0, depth).join('/') || '.';
      const override = await this.probe(input.workspace_id, normalized(path.join(appliesTo, 'AGENTS.override.md')));
      observed.push(override);
      const selected = override.exists ? override : await this.probe(input.workspace_id, normalized(path.join(appliesTo, 'AGENTS.md')));
      if (selected !== override) observed.push(selected);
      const record: Record<string, unknown> = { directory: appliesTo, override: override.stamp, source: selected.source, stamp: selected.stamp };
      manifest.push(record);
      if (!selected.exists) continue;
      try {
        if (!selected.info?.isFile() || selected.info.isSymbolicLink() || selected.info.nlink !== 1n) throw new AppError(selected.info ? 'PATH_DENIED' : selected.stamp.slice(6), 'Guidance cannot be safely read.');
        const size = Number(selected.info.size);
        if (size > limits.maxFileBytes) { omissions.push({ source: selected.source, reason: 'FILE_TOO_LARGE', size_bytes: size, limit: limits.maxFileBytes }); continue; }
        if (used + size > limits.maxTotalBytes) { omissions.push({ source: selected.source, reason: 'TOTAL_BYTES_EXCEEDED', size_bytes: size, limit: limits.maxTotalBytes }); continue; }
        const bytes = await this.readFile(input.workspace_id, selected); used += bytes.length;
        const sha256 = digest(bytes); record.sha256 = sha256;
        const redacted = redactSessionText(decode(bytes));
        all.push({ source: selected.source, applies_to: appliesTo, precedence: depth, sha256, redactions: redacted.redactions, content: redacted.text });
      } catch (error) {
        if (error instanceof AppError && error.code === 'CONTEXT_CHANGED') throw cursor ? stale() : error;
        omissions.push({ source: selected.source, reason: errorResult(error).error.code });
      }
    }
    if (segments.length > limits.maxDepth) omissions.push({ source: segments.slice(0, limits.maxDepth + 1).join('/'), reason: 'MAX_DEPTH_EXCEEDED', limit: limits.maxDepth });
    // Recheck absence/override selection as well as every source before exposing any content.
    for (const previous of observed) {
      const latest = await this.probe(input.workspace_id, previous.source);
      if (previous.stamp !== latest.stamp || previous.exists !== latest.exists) throw cursor ? stale() : changed();
    }
    await this.ctx.paths.resolve(input.workspace_id, target, { allowMissing: kind === 'missing_file', directory: kind === 'directory' });
    let finalKind: typeof kind;
    try { finalKind = (await lstat(absolute)).isDirectory() ? 'directory' : 'file'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; finalKind = 'missing_file'; }
    if (finalKind !== kind) throw cursor ? stale() : changed();
    if (initializeIdentity(this.ctx).workspaceIdentity(input.workspace_id) !== binding) throw cursor ? stale() : changed();
    const chain = digest(JSON.stringify({ manifest, omissions }));
    if (cursor && cursor.chain !== chain) throw stale();
    let index = cursor?.index ?? 0, offset = cursor?.offset ?? 0, returned = 0;
    const guidance: (Guidance & { chunk: { offset_bytes: number; end_bytes: number; total_bytes: number; has_more: boolean } })[] = [];
    if (cursor && (index >= all.length || offset > Buffer.byteLength(all[index].content))) throw new AppError('INVALID_CURSOR', 'The cursor does not reference guidance content.');
    while (index < all.length) {
      const item = all[index], bytes = Buffer.from(item.content);
      const end = boundary(bytes, Math.min(bytes.length, offset + max - returned));
      if (end === offset && bytes.length > offset) break;
      guidance.push({ source: item.source, applies_to: item.applies_to, precedence: item.precedence, sha256: item.sha256, redactions: item.redactions, content: bytes.subarray(offset, end).toString('utf8'), chunk: { offset_bytes: offset, end_bytes: end, total_bytes: bytes.length, has_more: end < bytes.length } });
      returned += end - offset;
      if (end < bytes.length) { offset = end; break; }
      index++; offset = 0;
    }
    const complete = index === all.length;
    this.ctx.store.audit('workspace_context', input.workspace_id, { target, chain_sha256: chain, source_count: all.length, omission_count: omissions.length, returned_bytes: returned });
    return { workspace_id: input.workspace_id, target, target_kind: kind, guidance, omissions, chain_sha256: chain, source_count: all.length, returned_bytes: returned, scanned_bytes: used, scan_complete: omissions.length === 0, complete, next_cursor: complete ? null : this.encode({ binding, target: targetKey, options, chain, index, offset }), scope: 'authorized_workspace_only', precedence: 'root_to_target; deeper guidance applies to its subtree', content_type: 'untrusted_project_guidance', chunk_unit: 'redacted_utf8_bytes' };
  }
}
