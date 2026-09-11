import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile, unlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { App } from '../src/app.js';
import { defaultConfig } from '../src/config.js';
import { DocumentService, type DocumentServiceOptions, type DocumentPage } from '../src/document-service.js';
import type { AppConfig } from '../src/types.js';

async function fixture(t: TestContext, options: DocumentServiceOptions = {}) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-document-'));
  const root = path.join(base, 'workspace'), other = path.join(base, 'other');
  await Promise.all([mkdir(root), mkdir(other)]);
  const configPath = path.join(base, 'config.json');
  const config: AppConfig = { ...defaultConfig(root, configPath), version: 2, configPath,
    device: { id: randomUUID(), name: 'Synthetic PDF device' },
    workspaces: [root, other].map((directory, index) => ({ id: index ? 'other' : 'default', uid: randomUUID(), root: directory, name: path.basename(directory), readOnly: false })) };
  await copyFile(path.resolve('test/fixtures/webcodex-reading-check.pdf'), path.join(root, '原件.pdf'));
  let now = Date.now();
  const app = new App(config), service = new DocumentService(app, { now: () => now, ...options });
  const opening = { workspace_id: 'default', path: '原件.pdf', expected_device_id: app.identity.deviceId };
  t.after(async () => {
    service.close(); await delay(0); await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-document-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { app, service, root, other, config, opening, advance: (ms: number) => { now += ms; }, open: () => service.open(opening) };
}
type Opened = Awaited<ReturnType<DocumentService['open']>>;
const privateInput = (opened: Opened) => ({ document_id: opened.data.document_id, ticket: opened.meta.ticket, expected_device_id: opened.meta.expected_device_id });
const publicInput = (opened: Opened, start_page = 1, page_count = 3) => ({ document_id: opened.data.document_id, workspace_id: opened.data.workspace_id, expected_device_id: opened.meta.expected_device_id, start_page, page_count });
async function command(service: DocumentService, opened: Opened) {
  const response = await service.poll(privateInput(opened));
  assert.equal(response.status, 'pending');
  if (response.status !== 'pending') assert.fail('Expected a prepared page request.');
  return response.request;
}
function pages(start: number, count: number, text = 'Browser parsed synthetic text'): DocumentPage[] {
  return Array.from({ length: count }, (_, index) => ({ page_number: start + index, text, truncated: false, text_layer: text ? 'present' as const : 'empty' as const }));
}

test('PDF open exposes metadata only while existing delivery reconstructs the complete original', async t => {
  const f = await fixture(t), opened = await f.open(), bytes = await readFile(path.join(f.root, '原件.pdf'));
  assert.equal(opened.data.size_bytes, bytes.length);
  assert.equal(opened.data.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(opened.data.mime_type, 'application/pdf');
  assert.equal(opened.data.initial_start_page, 1); assert.equal(opened.data.initial_page_count, 3);
  const publicJson = JSON.stringify(opened.data);
  for (const hidden of [opened.meta.ticket, bytes.toString('base64')]) assert.equal(publicJson.includes(hidden), false);
  assert.deepEqual(Object.keys(opened.meta.file).sort(), ['chunk_max_bytes', 'expires_at']);
  assert.equal(JSON.stringify(opened).includes('ticket_id'), false, 'The component must not receive the underlying shared delivery capability.');
  const delivered = await f.service.chunk({ ...privateInput(opened), offset: 0 });
  assert.deepEqual(Buffer.from(delivered._meta.base64, 'base64'), bytes); assert.equal(delivered.data.eof, true);
  assert.equal((await command(f.service, opened)).start_page, 1);
  const audits = JSON.stringify(f.app.store.db.prepare('SELECT event,details FROM audit_events').all());
  assert.equal(audits.includes(opened.meta.ticket), false); assert.equal(audits.includes('ticket_id'), false);
});

test('document chunks aggregate at most four existing policy reads with a 256 KiB reply cap', async t => {
  const f = await fixture(t), original = await readFile(path.join(f.root, '原件.pdf'));
  const bytes = Buffer.concat([original, Buffer.alloc(300000 - original.length, 32)]);
  await writeFile(path.join(f.root, '原件.pdf'), bytes);
  const opened = await f.open(), originalRead = f.app.fileWidgetDeliveries.read.bind(f.app.fileWidgetDeliveries);
  let calls = 0;
  f.app.fileWidgetDeliveries.read = async input => { calls++; return originalRead(input); };
  const first = await f.service.chunk({ ...privateInput(opened), offset: 0 });
  assert.equal(calls, 4); assert.equal(first.data.size_bytes, 262144); assert.equal(first.data.next_offset, 262144);
  assert.equal(JSON.stringify(first.data).includes(first._meta.base64), false);
  const second = await f.service.chunk({ ...privateInput(opened), offset: first.data.next_offset! });
  assert.equal(calls, 5); assert.equal(second.data.eof, true); assert.equal(second.data.next_offset, null);
  assert.deepEqual(Buffer.concat([Buffer.from(first._meta.base64, 'base64'), Buffer.from(second._meta.base64, 'base64')]), bytes);
  assert.equal(first.data.sha256, createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(f.service.chunk({ ...privateInput(opened), offset: -1 }), { code: 'DOCUMENT_INVALID_ARGUMENT' });
  await assert.rejects(f.service.chunk({ ...privateInput(opened), offset: 300001 }), { code: 'DOCUMENT_INVALID_ARGUMENT' });
});

test('document chunk delivery retains each configured block limit and rechecks closure after inner reads', async t => {
  const f = await fixture(t);
  f.config.limits.fileWidgetChunkMaxBytes = 4096;
  const original = await readFile(path.join(f.root, '原件.pdf'));
  await writeFile(path.join(f.root, '原件.pdf'), Buffer.concat([original, Buffer.alloc(20000, 32)]));
  const opened = await f.open();
  const first = await f.service.chunk({ ...privateInput(opened), offset: 0 });
  assert.equal(first.data.size_bytes, 4 * 4096);
  const originalRead = f.app.fileWidgetDeliveries.read.bind(f.app.fileWidgetDeliveries);
  f.app.fileWidgetDeliveries.read = async input => { const result = await originalRead(input); f.service.close(); return result; };
  await assert.rejects(f.service.chunk({ ...privateInput(opened), offset: first.data.next_offset! }), { code: 'SERVICE_CLOSING' });
});

test('serialized pending read, component submission and cached read returns actual pages with source provenance', async t => {
  const f = await fixture(t), opened = await f.open();
  const pending = await f.service.read(publicInput(opened));
  assert.equal(pending.status, 'pending'); assert.equal('pages' in pending, false);
  const job = await command(f.service, opened), submittedPages = pages(1, 3);
  submittedPages[1] = { page_number: 2, text: '', truncated: false, text_layer: 'empty' };
  assert.deepEqual(await f.service.submit({ ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, total_pages: 8, pages: submittedPages }), { accepted: true, duplicate: false });
  const result = await f.service.read(publicInput(opened));
  assert.equal(result.status, 'ready'); if (result.status !== 'ready') assert.fail();
  assert.deepEqual(result.pages, submittedPages); assert.equal(result.total_pages, 8); assert.equal(result.next_start_page, 4);
  assert.equal(result.source, 'browser_pdfjs_text_layer'); assert.equal(result.snapshot_scope, 'captured_original_not_current_file');
  result.pages[0].text = 'Caller mutation';
  const again = await f.service.read(publicInput(opened)); if (again.status !== 'ready') assert.fail();
  assert.equal(again.pages[0].text, submittedPages[0].text);
});

test('preparation before model read clamps end pages and exact duplicate submission is idempotent', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  const submission = { ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, total_pages: 1, pages: pages(1, 1) };
  assert.equal((await f.service.submit(submission)).duplicate, false);
  assert.equal((await f.service.submit(submission)).duplicate, true);
  const ready = await f.service.read(publicInput(opened)); if (ready.status !== 'ready') assert.fail();
  assert.equal(ready.next_start_page, null); assert.equal(ready.pages.length, 1);
  await assert.rejects(f.service.submit({ ...submission, pages: pages(1, 1, 'conflict') }), { code: 'DOCUMENT_RESULT_CONFLICT' });
  await assert.rejects(f.service.read(publicInput(opened, 2)), { code: 'DOCUMENT_PAGE_RANGE' });
});

test('queued ranges keep stable IDs and independent bounded observation budgets', async t => {
  const f = await fixture(t, { maxPendingReads: 2, maxJobsPerDocument: 3 }), opened = await f.open();
  const initial = await command(f.service, opened);
  for (let count = 0; count < 2; count++) assert.equal((await f.service.read(publicInput(opened))).request_id, initial.request_id);
  await assert.rejects(f.service.read(publicInput(opened)), { code: 'DOCUMENT_READ_LIMIT' });
  const next = await f.service.read(publicInput(opened, 4, 2));
  assert.notEqual(next.request_id, initial.request_id);
  await f.service.submit({ ...privateInput(opened), request_id: initial.request_id, sha256: opened.data.sha256, total_pages: 10, pages: pages(1, 3) });
  assert.equal((await f.service.read(publicInput(opened))).status, 'ready');
  const queued = await command(f.service, opened); assert.equal(queued.request_id, next.request_id);
  await f.service.submit({ ...privateInput(opened), request_id: queued.request_id, sha256: opened.data.sha256, total_pages: 10, pages: pages(4, 2) });
  await f.service.read(publicInput(opened, 6, 2));
  await assert.rejects(f.service.read(publicInput(opened, 8, 2)), { code: 'DOCUMENT_JOB_LIMIT' });
  assert.equal((await f.service.read(publicInput(opened, 4, 2))).status, 'ready');
});

test('default PDF observations allow thirty bounded transfer checks and ready content survives the cap', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  for (let remaining = 29; remaining >= 0; remaining--) {
    const observed = await f.service.read(publicInput(opened));
    if (observed.status !== 'pending') assert.fail();
    assert.equal(observed.pending_reads_remaining, remaining); assert.equal(observed.retry_after_ms, 2000);
    assert.equal(observed.progress.stage, 'awaiting_transfer'); assert.equal(observed.request_id, job.request_id);
  }
  await assert.rejects(f.service.read(publicInput(opened)), { code: 'DOCUMENT_READ_LIMIT' });
  await f.service.submit({ ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, total_pages: 1, pages: pages(1, 1) });
  assert.equal((await f.service.read(publicInput(opened))).status, 'ready');
});

test('credential, device, workspace and request mismatches never authorize content or assets', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  const bad = { ...privateInput(opened), ticket: randomUUID() };
  await assert.rejects(f.service.poll(bad), { code: 'DOCUMENT_ACCESS_DENIED' });
  await assert.rejects(f.service.authorizeAsset(bad), { code: 'DOCUMENT_ACCESS_DENIED' });
  await assert.rejects(f.service.read({ ...publicInput(opened), workspace_id: 'other' }), { code: 'DOCUMENT_NOT_FOUND' });
  await assert.rejects(f.service.read({ ...publicInput(opened), expected_device_id: randomUUID() }), { code: 'DEVICE_MISMATCH' });
  await assert.rejects(f.service.poll({ ...privateInput(opened), expected_device_id: randomUUID() }), { code: 'DEVICE_MISMATCH' });
  await assert.rejects(f.service.submit({ ...privateInput(opened), request_id: randomUUID(), sha256: opened.data.sha256, total_pages: 3, pages: pages(1, 3) }), { code: 'DOCUMENT_STALE_SUBMISSION' });
  await assert.rejects(f.service.submit({ ...privateInput(opened), request_id: job.request_id, sha256: '0'.repeat(64), total_pages: 3, pages: pages(1, 3) }), { code: 'FILE_INTEGRITY_ERROR' });
  assert.equal((await f.service.authorizeAsset(privateInput(opened))).document_id, opened.data.document_id);
});

test('incomplete, reordered, forged or inconsistent page results are rejected without poisoning a job', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  const base = { ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, total_pages: 8 };
  for (const invalid of [pages(1, 2), pages(2, 3), [...pages(1, 2), { ...pages(3, 1)[0], image: 'unrequested' }], [{ ...pages(1, 1)[0], text_layer: 'empty' }, ...pages(2, 2)]]) {
    await assert.rejects(f.service.submit({ ...base, pages: invalid as DocumentPage[] }), { code: 'DOCUMENT_INVALID_RESULT' });
  }
  await assert.rejects(f.service.submit({ ...base, total_pages: 2001, pages: pages(1, 3) }), { code: 'DOCUMENT_INVALID_RESULT' });
  await f.service.submit({ ...base, pages: pages(1, 3) });
  const next = await f.service.read(publicInput(opened, 4, 2));
  await assert.rejects(f.service.submit({ ...base, request_id: next.request_id, total_pages: 9, pages: pages(4, 2) }), { code: 'DOCUMENT_RESULT_CONFLICT' });
});

test('per-page, combined UTF-8 and per-document cache budgets are enforced', async t => {
  const f = await fixture(t, { maxTextCacheBytes: 20 }), opened = await f.open(), job = await command(f.service, opened);
  const base = { ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, total_pages: 8 };
  await assert.rejects(f.service.submit({ ...base, pages: pages(1, 3, '文'.repeat(5462)) }), { code: 'DOCUMENT_TEXT_LIMIT' });
  await assert.rejects(f.service.submit({ ...base, pages: pages(1, 3, 'x'.repeat(8)) }), { code: 'DOCUMENT_CACHE_LIMIT' });
  await f.service.submit({ ...base, pages: pages(1, 3, 'abc') });
  const next = await f.service.read(publicInput(opened, 4, 2));
  await assert.rejects(f.service.submit({ ...base, request_id: next.request_id, pages: pages(4, 2, 'abcdef') }), { code: 'DOCUMENT_CACHE_LIMIT' });
  const g = await fixture(t), second = await g.open();
  const five = await g.service.read(publicInput(second, 1, 5));
  await assert.rejects(g.service.submit({ ...privateInput(second), request_id: five.request_id, sha256: second.data.sha256, total_pages: 8, pages: pages(1, 5, 'x'.repeat(16384)) }), { code: 'DOCUMENT_TEXT_LIMIT' });
});

test('a page omitted by the shared text budget remains explicit and distinct from an empty text layer', async t => {
  const f = await fixture(t), opened = await f.open();
  const request = await f.service.read(publicInput(opened, 1, 5));
  const submission = { ...privateInput(opened), request_id: request.request_id, sha256: opened.data.sha256, total_pages: 5 };
  const content = [...pages(1, 4, 'x'.repeat(16384)), { page_number: 5, text: '', truncated: false, text_layer: 'present' as const }];
  await assert.rejects(f.service.submit({ ...submission, pages: content }), { code: 'DOCUMENT_INVALID_RESULT' });
  content[4].truncated = true;
  await f.service.submit({ ...submission, pages: content });
  const result = await f.service.read(publicInput(opened, 1, 5));
  if (result.status !== 'ready') assert.fail();
  assert.deepEqual(result.pages[4], { page_number: 5, text: '', truncated: true, text_layer: 'present' });
});

test('component failure codes are bounded, cached and cannot overwrite successful content', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  const failure = { ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, error_code: 'PDF_PASSWORD_REQUIRED' as const };
  await assert.rejects(f.service.submit({ ...failure, error_code: 'private stack trace' } as any), { code: 'DOCUMENT_INVALID_RESULT' });
  assert.deepEqual(await f.service.submit(failure), { accepted: true, duplicate: false });
  assert.deepEqual(await f.service.submit(failure), { accepted: true, duplicate: true });
  await assert.rejects(f.service.read(publicInput(opened)), { code: 'PDF_PASSWORD_REQUIRED' });
  await assert.rejects(f.service.submit({ ...failure, error_code: 'PDF_PARSE_FAILED' }), { code: 'DOCUMENT_RESULT_CONFLICT' });
  const stopped = await f.service.poll(privateInput(opened));
  assert.equal(stopped.status, 'idle'); assert.equal('failure_code' in stopped && stopped.failure_code, 'PDF_PASSWORD_REQUIRED');
});

test('component failure diagnostics reach every page read as immutable component reports with exact retry semantics', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  await f.service.chunk({ ...privateInput(opened), offset: 0 });
  const diagnostics = { component_version: '0.15.0-preview.2', phase: 'file' as const,
    code: 'FILE_INTEGRITY_ERROR' as const, detail_code: 'CHUNK_END_MISMATCH' as const };
  const submission = { ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256,
    error_code: 'FILE_INTEGRITY_ERROR' as const, failure_diagnostics: diagnostics };
  assert.deepEqual(await f.service.submit(submission), { accepted: true, duplicate: false });
  assert.deepEqual(await f.service.submit({ ...submission, failure_diagnostics: {
    detail_code: diagnostics.detail_code, code: diagnostics.code, phase: diagnostics.phase, component_version: diagnostics.component_version,
  } }), { accepted: true, duplicate: true });
  for (const changed of [
    { ...diagnostics, component_version: '0.15.0-preview.3' },
    { ...diagnostics, phase: 'parse' as const },
    { ...diagnostics, code: 'INVALID_RESPONSE' as const },
    { ...diagnostics, detail_code: 'CHUNK_SHA256_MISMATCH' as const },
    { component_version: diagnostics.component_version, phase: diagnostics.phase, code: diagnostics.code },
  ]) await assert.rejects(f.service.submit({ ...submission, failure_diagnostics: changed }), { code: 'DOCUMENT_RESULT_CONFLICT' });
  const { failure_diagnostics: _omitted, ...withoutDiagnostics } = submission;
  await assert.rejects(f.service.submit(withoutDiagnostics), { code: 'DOCUMENT_RESULT_CONFLICT' });
  // Neither a later caller mutation nor modifying returned error details changes the cached report.
  const expected = { source: 'component_reported', ...diagnostics };
  diagnostics.component_version = '0.15.0-preview.9';
  for (const [start, count] of [[1, 3], [1, 1], [4, 1]]) {
    await assert.rejects(f.service.read(publicInput(opened, start, count)), (error: any) => {
      assert.equal(error.code, 'FILE_INTEGRITY_ERROR');
      assert.deepEqual(error.details.component_diagnostics, expected);
      assert.equal(error.details.progress.complete_original_served, true);
      assert.equal(error.details.progress.failure_observed_stage, 'awaiting_page_result');
      const serialized = JSON.stringify(error.details);
      for (const hidden of [opened.meta.ticket, opened.data.sha256, opened.data.path]) assert.equal(serialized.includes(hidden), false);
      error.details.component_diagnostics.component_version = '0.15.0-preview.8';
      return true;
    });
  }
});

test('failure diagnostic validation rejects arbitrary text, unknown fields, incomplete reports and success contamination before committing a result', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  const base = { ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256 };
  const diagnostics = { component_version: '0.15.0-preview.2', phase: 'file', code: 'FILE_INTEGRITY_ERROR', detail_code: 'BASE64_LENGTH_MISMATCH' };
  for (const invalid of [
    null, undefined, [], 'private stack trace', {},
    { ...diagnostics, message: 'private stack trace' },
    { ...diagnostics, phase: 'C:\\private\\file.pdf' },
    { ...diagnostics, code: 'JSON_RPC_-32603' },
    { ...diagnostics, detail_code: 'unknown detail' },
    { ...diagnostics, detail_code: undefined },
    { ...diagnostics, component_version: '0.15.0-preview.2 /private/path' },
    { ...diagnostics, component_version: '0.15.0-preview.2\n' },
    { ...diagnostics, component_version: '1000.0.0' },
    { ...diagnostics, component_version: '0.15.0-preview.10000' },
    { ...diagnostics, component_version: '1'.repeat(41) },
    { component_version: diagnostics.component_version, phase: diagnostics.phase },
    { component_version: diagnostics.component_version, code: diagnostics.code },
    { phase: diagnostics.phase, code: diagnostics.code },
  ]) await assert.rejects(f.service.submit({ ...base, error_code: 'FILE_INTEGRITY_ERROR', failure_diagnostics: invalid } as any), { code: 'DOCUMENT_INVALID_RESULT' });
  await assert.rejects(f.service.submit({ ...base, error_code: 'FILE_INTEGRITY_ERROR', message: 'unsupported top-level field' } as any), { code: 'DOCUMENT_INVALID_RESULT' });
  for (const value of [diagnostics, undefined]) {
    await assert.rejects(f.service.submit({ ...base, total_pages: 1, pages: pages(1, 1), failure_diagnostics: value } as any), { code: 'DOCUMENT_INVALID_RESULT' });
  }
  assert.equal((await f.service.read(publicInput(opened))).status, 'pending');
  assert.deepEqual(await f.service.submit({ ...base, total_pages: 1, pages: pages(1, 1) }), { accepted: true, duplicate: false });
  assert.equal((await f.service.read(publicInput(opened))).status, 'ready');
});

test('legacy failure submissions remain valid and cannot later acquire a different diagnostic identity', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  const submission = { ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, error_code: 'PDF_PARSE_FAILED' as const };
  assert.deepEqual(await f.service.submit(submission), { accepted: true, duplicate: false });
  assert.deepEqual(await f.service.submit(submission), { accepted: true, duplicate: true });
  await assert.rejects(f.service.read(publicInput(opened)), (error: any) => {
    assert.equal(error.code, 'PDF_PARSE_FAILED'); assert.equal('component_diagnostics' in error.details, false); return true;
  });
  await assert.rejects(f.service.submit({ ...submission, failure_diagnostics: {
    component_version: '0.15.0', phase: 'extract', code: 'UNKNOWN_ERROR',
  } }), { code: 'DOCUMENT_RESULT_CONFLICT' });
});

test('bounded JSON-RPC and unknown component errors can be reported without exception text or detail codes', async t => {
  for (const code of ['UNKNOWN_ERROR', 'JSON_RPC_ERROR'] as const) {
    const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
    const diagnostics = { component_version: '0.15.0', phase: 'extract' as const, code };
    await f.service.submit({ ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256,
      error_code: 'PDF_PARSE_FAILED', failure_diagnostics: diagnostics });
    await assert.rejects(f.service.read(publicInput(opened)), (error: any) => {
      assert.deepEqual(error.details.component_diagnostics, { source: 'component_reported', ...diagnostics }); return true;
    });
  }
});

test('a fatal initial parse failure immediately reaches queued, subset and future reads', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  assert.equal((await f.service.read(publicInput(opened, 1, 1))).request_id, job.request_id);
  const queued = await f.service.read(publicInput(opened, 4, 1));
  await f.service.chunk({ ...privateInput(opened), offset: 0 });
  const failure = { ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, error_code: 'PDF_PARSE_FAILED' as const };
  await f.service.submit(failure);
  for (const [start, count] of [[1, 3], [1, 1], [4, 1], [12, 2]]) {
    await assert.rejects(f.service.read(publicInput(opened, start, count)), (error: any) => {
      assert.equal(error.code, 'PDF_PARSE_FAILED'); assert.equal(error.details.scope, 'document');
      assert.equal(error.details.progress.stage, 'failed');
      assert.equal(error.details.progress.failure_observed_stage, 'awaiting_page_result');
      assert.equal(error.details.progress.complete_original_served, true);
      assert.equal(JSON.stringify(error.details).includes(opened.meta.ticket), false);
      assert.equal(JSON.stringify(error.details).includes(opened.data.path), false);
      return true;
    });
  }
  assert.deepEqual(await f.service.submit(failure), { accepted: true, duplicate: true });
  await assert.rejects(f.service.submit({ ...privateInput(opened), request_id: queued.request_id, sha256: opened.data.sha256, total_pages: 4, pages: pages(4, 1) }), { code: 'PDF_PARSE_FAILED' });
  assert.equal((await f.service.poll(privateInput(opened))).status, 'idle');
});

test('fixed component failure codes are document-wide even if an earlier range was cached', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  await f.service.submit({ ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, total_pages: 4, pages: pages(1, 3) });
  const next = await f.service.read(publicInput(opened, 4, 1));
  await f.service.submit({ ...privateInput(opened), request_id: next.request_id, sha256: opened.data.sha256, error_code: 'FILE_INTEGRITY_ERROR' });
  await assert.rejects(f.service.read(publicInput(opened, 1, 1)), { code: 'FILE_INTEGRITY_ERROR' });
  await assert.rejects(f.service.chunk({ ...privateInput(opened), offset: 0 }), { code: 'FILE_INTEGRITY_ERROR' });
});

test('complete covering ranges serve subsets without spending request slots or creating additional work', async t => {
  const f = await fixture(t, { maxJobsPerDocument: 1 }), opened = await f.open(), job = await command(f.service, opened);
  const initialSubset = await f.service.read(publicInput(opened, 1, 1));
  assert.equal(initialSubset.request_id, job.request_id);
  await f.service.submit({ ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, total_pages: 4, pages: pages(1, 3) });
  for (const [start, count] of [[1, 1], [2, 1], [2, 2]]) {
    const result = await f.service.read(publicInput(opened, start, count));
    if (result.status !== 'ready') assert.fail();
    assert.equal(result.request_id, job.request_id); assert.equal(result.start_page, start); assert.equal(result.page_count, count);
    assert.deepEqual(result.pages.map(page => page.page_number), Array.from({ length: count }, (_, index) => start + index));
    assert.equal(result.next_start_page, start + count);
  }
  assert.deepEqual(await f.service.poll(privateInput(opened)), { status: 'idle' });
  await assert.rejects(f.service.read(publicInput(opened, 4, 1)), { code: 'DOCUMENT_JOB_LIMIT' });
});

test('a narrower range re-extracts truncated cached text while exact ranges preserve truncation', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  const partial = pages(1, 3); partial[2] = { page_number: 3, text: '', truncated: true, text_layer: 'present' };
  await f.service.submit({ ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, total_pages: 3, pages: partial });
  const exact = await f.service.read(publicInput(opened)); if (exact.status !== 'ready') assert.fail();
  assert.equal(exact.pages[2].truncated, true);
  assert.equal((await f.service.read(publicInput(opened, 1, 1))).status, 'ready');
  const narrower = await f.service.read(publicInput(opened, 3, 1));
  assert.equal(narrower.status, 'pending'); assert.notEqual(narrower.request_id, job.request_id);
  await f.service.submit({ ...privateInput(opened), request_id: narrower.request_id, sha256: opened.data.sha256, total_pages: 3, pages: pages(3, 1, 'Recovered full page text') });
  const recovered = await f.service.read(publicInput(opened, 3, 1)); if (recovered.status !== 'ready') assert.fail();
  assert.equal(recovered.pages[0].text, 'Recovered full page text'); assert.equal(recovered.pages[0].truncated, false);
});

test('pending progress distinguishes component startup, bytes served and awaiting parsing without claiming browser receipt', async t => {
  const f = await fixture(t), original = await readFile(path.join(f.root, '原件.pdf'));
  await writeFile(path.join(f.root, '原件.pdf'), Buffer.concat([original, Buffer.alloc(600000 - original.length, 32)]));
  const opened = await f.open();
  async function progress() { const result = await f.service.read(publicInput(opened)); if (result.status !== 'pending') assert.fail(); return result.progress; }
  assert.equal((await progress()).stage, 'awaiting_component');
  await command(f.service, opened); assert.equal((await progress()).stage, 'awaiting_transfer');
  await f.service.chunk({ ...privateInput(opened), offset: 0 });
  const partial = await progress(); assert.equal(partial.stage, 'transferring'); assert.equal(partial.served_contiguous_prefix_bytes, 262144);
  await f.service.chunk({ ...privateInput(opened), offset: 524288 });
  assert.equal((await progress()).complete_original_served, false, 'An EOF response alone must not claim earlier missing bytes were served.');
  await f.service.chunk({ ...privateInput(opened), offset: 262144 });
  await f.service.chunk({ ...privateInput(opened), offset: 524288 });
  const complete = await progress();
  assert.equal(complete.stage, 'awaiting_page_result'); assert.equal(complete.chunk_response_count, 4);
  assert.equal(complete.complete_original_served, true); assert.equal(complete.ready_request_count, 0);
  assert.match(complete.observation_scope, /not_browser_receipt_or_parse_verification/);
  for (const hidden of [opened.meta.ticket, opened.data.path, opened.data.sha256]) assert.equal(JSON.stringify(complete).includes(hidden), false);
});

test('source edits and deletion retain a labelled snapshot; linked replacements and policy changes reject all paths', async t => {
  const f = await fixture(t), opened = await f.open(), job = await command(f.service, opened);
  await f.service.submit({ ...privateInput(opened), request_id: job.request_id, sha256: opened.data.sha256, total_pages: 1, pages: pages(1, 1) });
  await writeFile(path.join(f.root, '原件.pdf'), 'A newer file');
  assert.equal((await f.service.read(publicInput(opened))).sha256, opened.data.sha256);
  await unlink(path.join(f.root, '原件.pdf'));
  assert.equal((await f.service.read(publicInput(opened))).status, 'ready');
  await writeFile(path.join(f.other, 'outside.pdf'), 'outside');
  await link(path.join(f.other, 'outside.pdf'), path.join(f.root, '原件.pdf'));
  await assert.rejects(f.service.read(publicInput(opened)), { code: 'PATH_DENIED' });
  await assert.rejects(f.service.poll(privateInput(opened)), { code: 'PATH_DENIED' });
  await assert.rejects(f.service.authorizeAsset(privateInput(opened)), { code: 'PATH_DENIED' });
  await unlink(path.join(f.root, '原件.pdf'));
  f.config.workspaces[0].enabled = false;
  await assert.rejects(f.service.read(publicInput(opened)), { code: 'WORKSPACE_DISABLED' });
  await assert.rejects(f.service.poll(privateInput(opened)), { code: 'WORKSPACE_DISABLED' });
  f.config.workspaces[0].enabled = true;
  const uid = f.config.workspaces[0].uid; f.config.workspaces[0].uid = randomUUID();
  await assert.rejects(f.service.authorizeAsset(privateInput(opened)), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  f.config.workspaces[0].uid = uid;
});

test('expiry during asynchronous authorization prevents reads, submissions and asset access', async t => {
  const f = await fixture(t, { ttlMs: 1000 }), opened = await f.open();
  const original = f.app.ctx.paths.resolve.bind(f.app.ctx.paths);
  f.app.ctx.paths.resolve = async (...args) => { const result = await original(...args); f.advance(1000); return result; };
  await assert.rejects(f.service.read(publicInput(opened)), { code: 'DOCUMENT_EXPIRED' });
  await assert.rejects(f.service.poll(privateInput(opened)), { code: 'DOCUMENT_NOT_FOUND' });
  await assert.rejects(f.service.authorizeAsset(privateInput(opened)), { code: 'DOCUMENT_NOT_FOUND' });
});

test('close while a path check is pending invalidates prepared and cached work', async t => {
  const f = await fixture(t), opened = await f.open();
  const original = f.app.ctx.paths.resolve.bind(f.app.ctx.paths);
  f.app.ctx.paths.resolve = async (...args) => { const result = await original(...args); f.service.close(); return result; };
  await assert.rejects(f.service.poll(privateInput(opened)), { code: 'SERVICE_CLOSING' });
  await assert.rejects(f.open(), { code: 'SERVICE_CLOSING' });
});

test('document capacity reserves concurrent opens and expiry releases original file delivery', async t => {
  const f = await fixture(t, { maxDocuments: 1, ttlMs: 1000 });
  const attempts = await Promise.allSettled([f.open(), f.open()]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((attempts.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'DOCUMENT_CAPACITY');
  const opened = (attempts.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Opened>).value;
  f.advance(1000);
  await assert.rejects(f.service.read(publicInput(opened)), { code: 'DOCUMENT_EXPIRED' });
  await delay(10);
  assert.equal(f.app.fileWidgetDeliveries.stats().ticket_count, 0);
  assert.ok((await f.open()).data.document_id);
});

test('unsupported formats, device mismatch and configured original byte limits fail before exposing a document', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'note.txt'), 'plain text');
  await assert.rejects(f.service.open({ ...f.opening, path: 'note.txt' }), { code: 'DOCUMENT_UNSUPPORTED' });
  await assert.rejects(f.service.open({ ...f.opening, expected_device_id: randomUUID() }), { code: 'DEVICE_MISMATCH' });
  f.config.limits.fileTransferMaxBytes = 4;
  await assert.rejects(f.open(), { code: 'FILE_TOO_LARGE' });
  assert.equal(f.app.fileWidgetDeliveries.stats().ticket_count, 0);
});
