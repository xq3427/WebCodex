import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { App } from './app.js';
import { AppError } from './errors.js';
import { DOCUMENT_FAILURE_CODES, DOCUMENT_DIAGNOSTIC_PHASES, DOCUMENT_DIAGNOSTIC_CODES, DOCUMENT_DIAGNOSTIC_DETAILS,
  DOCUMENT_COMPONENT_VERSION_PATTERN, DOCUMENT_COMPONENT_VERSION_MAX_LENGTH, type DocumentFailureDiagnostics } from './document-failure.js';

export { DOCUMENT_FAILURE_CODES } from './document-failure.js';

export const DOCUMENT_LIMITS = Object.freeze({ max_pages_per_request: 5, max_page_text_bytes: 16384, max_total_text_bytes: 65536 });
export const DOCUMENT_CHUNK_MAX_BYTES = 262144;
type FailureCode = typeof DOCUMENT_FAILURE_CODES[number];
type FileDelivery = Awaited<ReturnType<App['fileWidgetDeliveries']['prepare']>>;
type PrivateInput = { document_id: string; ticket: string; expected_device_id: string };
export interface DocumentPage { page_number: number; text: string; truncated: boolean; text_layer: 'present' | 'empty' }
export interface DocumentServiceOptions { now?: () => number; ttlMs?: number; maxDocuments?: number; maxJobsPerDocument?: number; maxTextCacheBytes?: number; maxPendingReads?: number }
export type DocumentSubmitInput = PrivateInput & { request_id: string; sha256: string } & (
  { total_pages: number; pages: DocumentPage[]; error_code?: never; failure_diagnostics?: never } |
  { error_code: FailureCode; total_pages?: never; pages?: never; failure_diagnostics?: DocumentFailureDiagnostics }
);
interface Snapshot { workspace_id: string; path: string; name: string; size_bytes: number; sha256: string; mime_type: 'application/pdf' }
interface Job {
  requestId: string; start: number; count: number; pendingReads: number;
  outcome?: { kind: 'ready'; total: number; pages: DocumentPage[] } | { kind: 'failed'; code: string; diagnostics?: DocumentFailureDiagnostics };
  submissionHash?: string;
}
interface Document {
  id: string; ticketBytes: Buffer; deviceId: string; binding: string; snapshot: Snapshot;
  file: FileDelivery; expiresAt: number; timer?: ReturnType<typeof setTimeout>;
  jobs: Map<string, Job>; totalPages?: number; cachedTextBytes: number;
  pollCount: number; chunkCount: number; servedPrefixBytes: number;
  failure?: { code: FailureCode; observedStage: DocumentStage; diagnostics?: DocumentFailureDiagnostics };
}
type DocumentStage = 'awaiting_component' | 'awaiting_transfer' | 'transferring' | 'awaiting_page_result' | 'pages_available' | 'failed';
const fail = (code: string, message: string) => new AppError(code, message);
function bounded(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw fail('DOCUMENT_INVALID_ARGUMENT', 'Document limits must be bounded positive integers.');
  return result;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function copyFailureDiagnostics(value: unknown): DocumentFailureDiagnostics {
  const invalid = () => fail('DOCUMENT_INVALID_RESULT', 'The component failure diagnostics are invalid.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['component_version', 'phase', 'code', 'detail_code'].includes(key))
    || !own(data, 'component_version') || !own(data, 'phase') || !own(data, 'code')
    || typeof data.component_version !== 'string' || data.component_version.length > DOCUMENT_COMPONENT_VERSION_MAX_LENGTH
    || !DOCUMENT_COMPONENT_VERSION_PATTERN.test(data.component_version)
    || !(DOCUMENT_DIAGNOSTIC_PHASES as readonly unknown[]).includes(data.phase)
    || !(DOCUMENT_DIAGNOSTIC_CODES as readonly unknown[]).includes(data.code)
    || (own(data, 'detail_code') && !(DOCUMENT_DIAGNOSTIC_DETAILS as readonly unknown[]).includes(data.detail_code))) throw invalid();
  // Stable order makes duplicate submissions independent of the input object's property order.
  return { component_version: data.component_version, phase: data.phase as DocumentFailureDiagnostics['phase'],
    code: data.code as DocumentFailureDiagnostics['code'],
    ...(own(data, 'detail_code') ? { detail_code: data.detail_code as DocumentFailureDiagnostics['detail_code'] } : {}) };
}

/** Full original bytes are captured by existing services; only the component parses PDF text. */
export class DocumentService {
  private readonly documents = new Map<string, Document>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxDocuments: number;
  private readonly maxJobs: number;
  private readonly maxTextCacheBytes: number;
  private readonly maxPendingReads: number;
  private opening = 0;
  private closed = false;

  constructor(private readonly app: App, options: DocumentServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = bounded(options.ttlMs, 300000, 300000);
    this.maxDocuments = bounded(options.maxDocuments, 16, 16);
    this.maxJobs = bounded(options.maxJobsPerDocument, 16, 16);
    this.maxTextCacheBytes = bounded(options.maxTextCacheBytes, 1048576, 1048576);
    this.maxPendingReads = bounded(options.maxPendingReads, 30, 30);
  }

  async open(input: { workspace_id: string; path: string; expected_device_id: string }) {
    this.assertOpen(); this.device(input.expected_device_id); this.prune();
    const binding = this.app.identity.workspaceIdentity(input.workspace_id);
    if (this.documents.size + this.opening >= this.maxDocuments) throw fail('DOCUMENT_CAPACITY', 'The bounded document cache is full. Wait for an existing document to expire.');
    this.opening++;
    let delivery: FileDelivery | undefined;
    try {
      const original = await this.app.fileTransfers.read({ workspace_id: input.workspace_id, path: input.path });
      this.assertOpen(); this.device(input.expected_device_id);
      if (this.app.identity.workspaceIdentity(input.workspace_id) !== binding) throw fail('WORKSPACE_IDENTITY_MISMATCH', 'The workspace changed while the document was captured.');
      if (original.data.mime_type !== 'application/pdf') throw fail('DOCUMENT_UNSUPPORTED', 'This prototype supports PDF files only.');
      delivery = await this.app.fileWidgetDeliveries.prepare(original);
      this.assertOpen(); this.device(input.expected_device_id);
      if (this.app.identity.workspaceIdentity(input.workspace_id) !== binding) throw fail('WORKSPACE_IDENTITY_MISMATCH', 'The workspace changed while the document was prepared.');
      const id = randomUUID(), ticket = randomBytes(32).toString('base64url');
      const info = original.data;
      const snapshot: Snapshot = { workspace_id: info.workspace_id, path: info.path, name: info.name, size_bytes: info.size_bytes, sha256: info.sha256, mime_type: 'application/pdf' };
      const expiresAt = Math.min(this.timestamp() + this.ttlMs, Date.parse(delivery.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= this.timestamp()) throw fail('DOCUMENT_EXPIRED', 'The original-file delivery expired during preparation.');
      const document: Document = { id, ticketBytes: Buffer.from(ticket), deviceId: input.expected_device_id, binding, snapshot,
        file: delivery, expiresAt, jobs: new Map(), cachedTextBytes: 0, pollCount: 0, chunkCount: 0, servedPrefixBytes: 0 };
      this.addJob(document, 1, 3);
      this.documents.set(id, document);
      document.timer = setTimeout(() => this.remove(document), Math.max(1, expiresAt - this.timestamp()));
      document.timer.unref();
      delivery = undefined;
      const expires_at = new Date(expiresAt).toISOString();
      return {
        data: { prototype: true, document_id: id, ...snapshot, expires_at, initial_start_page: 1, initial_page_count: 3,
          source: 'original_file_snapshot', model_access: 'pending', parsing: 'browser_pdfjs_text_layer', native_attachment: false,
          snapshot_scope: 'captured_original_not_current_file', original_file_max_bytes: this.app.config.limits.fileTransferMaxBytes ?? 4194304 },
        meta: { document_id: id, ticket, expected_device_id: input.expected_device_id, expires_at,
          file: { expires_at: document.file.expires_at, chunk_max_bytes: document.file.chunk_max_bytes }, limits: { ...DOCUMENT_LIMITS } },
      };
    } finally {
      this.opening--;
      if (delivery) this.releaseFile(delivery, input.expected_device_id);
    }
  }

  async read(input: { document_id: string; workspace_id: string; expected_device_id: string; start_page?: number; page_count?: number }) {
    const document = this.find(input.document_id);
    if (input.workspace_id !== document.snapshot.workspace_id) throw fail('DOCUMENT_NOT_FOUND', 'The document does not belong to this workspace.');
    await this.authorized(document, input.expected_device_id);
    this.recheck(document, input.expected_device_id);
    this.assertNoFailure(document);
    const { start, count } = this.range(input.start_page ?? 1, input.page_count ?? 3);
    if (document.totalPages !== undefined && start > document.totalPages) throw fail('DOCUMENT_PAGE_RANGE', 'The requested first page is beyond this PDF snapshot.');
    const key = this.key(start, count), job = this.coveringJob(document, start, count, true) ?? document.jobs.get(key)
      ?? this.coveringJob(document, start, count, false) ?? this.addJob(document, start, count);
    if (job.outcome?.kind === 'failed') throw fail(job.outcome.code, 'The browser component could not read this PDF page request. No page content was returned.');
    const base = { document_id: document.id, request_id: job.requestId, ...document.snapshot, start_page: start, page_count: count,
      snapshot_scope: 'captured_original_not_current_file' as const, native_attachment: false as const };
    if (job.outcome?.kind === 'ready') {
      const end = Math.min(start + count - 1, job.outcome.total);
      return { ...base, status: 'ready' as const, source: 'browser_pdfjs_text_layer' as const, text_verification: 'component_reported' as const,
        total_pages: job.outcome.total, pages: job.outcome.pages.filter(page => page.page_number >= start && page.page_number <= end).map(page => ({ ...page })), next_start_page: end < job.outcome.total ? end + 1 : null };
    }
    if (job.pendingReads >= this.maxPendingReads) throw fail('DOCUMENT_READ_LIMIT', 'The pending-read limit was reached before the component returned pages. Stop automatic retries; pending status is not successful reading.');
    job.pendingReads++;
    return { ...base, status: 'pending' as const, retry_after_ms: 2000, pending_reads_remaining: this.maxPendingReads - job.pendingReads,
      progress: this.progress(document) };
  }

  /** At most four existing authorized reads share one bounded component reply. */
  async chunk(input: PrivateInput & { offset: number }) {
    const document = await this.privateDocument(input);
    this.recheck(document, input.expected_device_id);
    this.assertNoFailure(document);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > document.snapshot.size_bytes) throw fail('DOCUMENT_INVALID_ARGUMENT', 'The byte offset must identify the captured original file or its end.');
    const chunks: Buffer[] = [];
    let size = 0;
    for (let count = 0; count < 4; count++) {
      const result = await this.app.fileWidgetDeliveries.read({ ticket_id: document.file.ticket_id, expected_device_id: input.expected_device_id, offset: input.offset + size });
      this.recheck(document, input.expected_device_id);
      if (result.data.sha256 !== document.snapshot.sha256 || result.data.total_bytes !== document.snapshot.size_bytes || result.data.offset !== input.offset + size) throw fail('FILE_INTEGRITY_ERROR', 'The document delivery no longer matches the captured original.');
      const bytes = Buffer.from(result.base64, 'base64');
      if (bytes.length !== result.data.size_bytes || createHash('sha256').update(bytes).digest('hex') !== result.data.chunk_sha256) throw fail('FILE_INTEGRITY_ERROR', 'The original-file delivery chunk failed verification.');
      // A runtime chunk-policy change may alter the next read's size. Never
      // exceed the transport cap or skip bytes that were not included here.
      if (size + bytes.length > DOCUMENT_CHUNK_MAX_BYTES) break;
      chunks.push(bytes); size += bytes.length;
      if (result.data.eof || size >= DOCUMENT_CHUNK_MAX_BYTES) break;
    }
    const bytes = Buffer.concat(chunks, size), end = input.offset + size, eof = end === document.snapshot.size_bytes;
    if (!eof && size === 0) throw fail('DOCUMENT_TEXT_LIMIT', 'The original-file chunk could not fit the bounded transport reply.');
    document.chunkCount++;
    if (input.offset <= document.servedPrefixBytes) document.servedPrefixBytes = Math.max(document.servedPrefixBytes, end);
    return { data: { document_id: document.id, offset: input.offset, size_bytes: size, total_bytes: document.snapshot.size_bytes,
      next_offset: eof ? null : end, eof, sha256: document.snapshot.sha256, chunk_sha256: createHash('sha256').update(bytes).digest('hex') },
      _meta: { base64: bytes.toString('base64') } };
  }

  async poll(input: PrivateInput) {
    const document = await this.privateDocument(input);
    this.recheck(document, input.expected_device_id);
    document.pollCount++;
    if (document.failure) return { status: 'idle' as const, failure_code: document.failure.code, progress: this.progress(document) };
    for (const job of document.jobs.values()) {
      if (job.outcome) continue;
      if (this.coveringJob(document, job.start, job.count, true)) continue;
      if (document.totalPages !== undefined && job.start > document.totalPages) {
        job.outcome = { kind: 'failed', code: 'DOCUMENT_PAGE_RANGE' }; continue;
      }
      return { status: 'pending' as const, request: { request_id: job.requestId, start_page: job.start, page_count: job.count } };
    }
    return { status: 'idle' as const };
  }

  async submit(input: DocumentSubmitInput) {
    const document = await this.privateDocument(input);
    this.recheck(document, input.expected_device_id);
    if (input.sha256 !== document.snapshot.sha256) throw fail('FILE_INTEGRITY_ERROR', 'The submitted result does not identify the captured original-file SHA-256.');
    const job = [...document.jobs.values()].find(candidate => candidate.requestId === input.request_id);
    if (!job) throw fail('DOCUMENT_STALE_SUBMISSION', 'The component submission does not match a prepared page request.');
    if (Object.keys(input).some(key => !['document_id', 'ticket', 'expected_device_id', 'request_id', 'sha256', 'total_pages', 'pages', 'error_code', 'failure_diagnostics'].includes(key))) {
      throw fail('DOCUMENT_INVALID_RESULT', 'The component submission contains unsupported fields.');
    }
    let outcome: NonNullable<Job['outcome']>, textBytes = 0;
    if (input.error_code !== undefined) {
      if (!(DOCUMENT_FAILURE_CODES as readonly string[]).includes(input.error_code) || input.pages !== undefined || input.total_pages !== undefined) throw fail('DOCUMENT_INVALID_RESULT', 'The document failure result is invalid.');
      const diagnostics = own(input, 'failure_diagnostics') ? copyFailureDiagnostics(input.failure_diagnostics) : undefined;
      outcome = { kind: 'failed', code: input.error_code, ...(diagnostics ? { diagnostics } : {}) };
    } else {
      if (own(input, 'failure_diagnostics')) throw fail('DOCUMENT_INVALID_RESULT', 'Successful page results cannot include failure diagnostics.');
      if (!Number.isSafeInteger(input.total_pages) || input.total_pages < 1 || input.total_pages > 2000 || job.start > input.total_pages) throw fail('DOCUMENT_INVALID_RESULT', 'The PDF total page count or requested page range is invalid.');
      const end = Math.min(job.start + job.count - 1, input.total_pages);
      if (!Array.isArray(input.pages) || input.pages.length !== end - job.start + 1) throw fail('DOCUMENT_INVALID_RESULT', 'The component must return every page in the requested interval, including empty text layers.');
      const pages: DocumentPage[] = [];
      for (let index = 0; index < input.pages.length; index++) {
        const page = input.pages[index];
        if (!page || page.page_number !== job.start + index || typeof page.text !== 'string' || typeof page.truncated !== 'boolean' ||
          !['present', 'empty'].includes(page.text_layer) || Object.keys(page).some(key => !['page_number', 'text', 'truncated', 'text_layer'].includes(key)) ||
          page.text_layer === 'empty' && (page.text.length !== 0 || page.truncated) || page.text_layer === 'present' && page.text.length === 0 && !page.truncated) {
          throw fail('DOCUMENT_INVALID_RESULT', 'The component page text, order or text-layer declaration is invalid.');
        }
        if (page.text.length > DOCUMENT_LIMITS.max_page_text_bytes) throw fail('DOCUMENT_TEXT_LIMIT', 'One page exceeds the text byte budget.');
        const length = Buffer.byteLength(page.text, 'utf8');
        if (length > DOCUMENT_LIMITS.max_page_text_bytes) throw fail('DOCUMENT_TEXT_LIMIT', 'One page exceeds the UTF-8 text byte budget.');
        textBytes += length;
        pages.push({ page_number: page.page_number, text: page.text, truncated: page.truncated, text_layer: page.text_layer });
      }
      if (textBytes > DOCUMENT_LIMITS.max_total_text_bytes) throw fail('DOCUMENT_TEXT_LIMIT', 'The requested pages exceed the combined UTF-8 text budget.');
      if (document.totalPages !== undefined && document.totalPages !== input.total_pages) throw fail('DOCUMENT_RESULT_CONFLICT', 'The component reported conflicting PDF page counts for one snapshot.');
      outcome = { kind: 'ready', total: input.total_pages, pages };
    }
    const submissionHash = hash({ sha256: input.sha256, outcome });
    if (job.outcome) {
      if (job.submissionHash === submissionHash) return { accepted: true as const, duplicate: true };
      throw fail('DOCUMENT_RESULT_CONFLICT', 'This page request already has a different result.');
    }
    this.assertNoFailure(document);
    if (document.cachedTextBytes + textBytes > this.maxTextCacheBytes) throw fail('DOCUMENT_CACHE_LIMIT', 'The bounded document text cache is full.');
    job.outcome = outcome; job.submissionHash = submissionHash;
    document.cachedTextBytes += textBytes;
    if (outcome.kind === 'ready') document.totalPages = outcome.total;
    else document.failure = { code: outcome.code as FailureCode, observedStage: this.stage(document),
      ...(outcome.diagnostics ? { diagnostics: { ...outcome.diagnostics } } : {}) };
    return { accepted: true as const, duplicate: false };
  }

  async authorizeAsset(input: PrivateInput) {
    const document = await this.privateDocument(input);
    this.recheck(document, input.expected_device_id);
    return { document_id: document.id, expires_at: new Date(document.expiresAt).toISOString() };
  }

  close() { if (this.closed) return; this.closed = true; for (const document of this.documents.values()) this.remove(document); }

  private range(start: number, count: number) {
    if (!Number.isSafeInteger(start) || start < 1 || start > 2000 || !Number.isSafeInteger(count) || count < 1 || count > DOCUMENT_LIMITS.max_pages_per_request) throw fail('DOCUMENT_INVALID_ARGUMENT', 'Use a first page from 1 to 2000 and request from 1 to 5 pages.');
    return { start, count };
  }
  private coveringJob(document: Document, start: number, count: number, ready: boolean) {
    const end = Math.min(start + count - 1, document.totalPages ?? 2000);
    for (const job of document.jobs.values()) {
      if (ready ? job.outcome?.kind !== 'ready' : job.outcome !== undefined) continue;
      const availableEnd = Math.min(job.start + job.count - 1, document.totalPages ?? 2000);
      if (job.start <= start && availableEnd >= end) {
        // A narrower request can recover text omitted by a wider request's
        // combined budget. Exact cached ranges retain their truncation markers.
        if (ready && job.outcome?.kind === 'ready' && (job.start !== start || job.count !== count)
          && job.outcome.pages.some(page => page.page_number >= start && page.page_number <= end && page.truncated)) continue;
        return job;
      }
    }
    return undefined;
  }
  private stage(document: Document): DocumentStage {
    if (document.failure) return 'failed';
    if ([...document.jobs.values()].some(job => job.outcome?.kind === 'ready')) return 'pages_available';
    if (document.chunkCount > 0 && document.servedPrefixBytes === document.snapshot.size_bytes) return 'awaiting_page_result';
    if (document.chunkCount > 0) return 'transferring';
    return document.pollCount > 0 ? 'awaiting_transfer' : 'awaiting_component';
  }
  private progress(document: Document) {
    return { stage: this.stage(document), component_poll_count: document.pollCount, chunk_response_count: document.chunkCount,
      served_contiguous_prefix_bytes: document.servedPrefixBytes, total_bytes: document.snapshot.size_bytes,
      complete_original_served: document.chunkCount > 0 && document.servedPrefixBytes === document.snapshot.size_bytes,
      ready_request_count: [...document.jobs.values()].filter(job => job.outcome?.kind === 'ready').length,
      observation_scope: 'server_calls_and_bytes_served_not_browser_receipt_or_parse_verification',
      ...(document.failure ? { failure_code: document.failure.code, failure_observed_stage: document.failure.observedStage } : {}) };
  }
  private assertNoFailure(document: Document) {
    if (document.failure) throw new AppError(document.failure.code, 'The browser component reported a fatal document failure. No new page requests can be served for this snapshot.',
      { scope: 'document', progress: this.progress(document),
        ...(document.failure.diagnostics ? { component_diagnostics: { source: 'component_reported', ...document.failure.diagnostics } } : {}) });
  }
  private key(start: number, count: number) { return `${start}:${count}`; }
  private addJob(document: Document, start: number, count: number) {
    if (document.jobs.size >= this.maxJobs) throw fail('DOCUMENT_JOB_LIMIT', 'This document reached its bounded page-request limit.');
    const job: Job = { requestId: randomUUID(), start, count, pendingReads: 0 };
    document.jobs.set(this.key(start, count), job); return job;
  }
  private assertOpen() { if (this.closed) throw fail('SERVICE_CLOSING', 'The document service is closed.'); }
  private timestamp() {
    this.assertOpen(); const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 - 300000) throw fail('INTERNAL_ERROR', 'The document clock is unavailable.');
    return now;
  }
  private device(expected: string) { if (this.app.identity.source().device_id !== expected) throw fail('DEVICE_MISMATCH', 'This document targets a different device.'); }
  private find(id: string) {
    const now = this.timestamp(), document = this.documents.get(id);
    if (document && document.expiresAt <= now) { this.remove(document); throw fail('DOCUMENT_EXPIRED', 'The document snapshot expired.'); }
    if (!document) throw fail('DOCUMENT_NOT_FOUND', 'The document snapshot is unavailable or belongs to another service instance.');
    return document;
  }
  private async authorized(document: Document, expected: string) {
    this.device(expected);
    if (expected !== document.deviceId || this.app.identity.workspaceIdentity(document.snapshot.workspace_id) !== document.binding) throw fail('WORKSPACE_IDENTITY_MISMATCH', 'This document has a different workspace binding.');
    await this.app.ctx.paths.resolve(document.snapshot.workspace_id, document.snapshot.path, { allowMissing: true });
    // Resolve is asynchronous: close, expiry or root changes must win before content is returned.
    this.recheck(document, expected);
  }
  private recheck(document: Document, expected: string) {
    if (this.find(document.id) !== document) throw fail('DOCUMENT_NOT_FOUND', 'The document changed during authorization.');
    this.device(expected);
    if (expected !== document.deviceId || this.app.identity.workspaceIdentity(document.snapshot.workspace_id) !== document.binding) throw fail('WORKSPACE_IDENTITY_MISMATCH', 'The document workspace changed during authorization.');
  }
  private async privateDocument(input: PrivateInput) {
    const document = this.find(input.document_id);
    const candidate = typeof input.ticket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.ticket) ? Buffer.from(input.ticket) : Buffer.alloc(43);
    if (!timingSafeEqual(candidate, document.ticketBytes)) throw fail('DOCUMENT_ACCESS_DENIED', 'The document component credential is invalid.');
    await this.authorized(document, input.expected_device_id); return document;
  }
  private releaseFile(file: FileDelivery, deviceId: string) {
    void this.app.fileWidgetDeliveries.release({ ticket_id: file.ticket_id, expected_device_id: deviceId }).catch(() => undefined);
  }
  private remove(document: Document) {
    if (this.documents.get(document.id) !== document) return;
    this.documents.delete(document.id); clearTimeout(document.timer); document.ticketBytes.fill(0); document.jobs.clear();
    this.releaseFile(document.file, document.deviceId);
  }
  private prune() { const now = this.timestamp(); for (const document of this.documents.values()) if (document.expiresAt <= now) this.remove(document); }
}
