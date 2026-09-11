import { BUNDLED_DOCUMENT_ASSETS } from 'webcodex:document-assets';

const MAX_ASSET_BYTES = 256 * 1024;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 32;
const cache = new Map();
let cacheBytes = 0;
let queue = Promise.resolve();

function failure(code, detail_code) {
  const error = new Error(code);
  error.code = code;
  error.detail_code = detail_code;
  return error;
}

function lookup(kind, filename) {
  if (kind !== 'cMapUrl' && kind !== 'standardFontDataUrl') {
    throw failure('ASSET_UNAVAILABLE', 'ASSET_KIND_UNSUPPORTED');
  }
  if (typeof filename !== 'string' || filename.length > 128
    || !/^[A-Za-z0-9_-]+\.(?:bcmap|pfb|ttf)$/.test(filename)) {
    throw failure('ASSET_UNAVAILABLE', 'ASSET_NAME_UNSUPPORTED');
  }
  const key = kind + ':' + filename;
  if (!Object.prototype.hasOwnProperty.call(BUNDLED_DOCUMENT_ASSETS, key)) {
    throw failure('ASSET_UNAVAILABLE', 'ASSET_NAME_UNSUPPORTED');
  }
  return { key, asset: BUNDLED_DOCUMENT_ASSETS[key] };
}

async function decode(asset) {
  const integrity = detail => failure('FILE_INTEGRITY_ERROR', detail);
  if (!asset || typeof asset !== 'object' || !Number.isSafeInteger(asset.size_bytes)
    || asset.size_bytes < 1 || asset.size_bytes > MAX_ASSET_BYTES) throw integrity('FILE_SIZE_INVALID');
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw integrity('CHUNK_METADATA_INVALID');
  if (typeof asset.base64 !== 'string') throw integrity('BASE64_FORMAT_INVALID');
  if (asset.base64.length !== 4 * Math.ceil(asset.size_bytes / 3)) throw integrity('BASE64_LENGTH_MISMATCH');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(asset.base64)) throw integrity('BASE64_FORMAT_INVALID');
  let binary;
  try { binary = atob(asset.base64); } catch { throw integrity('BASE64_DECODE_FAILED'); }
  if (binary.length !== asset.size_bytes) throw integrity('DECODED_SIZE_MISMATCH');
  if (btoa(binary) !== asset.base64) throw integrity('BASE64_ROUNDTRIP_MISMATCH');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== asset.sha256) throw integrity('FILE_SHA256_MISMATCH');
  return bytes;
}

/** Fixed package data only. No external fetch or component tool fallback exists. */
export async function getBundledDocumentAsset(kind, filename) {
  const { key, asset } = lookup(kind, filename);
  // Serialize misses so concurrent requests cannot over-reserve the decoded cache.
  const task = queue.then(async () => {
    let bytes = cache.get(key);
    if (bytes) {
      cache.delete(key);
      cache.set(key, bytes);
      return bytes.slice();
    }
    bytes = await decode(asset);
    while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes.length > MAX_CACHE_BYTES) {
      const oldest = cache.entries().next().value;
      if (!oldest) throw failure('ASSET_UNAVAILABLE', 'ASSET_BYTES_INVALID');
      cache.delete(oldest[0]);
      cacheBytes -= oldest[1].length;
    }
    cache.set(key, bytes);
    cacheBytes += bytes.length;
    return bytes.slice();
  });
  queue = task.then(() => undefined, () => undefined);
  return task;
}
