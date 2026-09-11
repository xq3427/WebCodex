import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Blob, File } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { renderDocumentWidget } from '../src/document-widget.js';

type Json = Record<string, any>;
const DEVICE = '11111111-1111-4111-8111-111111111111';
const DOCUMENT = '22222222-2222-4222-8222-222222222222';
const INSTANCE = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';
const source = { device_id: DEVICE, device_name: 'Synthetic envelope device', instance_id: INSTANCE };
const bytes = Buffer.from('synthetic private original bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const baseArgs = { expected_device_id: DEVICE, document_id: DOCUMENT, ticket: 'A'.repeat(43) };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function browserNormalizer() {
  const html = renderDocumentWidget();
  class DOMMatrix { a = 1; b = 0; c = 0; d = 1; e = 0; f = 0; }
  function forbidden() { throw new Error('The result normalizer must not use browser network, workers or rendering.'); }
  const context = vm.createContext({
    window: {}, document: { baseURI: 'https://synthetic.invalid/', getElementById: () => null, createElement: forbidden },
    navigator: { userAgent: 'SyntheticBrowser', platform: 'Win32', language: 'en-US' },
    DOMMatrix, Blob, File, crypto: webcrypto, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Uint8ClampedArray,
    ArrayBuffer, DataView, TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers, DOMException,
    ReadableStream, WritableStream, TransformStream, AbortController, AbortSignal, EventTarget, structuredClone, queueMicrotask,
    performance, atob, btoa, Date, fetch: forbidden, XMLHttpRequest: forbidden, Worker: forbidden,
    console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout,
  }, { codeGeneration: { strings: false, wasm: false } });
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInContext(script, context, { timeout: 10000 });
  const normalize = context.WebCodexDocument?.normalizeDocumentToolResult;
  assert.equal(typeof normalize, 'function', 'The production bundle must export its actual result-normalization helper.');
  return normalize as (raw: unknown, request: { name: string; args: Json }) => Json;
}

function chunk() {
  return { structuredContent: { ok: true, source: { ...source }, data: {
    document_id: DOCUMENT, offset: 0, size_bytes: bytes.length, total_bytes: bytes.length,
    next_offset: null, eof: true, sha256: hash, chunk_sha256: hash,
  } }, _meta: { base64: bytes.toString('base64') } };
}
const chunkRequest = { name: 'document_widget_chunk', args: { ...baseArgs, offset: 0 } };
function asset() {
  const result: Json = chunk();
  delete result.structuredContent.data.document_id;
  result.structuredContent.data.kind = 'cMapUrl';
  result.structuredContent.data.filename = '78-H.bcmap';
  return result;
}
const assetRequest = { name: 'document_widget_asset', args: { ...baseArgs, kind: 'cMapUrl', filename: '78-H.bcmap', offset: 0 } };

test('complete private bytes survive standard, raw and nested host response wrappers', () => {
  const normalize = browserNormalizer();
  const wrappers: Array<(value: Json) => unknown> = [
    value => value,
    value => ({ ...value.structuredContent, _meta: value._meta }),
    value => ({ mcp_tool_result: value }),
    value => ({ call_tool_result: value }),
    value => ({ call_tool_result: { mcp_tool_result: value } }),
    value => ({ structuredContent: value.structuredContent, mcp_tool_result: value }),
    value => ({ structuredContent: value.structuredContent, call_tool_result: value }),
    value => ({ mcp_tool_result: { structuredContent: value.structuredContent }, call_tool_result: value }),
    value => ({ call_tool_result: { structuredContent: value.structuredContent }, mcp_tool_result: value }),
    value => ({ mcp_tool_result: { ...value.structuredContent, _meta: value._meta }, call_tool_result: { structuredContent: value.structuredContent } }),
  ];
  for (const [make, request] of [[chunk, chunkRequest], [asset, assetRequest]] as const) {
    for (let index = 0; index < wrappers.length; index++) {
      const value = make(), expected = plain(value);
      const result = normalize(wrappers[index](value), request);
      assert.deepEqual(plain(result.structuredContent), expected.structuredContent, 'wrapper ' + index);
      assert.equal(result._meta.base64, expected._meta.base64, 'wrapper ' + index);
      assert.deepEqual(plain(value), expected, 'Normalization must not mutate a candidate.');
    }
  }
});

test('an incomplete outer summary cannot hide the nested original bytes needed for full integrity verification', () => {
  const normalize = browserNormalizer(), value = chunk();
  const wrapped = { structuredContent: value.structuredContent, mcp_tool_result: value };
  const normalized = normalize(wrapped, chunkRequest);
  assert.equal(normalized._meta?.base64, bytes.toString('base64'));
  assert.equal(createHash('sha256').update(Buffer.from(normalized._meta.base64, 'base64')).digest('hex'), normalized.structuredContent.data.sha256);
  assert.equal((wrapped as Json)._meta, undefined, 'Do not repair the input by borrowing or grafting metadata.');
});

test('anonymous private metadata and model-visible JSON text are never borrowed into a different public envelope', () => {
  const normalize = browserNormalizer(), value = chunk();
  for (const result of [
    { mcp_tool_result: { structuredContent: value.structuredContent }, call_tool_result: { _meta: value._meta } },
    { _meta: value._meta, mcp_tool_result: { structuredContent: value.structuredContent } },
    { structuredContent: value.structuredContent, call_tool_result: { _meta: value._meta } },
    { content: [{ type: 'text', text: JSON.stringify(value) }] },
    { structuredContent: value.structuredContent, _meta: { base64: 123 } },
  ]) assert.throws(() => normalize(result, chunkRequest), { code: 'INVALID_RESPONSE' });
});

test('conflicting source, document identity, byte range, hash and private bytes reject the entire wrapper graph', () => {
  const normalize = browserNormalizer();
  const conflicts: Array<(value: Json) => void> = [
    value => { value.structuredContent.source.device_id = 'another-device'; },
    value => { value.structuredContent.source.device_name = 'another-name'; },
    value => { value.structuredContent.source.instance_id = 'another-instance'; },
    value => { value.structuredContent.data.document_id = 'another-document'; },
    value => { value.structuredContent.data.offset = 1; },
    value => { value.structuredContent.data.size_bytes++; },
    value => { value.structuredContent.data.total_bytes++; },
    value => { value.structuredContent.data.next_offset = 7; },
    value => { value.structuredContent.data.eof = false; },
    value => { value.structuredContent.data.sha256 = '0'.repeat(64); },
    value => { value.structuredContent.data.chunk_sha256 = '0'.repeat(64); },
    value => { value._meta.base64 = Buffer.from('different bytes').toString('base64'); },
  ];
  for (const conflict of conflicts) {
    const valid = chunk(), other = chunk(); conflict(other);
    for (const result of [
      { mcp_tool_result: valid, call_tool_result: other },
      { mcp_tool_result: other, call_tool_result: valid },
      { structuredContent: other.structuredContent, mcp_tool_result: valid, call_tool_result: other },
    ]) assert.throws(() => normalize(result, chunkRequest), { code: 'INVALID_RESPONSE' });
  }
});

test('selected binary envelope must match the current requested device, document or asset, and offset', () => {
  const normalize = browserNormalizer();
  for (const args of [
    { ...chunkRequest.args, expected_device_id: 'wrong-device' },
    { ...chunkRequest.args, document_id: 'wrong-document' },
    { ...chunkRequest.args, offset: 2 },
  ]) assert.throws(() => normalize(chunk(), { name: chunkRequest.name, args }), { code: 'INVALID_RESPONSE' });
  for (const args of [
    { ...assetRequest.args, expected_device_id: 'wrong-device' },
    { ...assetRequest.args, kind: 'wasmUrl' },
    { ...assetRequest.args, filename: 'another.bcmap' },
    { ...assetRequest.args, offset: 2 },
  ]) assert.throws(() => normalize(asset(), { name: assetRequest.name, args }), { code: 'INVALID_RESPONSE' });
  const anonymous: Json = chunk(); delete anonymous.structuredContent.source.device_id;
  assert.throws(() => normalize(anonymous, chunkRequest), { code: 'INVALID_RESPONSE' });
  for (const [field, different] of [['kind', 'wasmUrl'], ['filename', 'other.bcmap']] as const) {
    const other = asset(); other.structuredContent.data[field] = different;
    assert.throws(() => normalize({ mcp_tool_result: asset(), call_tool_result: other }, assetRequest), { code: 'INVALID_RESPONSE' });
  }
});

test('nested tool errors cannot be hidden behind success and raw error messages are not propagated', () => {
  const normalize = browserNormalizer(), secret = 'synthetic-host-secret-and-private-path';
  const failed = { isError: true, structuredContent: { ok: false, error: { code: 'DOCUMENT_ACCESS_DENIED', message: secret } } };
  for (const result of [
    { mcp_tool_result: chunk(), call_tool_result: failed },
    { structuredContent: chunk().structuredContent, mcp_tool_result: chunk(), call_tool_result: { call_tool_result: failed } },
  ]) assert.throws(() => normalize(result, chunkRequest), (error: any) => {
    assert.equal(error.code, 'DOCUMENT_ACCESS_DENIED');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.throws(() => normalize({ ...chunk(), isError: true }, chunkRequest));
});

test('both wrapper branches are fully bounded, while shared candidates and cycles do not duplicate traversal', () => {
  const normalize = browserNormalizer(), value = chunk();
  let allowed: unknown = value;
  for (let depth = 0; depth < 4; depth++) allowed = { mcp_tool_result: allowed };
  assert.equal(normalize(allowed, chunkRequest)._meta.base64, value._meta.base64);
  assert.throws(() => normalize({ mcp_tool_result: allowed }, chunkRequest), { code: 'INVALID_RESPONSE' });
  const tree = (depth: number): Json => depth === 0 ? {} : { mcp_tool_result: tree(depth - 1), call_tool_result: tree(depth - 1) };
  assert.throws(() => normalize({ mcp_tool_result: value, call_tool_result: tree(3) }, chunkRequest), { code: 'INVALID_RESPONSE' });
  const cyclic: Json = { mcp_tool_result: value };
  cyclic.call_tool_result = { mcp_tool_result: cyclic, call_tool_result: value };
  assert.equal(normalize(cyclic, chunkRequest)._meta.base64, value._meta.base64);
});

test('public poll and submit responses unwrap consistently and contradictory generic results fail closed', () => {
  const normalize = browserNormalizer();
  for (const [name, body] of [
    ['document_widget_poll', { status: 'pending', request: { request_id: REQUEST, start_page: 1, page_count: 3 } }],
    ['document_widget_submit', { accepted: true, duplicate: false }],
  ] as const) {
    const value = { structuredContent: { ok: true, source: { ...source }, data: body } };
    assert.deepEqual(plain(normalize({ call_tool_result: { mcp_tool_result: value } }, { name, args: baseArgs }).structuredContent), plain(value.structuredContent));
    const other: Json = structuredClone(value);
    if (name === 'document_widget_poll') other.structuredContent.data.request.request_id = 'another-request';
    else other.structuredContent.data.accepted = false;
    assert.throws(() => normalize({ mcp_tool_result: value, call_tool_result: other }, { name, args: baseArgs }), { code: 'INVALID_RESPONSE' });
  }
});

test('EOF null omission in only one wrapper is equivalent without merging metadata or changing the selected envelope', () => {
  const normalize = browserNormalizer();
  for (const [make, request] of [[chunk, chunkRequest], [asset, assetRequest]] as const) {
    for (const outerMissing of [false, true]) {
      const outer: Json = make(), inner: Json = make();
      delete (outerMissing ? outer : inner).structuredContent.data.next_offset;
      const before = plain(inner);
      const result = normalize({ structuredContent: outer.structuredContent, mcp_tool_result: inner }, request);
      assert.deepEqual(plain(result), before);
      assert.equal(result._meta.base64, inner._meta.base64);
      assert.deepEqual(plain(inner), before);
      assert.equal(Object.hasOwn(result.structuredContent.data, 'next_offset'), outerMissing);
    }
  }
});

test('EOF-only null equivalence never hides an explicit offset or another identity, range or byte conflict', () => {
  const normalize = browserNormalizer();
  for (const [make, request] of [[chunk, chunkRequest], [asset, assetRequest]] as const) {
    const nonEof: Json = make();
    nonEof.structuredContent.data.total_bytes++;
    nonEof.structuredContent.data.eof = false;
    nonEof.structuredContent.data.next_offset = bytes.length;
    const omitted = plain(nonEof);
    delete omitted.structuredContent.data.next_offset;
    for (const result of [{ mcp_tool_result: nonEof, call_tool_result: omitted }, { mcp_tool_result: omitted, call_tool_result: nonEof }]) {
      assert.throws(() => normalize(result, request), { code: 'INVALID_RESPONSE' });
    }
    for (const explicit of [0, bytes.length, false, '0']) {
      const changed: Json = make(); changed.structuredContent.data.next_offset = explicit;
      assert.throws(() => normalize({ mcp_tool_result: make(), call_tool_result: changed }, request), { code: 'INVALID_RESPONSE' });
    }
    const noNext: Json = make(); delete noNext.structuredContent.data.next_offset;
    for (const change of [
      (value: Json) => { value.structuredContent.data.size_bytes--; },
      (value: Json) => { value.structuredContent.data.sha256 = '0'.repeat(64); },
      (value: Json) => { value._meta.base64 = 'AAAA'; },
    ]) {
      const changed = make(); change(changed);
      assert.throws(() => normalize({ mcp_tool_result: noNext, call_tool_result: changed }, request), { code: 'INVALID_RESPONSE' });
    }
  }
});
