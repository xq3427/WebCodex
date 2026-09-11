import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishDocumentWidget } from './document-widget-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist', 'src', 'assets');
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pdfjs = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const { VERSION } = await import(pathToFileURL(join(root, 'dist', 'src', 'version.js')).href);
const { DOCUMENT_ASSET_INVENTORY, DOCUMENT_ASSET_VERSION, readDocumentAsset } = await import(pathToFileURL(join(root, 'dist', 'src', 'document-assets.js')).href);
if (VERSION !== project.version || !/^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})(?:-preview\.(?:0|[1-9]\d{0,3}))?(?![\s\S])/.test(VERSION)) {
  throw new Error('The compiled widget version must match the project version.');
}
if (pdfjs.version !== DOCUMENT_ASSET_VERSION || DOCUMENT_ASSET_VERSION !== '6.3.289') {
  throw new Error('The installed PDF.js version must match the pinned asset inventory.');
}

const MAX_WIDGET_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLED_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024;
const directories = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts' };
const bundled = Object.create(null);
const counts = { cMapUrl: 0, standardFontDataUrl: 0 };
let assetBytes = 0;
for (const asset of DOCUMENT_ASSET_INVENTORY) {
  if (asset.kind === 'wasmUrl') continue;
  if (!Object.hasOwn(directories, asset.kind) || typeof asset.filename !== 'string'
    || !/^[A-Za-z0-9_-]+\.(?:bcmap|pfb|ttf)$/.test(asset.filename)
    || !Number.isSafeInteger(asset.size_bytes) || asset.size_bytes < 1 || asset.size_bytes > MAX_ASSET_BYTES
    || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error('The bundled PDF asset inventory is invalid.');
  }
  const key = asset.kind + ':' + asset.filename;
  if (Object.hasOwn(bundled, key)) throw new Error('The bundled PDF asset inventory has duplicate entries.');
  assetBytes += asset.size_bytes;
  if (assetBytes > MAX_BUNDLED_ASSET_BYTES) throw new Error('The bundled PDF asset inventory exceeds its byte budget.');
  // Reuse the bounded file-handle reader: reject oversized/corrupt package files
  // before they can become a generated payload, including changes during reads.
  const verified = await readDocumentAsset({ kind: asset.kind, filename: asset.filename, offset: 0 });
  const bytes = Buffer.from(verified.meta.base64, 'base64');
  if (verified.data.eof !== true || verified.data.offset !== 0 || verified.data.total_bytes !== asset.size_bytes
    || bytes.length !== asset.size_bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error('An installed PDF asset does not match its pinned size and SHA-256.');
  }
  bundled[key] = { size_bytes: asset.size_bytes, sha256: asset.sha256, base64: bytes.toString('base64') };
  counts[asset.kind]++;
}
if (counts.cMapUrl !== 168 || counts.standardFontDataUrl !== 14) throw new Error('The widget must bundle exactly 182 PDF fonts and CMaps.');

const outfile = join(outdir, `document-widget-${VERSION}.js`);
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/browser/document-widget.mjs'],
  outfile,
  write: false,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'WebCodexDocument',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  sourcemap: false,
  metafile: true,
  plugins: [{ name: 'pinned-document-assets', setup(plugin) {
    plugin.onResolve({ filter: /^webcodex:document-assets$/ }, () => ({ path: 'document-assets', namespace: 'webcodex-bundled' }));
    plugin.onLoad({ filter: /^document-assets$/, namespace: 'webcodex-bundled' }, () => ({
      loader: 'js', contents: 'const assets = ' + JSON.stringify(bundled)
        + '; for (const value of Object.values(assets)) Object.freeze(value); export const BUNDLED_DOCUMENT_ASSETS = Object.freeze(assets);',
    }));
  } }],
});
const output = result.outputFiles.find(file => resolve(file.path) === outfile);
if (!output || result.outputFiles.length !== 1 || output.contents.length > MAX_WIDGET_BYTES) {
  throw new Error('The complete document widget exceeds its 5 MiB build budget or has unexpected outputs.');
}
const licenses = ['PDF.js bundled browser runtime and data notices', '',
  'WebCodex source is MIT licensed. The following separately licensed dependencies retain their own terms.', ''];
for (const directory of ['', 'cmaps', 'standard_fonts', 'wasm']) {
  const entries = await readdir(join(packageRoot, directory));
  for (const name of entries.filter(name => /^LICENSE(?:_|$)|^NOTICE(?:\.|$)/.test(name)).sort()) {
    licenses.push('=== pdfjs-dist/' + (directory ? directory + '/' : '') + name + ' ===',
      await readFile(join(packageRoot, directory, name), 'utf8'), '');
  }
}
// A complete immutable asset is available before its version manifest changes.
// Generic and old versioned JS may still serve older launchers; never overwrite them.
await mkdir(outdir, { recursive: true });
await writeFile(join(outdir, 'PDFJS-NOTICES.txt'), licenses.join('\n'), 'utf8');
const committed = await publishDocumentWidget(outdir, VERSION, output.contents);
process.stdout.write(JSON.stringify({ widget: 'document-widget', version: VERSION, bytes: output.contents.length,
  max_bytes: MAX_WIDGET_BYTES, pdfjs: pdfjs.version, bundled_assets: counts.cMapUrl + counts.standardFontDataUrl,
  bundled_asset_bytes: assetBytes, asset_transport: 'bundled', wasm_assets: 0, manifest: committed.manifest,
  artifact: committed.file, sha256: committed.sha256 }) + '\n');
