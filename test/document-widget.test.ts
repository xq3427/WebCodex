import assert from 'node:assert/strict';
import { Blob, File } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import type { DocumentAssetKind } from '../src/document-assets.js';
import { DOCUMENT_WIDGET_URI, renderDocumentWidget } from '../src/document-widget.js';
import { VERSION } from '../src/version.js';

const NOW = Date.now();
const DOCUMENT_ID = 'f2a7a416-f50c-4d4f-aa88-a19a883e05b0';
const REQUEST_ID = '6ce435da-fccd-43a2-93de-369141592bc0';
const limits = { max_pages_per_request: 5, max_page_text_bytes: 16384, max_total_text_bytes: 65536 };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const envelope = (data: unknown, meta?: unknown) => ({ structuredContent: { ok: true, source: { device_id: 'synthetic-device' }, data }, ...(meta ? { _meta: meta } : {}) });
const tick = () => new Promise(resolve => setImmediate(resolve));

function makePdf(texts: string[], chinese = false): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '',
    chinese ? '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  if (chinese) objects.push('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>');
  const kids: string[] = [];
  for (const text of texts) {
    const pageId = objects.length + 1;
    const encoded = chinese ? '<' + [...text].map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '>'
      : '(' + text.replace(/[\\()]/g, '\\$&') + ')';
    const stream = 'BT /F1 12 Tf 72 720 Td ' + encoded + ' Tj ET';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (pageId + 1) + ' 0 R >>',
      '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream');
    kids.push(pageId + ' 0 R');
  }
  objects[1] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + texts.length + ' >>';
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(pdf)); pdf += (index + 1) + ' 0 obj\n' + objects[index] + '\nendobj\n'; }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Uint8Array.from(Buffer.from(pdf));
}

function opening(bytes: Uint8Array) {
  return envelope({ document_id: DOCUMENT_ID, name: '合成 <安全> 文档.pdf', workspace_id: 'synthetic', path: 'test.pdf', size_bytes: bytes.length, sha256: digest(bytes) },
    { webcodexDocument: { document_id: DOCUMENT_ID, ticket: 'A'.repeat(43), expected_device_id: 'synthetic-device',
      expires_at: new Date(NOW + 300000).toISOString(), file: { expires_at: new Date(NOW + 300000).toISOString(), chunk_max_bytes: 65536 }, limits } });
}
function chunk(bytes: Uint8Array, offset: number, size = 262144) {
  const part = bytes.subarray(offset, offset + size), end = offset + part.length, eof = end === bytes.length;
  return envelope({ document_id: DOCUMENT_ID, offset, size_bytes: part.length, total_bytes: bytes.length, next_offset: eof ? null : end, eof,
    sha256: digest(bytes), chunk_sha256: digest(part) }, { base64: Buffer.from(part).toString('base64') });
}

class Element {
  textContent = '';
  dataset: Record<string, string> = {};
  set innerHTML(_value: string) { throw new Error('Dynamic HTML is forbidden'); }
}
type Handler = (event: any) => unknown;

function harness(options: { rpc?: (name: string, args: any) => unknown | Promise<unknown>; host?: any; ui?: boolean; decodeBase64?: typeof atob } = {}) {
  const html = renderDocumentWidget();
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const sent: any[] = [], calls: any[] = [], listeners = new Map<string, Handler[]>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = NOW, timerId = 0;
  let deliver: (data: unknown) => Promise<void>;
  const parent = { postMessage(message: any, target: string) {
    assert.equal(target, '*'); sent.push(message);
    if (message.method === 'tools/call' && options.rpc) {
      calls.push(message.params);
      Promise.resolve().then(() => options.rpc!(message.params.name, message.params.arguments)).then(
        result => deliver({ jsonrpc: '2.0', id: message.id, result }),
        error => deliver({ jsonrpc: '2.0', id: message.id, error: { code: error.code, message: error.message } }),
      );
    }
  } };
  const host = options.host ?? {};
  const window = { parent, openai: host, location: { href: 'https://synthetic.invalid/' }, addEventListener(name: string, handler: Handler) {
    listeners.set(name, [...listeners.get(name) ?? [], handler]);
  } };
  class Clock extends Date { static override now() { return now; } }
  class DOMMatrix { a = 1; b = 0; c = 0; d = 1; e = 0; f = 0; }
  const noNetwork = () => { throw new Error('Browser network and worker access are forbidden in this test'); };
  const context = vm.createContext({
    window, document: { baseURI: 'https://synthetic.invalid/', getElementById: (id: string) => options.ui === false ? null : elements.get(id),
      createElement: () => { throw new Error('Text-only PDF parsing must not render a canvas'); } },
    navigator: { userAgent: 'SyntheticBrowser', platform: 'Win32', language: 'en-US' },
    DOMMatrix, Blob, File, crypto: webcrypto, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Uint8ClampedArray,
    ArrayBuffer, DataView, TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers, DOMException, ReadableStream, WritableStream, TransformStream,
    AbortController, AbortSignal, EventTarget, structuredClone, queueMicrotask, performance, atob: options.decodeBase64 ?? atob, btoa,
    Date: Clock, fetch: noNetwork, XMLHttpRequest: noNetwork, Worker: noNetwork,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout(callback: () => void, delay = 0) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  }, { codeGeneration: { strings: false, wasm: false } });
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInContext(script, context, { timeout: 10000 });
  const emit = async (name: string, event: unknown) => { for (const handler of listeners.get(name) ?? []) await handler(event); };
  const receive = (data: unknown, source: unknown = parent) => emit('message', { data, source });
  deliver = receive;
  const get = (id: string) => elements.get('webcodex-document-' + id)!;
  return {
    html, api: context.WebCodexDocument as any, sent, calls, timers, host, get, receive,
    text: () => [...elements.values()].map(element => element.textContent).join('\n'),
    initialize: async (capabilities: unknown = { serverTools: {} }) => {
      const init = sent.find(item => item.method === 'ui/initialize'); assert.ok(init);
      await receive({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26', hostCapabilities: capabilities } }); await tick();
    },
    result: async (result: unknown) => { await receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }); await tick(); },
    globals: () => emit('openai:set_globals', {}),
    close: async () => { await emit('pagehide', {}); await tick(); },
    waitState: async (state: string) => {
      const deadline = Date.now() + 10000;
      while (get('status').dataset.state !== state && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(get('status').dataset.state, state, get('status').textContent + ' ' + get('diagnostics').textContent);
    },
    advance: async (ms: number) => {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
        for (let i = 0; i < 5; i++) await tick();
      }
      now = end; await tick();
    },
  };
}

function assetLoader(h: ReturnType<typeof harness>, assets: string[]) {
  return async (kind: DocumentAssetKind, filename: string) => {
    assets.push(kind + '/' + filename);
    return h.api.getBundledDocumentAsset(kind, filename);
  };
}

test('document resource is self-contained and ships dependency notices without external assets or upload APIs', async () => {
  const html = renderDocumentWidget();
  assert.equal(DOCUMENT_WIDGET_URI, `ui://webcodex/document-${VERSION}.html`);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<button|<input|<script[^>]+src=|<link[^>]+href=|uploadFile|sendFollowUpMessage|selectFiles/);
  const notices = await readFile(new URL('../src/assets/PDFJS-NOTICES.txt', import.meta.url), 'utf8');
  assert.match(notices, /Apache License/);
  assert.match(notices, /LICENSE_LIBERATION/);
  assert.match(notices, /LICENSE_FOXIT/);
});

test('actual bundled PDF.js reads a synthetic multipage PDF through verified pinned font assets with network, workers, eval and wasm forbidden', async () => {
  const h = harness({ ui: false });
  const assets: string[] = [];
  const parser = h.api.createPdfRuntime({ loadAsset: assetLoader(h, assets), limits });
  try {
    assert.equal((await parser.load(makePdf(['Synthetic alpha 831', 'Synthetic beta 927']))).total_pages, 2);
    const result = await parser.readPages(1, 3);
    assert.equal(result.pages.length, 2);
    assert.match(result.pages[0].text, /Synthetic alpha 831/);
    assert.match(result.pages[1].text, /Synthetic beta 927/);
    assert.ok(result.pages.every((page: any) => page.text_layer === 'present' && page.truncated === false));
    assert.ok(assets.some(name => name.startsWith('standardFontDataUrl/')), assets.join(','));
    const cached = await parser.readPages(2, 1);
    assert.equal(cached.pages[0].text, result.pages[1].text);
  } finally { await parser.destroy(); }
});

test('actual Chinese Type0 PDF reads Chinese text using bundled local CMaps', async () => {
  const h = harness({ ui: false });
  const assets: string[] = [];
  const parser = h.api.createPdfRuntime({ loadAsset: assetLoader(h, assets), limits });
  try {
    await parser.load(makePdf(['中文论文验证'], true));
    const result = await parser.readPages(1, 1);
    assert.match(result.pages[0].text, /中文论文验证/);
    assert.ok(assets.some(name => name === 'cMapUrl/UniGB-UCS2-H.bcmap'), assets.join(','));
  } finally { await parser.destroy(); }
});

test('actual PDF extraction distinguishes empty text layers, aggregate omission, and Unicode-safe truncation', async () => {
  const h = harness({ ui: false });
  const empty = h.api.createPdfRuntime({ loadAsset: assetLoader(h, []), limits });
  try {
    await empty.load(makePdf(['']));
    assert.deepEqual(JSON.parse(JSON.stringify((await empty.readPages(1, 1)).pages[0])), { page_number: 1, text: '', truncated: false, text_layer: 'empty' });
  } finally { await empty.destroy(); }
  const dense = h.api.createPdfRuntime({ loadAsset: assetLoader(h, []), limits: { ...limits, max_page_text_bytes: 10, max_total_text_bytes: 40 } });
  try {
    await dense.load(makePdf(Array(5).fill('ABCDEFGHIJKLMNOPQRSTUVWXYZ')));
    const result = await dense.readPages(1, 5);
    assert.equal(result.pages[4].text, '');
    assert.equal(result.pages[4].truncated, true);
    assert.equal(result.pages[4].text_layer, 'present');
    assert.equal(result.pages.reduce((bytes: number, page: any) => bytes + Buffer.byteLength(page.text), 0), 40);
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.fitUtf8('中😀文', 7))), { text: '中😀', truncated: true });
  } finally { await dense.destroy(); }
});

test('actual parser rejects malformed documents and asset failure with safe symbolic codes', async () => {
  const h = harness({ ui: false });
  const invalid = h.api.createPdfRuntime({ loadAsset: assetLoader(h, []), limits });
  await assert.rejects(invalid.load(Uint8Array.from(Buffer.from('not a PDF'))), { code: 'PDF_INVALID' });
  const unavailable = h.api.createPdfRuntime({ loadAsset: async () => { throw new Error('SECRET /private/path'); }, limits });
  try {
    await unavailable.load(makePdf(['Asset check']));
    await assert.rejects(unavailable.readPages(1, 1), { code: 'ASSET_UNAVAILABLE', message: 'ASSET_UNAVAILABLE' });
  } finally { await unavailable.destroy(); }
});

test('the actual parser retains the first fixed asset cause when PDF.js swallows or rewraps font errors', async () => {
  const h = harness({ ui: false });
  const secret = 'synthetic-secret-font-message-and-path';
  for (const entry of [
    { code: 'HOST_TIMEOUT', expected: 'HOST_TIMEOUT' },
    { code: 'FILE_INTEGRITY_ERROR', expected: 'FILE_INTEGRITY_ERROR', detail: 'FILE_SHA256_MISMATCH' },
    { code: 'synthetic-private-code', expected: 'UNKNOWN_ERROR' },
  ]) {
    let calls = 0;
    const parser = h.api.createPdfRuntime({ limits, loadAsset: async () => {
      calls++; throw Object.assign(new Error(secret), { code: entry.code, detail_code: entry.detail ?? secret, cause: { secret } });
    } });
    try {
      await parser.load(makePdf(['Do not return text after a required font failure']));
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(parser.readPages(1, 1), (error: any) => {
          assert.equal(error.code, 'ASSET_UNAVAILABLE');
          assert.equal(error.diagnostic_code, entry.expected);
          assert.equal(error.detail_code, entry.detail);
          assert.equal(error.message, 'ASSET_UNAVAILABLE');
          assert.equal(error.cause, undefined);
          assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
          return true;
        });
      }
      assert.equal(calls, 1, 'A recorded failure must stop later reads before using cached or partial page text.');
    } finally { await parser.destroy(); }
  }
});

test('invalid bytes from a required asset loader cannot produce successful partial PDF text', async () => {
  const h = harness({ ui: false });
  for (const bytes of [undefined, new Uint8Array(0), new Uint16Array([1, 2])]) {
    const parser = h.api.createPdfRuntime({ limits, loadAsset: async () => bytes });
    try {
      await parser.load(makePdf(['Invalid loader output']));
      await assert.rejects(parser.readPages(1, 1), { code: 'ASSET_UNAVAILABLE', diagnostic_code: 'ASSET_UNAVAILABLE', detail_code: 'ASSET_BYTES_INVALID' });
    } finally { await parser.destroy(); }
  }
});

test('a whitespace-only truncated prefix remains a present but omitted text layer', () => {
  const h = harness({ ui: false });
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.pageTextResult(1, ' \n\t ', true))),
    { page_number: 1, text: '', truncated: true, text_layer: 'present' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.pageTextResult(1, ' \n\t ', false))),
    { page_number: 1, text: '', truncated: false, text_layer: 'empty' });
});

test('binary transfer validates multiple chunks, full hash, scope, and boundaries before returning bytes', async () => {
  const h = harness({ ui: false });
  const bytes = Uint8Array.from(Buffer.alloc(600000, 79));
  const offsets: number[] = [];
  const result = await h.api.readVerifiedBinary({ totalBytes: bytes.length, expectedSha: digest(bytes), maxBytes: 7 * 1024 * 1024,
    readChunk: async (offset: number) => { offsets.push(offset); return chunk(bytes, offset); } });
  assert.deepEqual(offsets, [0, 262144, 524288]);
  assert.equal(digest(result), digest(bytes));
  for (const change of [
    (value: any) => { value._meta.base64 = 'AAAA'; },
    (value: any) => { value.structuredContent.data.chunk_sha256 = '0'.repeat(64); },
    (value: any) => { value.structuredContent.data.sha256 = '0'.repeat(64); },
    (value: any) => { value.structuredContent.data.next_offset = 3; },
    (value: any) => { value.structuredContent.data.offset = 1; },
  ]) {
    await assert.rejects(h.api.readVerifiedBinary({ totalBytes: bytes.length, expectedSha: digest(bytes), maxBytes: bytes.length,
      readChunk: async (offset: number) => { const value = chunk(bytes, offset); change(value); return value; } }), { code: 'FILE_INTEGRITY_ERROR' });
  }
});

test('integrity failures identify the failed validation without returning raw private data', async () => {
  const h = harness({ ui: false });
  const bytes = Uint8Array.from([77]);
  const cases: Array<{ detail: string; change?: (value: any) => void; totalBytes?: number; expectedSha?: string }> = [
    { detail: 'FILE_SIZE_INVALID', totalBytes: 0 },
    { detail: 'CHUNK_METADATA_INVALID', change: value => { value.structuredContent.data.offset = 1; } },
    { detail: 'BASE64_LENGTH_MISMATCH', change: value => { value._meta.base64 = 'TQ'; } },
    { detail: 'BASE64_FORMAT_INVALID', change: value => { value._meta.base64 = 'T Q='; } },
    { detail: 'FILE_TOTAL_MISMATCH', change: value => { value.structuredContent.data.total_bytes = 2; } },
    { detail: 'FILE_HASH_METADATA_MISMATCH', change: value => { value.structuredContent.data.sha256 = '0'.repeat(64); } },
    { detail: 'DECODED_SIZE_MISMATCH', change: value => { value._meta.base64 = 'TWE='; } },
    { detail: 'BASE64_ROUNDTRIP_MISMATCH', change: value => { value._meta.base64 = 'TR=='; } },
    { detail: 'CHUNK_SHA256_MISMATCH', change: value => { value.structuredContent.data.chunk_sha256 = '0'.repeat(64); } },
    { detail: 'CHUNK_END_MISMATCH', change: value => { value.structuredContent.data.eof = false; } },
    { detail: 'FILE_SHA256_MISMATCH', expectedSha: '0'.repeat(64), change: value => { value.structuredContent.data.sha256 = '0'.repeat(64); } },
  ];
  for (const entry of cases) {
    await assert.rejects(h.api.readVerifiedBinary({ totalBytes: entry.totalBytes ?? bytes.length, expectedSha: entry.expectedSha ?? digest(bytes),
      maxBytes: 7340032, readChunk: async (offset: number) => { const value = chunk(bytes, offset); entry.change?.(value); return value; } }),
    { code: 'FILE_INTEGRITY_ERROR', detail_code: entry.detail, message: 'FILE_INTEGRITY_ERROR' });
  }
});

test('EOF permits omitted null next_offset only at the exact end and after complete hash verification', async () => {
  const h = harness({ ui: false });
  const bytes = Uint8Array.from(Buffer.from('Synthetic EOF transport verification'));
  for (const missing of [false, true]) {
    const result = await h.api.readVerifiedBinary({ totalBytes: bytes.length, expectedSha: digest(bytes), maxBytes: 7340032,
      readChunk: async (offset: number) => {
        const value = chunk(bytes, offset, 7);
        if (missing && (value.structuredContent.data as any).eof) delete (value.structuredContent.data as any).next_offset;
        return value;
      } });
    assert.equal(digest(result), digest(bytes));
  }
  for (const explicit of [0, bytes.length, false, '0', {}, []]) {
    await assert.rejects(h.api.readVerifiedBinary({ totalBytes: bytes.length, expectedSha: digest(bytes), maxBytes: 7340032,
      readChunk: async (offset: number) => {
        const value = chunk(bytes, offset); (value.structuredContent.data as any).next_offset = explicit; return value;
      } }), { code: 'FILE_INTEGRITY_ERROR', detail_code: 'CHUNK_END_MISMATCH' });
  }
  await assert.rejects(h.api.readVerifiedBinary({ totalBytes: bytes.length, expectedSha: digest(bytes), maxBytes: 7340032,
    readChunk: async (offset: number) => { const value = chunk(bytes, offset, 7); delete (value.structuredContent.data as any).next_offset; return value; } }),
  { code: 'FILE_INTEGRITY_ERROR', detail_code: 'CHUNK_END_MISMATCH' });
  await assert.rejects(h.api.readVerifiedBinary({ totalBytes: bytes.length, expectedSha: '0'.repeat(64), maxBytes: 7340032,
    readChunk: async (offset: number) => {
      const value = chunk(bytes, offset); delete (value.structuredContent.data as any).next_offset;
      (value.structuredContent.data as any).sha256 = '0'.repeat(64); return value;
    } }), { code: 'FILE_INTEGRITY_ERROR', detail_code: 'FILE_SHA256_MISMATCH' });
});

test('cancellation around transfer and digest checkpoints reports expiration instead of byte corruption', async () => {
  const h = harness({ ui: false });
  const bytes = Uint8Array.from(Buffer.from('Cancellation checkpoint'));
  for (const stopAt of [1, 2, 3, 4]) {
    let checks = 0;
    await assert.rejects(h.api.readVerifiedBinary({ totalBytes: bytes.length, expectedSha: digest(bytes), maxBytes: 7340032,
      cancelled: () => ++checks >= stopAt, readChunk: async (offset: number) => chunk(bytes, offset) }), { code: 'DOCUMENT_EXPIRED' });
  }
});

test('automatic widget checks original bytes then parses and submits actual content once; duplicate host notifications do not restart it', async () => {
  const bytes = makePdf(['Browser-only PDF title 741']);
  let submission: any;
  let assetCalls = 0;
  const h = harness({ rpc: async (name, args) => {
    if (name === 'document_widget_poll') return envelope(submission ? { status: 'idle' } : { status: 'pending', request: { request_id: REQUEST_ID, start_page: 1, page_count: 3 } });
    if (name === 'document_widget_chunk') return chunk(bytes, args.offset, 200);
    if (name === 'document_widget_asset') { assetCalls++; assert.fail('Bundled fonts must not request an MCP asset tool.'); }
    assert.equal(name, 'document_widget_submit'); submission = args; return envelope({ accepted: true, duplicate: false });
  } });
  try {
    await h.initialize(); await h.result(opening(bytes)); await h.result(opening(bytes)); await h.waitState('ready');
    assert.match(submission.pages[0].text, /Browser-only PDF title 741/);
    assert.equal(submission.sha256, digest(bytes));
    assert.equal(h.calls.filter(call => call.name === 'document_widget_submit').length, 1);
    assert.equal(assetCalls, 0);
    assert.equal(h.get('name').textContent, '合成 <安全> 文档.pdf');
    assert.doesNotMatch(h.text(), /Browser-only PDF title|AAAAA|BBBBB/);
  } finally { await h.close(); }
});

test('corrupt original bytes return integrity error without requesting parser font assets or claiming readiness', async () => {
  const bytes = makePdf(['Must not be parsed']);
  let submitted: any;
  const h = harness({ rpc: (name, args) => {
    if (name === 'document_widget_poll') return envelope({ status: 'pending', request: { request_id: REQUEST_ID, start_page: 1, page_count: 1 } });
    if (name === 'document_widget_chunk') { const value = chunk(bytes, args.offset); (value.structuredContent.data as any).chunk_sha256 = '0'.repeat(64); return value; }
    assert.equal(name, 'document_widget_submit'); submitted = args; return envelope({ accepted: true });
  } });
  await h.initialize(); await h.result(opening(bytes)); await h.waitState('failure');
  assert.equal(submitted.error_code, 'FILE_INTEGRITY_ERROR');
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.failure_diagnostics)), {
    component_version: VERSION, phase: 'file', code: 'FILE_INTEGRITY_ERROR', detail_code: 'CHUNK_SHA256_MISMATCH',
  });
  assert.equal(h.calls.filter(call => call.name === 'document_widget_asset').length, 0);
  assert.match(h.get('diagnostics').textContent, /file.*FILE_INTEGRITY_ERROR.*CHUNK_SHA256_MISMATCH/);
});

test('actual browser PDF parsing preserves wrapped original chunks and uses bundled fonts on both host bridges', async () => {
  for (const compatibility of [false, true]) {
    const bytes = makePdf(['Wrapped browser title 316', 'Wrapped second page 894']);
    const originalSha = digest(bytes);
    let submission: any, chunkCalls = 0, assetCalls = 0, submitCalls = 0;
    const handle = async (name: string, args: any) => {
      let value;
      if (name === 'document_widget_poll') value = envelope(submission ? { status: 'idle' }
        : { status: 'pending', request: { request_id: REQUEST_ID, start_page: 1, page_count: 3 } });
      else if (name === 'document_widget_chunk') { chunkCalls++; value = chunk(bytes, args.offset, 173); }
      else if (name === 'document_widget_asset') {
        assetCalls++; assert.fail('Bundled fonts must not request an MCP asset tool.');
      } else {
        assert.equal(name, 'document_widget_submit'); submitCalls++; submission = args;
        value = envelope({ accepted: true, duplicate: false });
      }
      // The outer structured summary carries no private metadata. The complete nested result owns it.
      return { structuredContent: value.structuredContent, mcp_tool_result: { call_tool_result: value } };
    };
    const initial = opening(bytes);
    const h = compatibility
      ? harness({ host: { toolOutput: initial.structuredContent, toolResponseMetadata: initial._meta, callTool: handle } })
      : harness({ rpc: handle });
    try {
      if (!compatibility) { await h.initialize(); await h.result(initial); }
      await h.waitState('ready');
      assert.equal(submission.sha256, originalSha);
      assert.equal(submission.total_pages, 2);
      assert.match(submission.pages[0].text, /Wrapped browser title 316/);
      assert.match(submission.pages[1].text, /Wrapped second page 894/);
      assert.ok(chunkCalls > 1);
      assert.equal(assetCalls, 0);
      assert.equal(submitCalls, 1);
      assert.doesNotMatch(h.text(), /Wrapped browser title|Wrapped second page/);
    } finally { await h.close(); }
  }
});

test('a local bundled font failure reaches the component submission with its fixed root cause', async () => {
  const bytes = makePdf(['Bundled font diagnostic propagation']);
  const secret = 'synthetic-private-decoder-error';
  let submission: any;
  const h = harness({ decodeBase64: value => {
    if (value.length > 100000) throw new Error(secret);
    return atob(value);
  }, rpc: (name, args) => {
    if (name === 'document_widget_poll') return envelope({ status: 'pending', request: { request_id: REQUEST_ID, start_page: 1, page_count: 1 } });
    if (name === 'document_widget_chunk') return chunk(bytes, args.offset);
    assert.equal(name, 'document_widget_submit'); submission = args; return envelope({ accepted: true });
  } });
  await h.initialize(); await h.result(opening(bytes)); await h.waitState('failure');
  assert.equal(submission.error_code, 'ASSET_UNAVAILABLE');
  assert.deepEqual(JSON.parse(JSON.stringify(submission.failure_diagnostics)), {
    component_version: VERSION, phase: 'extract', code: 'FILE_INTEGRITY_ERROR', detail_code: 'BASE64_DECODE_FAILED',
  });
  assert.match(h.get('diagnostics').textContent, /extract.*ASSET_UNAVAILABLE.*FILE_INTEGRITY_ERROR.*BASE64_DECODE_FAILED/);
  assert.doesNotMatch(JSON.stringify(submission), new RegExp(secret));
  assert.doesNotMatch(h.text(), new RegExp(secret));
  assert.equal(h.calls.filter(call => call.name === 'document_widget_asset').length, 0);
  assert.equal(h.timers.size, 0);
});

test('missing private bytes retain the fixed file-stage diagnostic after reporting the compatible fatal error', async () => {
  const bytes = makePdf(['Missing private bytes']);
  let submission: any;
  const h = harness({ rpc: (name, args) => {
    if (name === 'document_widget_poll') return envelope({ status: 'pending', request: { request_id: REQUEST_ID, start_page: 1, page_count: 1 } });
    if (name === 'document_widget_chunk') return { structuredContent: chunk(bytes, args.offset).structuredContent };
    assert.equal(name, 'document_widget_submit'); submission = args; return envelope({ accepted: true });
  } });
  await h.initialize(); await h.result(opening(bytes)); await h.waitState('failure');
  assert.equal(submission.error_code, 'PDF_PARSE_FAILED');
  assert.deepEqual(JSON.parse(JSON.stringify(submission.failure_diagnostics)), {
    component_version: VERSION, phase: 'file', code: 'INVALID_RESPONSE', detail_code: 'PRIVATE_BYTES_MISSING',
  });
  assert.match(h.get('diagnostics').textContent, /file.*INVALID_RESPONSE.*PRIVATE_BYTES_MISSING/);
  assert.equal(h.calls.filter(call => call.name === 'document_widget_asset').length, 0);
  assert.equal(h.timers.size, 0);
});

test('actual invalid PDF preserves parse as its originating failure phase after the error submission', async () => {
  const bytes = Uint8Array.from(Buffer.from('synthetic invalid PDF bytes'));
  let submission: any;
  const h = harness({ rpc: (name, args) => {
    if (name === 'document_widget_poll') return envelope({ status: 'pending', request: { request_id: REQUEST_ID, start_page: 1, page_count: 1 } });
    if (name === 'document_widget_chunk') return chunk(bytes, args.offset);
    assert.equal(name, 'document_widget_submit'); submission = args; return envelope({ accepted: true });
  } });
  await h.initialize(); await h.result(opening(bytes)); await h.waitState('failure');
  assert.equal(submission.error_code, 'PDF_INVALID');
  assert.deepEqual(JSON.parse(JSON.stringify(submission.failure_diagnostics)), { component_version: VERSION, phase: 'parse', code: 'PDF_INVALID' });
  assert.match(h.get('diagnostics').textContent, /parse.*PDF_INVALID/);
  assert.equal(h.timers.size, 0);
});

test('failure submission reports only fixed unknown and JSON-RPC diagnostics without host messages', async () => {
  const bytes = makePdf(['Safe failure diagnostics']);
  const secret = 'synthetic-secret-message-and-private-path';
  for (const [hostCode, expectedCode] of [[undefined, 'UNKNOWN_ERROR'], [-32602, 'JSON_RPC_ERROR']] as const) {
    let submission: any;
    const h = harness({ rpc: (name, args) => {
      if (name === 'document_widget_poll') return envelope({ status: 'pending', request: { request_id: REQUEST_ID, start_page: 1, page_count: 1 } });
      if (name === 'document_widget_chunk') throw Object.assign(new Error(secret), { code: hostCode });
      assert.equal(name, 'document_widget_submit'); submission = args; return envelope({ accepted: true });
    } });
    await h.initialize(); await h.result(opening(bytes)); await h.waitState('failure');
    assert.equal(submission.error_code, 'PDF_PARSE_FAILED');
    assert.deepEqual(JSON.parse(JSON.stringify(submission.failure_diagnostics)), { component_version: VERSION, phase: 'file', code: expectedCode });
    assert.doesNotMatch(JSON.stringify(submission), new RegExp(secret));
    assert.doesNotMatch(h.text(), new RegExp(secret));
    assert.equal(h.timers.size, 0);
  }
});

test('compatibility-only host automatically parses without waiting for unanswered standard initialization', async () => {
  const bytes = makePdf(['Compatibility PDF content 682']);
  const initial = opening(bytes);
  let submission: any;
  const h = harness({ host: { toolOutput: initial.structuredContent, toolResponseMetadata: initial._meta,
    callTool: async (name: string, args: any) => {
      if (name === 'document_widget_poll') return envelope({ status: 'pending', request: { request_id: REQUEST_ID, start_page: 1, page_count: 1 } });
      if (name === 'document_widget_chunk') return chunk(bytes, args.offset);
      assert.equal(name, 'document_widget_submit'); submission = args; return envelope({ accepted: true });
    } } });
  try {
    await h.waitState('ready');
    assert.match(submission.pages[0].text, /Compatibility PDF content 682/);
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('an uncertain submit timeout never retries or falls back through the compatibility bridge', async () => {
  const bytes = makePdf(['Uncertain submit']);
  let compat = 0, submissions = 0;
  const h = harness({ host: { callTool: async () => { compat++; throw new Error('Must not replay'); } }, rpc: async (name, args) => {
    if (name === 'document_widget_poll') return envelope({ status: 'pending', request: { request_id: REQUEST_ID, start_page: 1, page_count: 1 } });
    if (name === 'document_widget_chunk') return chunk(bytes, args.offset);
    assert.equal(name, 'document_widget_submit'); submissions++; return new Promise(() => {});
  } });
  await h.initialize(); await h.result(opening(bytes));
  const deadline = Date.now() + 3000;
  while (!submissions && Date.now() < deadline) await tick();
  assert.equal(submissions, 1);
  await h.advance(10000);
  assert.equal(h.get('status').dataset.state, 'failure');
  assert.match(h.get('diagnostics').textContent, /submit.*HOST_TIMEOUT/);
  await h.result(opening(bytes)); await h.globals();
  assert.equal(submissions, 1);
  assert.equal(compat, 0);
  assert.equal(h.timers.size, 0);
});

test('idle polls back off, honor the five-minute limit, and do not require any model read', async () => {
  const h = harness({ rpc: () => envelope({ status: 'idle' }) });
  await h.initialize(); await h.result(opening(makePdf(['Idle'])));
  await h.advance(300000);
  assert.equal(h.get('status').dataset.state, 'expired');
  assert.ok(h.calls.length <= 65, String(h.calls.length));
  assert.equal(h.timers.size, 0);
});

test('an idle poll carrying a previously reported document-wide fatal error ends polling immediately', async () => {
  const h = harness({ rpc: () => envelope({ status: 'idle', failure_code: 'PDF_PARSE_FAILED', progress: { stage: 'failed' } }) });
  await h.initialize(); await h.result(opening(makePdf(['Previously failed']))); await h.waitState('failure');
  assert.match(h.get('diagnostics').textContent, /poll.*PDF_PARSE_FAILED/);
  assert.equal(h.calls.length, 1);
  await h.advance(300000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test('parent-source checks, teardown, metadata validation and safe error codes stop unintended processing', async () => {
  const bytes = makePdf(['Teardown']);
  const h = harness();
  await h.initialize();
  await h.receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: opening(bytes) }, {});
  assert.equal(h.sent.filter(item => item.method === 'tools/call').length, 0);
  await h.result(opening(bytes));
  await h.receive({ jsonrpc: '2.0', id: 919, method: 'ui/resource-teardown', params: {} });
  assert.equal(h.get('status').dataset.state, 'closed');
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent.at(-1))), { jsonrpc: '2.0', id: 919, result: {} });
  assert.equal(h.timers.size, 0);
  const invalid = harness();
  await invalid.initialize();
  const data = opening(bytes); (data._meta as any).webcodexDocument.ticket = 'bad';
  await invalid.result(data);
  assert.equal(invalid.get('status').dataset.state, 'failure');
  assert.match(invalid.get('diagnostics').textContent, /INVALID_METADATA/);
  const failed = harness({ rpc: () => ({ isError: true, structuredContent: { ok: false, error: { code: 'WORKSPACE_DISABLED', message: 'SECRET HOST CONTENT' } } }) });
  await failed.initialize(); await failed.result(opening(bytes)); await failed.waitState('failure');
  assert.match(failed.get('diagnostics').textContent, /WORKSPACE_DISABLED/);
  assert.doesNotMatch(failed.text(), /SECRET HOST CONTENT/);
});
