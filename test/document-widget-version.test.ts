import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const publisherPath = path.resolve('scripts/document-widget-artifacts.mjs');
const { publishDocumentWidget } = await import(pathToFileURL(publisherPath).href);

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-document-version-'));
  t.after(async () => {
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-document-version-'));
    await rm(actual, { recursive: true, force: true });
  });
  const assets = path.join(base, 'assets');
  await mkdir(assets);
  await writeFile(path.join(base, 'package.json'), '{"type":"module"}');
  await copyFile(new URL('../src/document-widget.js', import.meta.url), path.join(base, 'document-widget.js'));
  await copyFile(new URL('../src/errors.js', import.meta.url), path.join(base, 'errors.js'));
  await copyFile(new URL('../src/file-routing.js', import.meta.url), path.join(base, 'file-routing.js'));
  await writeFile(path.join(base, 'version.js'), "export const VERSION = '1.2.3';\n");
  const module = await import(pathToFileURL(path.join(base, 'document-widget.js')).href);
  const publish = (text: string, version = '1.2.3') => publishDocumentWidget(assets, version, Buffer.from(text));
  return { base, assets, module, publish, manifest: path.join(assets, 'document-widget-1.2.3.json') };
}

test('a running resource module keeps its release when another version is built and preserves legacy bundles', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.assets, 'document-widget.js'), '/* original-generic */');
  await writeFile(path.join(f.assets, 'document-widget-1.2.3.js'), '/* original-versioned */');
  await f.publish('/* synthetic-owned-bundle */');
  const first = f.module.renderDocumentWidget();
  assert.match(first, /synthetic-owned-bundle/);
  assert.equal(f.module.DOCUMENT_WIDGET_URI, 'ui://webcodex/document-1.2.3.html');
  await f.publish('/* synthetic-next-bundle */', '1.2.4');
  await writeFile(path.join(f.base, 'version.js'), "export const VERSION = '1.2.4';\n");
  assert.equal(f.module.renderDocumentWidget(), first);
  assert.equal(await readFile(path.join(f.assets, 'document-widget.js'), 'utf8'), '/* original-generic */');
  assert.equal(await readFile(path.join(f.assets, 'document-widget-1.2.3.js'), 'utf8'), '/* original-versioned */');
});

test('same-version publication switches one manifest to complete new bytes and retains the prior immutable asset', async t => {
  const f = await fixture(t);
  const before = await f.publish('/* synthetic-before */');
  assert.equal(f.module.inspectDocumentWidgetAsset().sha256, before.sha256);
  const after = await f.publish('/* synthetic-after */');
  assert.notEqual(before.file, after.file);
  assert.deepEqual(f.module.inspectDocumentWidgetAsset(), { version: '1.2.3', sha256: after.sha256, size_bytes: after.size_bytes, file: after.file, manifest: after.manifest });
  assert.match(f.module.renderDocumentWidget(), /synthetic-after/);
  assert.equal(await readFile(path.join(f.assets, before.file), 'utf8'), '/* synthetic-before */');
  assert.equal(await readFile(path.join(f.assets, after.file), 'utf8'), '/* synthetic-after */');
});

test('concurrent same-version publishers expose only complete committed assets to readers', async t => {
  const f = await fixture(t);
  await f.publish('/* complete-initial */');
  let done = false, observations = 0;
  const complete = Array.from({ length: 6 }, (_, n) => '/* complete-' + n + ' */' + ' '.repeat(10_000));
  const candidates = new Set(['/* complete-initial */', ...complete]);
  const updates = Promise.all(complete.map(bytes => f.publish(bytes)))
    .then(() => undefined, error => error).finally(() => { done = true; });
  try {
    while (!done) {
      const html = f.module.renderDocumentWidget();
      assert.ok(candidates.has(html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''), 'Every observed bundle must equal one complete published input.');
      observations++;
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { await updates; }
  const error = await updates; if (error) throw error;
  assert.ok(observations > 0);
  assert.match(f.module.renderDocumentWidget(), /complete-[0-5]/);
});

// Simulate the metadata produced by POSIX atomic replacement, including on
// Windows where open-file replacement/link-count behavior is different.
function unlinkedManifestSnapshot(t: TestContext, timing: 'before-read' | 'during-read' | 'modified' | 'hard-linked') {
  const open = fs.openSync, stat = fs.fstatSync;
  const manifestDescriptors = new Set<number>();
  let samples = 0;
  const opened = t.mock.method(fs, 'openSync', ((file: fs.PathLike, ...args: unknown[]) => {
    const descriptor = Reflect.apply(open, fs, [file, ...args]);
    if (String(file).endsWith('document-widget-1.2.3.json')) manifestDescriptors.add(descriptor);
    else manifestDescriptors.delete(descriptor); // Descriptors can be reused for the JS asset.
    return descriptor;
  }) as typeof fs.openSync);
  const stated = t.mock.method(fs, 'fstatSync', ((descriptor: number, ...args: unknown[]) => {
    const result = Reflect.apply(stat, fs, [descriptor, ...args]);
    if (!manifestDescriptors.has(descriptor)) return result;
    samples++;
    const unlinked = timing === 'before-read' || samples % 2 === 0;
    const nlink = timing === 'hard-linked' ? 2n : timing === 'modified' ? 1n : unlinked ? 0n : 1n;
    return Object.assign(Object.create(Object.getPrototypeOf(result)), result,
      { nlink, ctimeNs: result.ctimeNs + (unlinked ? 1n : 0n) });
  }) as typeof fs.fstatSync);
  syncBuiltinESMExports();
  t.after(() => { opened.mock.restore(); stated.mock.restore(); syncBuiltinESMExports(); });
  return () => samples;
}

for (const timing of ['before-read', 'during-read'] as const) test(`a complete opened manifest remains readable when atomic replacement unlinks it ${timing}`, async t => {
  const f = await fixture(t), committed = await f.publish('/* complete-opened-snapshot */');
  const samples = unlinkedManifestSnapshot(t, timing);
  assert.match(f.module.renderDocumentWidget(), /complete-opened-snapshot/);
  assert.equal(samples(), 2, 'An intact opened snapshot needs no retry or newer manifest.');
  assert.equal(f.module.inspectDocumentWidgetAsset().sha256, committed.sha256);
});

test('an unlinked manifest snapshot still rejects same-size corrupt committed JavaScript', async t => {
  const f = await fixture(t), committed = await f.publish('/* complete-opened-snapshot */');
  await writeFile(path.join(f.assets, committed.file), 'x'.repeat(committed.size_bytes));
  unlinkedManifestSnapshot(t, 'during-read');
  assert.throws(() => f.module.renderDocumentWidget(), { code: 'DOCUMENT_WIDGET_ASSET_INVALID' });
});

for (const timing of ['modified', 'hard-linked'] as const) test(`a ${timing} open manifest is not treated as an intact atomic replacement`, async t => {
  const f = await fixture(t); await f.publish('/* complete-opened-snapshot */');
  unlinkedManifestSnapshot(t, timing);
  assert.throws(() => f.module.renderDocumentWidget(), { code: 'DOCUMENT_WIDGET_ASSET_INVALID' });
});

test('reader rejects absent, malformed, mismatched or escaping manifests without a legacy fallback', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.assets, 'document-widget-1.2.3.js'), '/* legacy cannot mask incomplete new release */');
  assert.throws(() => f.module.renderDocumentWidget(), { code: 'DOCUMENT_WIDGET_ASSET_INVALID' });
  const committed = await f.publish('/* valid */');
  const original = JSON.parse(await readFile(f.manifest, 'utf8'));
  for (const value of ['{', 'null', JSON.stringify({ ...original, version: '1.2.4' }),
    JSON.stringify({ ...original, file: '../outside.js' }), JSON.stringify({ ...original, size_bytes: original.size_bytes + 1 }),
    JSON.stringify({ ...original, sha256: '0'.repeat(64) }), JSON.stringify({ ...original, unknown: true })]) {
    await writeFile(f.manifest, value);
    assert.throws(() => f.module.inspectDocumentWidgetAsset(), { code: 'DOCUMENT_WIDGET_ASSET_INVALID' });
    assert.throws(() => f.module.renderDocumentWidget(), { code: 'DOCUMENT_WIDGET_ASSET_INVALID' });
  }
  await writeFile(f.manifest, JSON.stringify(original));
  await unlink(path.join(f.assets, committed.file));
  assert.throws(() => f.module.renderDocumentWidget(), { code: 'DOCUMENT_WIDGET_ASSET_INVALID' });
});

test('truncated and same-size corrupt JavaScript is rejected before returning a browser resource', async t => {
  const f = await fixture(t), committed = await f.publish('/* complete */');
  const asset = path.join(f.assets, committed.file);
  await writeFile(asset, '(()=>{');
  assert.throws(() => f.module.renderDocumentWidget(), { code: 'DOCUMENT_WIDGET_ASSET_INVALID' });
  await writeFile(asset, 'x'.repeat(committed.size_bytes));
  assert.throws(() => f.module.renderDocumentWidget(), { code: 'DOCUMENT_WIDGET_ASSET_INVALID' });
});

test('failed publication preserves the prior commit and the HTML wrapper still counts toward its budget', async t => {
  const f = await fixture(t);
  await f.publish('/* complete */');
  const before = await readFile(f.manifest, 'utf8');
  await assert.rejects(f.publish('x'.repeat(f.module.DOCUMENT_WIDGET_MAX_BYTES + 1)));
  await assert.rejects(f.publish('x', '../unsafe'));
  assert.equal(await readFile(f.manifest, 'utf8'), before);
  assert.match(f.module.renderDocumentWidget(), /complete/);
  await f.publish(' '.repeat(f.module.DOCUMENT_WIDGET_MAX_BYTES));
  assert.throws(() => f.module.renderDocumentWidget(), /exceeds its fixed resource budget/);
  assert.throws(() => f.module.inspectDocumentWidgetAsset(), { code: 'DOCUMENT_WIDGET_ASSET_INVALID' });
});
