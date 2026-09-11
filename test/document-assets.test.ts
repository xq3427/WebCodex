import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DocumentAssetReader, readDocumentAsset, DOCUMENT_ASSET_INVENTORY, DOCUMENT_ASSET_VERSION,
  DOCUMENT_ASSET_CHUNK_BYTES, DOCUMENT_ASSET_FILE_MAX_BYTES, DOCUMENT_ASSET_CACHE_MAX_BYTES,
  type DocumentAssetInput } from '../src/document-assets.js';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const directories = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

test('asset inventory pins exact names, sizes and hashes from all supported binary directories', async () => {
  assert.equal(DOCUMENT_ASSET_VERSION, '6.3.289');
  assert.equal(JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version, DOCUMENT_ASSET_VERSION);
  assert.equal(DOCUMENT_ASSET_CHUNK_BYTES, 256 * 1024);
  assert.equal(DOCUMENT_ASSET_FILE_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(DOCUMENT_ASSET_CACHE_MAX_BYTES, 8 * 1024 * 1024);
  assert.ok(Object.isFrozen(DOCUMENT_ASSET_INVENTORY));
  const counts = { cMapUrl: 0, standardFontDataUrl: 0, wasmUrl: 0 };
  const names = new Set<string>();
  for (const asset of DOCUMENT_ASSET_INVENTORY) {
    assert.ok(Object.isFrozen(asset));
    const key = asset.kind + ':' + asset.filename;
    assert.equal(names.has(key), false); names.add(key);
    counts[asset.kind]++;
    const bytes = await readFile(path.join(packageRoot, directories[asset.kind], asset.filename));
    assert.equal(bytes.length, asset.size_bytes);
    assert.equal(digest(bytes), asset.sha256);
    assert.ok(bytes.length <= DOCUMENT_ASSET_FILE_MAX_BYTES);
  }
  assert.deepEqual(counts, { cMapUrl: 168, standardFontDataUrl: 14, wasmUrl: 4 });
});

test('asset chunks reconstruct exact original bytes and expose only bounded private Base64 plus integrity metadata', async () => {
  for (const input of [
    { kind: 'cMapUrl', filename: 'Adobe-Japan1-UCS2.bcmap' },
    { kind: 'standardFontDataUrl', filename: 'LiberationSans-Regular.ttf' },
    { kind: 'wasmUrl', filename: 'quickjs-eval.wasm' },
  ] as const) {
    const expected = await readFile(path.join(packageRoot, directories[input.kind], input.filename));
    const chunks: Buffer[] = [];
    let offset = 0;
    do {
      const result = await readDocumentAsset({ ...input, offset });
      const bytes = Buffer.from(result.meta.base64, 'base64');
      assert.deepEqual(Object.keys(result).sort(), ['data', 'meta']);
      assert.deepEqual(Object.keys(result.meta), ['base64']);
      assert.equal(JSON.stringify(result.data).includes('base64'), false);
      assert.deepEqual(result.data, {
        ...input, offset, size_bytes: bytes.length, total_bytes: expected.length,
        next_offset: offset + bytes.length === expected.length ? null : offset + bytes.length,
        eof: offset + bytes.length === expected.length, sha256: digest(expected), chunk_sha256: digest(bytes),
      });
      assert.ok(bytes.length <= DOCUMENT_ASSET_CHUNK_BYTES);
      chunks.push(bytes);
      if (result.data.eof) break;
      offset = result.data.next_offset!;
    } while (true);
    assert.deepEqual(Buffer.concat(chunks), expected);
    const eof = await readDocumentAsset({ ...input, offset: expected.length });
    assert.equal(eof.meta.base64, '');
    assert.equal(eof.data.eof, true);
    assert.equal(eof.data.next_offset, null);
    assert.equal(eof.data.chunk_sha256, digest(Buffer.alloc(0)));
  }
});

test('invalid kinds, filename spellings, paths, URLs and offsets are rejected before package reads', async () => {
  const valid = { kind: 'cMapUrl', filename: '78-H.bcmap', offset: 0 } as const;
  const invalid: unknown[] = [null, [], {}, { ...valid, kind: '__proto__' }, { ...valid, kind: {} },
    ...['../78-H.bcmap', '..\\78-H.bcmap', '/78-H.bcmap', 'C:\\78-H.bcmap', '//host/78-H.bcmap',
      'https://example.test/78-H.bcmap', '78-H.bcmap?x=1', '78-H.bcmap#x', '78-H.bcmap:secret', '78-H.bcmap ',
      '78-H.BCMAP', '78-h.bcmap', '%2e%2e%2f78-H.bcmap', '78-H.bcmap\u0000', 'missing.bcmap',
      'LICENSE', 'openjpeg_nowasm_fallback.js', 'pdf.mjs'].map(filename => ({ ...valid, filename })),
    { ...valid, kind: 'wasmUrl' },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '0', undefined].map(offset => ({ ...valid, offset })),
  ];
  for (const input of invalid) {
    await assert.rejects(readDocumentAsset(input as DocumentAssetInput), { code: 'DOCUMENT_ASSET_INVALID' });
  }
});

test('queued request and returned objects cannot mutate validated assets or cached content', async () => {
  const reader = new DocumentAssetReader();
  const input: DocumentAssetInput = { kind: 'wasmUrl', filename: 'quickjs-eval.wasm', offset: 7 };
  const task = reader.read(input);
  input.kind = 'cMapUrl'; input.filename = '../private.json'; input.offset = 900000;
  const first = await task;
  const original = await readFile(path.join(packageRoot, 'wasm', 'quickjs-eval.wasm'));
  assert.equal(first.data.offset, 7);
  assert.deepEqual(Buffer.from(first.meta.base64, 'base64'), original.subarray(7, 7 + DOCUMENT_ASSET_CHUNK_BYTES));
  first.data.filename = '../changed'; first.meta.base64 = 'changed';
  const second = await reader.read({ kind: 'wasmUrl', filename: 'quickjs-eval.wasm', offset: 7 });
  assert.equal(second.data.filename, 'quickjs-eval.wasm');
  assert.deepEqual(Buffer.from(second.meta.base64, 'base64'), original.subarray(7, 7 + DOCUMENT_ASSET_CHUNK_BYTES));
});

test('file and aggregate cache budgets are enforced across parallel misses and LRU eviction', async () => {
  for (const options of [{ maxFileBytes: 1 }, { maxCacheBytes: 1 }]) {
    const reader = new DocumentAssetReader(options);
    await assert.rejects(reader.read({ kind: 'cMapUrl', filename: '78-H.bcmap', offset: 0 }), { code: 'DOCUMENT_ASSET_LIMIT' });
    assert.equal(reader.cacheUsage().size_bytes, 0);
  }
  for (const options of [{ maxFileBytes: 0 }, { maxFileBytes: DOCUMENT_ASSET_FILE_MAX_BYTES + 1 },
    { maxCacheBytes: -1 }, { maxCacheBytes: DOCUMENT_ASSET_CACHE_MAX_BYTES + 1 }]) {
    assert.throws(() => new DocumentAssetReader(options), { code: 'DOCUMENT_ASSET_LIMIT' });
  }
  const reader = new DocumentAssetReader({ maxCacheBytes: 20000 });
  const inputs = ['FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedItalic.pfb', 'FoxitFixed.pfb']
    .map(filename => ({ kind: 'standardFontDataUrl' as const, filename, offset: 0 }));
  const results = await Promise.all(inputs.map(input => reader.read(input)));
  for (let index = 0; index < inputs.length; index++) {
    assert.equal(results[index].data.filename, inputs[index].filename);
    assert.equal(results[index].data.sha256, digest(Buffer.from(results[index].meta.base64, 'base64')));
  }
  assert.deepEqual(reader.cacheUsage(), { entries: 1, size_bytes: 17597, max_bytes: 20000 });
  await assert.rejects(reader.read({ kind: 'wasmUrl', filename: 'quickjs-eval.wasm', offset: 0 }), { code: 'DOCUMENT_ASSET_LIMIT' });
  assert.equal(reader.cacheUsage().entries, 1, 'A rejected oversized asset must not evict valid cache entries.');
});

async function isolatedPackage(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-pdf-assets-'));
  t.after(async () => {
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-pdf-assets-'));
    await rm(actual, { recursive: true, force: true });
  });
  await writeFile(path.join(base, 'package.json'), '{"type":"module"}');
  await copyFile(new URL('../src/document-assets.js', import.meta.url), path.join(base, 'document-assets.js'));
  await copyFile(new URL('../src/errors.js', import.meta.url), path.join(base, 'errors.js'));
  await copyFile(new URL('../src/file-routing.js', import.meta.url), path.join(base, 'file-routing.js'));
  const module: typeof import('../src/document-assets.js') = await import(pathToFileURL(path.join(base, 'document-assets.js')).href);
  const fakeRoot = path.join(base, 'node_modules', 'pdfjs-dist');
  await mkdir(path.join(fakeRoot, 'cmaps'), { recursive: true });
  await writeFile(path.join(fakeRoot, 'package.json'), '{"name":"pdfjs-dist","version":"6.3.289"}');
  return { base, fakeRoot, module };
}

test('package resolution is portable and corrupted or missing assets never expose raw filesystem details', async t => {
  const f = await isolatedPackage(t);
  const input = { kind: 'cMapUrl', filename: '78-H.bcmap', offset: 0 } as const;
  const filename = path.join(f.fakeRoot, 'cmaps', input.filename);
  const expected = await readFile(path.join(packageRoot, 'cmaps', input.filename));
  const safeFailure = async () => {
    await assert.rejects(new f.module.DocumentAssetReader().read(input), (error: any) => {
      assert.equal(error.code, 'DOCUMENT_ASSET_UNAVAILABLE');
      assert.equal(error.details, undefined);
      assert.equal(error.message.includes(f.base), false);
      assert.equal(error.message.includes(filename), false);
      assert.equal(error.message.includes('synthetic-secret'), false);
      return true;
    });
  };
  await safeFailure();
  await writeFile(filename, Buffer.alloc(expected.length, 13));
  await safeFailure();
  await writeFile(filename, 'synthetic-secret');
  await safeFailure();
  await writeFile(filename, Buffer.alloc(DOCUMENT_ASSET_FILE_MAX_BYTES + 1));
  await safeFailure();
  await writeFile(filename, expected);
  const reader = new f.module.DocumentAssetReader();
  const result = await reader.read(input);
  assert.deepEqual(Buffer.from(result.meta.base64, 'base64'), expected);
  await writeFile(filename, Buffer.alloc(expected.length, 0));
  assert.deepEqual(Buffer.from((await reader.read(input)).meta.base64, 'base64'), expected, 'Verified cached bytes remain an immutable package snapshot.');
  await safeFailure();
});
