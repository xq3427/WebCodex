import { constants as bufferConstants } from 'node:buffer';
import dns from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import type { Socket } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { AppError } from './errors.js';

const FILE_HOST = 'files.oaiusercontent.com';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const URL_LIMIT = 16_384;

export interface FileDownloadOptions {
  maxBytes: number;
  /** Total deadline, including DNS, redirects and body transfer. */
  timeoutMs?: number;
  /** Trusted local configuration only; never a tool argument. No proxy credentials. */
  proxyUrl?: string;
}

function failure(code: string, message: string): AppError { return new AppError(code, message); }
type SourceDenialStage = 'source_url' | 'dns' | 'redirect_url';
type SourceDenialReason = 'sandbox_reference' | 'local_file_reference' | 'invalid_url' | 'https_required' | 'host_not_allowed' | 'url_policy_violation'
  | 'empty_answer' | 'invalid_address' | 'non_public_address' | 'invalid_location';
function denied(stage: SourceDenialStage, reason: SourceDenialReason): AppError {
  return new AppError('FILE_IMPORT_SOURCE_DENIED', 'WebCodex fs_import_file rejected the remote download source under its local HTTPS host/address policy, before writing the destination. This is not a host tool-dispatch block, and fs_write_binary_chunk has not been attempted by this call.', { stage, reason });
}
function downloadFailed(httpStatus?: number): AppError {
  const details = Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599
    ? { stage: 'http' as const, http_status: httpStatus } : undefined;
  return new AppError('FILE_IMPORT_DOWNLOAD_FAILED', 'The official file download could not be completed. The file link may have expired or be unavailable.', details);
}
function tooLarge(): AppError { return failure('FILE_IMPORT_TOO_LARGE', 'The source file exceeds the configured binary write limit.'); }
function integrityFailed(): AppError { return failure('FILE_IMPORT_INTEGRITY_ERROR', 'The file download was incomplete or did not match its declared byte length.'); }

function sourceUrl(input: string, stage: 'source_url' | 'redirect_url' = 'source_url'): URL {
  if (typeof input !== 'string') throw denied(stage, 'invalid_url');
  if (/^sandbox:/i.test(input)) throw denied(stage, 'sandbox_reference');
  if (/^(?:file:|[a-z]:[\\/]|\\\\|\/)/i.test(input)) throw denied(stage, 'local_file_reference');
  if (input.length > URL_LIMIT || /[\u0000-\u0020\u007f#]/.test(input) || /^https:\/\/[^/?#]*@/i.test(input)) throw denied(stage, 'url_policy_violation');
  let url: URL;
  try { url = new URL(input); } catch { throw denied(stage, 'invalid_url'); }
  if (url.protocol !== 'https:') throw denied(stage, 'https_required');
  if (url.hostname !== FILE_HOST) throw denied(stage, 'host_not_allowed');
  if (url.username || url.password || url.hash || (url.port && url.port !== '443')) throw denied(stage, 'url_policy_violation');
  return url;
}

/** Conservative public-unicast filter; private, transition and special-use ranges fail closed. */
function publicAddress(address: string, family: number): boolean {
  if (isIP(address) !== family) return false;
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%')) return false;
  // Only 2000::/3 is global unicast. This also rejects mapped IPv4, NAT64,
  // loopback, link-local, unique-local and multicast addresses.
  const groups = address.toLowerCase().split(':');
  const first = Number.parseInt(groups[0], 16), second = Number.parseInt(groups[1] || '0', 16);
  if (!(first >= 0x2000 && first <= 0x3fff)) return false;
  if (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) return false;
  if (first === 0x2002 || first === 0x3fff) return false;
  return true;
}

async function pinnedLookup(url: URL, signal: AbortSignal): Promise<{ lookup: LookupFunction; addresses: { address: string; family: number }[] }> {
  let addresses: { address: string; family: number }[];
  try { addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }); } catch { throw downloadFailed(); }
  signal.throwIfAborted();
  if (!addresses.length) throw denied('dns', 'empty_answer');
  if (addresses.some(item => ![4, 6].includes(item.family) || isIP(item.address) !== item.family)) throw denied('dns', 'invalid_address');
  if (addresses.some(item => !publicAddress(item.address, item.family))) throw denied('dns', 'non_public_address');
  // The TLS connection still uses the original hostname for SNI and certificate
  // validation. Its address cannot be replaced by a second DNS lookup. Preserve
  // all validated addresses so Node can fall back between IPv6 and IPv4.
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (hostname !== url.hostname) { callback(denied('dns', 'host_not_allowed'), '', 0); return; }
    const candidates = options.family === 4 || options.family === 6 ? addresses.filter(item => item.family === options.family) : addresses;
    if (!candidates.length) { callback(downloadFailed(), '', 0); return; }
    if (options.all) callback(null, candidates.map(item => ({ ...item })));
    else callback(null, candidates[0].address, candidates[0].family);
  };
  return { lookup, addresses };
}

function configuredProxy(input: string | undefined): URL | undefined {
  if (!input) return undefined;
  const invalid = () => failure('FILE_IMPORT_PROXY_INVALID', 'The locally configured file-download proxy must be an HTTP or HTTPS origin without credentials, query or fragment.');
  if (input.length > URL_LIMIT || /[\u0000-\u0020\u007f#]/.test(input) || /^[a-z]+:\/\/[^/?#]*@/i.test(input)) throw invalid();
  let proxy: URL;
  try { proxy = new URL(input); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/') throw invalid();
  return proxy;
}

/** Establish CONNECT to a pinned IP, then TLS to the original official hostname. */
async function proxySocket(proxy: URL, hostname: string, address: { address: string; family: number }, signal: AbortSignal): Promise<tls.TLSSocket> {
  signal.throwIfAborted();
  const authority = address.family === 6 ? `[${address.address}]:443` : `${address.address}:443`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | undefined, raw: Socket | undefined, secured: tls.TLSSocket | undefined;
    const abort = () => {
      request?.destroy(); raw?.destroy(); secured?.destroy();
      fail();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      request?.destroy(); raw?.destroy(); secured?.destroy();
      reject(downloadFailed());
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const transport = proxy.protocol === 'https:' ? https : http;
      request = transport.request(proxy, {
        method: 'CONNECT', path: authority, headers: { Host: authority },
        signal, agent: false, ...(proxy.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
      });
      request.on('error', fail);
      request.once('close', () => { if (!raw && !settled) fail(); });
      request.on('response', response => { response.destroy(); fail(); });
      request.on('connect', (response, socket, head) => {
        raw = socket;
        raw.on('error', fail);
        if (signal.aborted || response.statusCode !== 200 || head.length) { fail(); return; }
        try {
          secured = tls.connect({ socket, servername: hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
          secured.on('error', fail);
          secured.once('close', () => { signal.removeEventListener('abort', abort); if (!settled) fail(); });
          secured.once('secureConnect', () => {
            if (settled) return;
            if (!secured!.authorized || signal.aborted) { fail(); return; }
            settled = true;
            resolve(secured!);
          });
        } catch { fail(); }
      });
      request.end();
    } catch { fail(); }
  });
}

type DownloadResponse = { redirect: string } | { bytes: Buffer };

async function getFile(url: URL, maxBytes: number, signal: AbortSignal, proxy?: URL): Promise<DownloadResponse> {
  const { lookup, addresses } = await pinnedLookup(url, signal);
  signal.throwIfAborted();
  let agent: https.Agent | undefined;
  if (proxy) {
    // IPv4 CONNECT is supported by more locally configured proxies. All choices
    // came from the validated DNS snapshot; the proxy never resolves the target.
    const socket = await proxySocket(proxy, url.hostname, addresses.find(item => item.family === 4) ?? addresses[0], signal);
    if (signal.aborted) { socket.destroy(); signal.throwIfAborted(); }
    agent = new https.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
    agent.createConnection = () => socket;
  }
  try { return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: AppError) => {
      if (settled) return;
      settled = true;
      reject(error);
      request.destroy();
    };
    const request = https.request(url, {
      method: 'GET', signal, agent: agent ?? false, lookup, rejectUnauthorized: true,
      // Avoid content negotiation altering the original file's bytes. No API
      // key, cookies or Authorization header is sent to the download endpoint.
      headers: { 'Accept-Encoding': 'identity' },
    }, response => {
      response.on('error', () => fail(downloadFailed()));
      const status = response.statusCode;
      if (status && REDIRECTS.has(status)) {
        const location = response.headers.location;
        if (!location || location.length > URL_LIMIT || /[\u0000-\u0020\u007f#]/.test(location)) { fail(denied('redirect_url', 'invalid_location')); response.destroy(); return; }
        settled = true;
        resolve({ redirect: location });
        response.destroy();
        return;
      }
      if (status !== 200) { fail(downloadFailed(status)); response.destroy(); return; }
      const encoding = response.headers['content-encoding'];
      if (encoding && encoding.toLowerCase() !== 'identity') { fail(downloadFailed()); response.destroy(); return; }
      const declaredHeader = response.headers['content-length'];
      let declared: number | undefined;
      if (declaredHeader !== undefined) {
        if (!/^\d+$/.test(declaredHeader) || !Number.isSafeInteger(Number(declaredHeader))) { fail(integrityFailed()); response.destroy(); return; }
        declared = Number(declaredHeader);
        if (declared > maxBytes) { fail(tooLarge()); response.destroy(); return; }
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (data: Buffer) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        received += chunk.length;
        if (received > maxBytes) { fail(tooLarge()); response.destroy(); return; }
        if (declared !== undefined && received > declared) { fail(integrityFailed()); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('aborted', () => fail(integrityFailed()));
      response.on('end', () => {
        if (settled) return;
        if (!response.complete || (declared !== undefined && received !== declared)) { fail(integrityFailed()); return; }
        settled = true;
        resolve({ bytes: Buffer.concat(chunks, received) });
      });
      response.on('close', () => { if (!settled) fail(integrityFailed()); });
    });
    request.on('error', () => fail(downloadFailed()));
    request.end();
  }); } finally { agent?.destroy(); }
}

/** Download exact bytes from an official ChatGPT file parameter, with no credential logging. */
export async function downloadChatGptFile(input: string, options: FileDownloadOptions): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > bufferConstants.MAX_LENGTH ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw failure('FILE_IMPORT_INVALID_ARGUMENT', 'The binary file download size or timeout limit is invalid.');
  }
  let url = sourceUrl(input);
  const proxy = configuredProxy(options.proxyUrl);
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(failure('FILE_IMPORT_TIMEOUT', 'The official file download exceeded its total time limit.'));
      controller.abort();
    }, timeoutMs);
  });
  const download = async () => {
    for (let redirects = 0; ; redirects++) {
      const result = await getFile(url, options.maxBytes, controller.signal, proxy);
      if ('bytes' in result) return result.bytes;
      if (redirects >= MAX_REDIRECTS) throw downloadFailed();
      let redirected: string;
      try { redirected = new URL(result.redirect, url).href; } catch { throw denied('redirect_url', 'invalid_location'); }
      url = sourceUrl(redirected, 'redirect_url');
    }
  };
  try { return await Promise.race([download(), timeout]); }
  catch (error) {
    if (timedOut) throw failure('FILE_IMPORT_TIMEOUT', 'The official file download exceeded its total time limit.');
    if (error instanceof AppError) throw error;
    // Never preserve native exceptions: DNS, TLS and HTTP errors can contain
    // the signed URL or headers. Public errors contain only fixed messages.
    throw downloadFailed();
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
