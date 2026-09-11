import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { VERSION } from './version.js';
import { AppError } from './errors.js';

export const DOCUMENT_WIDGET_URI = `ui://webcodex/document-${VERSION}.html`;
export const LEGACY_DOCUMENT_WIDGET_URIS = ['ui://webcodex/document-0.15.0-preview.1.html', 'ui://webcodex/document-0.15.0-preview.2.html', 'ui://webcodex/document-0.15.0-preview.3.html', 'ui://webcodex/document-0.15.0-preview.4.html', 'ui://webcodex/document-0.15.0-preview.5.html', 'ui://webcodex/document-0.15.0-preview.6.html', 'ui://webcodex/document-0.15.0-preview.7.html', 'ui://webcodex/document-0.16.0-preview.1.html', 'ui://webcodex/document-0.16.0-preview.2.html', 'ui://webcodex/document-0.16.0-preview.3.html', 'ui://webcodex/document-0.16.0-preview.4.html', 'ui://webcodex/document-0.16.0-preview.5.html', 'ui://webcodex/document-0.16.0-preview.6.html'] as const;
export const DOCUMENT_WIDGET_MIME_TYPE = 'text/html;profile=mcp-app';
export const DOCUMENT_WIDGET_MAX_BYTES = 5 * 1024 * 1024;

type Manifest = { schema_version: 1; version: string; file: string; size_bytes: number; sha256: string };
const invalid = () => new AppError('DOCUMENT_WIDGET_ASSET_INVALID', 'The committed PDF component is missing, incomplete or corrupt. Rebuild this release before restarting the service.');
const changedDuringRead = Symbol('changed-during-artifact-read');

function boundedArtifact(file: URL, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    const entry = lstatSync(file, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.size < 1n || entry.size > BigInt(maxBytes)) throw invalid();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd, { bigint: true });
    if (entry.ino !== before.ino || entry.size !== before.size) throw changedDuringRead;
    if (before.nlink !== 1n) throw invalid();
    const bytes = Buffer.alloc(Number(before.size));
    let count = 0;
    while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, count); if (!read) throw invalid(); count += read; }
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw changedDuringRead;
    return bytes;
  } catch (error) { if (error === changedDuringRead) throw error; throw invalid(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function committedRuntime(): { manifest: Manifest; bytes: Buffer } {
  for (let attempt = 0; ; attempt++) { try {
    const manifest: unknown = JSON.parse(boundedArtifact(new URL(`./assets/document-widget-${VERSION}.json`, import.meta.url), 4096).toString('utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw invalid();
    const record = manifest as Manifest;
    if (Object.keys(record).sort().join(',') !== 'file,schema_version,sha256,size_bytes,version' || record.schema_version !== 1 || record.version !== VERSION ||
      typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.size_bytes) || record.size_bytes < 1 || record.size_bytes > DOCUMENT_WIDGET_MAX_BYTES ||
      record.file !== `document-widget-${VERSION}-${record.sha256}.js`) throw invalid();
    const bytes = boundedArtifact(new URL('./assets/' + record.file, import.meta.url), record.size_bytes);
    if (bytes.length !== record.size_bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw invalid();
    return { manifest: record, bytes };
  } catch (error) { if (error === changedDuringRead && attempt < 2) continue; throw invalid(); } }
}

/** Read-only preflight suitable for doctor; never acquires application state. */
export function inspectDocumentWidgetAsset() {
  const { manifest, bytes } = committedRuntime();
  renderCommittedHtml(bytes); // The wrapper and escaped script also fit the resource budget.
  return { version: manifest.version, sha256: manifest.sha256, size_bytes: manifest.size_bytes,
    manifest: `document-widget-${VERSION}.json`, file: manifest.file };
}

/** Original file bytes and filenames are never interpolated into this static resource. */
export function renderDocumentWidget(): string {
  // Read one atomic manifest snapshot, then its immutable complete asset.
  return renderCommittedHtml(committedRuntime().bytes);
}

function renderCommittedHtml(bytes: Buffer): string {
  const runtime = bytes.toString('utf8').replace(/<\/script/gi, '<\\/script');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebCodex 文档读取</title><style>
:root{color-scheme:light dark;font:14px system-ui,sans-serif}body{margin:0;padding:14px;background:Canvas;color:CanvasText}h1{font-size:16px;margin:0 0 8px}p{line-height:1.5;margin:7px 0;overflow-wrap:anywhere}.muted{font-size:12px;opacity:.75}#webcodex-document-status{border-inline-start:3px solid #5674d4;padding-inline-start:10px}#webcodex-document-status[data-state="failure"]{border-color:#bb7233}
</style></head><body><main><h1>WebCodex 文档读取</h1>
<p id="webcodex-document-name"></p><p id="webcodex-document-status" data-state="waiting" role="status" aria-live="polite">正在连接文档读取组件…</p>
<p class="muted">完整原文件在浏览器中校验后解析，正文经普通工具返回。当前支持 PDF 文本层；扫描件尚不提供 OCR。</p>
<p class="muted">组件版本：${VERSION} · <span id="webcodex-document-bridge">正在初始化</span></p><p id="webcodex-document-diagnostics" class="muted"></p>
</main><script>${runtime}</script></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > DOCUMENT_WIDGET_MAX_BYTES) throw new AppError('DOCUMENT_WIDGET_ASSET_INVALID', 'The bundled PDF component exceeds its fixed resource budget. Rebuild the matching release.');
  return html;
}
