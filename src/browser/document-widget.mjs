import { VERSION } from '../version.ts';
import { DOCUMENT_FAILURE_CODES, DOCUMENT_DIAGNOSTIC_CODES, DOCUMENT_DIAGNOSTIC_DETAILS } from '../document-failure.ts';
import { createPdfRuntime, fitUtf8, pageTextResult, PDFJS_VERSION, pdfAssetError } from './pdf-runtime.mjs';
import { getBundledDocumentAsset } from './document-bundled-assets.mjs';

export { createPdfRuntime, fitUtf8, pageTextResult, PDFJS_VERSION, getBundledDocumentAsset };
const MAX_FILE_BYTES = 7 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_LIFETIME_MS = 300000;
const REQUEST_TIMEOUT_MS = 10000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const ticket = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const PDF_ERRORS = new Set(DOCUMENT_FAILURE_CODES);
const SAFE_CODES = new Set(DOCUMENT_DIAGNOSTIC_CODES);

const SAFE_DETAILS = new Set(DOCUMENT_DIAGNOSTIC_DETAILS);
function failure(code, detailCode) {
  const error = new Error(code); error.code = code;
  if (SAFE_DETAILS.has(detailCode)) error.detail_code = detailCode;
  return error;
}
function safeCode(error) {
  if (SAFE_CODES.has(error?.code)) return error.code;
  if (Number.isSafeInteger(error?.code) && error.code >= -2147483648 && error.code <= 2147483647) return 'JSON_RPC_' + error.code;
  return 'UNKNOWN_ERROR';
}
async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Select one complete result; never graft anonymous private bytes onto a public summary. */
export function normalizeDocumentToolResult(result, { name, args }) {
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const candidates = [], seen = new Set(), queue = [{ value: result, depth: 0 }];
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!object(value) || seen.has(value)) continue;
    // Inspect both recognized branches completely: a skipped branch may contradict success.
    if (depth > 4 || candidates.length >= 12) throw failure('INVALID_RESPONSE', 'RESULT_WRAPPER_LIMIT');
    seen.add(value); candidates.push(value);
    for (const key of ['mcp_tool_result', 'call_tool_result']) {
      if (own(value, key) && object(value[key])) queue.push({ value: value[key], depth: depth + 1 });
    }
  }
  for (const value of candidates) {
    const structured = own(value, 'structuredContent') ? value.structuredContent : value;
    if ((value.isError !== undefined && value.isError !== false) || value.ok === false || structured?.ok === false) {
      const code = value.ok === false ? value.error?.code : structured?.error?.code;
      throw failure(SAFE_CODES.has(code) ? code : 'INVALID_RESPONSE');
    }
  }
  const envelopes = candidates.flatMap(value => {
    if (own(value, 'structuredContent')) return [value];
    if (own(value, 'ok')) return [{ structuredContent: { ok: value.ok, source: value.source, data: value.data },
      ...(own(value, '_meta') ? { _meta: value._meta } : {}) }];
    return [];
  });
  const binary = name === 'document_widget_chunk' || name === 'document_widget_asset';
  if (!binary && name !== 'document_widget_poll' && name !== 'document_widget_submit') throw failure('INVALID_RESPONSE');
  if (!envelopes.length || !object(args) || typeof args.expected_device_id !== 'string') throw failure('INVALID_RESPONSE');
  for (const value of envelopes) {
    const structured = value.structuredContent;
    if (structured?.ok !== true || !object(structured.data) || !object(structured.source)
      || structured.source.device_id !== args.expected_device_id) throw failure('INVALID_RESPONSE', 'RESULT_IDENTITY_MISMATCH');
  }
  // Data is small structured control information; bound comparison independently from private binary bytes.
  function signature(value) {
    let nodes = 0, chars = 0;
    const ancestors = new Set();
    function canonical(item, depth = 0) {
      if (++nodes > 128 || depth > 6) throw failure('INVALID_RESPONSE', 'RESULT_WRAPPER_LIMIT');
      if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return JSON.stringify(item);
      if (typeof item === 'string') {
        chars += item.length;
        if (chars > 16384) throw failure('INVALID_RESPONSE', 'RESULT_WRAPPER_LIMIT');
        return JSON.stringify(item);
      }
      if ((!object(item) && !Array.isArray(item)) || ancestors.has(item)) throw failure('INVALID_RESPONSE');
      ancestors.add(item);
      let encoded;
      if (Array.isArray(item)) encoded = '[' + item.map(entry => canonical(entry, depth + 1)).join(',') + ']';
      else {
        const keys = Object.keys(item).sort();
        if (keys.length > 64) throw failure('INVALID_RESPONSE', 'RESULT_WRAPPER_LIMIT');
        encoded = '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(item[key], depth + 1)).join(',') + '}';
      }
      ancestors.delete(item);
      return encoded;
    }
    return canonical(value);
  }
  const first = envelopes[0].structuredContent;
  function comparableData(data) {
    // Hosts may omit null in only one wrapper copy. Treat that single EOF
    // representation as equivalent without changing either returned envelope.
    if (binary && data.eof === true && Number.isSafeInteger(data.offset) && data.offset >= 0
      && Number.isSafeInteger(data.size_bytes) && data.size_bytes > 0 && data.size_bytes <= MAX_CHUNK_BYTES
      && Number.isSafeInteger(data.total_bytes) && data.total_bytes > 0 && data.offset + data.size_bytes === data.total_bytes
      && (data.next_offset === null || data.next_offset === undefined)) {
      const comparable = { ...data };
      delete comparable.next_offset;
      return comparable;
    }
    return data;
  }
  const identity = signature(comparableData(first.data));
  for (const value of envelopes) {
    const structured = value.structuredContent;
    if (['device_id', 'device_name', 'instance_id'].some(key => structured.source[key] !== first.source[key])
      || signature(comparableData(structured.data)) !== identity) throw failure('INVALID_RESPONSE', 'RESULT_CONFLICT');
  }
  if (!binary) return envelopes[0];
  if (envelopes.some(value => object(value._meta) && own(value._meta, 'base64') && typeof value._meta.base64 !== 'string')) {
    throw failure('INVALID_RESPONSE', 'PRIVATE_BYTES_MISSING');
  }
  const complete = envelopes.filter(value => own(value, '_meta') && object(value._meta)
    && own(value._meta, 'base64') && typeof value._meta.base64 === 'string');
  if (!complete.length) throw failure('INVALID_RESPONSE', 'PRIVATE_BYTES_MISSING');
  const selected = complete[0], data = selected.structuredContent.data;
  if (data.offset !== args.offset
    || (name === 'document_widget_chunk' && data.document_id !== args.document_id)
    || (name === 'document_widget_asset' && (data.kind !== args.kind || data.filename !== args.filename))) {
    throw failure('INVALID_RESPONSE', 'RESULT_IDENTITY_MISMATCH');
  }
  if (complete.some(value => value._meta.base64 !== selected._meta.base64)) throw failure('INVALID_RESPONSE', 'RESULT_CONFLICT');
  // The caller still verifies ranges, canonical Base64, per-chunk and whole-file hashes.
  return selected;
}

/** Reconstruct a bounded complete binary. Every response and hash is checked before returning any bytes. */
export async function readVerifiedBinary({ readChunk, totalBytes, expectedSha, maxBytes, kind, filename, cancelled = () => false }) {
  let offset = 0, bytes = null, digest = expectedSha;
  const ensureActive = () => { if (cancelled()) throw failure('DOCUMENT_EXPIRED'); };
  const integrity = detail => failure('FILE_INTEGRITY_ERROR', detail);
  if (totalBytes !== undefined && (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > maxBytes)) throw integrity('FILE_SIZE_INVALID');
  while (true) {
    ensureActive();
    const response = await readChunk(offset);
    ensureActive();
    const data = response.structuredContent?.data;
    const base64 = response._meta?.base64;
    if (!object(data) || data.offset !== offset || !Number.isSafeInteger(data.total_bytes) || data.total_bytes < 1 || data.total_bytes > maxBytes
      || !Number.isSafeInteger(data.size_bytes) || data.size_bytes < 1 || data.size_bytes > MAX_CHUNK_BYTES
      || data.size_bytes + offset > data.total_bytes || !sha256(data.sha256) || !sha256(data.chunk_sha256)
      || (kind !== undefined && (data.kind !== kind || data.filename !== filename))) throw integrity('CHUNK_METADATA_INVALID');
    if (typeof base64 !== 'string') throw integrity('BASE64_FORMAT_INVALID');
    if (base64.length !== 4 * Math.ceil(data.size_bytes / 3)) throw integrity('BASE64_LENGTH_MISMATCH');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw integrity('BASE64_FORMAT_INVALID');
    if (bytes === null) {
      totalBytes ??= data.total_bytes;
      digest ??= data.sha256;
      bytes = new Uint8Array(totalBytes);
    }
    if (data.total_bytes !== totalBytes) throw integrity('FILE_TOTAL_MISMATCH');
    if (data.sha256 !== digest) throw integrity('FILE_HASH_METADATA_MISMATCH');
    let binary;
    try { binary = atob(base64); } catch { throw integrity('BASE64_DECODE_FAILED'); }
    if (binary.length !== data.size_bytes) throw integrity('DECODED_SIZE_MISMATCH');
    if (btoa(binary) !== base64) throw integrity('BASE64_ROUNDTRIP_MISMATCH');
    const chunk = Uint8Array.from(binary, char => char.charCodeAt(0));
    const chunkSha = await hash(chunk);
    ensureActive();
    if (chunkSha !== data.chunk_sha256) throw integrity('CHUNK_SHA256_MISMATCH');
    bytes.set(chunk, offset);
    offset += chunk.length;
    const eof = offset === totalBytes;
    // Some JSON hosts omit null fields. An absent next offset is unambiguous
    // only at the exact verified end; it never terminates a partial transfer.
    if (data.eof !== eof || (eof ? data.next_offset !== null && data.next_offset !== undefined : data.next_offset !== offset)) {
      throw integrity('CHUNK_END_MISMATCH');
    }
    if (eof) {
      const fileSha = await hash(bytes);
      ensureActive();
      if (fileSha !== digest) throw integrity('FILE_SHA256_MISMATCH');
      return bytes;
    }
  }
}

export function startDocumentWidget() {
  const statusElement = document.getElementById('webcodex-document-status');
  if (!statusElement) return;
  const el = id => document.getElementById('webcodex-document-' + id);
  const pending = new Map(), compatibilityPending = new Set(), submitted = new Set();
  let nextId = 0, stopped = false, bridgeReady = false, serverTools = false;
  let active = null, runtime = null, initialization, pollTimer, expiryTimer, phase = 'initialize';
  let idleDelay = 1000;
  const startedAt = Date.now();
  const host = () => window.openai;
  const status = (state, text) => { statusElement.dataset.state = state; statusElement.textContent = text; };
  const current = descriptor => !stopped && active === descriptor && Date.now() < descriptor.deadline;

  function diagnostics(error) {
    el('diagnostics').textContent = '阶段：' + phase + ' · 错误码：' + safeCode(error)
      + (SAFE_CODES.has(error?.diagnostic_code) && error.diagnostic_code !== safeCode(error) ? ' · 原因码：' + error.diagnostic_code : '')
      + (SAFE_DETAILS.has(error?.detail_code) ? ' · 详情码：' + error.detail_code : '');
  }
  function finish(state, text, error) {
    if (stopped) return;
    stopped = true;
    if (error) diagnostics(error);
    clearTimeout(pollTimer); clearTimeout(expiryTimer);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure('DOCUMENT_EXPIRED')); }
    pending.clear();
    for (const cancel of compatibilityPending) cancel();
    compatibilityPending.clear();
    const parser = runtime; runtime = null; active = null;
    void parser?.destroy();
    status(state, text);
  }
  function expire() { finish('expired', '本次文档组件已到期，自动处理已停止。', failure('DOCUMENT_EXPIRED')); }
  expiryTimer = setTimeout(expire, MAX_LIFETIME_MS);

  function request(method, params) {
    if (stopped) return Promise.reject(failure('DOCUMENT_EXPIRED'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(failure('HOST_TIMEOUT')); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try { window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function compatibilityCall(name, args) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); compatibilityPending.delete(cancel); fn(value);
      };
      const cancel = () => settle(reject, failure('DOCUMENT_EXPIRED'));
      const timer = setTimeout(() => settle(reject, failure('HOST_TIMEOUT')), REQUEST_TIMEOUT_MS);
      compatibilityPending.add(cancel);
      Promise.resolve().then(() => {
        if (stopped) throw failure('DOCUMENT_EXPIRED');
        return host().callTool(name, args);
      }).then(value => settle(resolve, value), error => settle(reject, error));
    });
  }
  async function callTool(name, args) {
    let result;
    if (bridgeReady && serverTools) {
      try { result = await request('tools/call', { name, arguments: args }); }
      catch (error) {
        if (error?.code !== -32601 || typeof host()?.callTool !== 'function' || stopped) throw error;
        result = await compatibilityCall(name, args);
      }
    } else if (typeof host()?.callTool === 'function') result = await compatibilityCall(name, args);
    else throw failure('HOST_UNAVAILABLE');
    return normalizeDocumentToolResult(result, { name, args });
  }
  async function initialize() {
    try {
      if (window.parent === window) throw failure('HOST_UNAVAILABLE');
      const result = await request('ui/initialize', { appInfo: { name: 'webcodex-document', version: VERSION }, appCapabilities: {}, protocolVersion: '2026-01-26' });
      if (stopped) return;
      if (result?.protocolVersion !== '2026-01-26') throw failure('UNSUPPORTED_PROTOCOL');
      bridgeReady = true; serverTools = object(result.hostCapabilities?.serverTools);
      window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
      el('bridge').textContent = serverTools ? 'MCP Apps 工具通道已声明' : '使用宿主兼容工具通道';
    } catch (error) {
      if (!stopped) el('bridge').textContent = 'MCP Apps 未确认（' + safeCode(error) + '），检测兼容通道';
    }
  }

  async function loadAsset(descriptor, kind, filename) {
    try {
      if (!current(descriptor)) throw failure('DOCUMENT_EXPIRED');
      const bytes = await getBundledDocumentAsset(kind, filename);
      if (!current(descriptor)) throw failure('DOCUMENT_EXPIRED');
      return bytes;
    } catch (error) { throw pdfAssetError(error); }
  }

  async function prepare(descriptor) {
    if (runtime) return;
    phase = 'file'; status('downloading', '正在传输完整原文件并校验每个数据块…');
    const bytes = await readVerifiedBinary({ totalBytes: descriptor.data.size_bytes, expectedSha: descriptor.data.sha256,
      maxBytes: MAX_FILE_BYTES, cancelled: () => !current(descriptor),
      readChunk: offset => callTool('document_widget_chunk', { ...descriptor.base, offset }) });
    if (!current(descriptor)) throw failure('DOCUMENT_EXPIRED');
    phase = 'parse'; status('parsing', '原文件完整性校验通过，正在浏览器中解析 PDF…');
    runtime = createPdfRuntime({ loadAsset: (kind, filename) => loadAsset(descriptor, kind, filename), limits: descriptor.limits });
    // PDF.js takes ownership only after both chunk hashes and the whole original hash match.
    await runtime.load(bytes);
  }

  async function poll(descriptor) {
    if (!current(descriptor)) { if (!stopped) expire(); return; }
    let job = null;
    try {
      phase = 'poll';
      const result = (await callTool('document_widget_poll', descriptor.base)).structuredContent.data;
      let nextPollDelay = 1000;
      if (!current(descriptor)) { if (!stopped) expire(); return; }
      if (result.status === 'pending') {
        idleDelay = 1000;
        job = result.request;
        if (!object(job) || !uuid(job.request_id) || !Number.isSafeInteger(job.start_page) || job.start_page < 1
          || !Number.isSafeInteger(job.page_count) || job.page_count < 1 || job.page_count > descriptor.limits.max_pages_per_request) throw failure('INVALID_RESPONSE');
        if (!submitted.has(job.request_id)) {
          let pageData;
          try {
            await prepare(descriptor);
            if (!current(descriptor)) throw failure('DOCUMENT_EXPIRED');
            phase = 'extract'; status('parsing', '正在提取所选页的文本层…');
            pageData = await runtime.readPages(job.start_page, job.page_count);
          } catch (error) {
            if (!current(descriptor)) { if (!stopped) expire(); return; }
            const failedPhase = phase;
            const errorCode = PDF_ERRORS.has(error?.code) ? error.code : 'PDF_PARSE_FAILED';
            const underlyingCode = error?.diagnostic_code ?? error?.code;
            const diagnosticCode = SAFE_CODES.has(underlyingCode) ? underlyingCode
              : Number.isSafeInteger(underlyingCode) && underlyingCode >= -2147483648 && underlyingCode <= 2147483647 ? 'JSON_RPC_ERROR' : 'UNKNOWN_ERROR';
            const failureDiagnostics = { component_version: VERSION, phase: failedPhase, code: diagnosticCode,
              ...(SAFE_DETAILS.has(error?.detail_code) ? { detail_code: error.detail_code } : {}) };
            phase = 'submit';
            const ack = (await callTool('document_widget_submit', { ...descriptor.base, request_id: job.request_id,
              sha256: descriptor.data.sha256, error_code: errorCode, failure_diagnostics: failureDiagnostics })).structuredContent.data;
            if (ack.accepted !== true) throw failure('INVALID_RESPONSE');
            submitted.add(job.request_id);
            phase = failedPhase;
            finish('failure', errorCode === 'PDF_PASSWORD_REQUIRED' ? 'PDF 需要密码，当前原型暂不支持加密文档。'
              : '文档解析未完成，错误已返回普通读取工具。', error ?? failure('UNKNOWN_ERROR'));
            return;
          }
          if (!current(descriptor)) { if (!stopped) expire(); return; }
          phase = 'submit';
          const ack = (await callTool('document_widget_submit', { ...descriptor.base, request_id: job.request_id,
            sha256: descriptor.data.sha256, ...pageData })).structuredContent.data;
          if (!current(descriptor)) { if (!stopped) expire(); return; }
          if (ack.accepted !== true) throw failure('INVALID_RESPONSE');
          submitted.add(job.request_id);
          const hasText = pageData.pages.some(page => page.text.trim().length > 0);
          const truncated = pageData.pages.some(page => page.truncated);
          status(hasText ? 'ready' : truncated ? 'limited' : 'empty', hasText
            ? (truncated ? '所选页的部分文本已缓存；有内容因文本预算省略，普通读取工具会标明截断。'
              : '所选页文本已缓存，GPT 可通过普通读取工具取得正文。实际分析请以对话回答为准。')
            : truncated ? '文本预算已用尽，当前没有可返回的正文；结果会标明截断，请缩小页范围。'
              : '所选页未检测到文本层，结果已返回读取工具；当前未启用 OCR。');
        }
      } else if (result.status === 'idle') {
        if (result.failure_code !== undefined) {
          if (!PDF_ERRORS.has(result.failure_code)) throw failure('INVALID_RESPONSE');
          finish('failure', '此文档此前已报告解析失败，自动处理已停止。', failure(result.failure_code));
          return;
        }
        nextPollDelay = idleDelay;
        idleDelay = Math.min(5000, idleDelay * 2);
      } else throw failure('INVALID_RESPONSE');
      if (current(descriptor)) pollTimer = setTimeout(() => { void poll(descriptor); }, nextPollDelay);
    } catch (error) {
      if (!stopped) finish('failure', '组件工具通道中断，已停止自动处理；不会重放结果未确认的提交。', error);
    }
  }

  function receive(result, metadata) {
    if (stopped || !object(result)) return;
    const envelope = object(result.structuredContent) ? result.structuredContent : result;
    const privateData = result._meta?.webcodexDocument ?? metadata?.webcodexDocument;
    if (privateData === undefined) return;
    const data = envelope.data;
    const limits = privateData?.limits;
    const expires = Date.parse(privateData?.expires_at);
    const fileExpiry = Date.parse(privateData?.file?.expires_at);
    if (result.isError === true || envelope.ok !== true || !object(data) || !object(privateData)
      || !uuid(privateData.document_id) || data.document_id !== privateData.document_id || !ticket(privateData.ticket)
      || typeof privateData.expected_device_id !== 'string' || !privateData.expected_device_id.length || privateData.expected_device_id.length > 128
      || (envelope.source?.device_id !== undefined && envelope.source.device_id !== privateData.expected_device_id)
      || !Number.isFinite(fileExpiry)
      || !Number.isSafeInteger(privateData.file?.chunk_max_bytes) || privateData.file.chunk_max_bytes < 1 || privateData.file.chunk_max_bytes > MAX_CHUNK_BYTES
      || !Number.isFinite(expires) || !Number.isSafeInteger(data.size_bytes) || data.size_bytes < 1 || data.size_bytes > MAX_FILE_BYTES || !sha256(data.sha256)
      || !object(limits) || !Number.isSafeInteger(limits.max_pages_per_request) || limits.max_pages_per_request < 1 || limits.max_pages_per_request > 5
      || !Number.isSafeInteger(limits.max_page_text_bytes) || limits.max_page_text_bytes < 1 || limits.max_page_text_bytes > 16384
      || !Number.isSafeInteger(limits.max_total_text_bytes) || limits.max_total_text_bytes < 1 || limits.max_total_text_bytes > 65536) {
      finish('failure', '文档传输信息无效，自动处理已停止。', failure('INVALID_METADATA')); return;
    }
    if (active) {
      if (active.base.document_id !== privateData.document_id || active.base.ticket !== privateData.ticket || active.data.sha256 !== data.sha256) {
        finish('failure', '组件收到不同文档的数据，已停止以避免交叉提交。', failure('INVALID_METADATA'));
      }
      return;
    }
    if (expires <= Date.now() || fileExpiry <= Date.now()) { expire(); return; }
    active = { base: { document_id: privateData.document_id, ticket: privateData.ticket, expected_device_id: privateData.expected_device_id },
      data: { size_bytes: data.size_bytes, sha256: data.sha256 }, limits: { ...limits }, deadline: Math.min(expires, startedAt + MAX_LIFETIME_MS) };
    el('name').textContent = typeof data.name === 'string' ? data.name.slice(0, 1024) : 'PDF 文档';
    clearTimeout(expiryTimer); expiryTimer = setTimeout(expire, Math.max(0, active.deadline - Date.now()));
    const descriptor = active;
    void (async () => {
      if (!bridgeReady && typeof host()?.callTool !== 'function') await initialization;
      if (current(descriptor)) await poll(descriptor);
    })().catch(error => { if (!stopped) finish('failure', '无法启动自动文档读取。', error); });
  }
  const compatibilityResult = () => receive(host()?.toolOutput, host()?.toolResponseMetadata);
  window.addEventListener('message', event => {
    if (event.source !== window.parent || !object(event.data) || event.data.jsonrpc !== '2.0') return;
    const message = event.data;
    if (message.method === 'ui/resource-teardown') {
      finish('closed', '组件已关闭，自动处理已停止。');
      if (typeof message.id === 'string' || typeof message.id === 'number') window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
      return;
    }
    if (stopped) return;
    if (message.method === undefined && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(message.error); else entry.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      receive(message.params);
      if (!active && !stopped) compatibilityResult();
    }
  });
  window.addEventListener('openai:set_globals', compatibilityResult);
  window.addEventListener('pagehide', () => finish('closed', '组件已关闭，自动处理已停止。'));
  initialization = initialize();
  compatibilityResult();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') startDocumentWidget();
