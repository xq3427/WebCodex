import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { App } from './app.js';
import { AppError } from './errors.js';

type Original = Awaited<ReturnType<App['fileTransfers']['read']>>;
interface Ticket {
  deviceId: string; workspaceId: string; binding: string; relativePath: string;
  sha256: string; bytes: Buffer; expiresAt: number;
}
const MAX_TICKETS = 32;
const MAX_INLINE_BYTES = 7 * 1024 * 1024;
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** App-owned, bounded immutable snapshots. Callers guard operations with app.runTool. */
export class FileWidgetDeliveryService {
  private readonly tickets = new Map<string, Ticket>();
  private usedBytes = 0;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly app: App, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private limits() {
    const configured = this.app.config.limits as App['config']['limits'] & {
      fileWidgetTicketTtlMs?: number; fileWidgetCacheMaxBytes?: number; fileWidgetChunkMaxBytes?: number;
    };
    const ttl = configured.fileWidgetTicketTtlMs ?? 300000;
    const cache = configured.fileWidgetCacheMaxBytes ?? 33554432;
    const chunk = configured.fileWidgetChunkMaxBytes ?? 65536;
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 1800000 ||
      !Number.isSafeInteger(cache) || cache < 1 || cache > 268435456 ||
      !Number.isSafeInteger(chunk) || chunk < 4096 || chunk > 262144) {
      throw new AppError('CONFIG_ERROR', 'Invalid file widget ticket TTL, cache byte budget or chunk byte limit. Check the local limits configuration.');
    }
    return { ttl, cache, chunk };
  }
  private timestamp() {
    if (this.closed) throw new AppError('SERVICE_CLOSING', 'File widget delivery is closed. Open a file after the service restarts.');
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 - 1800000) throw new AppError('INTERNAL_ERROR', 'The file widget clock is unavailable.');
    return now;
  }
  private remove(id: string) {
    const ticket = this.tickets.get(id);
    if (ticket) { this.usedBytes -= ticket.bytes.length; this.tickets.delete(id); }
  }
  private prune(now: number) {
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= now) this.remove(id);
  }
  private device(expectedDevice: string) {
    // source() also checks that configuration identity did not change in place.
    if (expectedDevice !== this.app.identity.source().device_id) throw new AppError('DEVICE_MISMATCH', 'This file ticket targets a different device. Select the intended connection.');
  }
  private find(id: string, now: number): Ticket {
    if (typeof id !== 'string' || !ticketPattern.test(id)) throw new AppError('FILE_WIDGET_TICKET_INVALID', 'The file ticket format is invalid. Open the original file again.');
    const previous = this.tickets.get(id);
    this.prune(now);
    if (previous && previous.expiresAt <= now) throw new AppError('FILE_WIDGET_TICKET_EXPIRED', 'The file ticket expired. Open the original file again.');
    const ticket = this.tickets.get(id);
    if (!ticket) throw new AppError('FILE_WIDGET_TICKET_NOT_FOUND', 'The file ticket is unavailable, released or belongs to another service instance. Open the original file again.');
    return ticket;
  }
  private async authorized(ticket: Ticket) {
    this.device(ticket.deviceId);
    if (this.app.identity.workspaceIdentity(ticket.workspaceId) !== ticket.binding) throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'The file ticket belongs to a different workspace identity.');
    // Deleting the final file does not invalidate captured bytes. A changed parent,
    // link, protected path, disabled/offline root or changed binding still rejects.
    await this.app.ctx.paths.resolve(ticket.workspaceId, ticket.relativePath, { allowMissing: true });
    if (this.app.identity.workspaceIdentity(ticket.workspaceId) !== ticket.binding) throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'The file ticket workspace changed during authorization.');
  }

  async prepare(original: Original) {
    const limits = this.limits(), started = this.timestamp();
    this.prune(started);
    const info = original.data;
    const inline = this.app.config.limits.fileTransferMaxBytes ?? 4194304;
    const upload = this.app.config.limits.fileWidgetUploadMaxBytes ?? 104857600;
    if (!Number.isSafeInteger(inline) || inline < 1 || inline > MAX_INLINE_BYTES || !Number.isSafeInteger(upload) || upload < 1 || upload > 536870912) throw new AppError('CONFIG_ERROR', 'Invalid original-file or file widget upload limit.');
    if (!info || info.complete !== true || !Number.isSafeInteger(info.size_bytes) || info.size_bytes < 0 || !/^[a-f0-9]{64}$/.test(info.sha256)) throw new AppError('INVALID_FILE_SNAPSHOT', 'The original-file snapshot metadata is invalid.');
    if (info.size_bytes > Math.min(inline, upload)) throw new AppError('FILE_TOO_LARGE', 'The original-file snapshot exceeds the current file/widget limit.', { size_bytes: info.size_bytes, limit: Math.min(inline, upload) });
    const source = this.app.identity.source(), binding = this.app.identity.workspaceIdentity(info.workspace_id);
    let uri: URL;
    try { uri = new URL(info.snapshot_uri); }
    catch { throw new AppError('INVALID_FILE_SNAPSHOT', 'The original-file snapshot identifier is invalid.'); }
    const parts = uri.pathname.split('/');
    if (uri.protocol !== 'webcodex-file:' || uri.search || uri.hash || parts.length !== 4 || parts[1] !== binding || parts[2] !== info.sha256 || parts[3] !== encodeURIComponent(info.name) || path.posix.basename(info.path) !== info.name) {
      throw new AppError('INVALID_FILE_SNAPSHOT', 'The original-file snapshot does not match this workspace binding, hash or name.');
    }
    const selected = original.content?.[0];
    const encoded = selected?.type === 'image' ? selected.data : selected?.type === 'resource' && 'blob' in selected.resource ? selected.resource.blob : undefined;
    if (original.content.length !== 1 || typeof encoded !== 'string' || encoded.length !== 4 * Math.ceil(info.size_bytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AppError('INVALID_FILE_SNAPSHOT', 'The original-file snapshot encoding is invalid.');
    const ticket: Ticket = { deviceId: source.device_id, workspaceId: info.workspace_id, binding, relativePath: info.path, sha256: info.sha256, bytes: Buffer.alloc(0), expiresAt: 0 };
    await this.authorized(ticket);
    const now = this.timestamp(); this.prune(now);
    // No await between checking budgets and storing the decoded buffer: concurrent
    // preparations cannot both claim the same remaining space.
    if (this.tickets.size >= MAX_TICKETS || this.usedBytes + info.size_bytes > limits.cache) throw new AppError('FILE_WIDGET_CACHE_FULL', 'The bounded file widget cache is full. Release a ticket or wait for expiry; active tickets were preserved.');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== info.size_bytes || bytes.toString('base64') !== encoded || sha(bytes) !== info.sha256) throw new AppError('INVALID_FILE_SNAPSHOT', 'The original-file snapshot bytes do not match their complete SHA-256.');
    ticket.bytes = bytes; ticket.expiresAt = now + limits.ttl;
    let id: string;
    do { id = randomBytes(32).toString('base64url'); } while (this.tickets.has(id));
    this.tickets.set(id, ticket); this.usedBytes += bytes.length;
    return { ticket_id: id, expires_at: new Date(ticket.expiresAt).toISOString(), chunk_max_bytes: limits.chunk };
  }

  async read(input: { ticket_id: string; expected_device_id: string; offset: number }) {
    const limits = this.limits(), now = this.timestamp();
    this.device(input.expected_device_id);
    const ticket = this.find(input.ticket_id, now);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > ticket.bytes.length) throw new AppError('INVALID_ARGUMENT', 'offset must be an integer within the captured file, including its end.');
    await this.authorized(ticket);
    // A release, close or expiration during the async path check cannot return data.
    if (this.find(input.ticket_id, this.timestamp()) !== ticket) throw new AppError('FILE_WIDGET_TICKET_NOT_FOUND', 'The file ticket changed during authorization.');
    const end = Math.min(ticket.bytes.length, input.offset + limits.chunk), chunk = ticket.bytes.subarray(input.offset, end), eof = end === ticket.bytes.length;
    return { data: { ticket_id: input.ticket_id, offset: input.offset, size_bytes: chunk.length, total_bytes: ticket.bytes.length, next_offset: eof ? null : end, eof, sha256: ticket.sha256, chunk_sha256: sha(chunk) }, base64: chunk.toString('base64') };
  }

  async release(input: { ticket_id: string; expected_device_id: string }) {
    const now = this.timestamp();
    this.device(input.expected_device_id);
    const ticket = this.find(input.ticket_id, now);
    await this.authorized(ticket);
    if (this.find(input.ticket_id, this.timestamp()) !== ticket) throw new AppError('FILE_WIDGET_TICKET_NOT_FOUND', 'The file ticket changed during authorization.');
    this.remove(input.ticket_id);
    return { released: true as const };
  }

  /** Diagnostics expose bounded counts only, never ticket IDs, paths, bytes or hashes. */
  stats() {
    if (!this.closed) this.prune(this.timestamp());
    return { closed: this.closed, ticket_count: this.tickets.size, cached_bytes: this.usedBytes };
  }
  close() { this.closed = true; this.tickets.clear(); this.usedBytes = 0; }
}
