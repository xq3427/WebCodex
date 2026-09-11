import { VERSION } from './version.js';

export const FILE_SAVE_WIDGET_URI = `ui://webcodex/file-save-${encodeURIComponent(VERSION)}.html`;
export const FILE_SAVE_WIDGET_MIME_TYPE = 'text/html;profile=mcp-app';

/** Static automatic host-file handoff. Private references never enter visible or model content. */
export function renderFileSaveWidget(): string {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebCodex 保存原文件</title>
<style>
:root{color-scheme:light dark;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:CanvasText;background:Canvas}
*{box-sizing:border-box}body{margin:0;padding:16px}.card{max-width:620px;margin:auto;border:1px solid color-mix(in srgb,CanvasText 12%,Canvas);border-radius:18px;padding:20px;background:linear-gradient(130deg,color-mix(in srgb,#6282ee 5%,Canvas),Canvas 70%)}
header{display:flex;align-items:center;gap:12px}.mark{width:42px;height:42px;display:grid;place-items:center;background:color-mix(in srgb,#5674d4 12%,Canvas);color:#6682df;border-radius:12px}.mark svg{width:24px;height:24px}h1{font-size:17px;letter-spacing:-.3px;margin:0}header p{margin:2px 0 0;font-size:12px;opacity:.62}.badge{margin-inline-start:auto;flex-shrink:0;font-size:11px;border:1px solid color-mix(in srgb,CanvasText 14%,Canvas);border-radius:99px;padding:3px 9px;opacity:.72}
#status{margin:18px 0 14px;font-weight:600;overflow-wrap:anywhere}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:0 0 18px}.step{border-top:3px solid color-mix(in srgb,CanvasText 10%,Canvas);padding-top:7px;font-size:11px;opacity:.55}.step[data-state="active"]{border-color:#7890e6;opacity:1}.step[data-state="done"]{border-color:#35a284;opacity:1}
dl{margin:0;display:grid;grid-template-columns:62px minmax(0,1fr);gap:8px 14px;padding:13px 14px;border-radius:10px;background:color-mix(in srgb,CanvasText 3%,Canvas)}dt{font-size:12px;opacity:.58}dd{margin:0;font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap}#path{font-weight:550}#detail{font-size:12px;opacity:.72;margin:13px 0 0;overflow-wrap:anywhere}footer{margin-top:16px;padding-top:10px;border-top:1px solid color-mix(in srgb,CanvasText 9%,Canvas);display:flex;flex-wrap:wrap;gap:5px 10px;font-size:10px;opacity:.55}#diagnostics{overflow-wrap:anywhere}
.card[data-state="saved"] #status{color:#248669}.card[data-state="failed"] #status,.card[data-state="uncertain"] #status{color:light-dark(#a05a27,#e5ae79)}@media(max-width:420px){body{padding:10px}.card{padding:16px}.badge{display:none}dl{grid-template-columns:50px minmax(0,1fr);gap:8px}.steps{gap:5px}.step{font-size:10px}}
</style>
</head>
<body><main class="card" id="card" data-state="waiting">
<header><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6m-3-3 3 3 3-3"/></svg></span><div><h1>保存原文件</h1><p>WebCodex · 自动写回本机</p></div><span class="badge">无需选择文件</span></header>
<p id="status" role="status" aria-live="polite">正在连接宿主文件通道…</p>
<div class="steps" aria-hidden="true"><span class="step" id="step-reference" data-state="active">01 获取文件引用</span><span class="step" id="step-transfer">02 传输至本机</span><span class="step" id="step-save">03 校验并保存</span></div>
<dl><dt>目标位置</dt><dd id="path">等待工具提供目标位置</dd><dt>原文件</dt><dd id="size">大小待确认</dd></dl>
<p id="detail">组件自动获取宿主文件引用，由本机服务下载并校验原文件。</p>
<footer><span>组件 <span id="version"></span></span><span id="bridge">MCP Apps 初始化中</span><span id="diagnostics"></span></footer>
</main>
<script>
(() => {
  'use strict';
  const BUILD_VERSION = ${JSON.stringify(VERSION)};
  const PROTOCOL = '2026-01-26';
  const REQUEST_TIMEOUT_MS = 10000;
  const COMPLETE_TIMEOUT_MS = 75000;
  const API_WAIT_MS = 5000;
  const METADATA_WAIT_MS = 15000;
  const el = id => document.getElementById(id);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => object(value) && Object.prototype.hasOwnProperty.call(value, key);
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  const host = () => window.openai;
  const pending = new Map();
  const SAFE_CODES = new Set(['HOST_FILE_API_UNAVAILABLE','HOST_FILE_REFERENCE_UNAVAILABLE','HOST_FILE_RESOLUTION_FAILED','FILE_SAVE_TRANSFER_UNCERTAIN',
    'FILE_SAVE_INVALID_ARGUMENT','FILE_SAVE_NOT_FOUND','FILE_SAVE_EXPIRED','FILE_SAVE_ACCESS_DENIED','FILE_SAVE_TICKET_INVALID','FILE_SAVE_TICKET_NOT_FOUND','FILE_SAVE_TICKET_EXPIRED','FILE_SAVE_REFERENCE_INVALID','FILE_SAVE_CONFLICT','FILE_SAVE_CAPACITY','FILE_SAVE_BLOCKED',
    'FILE_IMPORT_SOURCE_DENIED','FILE_IMPORT_INVALID_ARGUMENT','FILE_IMPORT_DOWNLOAD_FAILED','FILE_IMPORT_TIMEOUT','FILE_IMPORT_INTEGRITY_ERROR','FILE_IMPORT_ORIGINAL_MISMATCH','FILE_IMPORT_TOO_LARGE','FILE_IMPORT_BUSY','FILE_IMPORT_PROXY_INVALID',
    'DEVICE_MISMATCH','WORKSPACE_NOT_FOUND','WORKSPACE_DISABLED','WORKSPACE_UNAVAILABLE','WORKSPACE_IDENTITY_MISMATCH','READ_ONLY','PATH_DENIED','NOT_FOUND','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','FILE_TOO_LARGE','FILE_WRITE_VERIFICATION_FAILED','EXECUTION_UNKNOWN','ACCESS_DENIED','FILE_BUSY','SERVICE_CLOSING']);
  let nextId = 0, bridgeReady = false, initDone = false, closed = false, terminal = false, ending = false;
  let initial = null, active = null, standardResult = null, attempted = false, completeSubmitted = false, failureReported = false;
  let metadataTimer, apiTimer, wakeApi;
  el('version').textContent = BUILD_VERSION;
  function codeError(code) { const error = new Error('文件保存通道未完成。'); error.code = code; return error; }
  function safeCode(value, fallback = 'FILE_SAVE_TRANSFER_UNCERTAIN') { return typeof value === 'string' && SAFE_CODES.has(value) ? value : fallback; }
  function view(state, text, detail, code) {
    if (closed) return;
    el('card').dataset.state = state; el('status').dataset.state = state; el('status').textContent = text;
    if (detail) el('detail').textContent = detail;
    el('diagnostics').textContent = code ? '错误码：' + safeCode(code) : '';
    const resolved = ['saving','pending','saved','uncertain'].includes(state);
    el('step-reference').dataset.state = resolved ? 'done' : 'active';
    el('step-transfer').dataset.state = state === 'saved' ? 'done' : resolved ? 'active' : '';
    el('step-save').dataset.state = state === 'saved' ? 'done' : '';
  }
  function relativePath(value) {
    if (typeof value !== 'string' || !value || /^[\\/]/.test(value) || /^[a-z]:/i.test(value) || value.includes('\0')) return null;
    const parts = value.replace(/\\/g, '/').split('/');
    if (parts.includes('..')) return null;
    const path = parts.filter(part => part && part !== '.').join('/');
    return path || null;
  }
  function digest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null; }
  function publicIdentity(value) { return [value?.ok, value?.source?.device_id, relativePath(value?.data?.path) ?? value?.data?.path,
    value?.data?.workspace_id, value?.data?.idempotency_key, value?.data?.size_bytes, digest(value?.data?.content_sha256) ?? value?.data?.content_sha256]; }
  function samePublic(left, right) { return publicIdentity(left).every((value, index) => value === publicIdentity(right)[index]); }
  function sameEnvelope(left, right) {
    return samePublic(left, right) && ['status','verified','sha256','error_code'].every(key => left?.data?.[key] === right?.data?.[key])
      && left?.error?.code === right?.error?.code;
  }
  function candidates(input) {
    const values = [], seen = new Set(), queue = [{ value: input, depth: 0 }];
    while (queue.length) {
      const { value, depth } = queue.shift();
      if (!object(value) || seen.has(value)) continue;
      if (depth > 4 || values.length >= 12) return null;
      seen.add(value); values.push(value);
      for (const key of ['mcp_tool_result','call_tool_result','result']) if (own(value, key) && object(value[key])) queue.push({ value: value[key], depth: depth + 1 });
    }
    return values;
  }
  function envelope(input) {
    const list = candidates(input);
    if (!list) return null;
    const entries = list.filter(value => object(value.structuredContent) || typeof value.ok === 'boolean').map(value => ({ outer: value, body: value.structuredContent ?? value, meta: value._meta }));
    if (!entries.length) return null;
    const first = entries[0];
    if (entries.some(entry => !sameEnvelope(first.body, entry.body) || (entry.outer.isError === true) !== (first.outer.isError === true))) return null;
    const withMeta = entries.filter(entry => own(entry.meta, 'webcodexFileSave'));
    if (withMeta.length > 1) {
      const one = withMeta[0].meta.webcodexFileSave;
      if (withMeta.some(entry => ['ticket','file_id','workspace_id','expected_device_id','idempotency_key','expires_at'].some(key => entry.meta.webcodexFileSave?.[key] !== one?.[key]))) return null;
    }
    return withMeta[0] ?? first;
  }
  function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (closed) return Promise.reject(codeError('FILE_SAVE_TRANSFER_UNCERTAIN'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(codeError('FILE_SAVE_TRANSFER_UNCERTAIN')); }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      try { window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); }
      catch { pending.delete(id); clearTimeout(timeout); reject(codeError('FILE_SAVE_TRANSFER_UNCERTAIN')); }
    });
  }
  function bounded(action, timeoutMs, code) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const timer = setTimeout(() => settle(reject, codeError(code)), timeoutMs);
      Promise.resolve().then(action).then(value => settle(resolve, value), () => settle(reject, codeError(code)));
    });
  }
  async function callTool(name, args, timeoutMs = REQUEST_TIMEOUT_MS) {
    try { return await request('tools/call', { name, arguments: args }, timeoutMs); }
    catch (error) {
      // Only a definite unknown method can authorize a second transport. A
      // timeout may already have committed the file and must never be replayed.
      if (error?.code !== -32601 || typeof host()?.callTool !== 'function' || closed) throw error;
      el('bridge').textContent = '宿主兼容工具通道';
      return await bounded(() => host().callTool(name, args), timeoutMs, 'FILE_SAVE_TRANSFER_UNCERTAIN');
    }
  }
  function showFile(body) {
    const data = body?.data;
    if (typeof data?.path === 'string' && data.path.length <= 2048) el('path').textContent = data.path;
    if (Number.isSafeInteger(data?.size_bytes) && data.size_bytes >= 0) el('size').textContent = data.size_bytes.toLocaleString('zh-CN') + ' 字节 · 保留原文件';
  }
  function saved(body) {
    const data = body?.data, expected = initial?.data, path = relativePath(data?.path), sourceHash = digest(expected?.content_sha256);
    return body?.ok === true && body?.source?.device_id === (active?.expected_device_id ?? initial?.source?.device_id)
      && data?.status === 'saved' && data.verified === true && path !== null && path === relativePath(expected?.path)
      && typeof expected?.workspace_id === 'string' && data.workspace_id === expected.workspace_id
      && typeof expected?.idempotency_key === 'string' && data.idempotency_key === expected.idempotency_key
      && (!active || data.workspace_id === active.workspace_id && data.idempotency_key === active.idempotency_key)
      && Number.isSafeInteger(data.size_bytes) && data.size_bytes >= 0 && data.size_bytes === expected?.size_bytes
      && sourceHash !== null && digest(data.sha256) === sourceHash;
  }
  function finish(state, text, detail, code) { terminal = true; ending = true; clearTimeout(metadataTimer); clearTimeout(apiTimer); view(state, text, detail, code); }
  function resultState(raw) {
    const found = envelope(raw);
    if (!found || found.body?.source?.device_id !== (active?.expected_device_id ?? initial?.source?.device_id)) return false;
    const body = found.body, data = body.data;
    if (saved(body) && found.outer.isError !== true) { showFile(body); finish('saved','原文件已保存','已写入目标位置，并完成原文件大小与 SHA-256 校验。'); return true; }
    if (found.outer.isError === true || body.ok === false) {
      finish('failed','文件未完成保存','服务返回了错误；请在对话中查询 fs_save_file_status，核对本次保存结果。',safeCode(body.error?.code)); return true;
    }
    if (body.ok !== true || !object(data)) return false;
    if (data.status === 'pending') { finish('pending','文件保存仍在处理中','当前回执尚未确认保存完成；请在对话中查询 fs_save_file_status。'); return true; }
    if (data.status === 'unknown') { finish('uncertain','保存结果尚未确认','不会重复提交文件；请在对话中查询 fs_save_file_status。','FILE_SAVE_TRANSFER_UNCERTAIN'); return true; }
    if (['failed','expired','not_found','blocked'].includes(data.status)) {
      finish('failed','文件未完成保存','请在对话中查询 fs_save_file_status，查看本次操作的实际状态。',safeCode(data.error_code)); return true;
    }
    return false;
  }
  async function fail(code) {
    if (closed || terminal || ending) return;
    ending = true; clearTimeout(metadataTimer); clearTimeout(apiTimer);
    const uncertain = code === 'FILE_SAVE_TRANSFER_UNCERTAIN';
    const canReport = active && token(active.ticket) && uuid(active.expected_device_id) && !failureReported;
    view(uncertain ? 'uncertain' : 'failed', uncertain ? '保存结果尚未确认' : '宿主文件通道未能完成',
      canReport ? (uncertain ? '不会重复提交文件；正在向本机记录结果未确认状态。' : '已停止自动保存，正在向本机记录具体失败原因。') : '组件没有收到完整的保存信息，已停止自动保存。', code);
    if (canReport) {
      failureReported = true;
      try {
        const result = await callTool('file_save_widget_fail', { ticket: active.ticket, error_code: code, expected_device_id: active.expected_device_id });
        // A late authoritative saved receipt takes priority over a component
        // failure report; the failure endpoint must not overwrite saved state.
        const returned = envelope(result);
        if (returned && saved(returned.body) && returned.outer.isError !== true) { showFile(returned.body); finish('saved','原文件已保存','本机已确认完整原文件保存成功。'); return; }
      } catch { /* A failed status report does not authorize resending the file. */ }
    }
    finish(uncertain ? 'uncertain' : 'failed', uncertain ? '保存结果尚未确认' : '宿主文件通道未能完成',
      uncertain ? '请在对话中查询 fs_save_file_status；不会重复提交原文件。' : '此组件没有完成文件保存；请在对话中查询 fs_save_file_status。', code);
  }
  function waitForApi() {
    const deadline = Date.now() + API_WAIT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const poll = () => {
        if (settled) return;
        clearTimeout(apiTimer);
        if (closed || terminal || ending || Date.now() >= deadline) { settled = true; wakeApi = null; reject(codeError('HOST_FILE_API_UNAVAILABLE')); return; }
        if (typeof host()?.getFileDownloadUrl === 'function') { settled = true; wakeApi = null; resolve(); return; }
        apiTimer = setTimeout(poll, 100);
      };
      wakeApi = poll; poll();
    });
  }
  async function start() {
    if (!active || !initDone || attempted || ending || terminal || closed) return;
    attempted = true; clearTimeout(metadataTimer);
    if (!bridgeReady) { await fail('HOST_FILE_API_UNAVAILABLE'); return; }
    if (typeof active.file_id !== 'string' || !active.file_id || active.file_id.length > 512 || /[\s\\/:]/.test(active.file_id)) { await fail('HOST_FILE_REFERENCE_UNAVAILABLE'); return; }
    try {
      await waitForApi();
      if (closed || ending || terminal) return;
      view('resolving','正在获取宿主原文件引用','由宿主解析文件引用，无需上传、选择或转换文件。');
      const result = await bounded(() => host().getFileDownloadUrl({ fileId: active.file_id }), REQUEST_TIMEOUT_MS, 'HOST_FILE_RESOLUTION_FAILED');
      if (closed || ending || terminal) return;
      if (!object(result) || typeof result.downloadUrl !== 'string' || !result.downloadUrl || result.downloadUrl.length > 16384) { await fail('HOST_FILE_RESOLUTION_FAILED'); return; }
      view('saving','正在传输并校验原文件','本机服务正在下载完整文件；只有校验成功后才会显示已保存。');
      completeSubmitted = true;
      const completed = await callTool('file_save_widget_complete', { ticket: active.ticket, download_url: result.downloadUrl, expected_device_id: active.expected_device_id }, COMPLETE_TIMEOUT_MS);
      if (closed || terminal || ending) return;
      if (!resultState(completed)) await fail('FILE_SAVE_TRANSFER_UNCERTAIN');
    } catch (error) { await fail(completeSubmitted ? 'FILE_SAVE_TRANSFER_UNCERTAIN' : safeCode(error?.code, 'HOST_FILE_RESOLUTION_FAILED')); }
  }
  function accept(input) {
    if (closed || terminal || ending) return;
    const selected = envelope(input);
    if (!selected) return;
    const body = selected.body;
    if (initial && !samePublic(initial, body)) return;
    if (!initial) { initial = body; showFile(body); }
    if (body.ok !== true || body.data?.status !== 'awaiting_host_file') { resultState(input); return; }
    const privateData = selected.meta?.webcodexFileSave;
    if (!object(privateData) || active) return;
    if (!token(privateData.ticket) || !uuid(privateData.expected_device_id) || privateData.expected_device_id !== body.source?.device_id
      || typeof privateData.workspace_id !== 'string' || typeof privateData.idempotency_key !== 'string'
      || body.data.workspace_id !== privateData.workspace_id || body.data.idempotency_key !== privateData.idempotency_key) return;
    active = { ticket: privateData.ticket, file_id: privateData.file_id, workspace_id: privateData.workspace_id,
      expected_device_id: privateData.expected_device_id, idempotency_key: privateData.idempotency_key };
    void start();
  }
  function compatibility() {
    if (closed || terminal || ending) return;
    // Once a standard result supplies its private reference, stale globals
    // cannot replace it. Late API injection still wakes the bounded wait.
    if (attempted || active && object(standardResult?.meta?.webcodexFileSave)) { wakeApi?.(); return; }
    const output = envelope(host()?.toolOutput), metadata = host()?.toolResponseMetadata, wrapped = envelope(metadata);
    const current = standardResult ?? output;
    const publicBody = current?.body ?? initial ?? wrapped?.body;
    const conflict = () => {
      if (publicBody) { initial = publicBody; showFile(publicBody); }
      finish('failed','宿主文件引用不一致','组件收到的文件引用与当前保存目标不一致，已停止自动保存；未提交任何文件。','HOST_FILE_REFERENCE_UNAVAILABLE');
    };
    if (current && output && !sameEnvelope(current.body, output.body)) { conflict(); return; }
    if (publicBody && wrapped && !sameEnvelope(publicBody, wrapped.body)) { conflict(); return; }
    if (publicBody) {
      const direct = object(metadata) && own(metadata, 'webcodexFileSave') && !wrapped ? metadata : wrapped?.meta;
      const chosen = object(current?.meta?.webcodexFileSave) ? current.meta : direct;
      const references = [current?.meta?.webcodexFileSave, direct?.webcodexFileSave].filter(object);
      if (references.some(value => value.expected_device_id !== publicBody.source?.device_id
        || value.workspace_id !== publicBody.data?.workspace_id || value.idempotency_key !== publicBody.data?.idempotency_key)
        || references.length > 1 && ['ticket','file_id','workspace_id','expected_device_id','idempotency_key'].some(key => references[0][key] !== references[1][key])) { conflict(); return; }
      accept({ structuredContent: publicBody, _meta: chosen, isError: current?.outer.isError ?? wrapped?.outer.isError });
    }
    wakeApi?.();
  }
  window.addEventListener('message', event => {
    if (closed || event.source !== window.parent) return;
    const message = event.data;
    if (!object(message) || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timeout);
      if (message.error) item.reject({ code: message.error.code }); else item.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      const selected = envelope(message.params);
      if (selected) {
        if (!attempted && !standardResult) { initial = null; active = null; }
        standardResult = selected; accept(message.params);
      }
      compatibility();
    }
    if (message.method === 'ui/notifications/host-context-changed') compatibility();
  });
  window.addEventListener('openai:set_globals', compatibility);
  window.addEventListener('pagehide', () => {
    closed = true; clearTimeout(metadataTimer); clearTimeout(apiTimer); wakeApi?.();
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(codeError('FILE_SAVE_TRANSFER_UNCERTAIN')); }
    pending.clear();
  });
  async function initialize() {
    try {
      if (window.parent === window) throw codeError('HOST_FILE_API_UNAVAILABLE');
      const response = await request('ui/initialize', { appInfo: { name: 'webcodex-file-save', version: BUILD_VERSION }, appCapabilities: {}, protocolVersion: PROTOCOL });
      if (!object(response) || response.protocolVersion !== PROTOCOL) throw codeError('HOST_FILE_API_UNAVAILABLE');
      if (closed) return;
      bridgeReady = true;
      window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
      el('bridge').textContent = 'MCP Apps 已初始化';
    } catch { el('bridge').textContent = 'MCP Apps 初始化未确认'; }
    finally { initDone = true; compatibility(); void start(); }
  }
  metadataTimer = setTimeout(() => { if (!active && !terminal) void fail(initDone && bridgeReady ? 'HOST_FILE_REFERENCE_UNAVAILABLE' : 'HOST_FILE_API_UNAVAILABLE'); }, METADATA_WAIT_MS);
  compatibility(); void initialize();
})();
</script>
</body>
</html>`;
}
