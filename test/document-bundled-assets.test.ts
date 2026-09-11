import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { DOCUMENT_ASSET_INVENTORY } from '../src/document-assets.js';
import { inspectDocumentWidgetAsset, renderDocumentWidget } from '../src/document-widget.js';
import { VERSION } from '../src/version.js';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const assets = DOCUMENT_ASSET_INVENTORY.filter(asset => asset.kind !== 'wasmUrl');
const directories = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Execute the published browser bundle, with no host tool channel or network access. */
function reader(transform?: (script: string) => string) {
  let decoded = 0, forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('Bundled asset access must be local.'); };
  class DOMMatrix { a = 1; b = 0; c = 0; d = 1; e = 0; f = 0; }
  const context = vm.createContext({
    window: {}, document: { baseURI: 'https://synthetic.invalid/', getElementById: () => null, createElement: forbidden },
    navigator: { userAgent: 'SyntheticBrowser', platform: 'Win32', language: 'en-US' },
    DOMMatrix, Blob, File, crypto: webcrypto, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Uint8ClampedArray,
    ArrayBuffer, DataView, TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers, DOMException,
    ReadableStream, WritableStream, TransformStream, AbortController, AbortSignal, EventTarget, structuredClone, queueMicrotask,
    performance, atob(value: string) { decoded++; return atob(value); }, btoa, Date,
    fetch: forbidden, XMLHttpRequest: forbidden, Worker: forbidden,
    console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout: forbidden, clearTimeout() {},
  }, { codeGeneration: { strings: false, wasm: false } });
  const script = renderDocumentWidget().match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInContext(transform ? transform(script) : script, context, { timeout: 10000 });
  const api = context.WebCodexDocument as { getBundledDocumentAsset: (kind: unknown, filename: unknown) => Promise<Uint8Array> };
  assert.equal(typeof api.getBundledDocumentAsset, 'function');
  return { get: api.getBundledDocumentAsset, decoded: () => decoded,
    assertOffline() { assert.equal(forbiddenCalls, 0); } };
}

test('the published bundle contains exactly the pinned 182 fonts and CMaps with no eager decoding or asset transport', async () => {
  const h = reader();
  assert.equal(h.decoded(), 0);
  assert.equal(assets.length, 182);
  assert.equal(assets.filter(asset => asset.kind === 'cMapUrl').length, 168);
  assert.equal(assets.filter(asset => asset.kind === 'standardFontDataUrl').length, 14);
  for (const asset of assets) {
    const actual = await h.get(asset.kind, asset.filename);
    const expected = await readFile(path.join(packageRoot, directories[asset.kind], asset.filename));
    assert.equal(actual.length, asset.size_bytes);
    assert.equal(digest(actual), asset.sha256);
    assert.deepEqual(Buffer.from(actual), expected);
  }
  assert.equal(h.decoded(), 182);
  h.assertOffline();
});

test('bundled lookup rejects paths, unknown spellings, unsupported kinds and all WASM without decoding or fallback', async () => {
  const h = reader();
  for (const [kind, filename, detail] of [
    ...['wasmUrl', '__proto__', 'unknown', '', null, {}].map(kind => [kind, 'qcms_bg.wasm', 'ASSET_KIND_UNSUPPORTED']),
    ...['../78-H.bcmap', '..\\78-H.bcmap', '/78-H.bcmap', 'C:\\private\\78-H.bcmap', 'https://example.test/78-H.bcmap',
      '78-H.bcmap?x=1', '78-H.bcmap#x', '78-H.bcmap:secret', '78-H.BCMAP', '78-h.bcmap', '78-H.bcmap ',
      '78-H.bcmap\n', '%2e%2e%2f78-H.bcmap', 'missing.bcmap', 'constructor', '__proto__',
      'pdf.mjs', 'qcms_bg.wasm', null, 1, {}].map(filename => ['cMapUrl', filename, 'ASSET_NAME_UNSUPPORTED']),
    ['cMapUrl', 'LiberationSans-Regular.ttf', 'ASSET_NAME_UNSUPPORTED'],
    ['standardFontDataUrl', '78-H.bcmap', 'ASSET_NAME_UNSUPPORTED'],
  ]) {
    await assert.rejects(h.get(kind, filename), (error: any) => {
      assert.equal(error.code, 'ASSET_UNAVAILABLE');
      assert.equal(error.message, 'ASSET_UNAVAILABLE');
      assert.equal(error.detail_code, detail);
      assert.deepEqual(Object.keys(error).sort(), ['code', 'detail_code']);
      return true;
    });
  }
  assert.equal(h.decoded(), 0);
  h.assertOffline();
});

test('concurrent reads share a verified decode while callers can only mutate their own byte copies', async () => {
  const h = reader(), asset = assets.find(asset => asset.kind === 'standardFontDataUrl')!;
  const first = h.get(asset.kind, asset.filename), second = h.get(asset.kind, asset.filename);
  const a = await first, b = await second;
  assert.equal(h.decoded(), 1);
  assert.notEqual(a, b); assert.notEqual(a.buffer, b.buffer);
  a.fill(0);
  assert.equal(digest(b), asset.sha256);
  b.fill(1);
  const c = await h.get(asset.kind, asset.filename);
  assert.equal(digest(c), asset.sha256);
  assert.equal(h.decoded(), 1);
  h.assertOffline();
});

test('a same-size canonical payload with a mismatching pinned hash is rejected and never cached', async () => {
  const asset = assets.find(asset => asset.kind === 'standardFontDataUrl')!;
  const original = await readFile(path.join(packageRoot, directories[asset.kind], asset.filename));
  const altered = Buffer.from(original); altered[0] ^= 1;
  const encoded = original.toString('base64'), corrupted = altered.toString('base64');
  assert.equal(encoded.length, corrupted.length);
  assert.notEqual(digest(altered), asset.sha256);
  const h = reader(script => {
    assert.equal(script.split(encoded).length, 2, 'Change one bundled payload while preserving its pinned metadata.');
    return script.replace(encoded, corrupted);
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await assert.rejects(h.get(asset.kind, asset.filename), (error: any) => {
      assert.equal(error.code, 'FILE_INTEGRITY_ERROR');
      assert.equal(error.message, 'FILE_INTEGRITY_ERROR');
      assert.equal(error.detail_code, 'FILE_SHA256_MISMATCH');
      return true;
    });
    assert.equal(h.decoded(), attempt, 'Rejected content must be decoded and checked again instead of entering the cache.');
  }
  h.assertOffline();
});

test('decoded package cache evicts by both entry count and byte budget then verifies evicted data again', async () => {
  const byCount = reader(), selected = assets.filter(asset => asset.kind === 'cMapUrl').slice(0, 33);
  for (const asset of selected) await byCount.get(asset.kind, asset.filename);
  assert.equal(byCount.decoded(), 33);
  assert.equal(digest(await byCount.get(selected[0].kind, selected[0].filename)), selected[0].sha256);
  assert.equal(byCount.decoded(), 34);
  byCount.assertOffline();

  const byBytes = reader();
  const large = [...assets.filter(asset => asset.kind === 'standardFontDataUrl'),
    ...assets.filter(asset => asset.kind === 'cMapUrl').sort((a, b) => b.size_bytes - a.size_bytes).slice(0, 12)];
  assert.ok(large.length < 32);
  assert.ok(large.reduce((sum, asset) => sum + asset.size_bytes, 0) > 1024 * 1024);
  for (const asset of large) await byBytes.get(asset.kind, asset.filename);
  assert.equal(byBytes.decoded(), large.length);
  assert.equal(digest(await byBytes.get(large[0].kind, large[0].filename)), large[0].sha256);
  assert.equal(byBytes.decoded(), large.length + 1);
  byBytes.assertOffline();
});

test('generated binary payload stays out of source and the versioned browser artifact remains within its build budget', async () => {
  const helper = await readFile(path.resolve('src/browser/document-bundled-assets.mjs'), 'utf8');
  const builder = await readFile(path.resolve('scripts/build-document-widget.mjs'), 'utf8');
  assert.ok(Buffer.byteLength(helper) < 16384);
  assert.match(helper, /from 'webcodex:document-assets'/);
  assert.doesNotMatch(helper, /\bfetch\s*\(|callTool\s*\(|DecompressionStream|new Worker/);
  const sample = assets.find(asset => asset.kind === 'standardFontDataUrl')!;
  const encoded = (await readFile(path.join(packageRoot, directories[sample.kind], sample.filename))).toString('base64');
  assert.equal(helper.includes(encoded.slice(0, 128)), false);
  assert.equal(builder.includes(encoded.slice(0, 128)), false);
  assert.match(builder, /write:\s*false/);
  assert.match(builder, /document-widget-\$\{VERSION\}\.js/);
  const output = await stat(new URL(`../src/assets/${inspectDocumentWidgetAsset().file}`, import.meta.url));
  assert.ok(output.size > 2586948, 'The uncompressed, fixed binary assets must actually be present.');
  assert.ok(output.size <= 5 * 1024 * 1024);
});
