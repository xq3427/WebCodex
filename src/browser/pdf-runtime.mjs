import { getDocument, version as pdfjsVersion } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { DOCUMENT_DIAGNOSTIC_CODES, DOCUMENT_DIAGNOSTIC_DETAILS } from '../document-failure.ts';

// A bundled handler avoids both remote worker URLs and blob-worker CSP exceptions.
globalThis.pdfjsWorker = { WorkerMessageHandler };

export const PDFJS_VERSION = pdfjsVersion;
const MAX_CACHE_PAGES = 20;
const encoder = new TextEncoder();
const SAFE_CODES = new Set(DOCUMENT_DIAGNOSTIC_CODES);
const SAFE_DETAILS = new Set(DOCUMENT_DIAGNOSTIC_DETAILS);

export function pdfError(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (SAFE_DETAILS.has(detail)) error.detail_code = detail;
  return error;
}

/** Retain fixed diagnostic fields only; parser/host messages and arbitrary causes are discarded. */
export function pdfAssetError(error) {
  const safe = pdfError('ASSET_UNAVAILABLE', error?.detail_code);
  const code = error?.diagnostic_code ?? error?.code;
  safe.diagnostic_code = SAFE_CODES.has(code) ? code
    : Number.isSafeInteger(code) && code >= -2147483648 && code <= 2147483647 ? 'JSON_RPC_ERROR' : 'UNKNOWN_ERROR';
  return safe;
}

function checkedLimit(value, ceiling) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw pdfError('PDF_LIMIT');
  return value;
}

/** Return the longest whole-Unicode-code-point prefix within a UTF-8 byte budget. */
export function fitUtf8(text, budget) {
  if (encoder.encode(text).length <= budget) return { text, truncated: false };
  let bytes = 0, length = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (bytes + size > budget) break;
    bytes += size;
    length += character.length;
  }
  return { text: text.slice(0, length), truncated: true };
}

export function pageTextResult(pageNumber, text, truncated) {
  text = text.trimEnd();
  // A truncated prefix does not establish that a page has no text layer.
  return { page_number: pageNumber, text, truncated, text_layer: text.trim().length || truncated ? 'present' : 'empty' };
}

/** Browser-only parser. It receives owned, already verified original bytes and an MCP asset loader. */
export function createPdfRuntime({ loadAsset, limits }) {
  const maxPages = checkedLimit(limits.max_pages_per_request, 5);
  const maxPageBytes = checkedLimit(limits.max_page_text_bytes, 16384);
  const maxTotalBytes = checkedLimit(limits.max_total_text_bytes, 65536);
  if (typeof loadAsset !== 'function') throw pdfError('ASSET_UNAVAILABLE');
  let loadingTask = null;
  let pdf = null;
  let destroyed = false;
  let assetFailure = null;
  const pages = new Map();

  class LocalBinaryDataFactory {
    async fetch(request) {
      try {
        if (assetFailure) throw assetFailure;
        if (destroyed) throw pdfError('DOCUMENT_EXPIRED');
        const kind = request?.kind, filename = request?.filename;
        if (!['cMapUrl', 'standardFontDataUrl', 'wasmUrl'].includes(kind)) throw pdfError('ASSET_UNAVAILABLE', 'ASSET_KIND_UNSUPPORTED');
        if (typeof filename !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(filename)
          || filename.includes('..')) throw pdfError('ASSET_UNAVAILABLE', 'ASSET_NAME_UNSUPPORTED');
        const bytes = await loadAsset(kind, filename);
        if (destroyed) throw pdfError('DOCUMENT_EXPIRED');
        if (!(bytes instanceof Uint8Array) || !bytes.length) throw pdfError('ASSET_UNAVAILABLE', 'ASSET_BYTES_INVALID');
        return bytes.slice();
      } catch (error) {
        // PDF.js may swallow a font failure and continue extracting. Keep the
        // first sanitized failure outside its message bridge and reject that result.
        assetFailure ??= pdfAssetError(error);
        throw assetFailure;
      }
    }
  }

  function normalizeError(error) {
    if (assetFailure) return assetFailure;
    if (error?.code && ['PDF_LIMIT', 'PDF_PASSWORD_REQUIRED', 'ASSET_UNAVAILABLE'].includes(error.code)) return error;
    if (error?.name === 'PasswordException') return pdfError('PDF_PASSWORD_REQUIRED');
    if (error?.name === 'InvalidPDFException') return pdfError('PDF_INVALID');
    return pdfError('PDF_PARSE_FAILED');
  }

  async function load(bytes) {
    if (destroyed || loadingTask || !(bytes instanceof Uint8Array) || !bytes.byteLength) throw pdfError('PDF_INVALID');
    let rejectPassword;
    const password = new Promise((_resolve, reject) => { rejectPassword = reject; });
    try {
      loadingTask = getDocument({
        data: bytes,
        BinaryDataFactory: LocalBinaryDataFactory,
        useWorkerFetch: false,
        useWasm: false,
        cMapPacked: true,
        disableFontFace: true,
        useSystemFonts: false,
        enableXfa: false,
        isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false,
        enableHWA: false,
        enableWebGPU: false,
        disableAutoFetch: true,
        disableStream: true,
        disableRange: true,
        stopAtErrors: true,
        maxImageSize: 16_000_000,
        canvasMaxAreaInBytes: 16_000_000,
        verbosity: 0,
      });
      loadingTask.onPassword = () => rejectPassword(pdfError('PDF_PASSWORD_REQUIRED'));
      pdf = await Promise.race([loadingTask.promise, password]);
      if (destroyed) throw pdfError('PDF_PARSE_FAILED');
      if (assetFailure) throw assetFailure;
      if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 2000) throw pdfError('PDF_LIMIT');
      return { total_pages: pdf.numPages };
    } catch (error) {
      const safe = normalizeError(error);
      await destroy();
      throw safe;
    }
  }

  async function readPage(pageNumber) {
    if (pages.has(pageNumber)) {
      const page = pages.get(pageNumber);
      pages.delete(pageNumber);
      pages.set(pageNumber, page);
      return { ...page };
    }
    let page;
    let reader;
    try {
      page = await pdf.getPage(pageNumber);
      reader = page.streamTextContent({ includeMarkedContent: false, disableNormalization: false }).getReader();
      let text = '', size = 0, truncated = false, items = 0;
      while (true) {
        if (destroyed) throw pdfError('PDF_PARSE_FAILED');
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const item of chunk.value.items) {
          if (++items > 100000) { truncated = true; break; }
          if (typeof item.str !== 'string') continue;
          const candidate = item.str + (item.hasEOL ? '\n' : ' ');
          const fitted = fitUtf8(candidate, Math.max(0, maxPageBytes - size));
          text += fitted.text;
          size += encoder.encode(fitted.text).length;
          if (fitted.truncated) { truncated = true; break; }
        }
        if (truncated) { await reader.cancel(pdfError('PDF_LIMIT')); break; }
      }
      if (assetFailure) throw assetFailure;
      const result = pageTextResult(pageNumber, text, truncated);
      if (pages.size >= MAX_CACHE_PAGES) pages.delete(pages.keys().next().value);
      pages.set(pageNumber, result);
      return { ...result };
    } finally {
      try { reader?.releaseLock(); } catch { /* Reader may already be cancelled. */ }
      try { page?.cleanup(); } catch { /* Document teardown remains authoritative. */ }
    }
  }

  async function readPages(startPage, pageCount) {
    if (!pdf || destroyed) throw pdfError('PDF_PARSE_FAILED');
    if (assetFailure) throw assetFailure;
    if (!Number.isSafeInteger(startPage) || startPage < 1 || startPage > pdf.numPages
      || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > maxPages) throw pdfError('PDF_LIMIT');
    try {
      const result = [];
      let remaining = maxTotalBytes;
      for (let number = startPage; number < startPage + pageCount && number <= pdf.numPages; number++) {
        const page = await readPage(number);
        const fitted = fitUtf8(page.text, remaining);
        result.push({ ...page, text: fitted.text, truncated: page.truncated || fitted.truncated });
        remaining -= encoder.encode(fitted.text).length;
      }
      if (assetFailure) throw assetFailure;
      return { total_pages: pdf.numPages, pages: result };
    } catch (error) { throw normalizeError(error); }
  }

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    pages.clear();
    const task = loadingTask;
    pdf = null;
    loadingTask = null;
    try { await task?.destroy(); } catch { /* Teardown never exposes parser error text. */ }
  }
  return { load, readPages, destroy };
}
