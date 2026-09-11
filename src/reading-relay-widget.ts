import { VERSION } from './version.js';

export const READING_RELAY_URI = `ui://webcodex/reading-relay-${VERSION}.html`;

/** Self-contained host probe. Only an ordinary tool result may carry its computed text to the model. */
export function renderReadingRelayWidget(): string {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WebCodex 阅读通道验证</title>
  <style>
    :root { color-scheme: light dark; font: 14px system-ui, sans-serif; }
    body { margin: 0; padding: 14px; color: CanvasText; background: Canvas; }
    h1 { margin: 0 0 8px; font-size: 16px; }
    p { line-height: 1.5; margin: 7px 0; }
    #status { border-inline-start: 3px solid #5674d4; padding-inline-start: 10px; }
    #status[data-state="failure"], #status[data-state="expired"] { border-color: #bb7233; }
    .muted { opacity: .75; font-size: 12px; }
  </style>
</head>
<body>
<main>
  <h1>WebCodex 阅读通道验证</h1>
  <p id="status" role="status" aria-live="polite" data-state="waiting">正在连接组件工具通道…</p>
  <p class="muted">自动验证组件内容能否作为普通工具结果返回。此步骤不读取本地文件；模型实际读到内容仍需对话回答确认。</p>
  <p class="muted">组件版本：<span id="version"></span> · <span id="bridge">正在初始化 MCP Apps</span></p>
  <p id="diagnostics" class="muted"></p>
</main>
<script>
(() => {
  'use strict';
  const BUILD_VERSION = ${JSON.stringify(VERSION)};
  const PROTOCOL_VERSION = '2026-01-26';
  const MAX_LIFETIME_MS = 120000;
  const REQUEST_TIMEOUT_MS = 10000;
  const POLL_INTERVAL_MS = 500;
  const startedAt = Date.now();
  const el = (id) => document.getElementById(id);
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const privateToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  const identifier = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const pending = new Map();
  const SAFE_ERROR_CODES = new Set(['RELAY_INVALID_ARGUMENT', 'RELAY_CAPACITY', 'RELAY_CANCELLED', 'RELAY_BUSY', 'RELAY_TIMEOUT',
    'RELAY_PAYLOAD_TOO_LARGE', 'RELAY_STALE_SUBMISSION', 'RELAY_INVALID_CONTENT', 'RELAY_CLOSED', 'RELAY_NOT_FOUND',
    'RELAY_EXPIRED', 'RELAY_ACCESS_DENIED', 'RELAY_READ_LIMIT', 'HOST_TIMEOUT', 'HOST_UNAVAILABLE', 'UNSUPPORTED_PROTOCOL',
    'INVALID_RESPONSE', 'INVALID_METADATA', 'CRYPTO_UNAVAILABLE', 'COMPONENT_CLOSED']);
  const compatibilityPending = new Set();
  let nextId = 0;
  let bridgeReady = false;
  let serverTools = false;
  let initialization;
  let stopped = false;
  let active = null;
  let loopTimer;
  let expiryTimer;
  let phase = 'initialize';
  const host = () => window.openai;
  el('version').textContent = BUILD_VERSION;

  function status(state, text) {
    el('status').dataset.state = state;
    el('status').textContent = text;
  }
  function codedError(code) { const error = new Error('组件验证失败。'); error.code = code; return error; }
  function safeCode(error) {
    const code = error?.code;
    if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) return code;
    if (Number.isSafeInteger(code) && code >= -2147483648 && code <= 2147483647) return 'JSON_RPC_' + code;
    return 'UNKNOWN_ERROR';
  }
  function diagnostics(stage, error) {
    // Only fixed phase names and allowlisted codes reach the UI; host error text may contain credentials.
    el('diagnostics').textContent = '阶段：' + stage + ' · 错误码：' + safeCode(error);
  }
  function fail(stage, error, text) {
    if (stopped) return;
    diagnostics(stage, error);
    finish('failure', text);
  }
  function finish(state, text) {
    if (stopped) return;
    stopped = true;
    clearTimeout(loopTimer);
    clearTimeout(expiryTimer);
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error('组件验证已结束。'));
    }
    pending.clear();
    for (const cancel of compatibilityPending) cancel();
    compatibilityPending.clear();
    active = null;
    status(state, text);
  }
  function expire() {
    if (stopped) return;
    diagnostics(phase, codedError('RELAY_EXPIRED'));
    finish('expired', '本次组件验证已到期。尚未证明模型读到内容，请重新发起验证。');
  }
  expiryTimer = setTimeout(expire, MAX_LIFETIME_MS);

  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }
  function request(method, params) {
    if (stopped) return Promise.reject(new Error('组件验证已结束。'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(codedError('HOST_TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
      try { window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); }
      catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
    });
  }
  function compatibilityCall(name, args) {
    if (stopped) return Promise.reject(new Error('组件验证已结束。'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        compatibilityPending.delete(cancel);
        callback(value);
      };
      const cancel = () => settle(reject, new Error('组件验证已结束。'));
      const timeout = setTimeout(() => settle(reject, codedError('HOST_TIMEOUT')), REQUEST_TIMEOUT_MS);
      compatibilityPending.add(cancel);
      Promise.resolve().then(() => {
        if (stopped) throw new Error('组件验证已结束。');
        return host().callTool(name, args);
      }).then(value => settle(resolve, value), error => settle(reject, error));
    });
  }
  async function initialize() {
    try {
      if (window.parent === window) throw codedError('HOST_UNAVAILABLE');
      const result = await request('ui/initialize', {
        appInfo: { name: 'webcodex-reading-relay', version: BUILD_VERSION }, appCapabilities: {}, protocolVersion: PROTOCOL_VERSION
      });
      if (stopped) return;
      if (!object(result) || result.protocolVersion !== PROTOCOL_VERSION) throw codedError('UNSUPPORTED_PROTOCOL');
      bridgeReady = true;
      serverTools = object(result.hostCapabilities?.serverTools);
      notify('ui/notifications/initialized', {});
      el('bridge').textContent = serverTools ? 'MCP Apps 工具通道已声明' : 'MCP Apps 已初始化，检测兼容工具通道';
    } catch (error) {
      if (!stopped) el('bridge').textContent = 'MCP Apps 初始化未确认（' + safeCode(error) + '），检测兼容工具通道';
    }
  }
  async function callTool(name, args) {
    let result;
    // Prefer the standard bridge after negotiation. Unknown outcomes are never replayed.
    if (bridgeReady && serverTools) {
      try { result = await request('tools/call', { name, arguments: args }); }
      catch (error) {
        if (error?.code !== -32601 || typeof host()?.callTool !== 'function' || stopped) throw error;
        el('bridge').textContent = '使用宿主兼容工具通道';
        result = await compatibilityCall(name, args);
      }
    } else if (typeof host()?.callTool === 'function') {
      el('bridge').textContent = '使用宿主兼容工具通道';
      result = await compatibilityCall(name, args);
    } else throw codedError('HOST_UNAVAILABLE');
    for (let depth = 0; depth < 4 && object(result); depth++) {
      if (result.isError === true) throw codedError(result.structuredContent?.error?.code ?? result.error?.code);
      if (object(result.structuredContent)) { result = result.structuredContent; break; }
      if (object(result.mcp_tool_result)) result = result.mcp_tool_result;
      else if (object(result.call_tool_result)) result = result.call_tool_result;
      else break;
    }
    if (object(result) && result.ok === false) throw codedError(result.error?.code);
    if (!object(result) || result.ok !== true || !object(result.data)) throw codedError('INVALID_RESPONSE');
    return result.data;
  }
  function current(descriptor) { return !stopped && active === descriptor && Date.now() < descriptor.deadline; }
  async function poll(descriptor) {
    if (!current(descriptor)) { if (!stopped) expire(); return; }
    try {
      phase = 'poll';
      const args = { relay_id: descriptor.relayId, ticket: descriptor.ticket };
      const result = await callTool('reading_probe_poll', args);
      if (!current(descriptor)) { if (!stopped) expire(); return; }
      if (result.relay_id !== undefined && result.relay_id !== descriptor.relayId) throw codedError('INVALID_RESPONSE');
      if (result.status === 'complete') {
        finish('returned', '服务已缓存组件验证文本，普通读取工具现在可取得内容。模型是否实际读到，请以对话中的实际回答确认。');
        return;
      }
      if (result.status === 'pending') {
        if (!identifier(result.request_id)) throw codedError('INVALID_RESPONSE');
        phase = 'submit';
        status('returning', '正在自动保存组件计算的验证文本…');
        // Await submission before any next poll; a long or parallel poll can block it in serialized hosts.
        const submitted = await callTool('reading_probe_submit', { ...args, request_id: result.request_id, text: descriptor.text });
        if (!current(descriptor)) { if (!stopped) expire(); return; }
        if (submitted.accepted !== true || typeof submitted.duplicate !== 'boolean') throw codedError('INVALID_RESPONSE');
        finish('returned', '组件验证文本已缓存，普通读取工具现在可取得内容。模型是否实际读到，请以对话中的实际回答确认。');
        return;
      }
      if (result.status !== 'idle') throw codedError('INVALID_RESPONSE');
      status('waiting', '组件任务正在准备，稍后自动检查状态；无需点击。');
      loopTimer = setTimeout(() => { void poll(descriptor); }, POLL_INTERVAL_MS);
    } catch (error) {
      fail(phase, error, '组件工具通道未完成验证，已停止。请检查 reading_probe_read 返回的诊断；不会把组件显示当作模型已读取。');
    }
  }
  async function start(descriptor) {
    try {
      phase = 'digest';
      if (!globalThis.crypto?.subtle?.digest || typeof TextEncoder !== 'function') throw codedError('CRYPTO_UNAVAILABLE');
      const bytes = new TextEncoder().encode('webcodex-reading-relay-v1:' + descriptor.challenge);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      if (!current(descriptor)) { if (!stopped) expire(); return; }
      descriptor.text = 'WebCodex browser relay: ' + Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
      descriptor.challenge = null;
      // Compatibility-only hosts may never answer ui/initialize. Begin automatic
      // preparation immediately when their own tool bridge already exists.
      if (!bridgeReady && typeof host()?.callTool !== 'function') { phase = 'initialize'; await initialization; }
      if (!current(descriptor)) { if (!stopped) expire(); return; }
      await poll(descriptor);
    } catch (error) {
      fail(phase, error, '组件无法完成本次自动验证。未读取本地文件，也未确认模型取得内容。');
    }
  }
  function receive(result, metadata) {
    if (stopped || !object(result)) return;
    const publicResult = object(result.structuredContent) ? result.structuredContent : result;
    const privateData = result._meta?.webcodexReadingRelay ?? metadata?.webcodexReadingRelay;
    if (privateData === undefined) return;
    const data = publicResult.data;
    const expires = object(privateData) && typeof privateData.expires_at === 'string' ? Date.parse(privateData.expires_at) : NaN;
    if (result.isError === true || publicResult.ok !== true || !object(data) || data.prototype !== true
      || !object(privateData) || !identifier(privateData.relay_id) || data.relay_id !== privateData.relay_id
      || !privateToken(privateData.ticket) || !privateToken(privateData.challenge)
      || !Number.isFinite(expires) || data.expires_at !== privateData.expires_at) {
      fail('initialize', codedError('INVALID_METADATA'), '验证元数据无效，已停止。请重新发起阅读通道验证。');
      return;
    }
    if (active) {
      // One resource instance owns one relay; duplicate host notifications must not start more loops.
      if (active.relayId !== privateData.relay_id || active.ticket !== privateData.ticket) {
        fail('initialize', codedError('INVALID_METADATA'), '组件收到不同验证任务的数据，已停止以避免交叉提交。');
      }
      return;
    }
    if (expires <= Date.now()) { expire(); return; }
    active = { relayId: privateData.relay_id, ticket: privateData.ticket, challenge: privateData.challenge,
      deadline: Math.min(expires, startedAt + MAX_LIFETIME_MS), text: null };
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(expire, Math.max(0, active.deadline - Date.now()));
    status('waiting', '正在自动准备组件内容；无需选择文件或点击上传。');
    void start(active);
  }
  function compatibilityResult() {
    const api = host();
    receive(api?.toolOutput, api?.toolResponseMetadata);
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || !object(event.data) || event.data.jsonrpc !== '2.0') return;
    const message = event.data;
    if (message.method === 'ui/resource-teardown') {
      finish('closed', '组件已关闭，验证已停止。');
      if (typeof message.id === 'string' || typeof message.id === 'number') {
        window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
      }
      return;
    }
    if (stopped) return;
    if (message.method === undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timeout);
      if (message.error) entry.reject(message.error); else entry.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      const result = message.params;
      receive(result);
      // Some hosts expose private metadata only through compatibility globals.
      if (!active && !stopped && object(result?.structuredContent) && !result._meta?.webcodexReadingRelay) {
        const output = host()?.toolOutput;
        const data = object(output?.structuredContent) ? output.structuredContent.data : output?.data;
        if (data?.relay_id === result.structuredContent.data?.relay_id) compatibilityResult();
      }
    }
  });
  window.addEventListener('openai:set_globals', compatibilityResult);
  window.addEventListener('pagehide', () => finish('closed', '组件已关闭，验证已停止。'));
  initialization = initialize();
  compatibilityResult();
})();
</script>
</body>
</html>`;
}
