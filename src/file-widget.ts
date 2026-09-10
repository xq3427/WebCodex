/** Original-byte component delivery, host upload and explicit file-reference handoff. */
import { VERSION } from './version.js';

export const FILE_WIDGET_URI = `ui://webcodex/file-feasibility-${encodeURIComponent(VERSION)}.html`;
/** Finite static-HTML aliases for the preview naming scheme; these are never file endpoints. */
export const LEGACY_FILE_WIDGET_URIS = [
  'ui://webcodex/file-feasibility-v012.html',
  'ui://webcodex/file-feasibility-v012-preview1.html',
  'ui://webcodex/file-feasibility-v012-preview2.html',
  'ui://webcodex/file-feasibility-v012-preview3.html',
  'ui://webcodex/file-feasibility-v012-preview4.html',
  'ui://webcodex/file-feasibility-v012-preview5.html',
  'ui://webcodex/file-feasibility-v012-preview6.html',
  'ui://webcodex/file-feasibility-v012-preview7.html',
  'ui://webcodex/file-feasibility-v012-preview8.html',
  'ui://webcodex/file-feasibility-0.12.0-preview.9.html',
  'ui://webcodex/file-feasibility-0.12.0-preview.10.html',
  'ui://webcodex/file-feasibility-0.12.0-preview.11.html',
  'ui://webcodex/file-feasibility-0.13.0-preview.1.html',
  'ui://webcodex/file-feasibility-0.13.0-preview.2.html',
  'ui://webcodex/file-feasibility-0.14.0-preview.1.html',
] as const;
export const FILE_WIDGET_MIME_TYPE = 'text/html;profile=mcp-app';

/** Static template: filenames, tool results and host errors are rendered with textContent. */
export function renderFileWidget(): string {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WebCodex 原文件</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; font-size: 14px; }
    body { margin: 0; padding: 18px; color: CanvasText; background: Canvas; }
    main { max-width: 760px; margin: auto; }
    h1 { margin: 0 0 8px; font-size: 19px; }
    p { line-height: 1.6; margin: 8px 0; }
    .muted { opacity: .75; }
    dl { display: grid; grid-template-columns: 106px minmax(0, 1fr); gap: 8px 12px; }
    dt { opacity: .75; } dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    fieldset { border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); border-radius: 10px; margin: 16px 0; padding: 14px; }
    legend { padding: 0 6px; }
    button, input { font: inherit; max-width: 100%; }
    button { padding: 8px 12px; border-radius: 7px; cursor: pointer; }
    button:disabled { cursor: default; opacity: .5; }
    input[type="checkbox"] { margin: 0 7px 0 0; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 14px; }
    #status { border-inline-start: 3px solid #5674d4; padding: 8px 12px; background: color-mix(in srgb, #5674d4 8%, Canvas); white-space: pre-wrap; overflow-wrap: anywhere; }
    #status[data-state="failure"], #status[data-state="unavailable"] { border-color: #bb7233; }
    #receipt { white-space: pre-wrap; overflow-wrap: anywhere; }
    details { margin-top: 10px; } summary { cursor: pointer; padding: 5px 0; }
    #compact-file { font-weight: 600; overflow-wrap: anywhere; }
    @media (max-width: 420px) { body { padding: 12px; } dl { grid-template-columns: 82px minmax(0, 1fr); } }
  </style>
</head>
<body>
<main>
  <h1>WebCodex 原文件</h1>
  <p id="compact-file"></p>
  <p id="status" role="status" aria-live="polite" data-state="idle">请选择文件，或从 WebCodex 工具带入已授权的本地原文件。</p>
  <details id="details" open>
  <summary>查看文件、设备与操作</summary>
  <p class="muted">自动模式上传已授权的 MCP 原文件，并在宿主声明支持时尝试发送文件引用；GPT 能否读取正文仍需确认。从浏览器选择的文件始终由你手动上传。</p>
  <fieldset>
    <legend>宿主能力</legend>
    <dl>
      <dt>组件版本</dt><dd id="version">—</dd>
      <dt>当前模式</dt><dd id="operation-mode">manual（手动）</dd>
      <dt>MCP Apps</dt><dd id="bridge">正在初始化…</dd>
      <dt>原文件上传</dt><dd id="upload-capability">检测中…</dd>
      <dt>文件库选择</dt><dd id="library-capability">检测中…</dd>
      <dt>工具调用</dt><dd id="tool-capability">尚未验证</dd>
      <dt>协商摘要</dt><dd id="capabilities-summary">检测中…</dd>
    </dl>
    <div class="actions"><button type="button" id="refresh">重新检测</button><button type="button" id="probe">检查工具通道</button></div>
  </fieldset>
  <fieldset>
    <legend>原文件</legend>
    <dl>
      <dt>设备</dt><dd id="device">—</dd>
      <dt>工作区</dt><dd id="workspace">—</dd>
      <dt>相对路径</dt><dd id="path">—</dd>
      <dt>来源</dt><dd id="source">尚未选择</dd>
      <dt>文件</dt><dd id="filename">—</dd>
      <dt>类型</dt><dd id="mime">—</dd>
      <dt>大小</dt><dd id="size">—</dd>
      <dt>SHA-256</dt><dd id="digest">—</dd>
    </dl>
    <label for="pick">或从当前浏览器所在设备选择原文件：</label>
    <p><input id="pick" type="file"></p>
    <p class="muted" id="policy">本机工作区原文件的有效上限将由服务返回。组件上传策略默认 100 MiB，宿主可能另有限制；上传策略不会扩大本机读取上限。</p>
    <label><input id="library" type="checkbox">同时保存到 ChatGPT 文件库（是否支持以宿主结果为准）</label>
    <div class="actions"><button type="button" id="upload" disabled>上传完整原文件</button><button type="button" id="send" disabled>发送给 GPT 读取</button><button type="button" id="compat-send" disabled>兼容性试发文件引用</button><button type="button" id="clear">清除所选文件 / 取消读取</button></div>
    <p id="compat-status" class="muted">兼容性试发仅供手动验证未声明文件类型的宿主，不代表正式支持。每个上传回执最多试发一次。</p>
  </fieldset>
  <p id="receipt"></p>
  <p id="sync-status" role="status" aria-live="polite">模型状态同步：等待上传结果。</p>
  <p id="send-status" role="status" aria-live="polite">文件引用：等待上传。发送引用后仍需确认 GPT 能否读取原文件。</p>
  <p id="message-ack-shape" class="muted">宿主回执形态：尚未采集。</p>
  <p id="close-status"></p>
  </details>
</main>
<script>
(() => {
  'use strict';
  const BUILD_VERSION = ${JSON.stringify(VERSION)};
  const HOST_REQUEST_TIMEOUT_MS = 10000;
  const INLINE_LIMIT = 7 * 1024 * 1024;
  const PICK_RESOURCE_CEILING = 512 * 1024 * 1024;
  let pickLimit = 100 * 1024 * 1024;
  const el = (id) => document.getElementById(id);
  const pending = new Map();
  let nextId = 0;
  let generation = 0;
  let selectedFile = null;
  let selectedSha = null;
  let selectedSource = { source: 'browser' };
  let uploadedFile = null;
  let sending = false;
  let syncVersion = 0;
  let activeDelivery = null;
  let currentUi = { mode: 'manual', compact: false, closeAfterSend: false };
  const automaticAttempts = new Map();
  const deliveryOrder = new Map();
  let latestDeliveryOrder = 0;
  let lastModelSnapshot = null;
  let persistenceQueue = Promise.resolve();
  let modelSyncQueue = Promise.resolve();
  let currentFileData = null;
  let activeProbeData = null;
  let lastProbeSyncKey;
  let busy = false;
  let probing = false;
  let bridgeReady = false;
  let hostCapabilities = {};
  let initialization = null;
  let authoritativeResult = null;
  let allowMetadataEnrichment = false;
  let pendingDelivery = null;
  let lastCompatibilityFields;
  let lastCompatibilityBytes;
  let lastCompatibilityIdentity = null;
  let lastDeliveryKey;
  let lastDeliveryBytes;

  const host = () => window.openai;
  const hasUpload = () => typeof host()?.uploadFile === 'function';
  const isCapabilityObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const canSendReference = () => bridgeReady && isCapabilityObject(hostCapabilities.message) && isCapabilityObject(hostCapabilities.message.resourceLink);
  const referenceBlockedText = '默认路线已阻断：宿主未声明 resourceLink 消息类型，自动发送已停止；这不代表宿主实际拒绝过该文件引用。继续等待或重复上传不会补足能力声明，上传回执已保留。';
  const canCompatibilityProbe = (snapshot = uploadedFile) => bridgeReady && isCapabilityObject(hostCapabilities.message)
    && capabilitySummary().message.declaration === 'empty' && snapshot && snapshot === uploadedFile && !snapshot.referenceSent
    && (snapshot.referenceAttempt ?? 'not_attempted') === 'not_attempted';
  function capabilitySummary() {
    const modalities = ['text', 'image', 'audio', 'resource', 'resourceLink', 'structuredContent'];
    const contentCapability = (name) => {
      const capability = hostCapabilities[name];
      if (!isCapabilityObject(capability)) return { declaration: 'absent', modalities: [] };
      const declared = modalities.filter((modality) => isCapabilityObject(capability[modality]));
      return { declaration: declared.length ? 'modalities' : 'empty', modalities: declared };
    };
    return { initialization: bridgeReady ? 'ready' : 'not_ready', message: contentCapability('message'),
      update_model_context: contentCapability('updateModelContext'), compatibility: {
        uploadFile: hasUpload(), getFileDownloadUrl: typeof host()?.getFileDownloadUrl === 'function',
        selectFiles: typeof host()?.selectFiles === 'function', sendFollowUpMessage: typeof host()?.sendFollowUpMessage === 'function'
      } };
  }
  function handoffStatus(snapshot) {
    if (snapshot.referenceSent) return 'reference_sent';
    if (!bridgeReady) return 'host_initialization_pending';
    return canSendReference() ? 'uploaded_awaiting_reference' : 'host_file_reference_not_declared';
  }
  function refreshUploadedDiagnostics() {
    if (!uploadedFile || busy || sending) return;
    if (lastModelSnapshot?.file_id === uploadedFile.fileId && lastModelSnapshot.handoff_status === handoffStatus(uploadedFile)
      && JSON.stringify(lastModelSnapshot.host_capabilities) === JSON.stringify(capabilitySummary())) return;
    void synchronizeUpload(uploadedFile);
  }
  function modelSyncRoute() {
    const supported = hostCapabilities.updateModelContext;
    if (bridgeReady && isCapabilityObject(supported)) {
      if (isCapabilityObject(supported.structuredContent)) return 'structured';
      if (isCapabilityObject(supported.text)) return 'text';
    }
    return typeof host()?.setWidgetState === 'function' ? 'widget_state' : 'unavailable';
  }
  function refreshProbeDiagnostics() {
    if (!activeProbeData || activeProbeData !== currentFileData || currentFileData.mode !== 'capabilities'
      || selectedFile || uploadedFile || busy || sending) return;
    const data = activeProbeData;
    const token = generation;
    const route = modelSyncRoute();
    const summary = capabilitySummary();
    const key = JSON.stringify([token, route, summary]);
    if (lastProbeSyncKey === key) return;
    lastProbeSyncKey = key;
    const version = ++syncVersion;
    const isCurrent = () => token === generation && version === syncVersion && activeProbeData === data && currentFileData === data
      && !selectedFile && !uploadedFile && !busy && !sending;
    const state = { kind: 'webcodex_host_capabilities', component_version: BUILD_VERSION, host_capabilities: summary, upload_performed: false,
      file_read_performed: false, model_access: 'unverified', context_scope: 'future_turns',
      ...(typeof data.device_id === 'string' ? { device_id: data.device_id.slice(0, 128) } : {}),
      ...(typeof data.instance_id === 'string' ? { instance_id: data.instance_id.slice(0, 128) } : {}) };
    lastModelSnapshot = state;
    if (route === 'unavailable') {
      write('sync-status', '能力摘要同步未确认：宿主尚未提供可用的模型上下文同步接口。当前摘要仍可在组件详情查看。');
      return;
    }
    write('sync-status', '能力摘要同步：正在提交白名单能力信息，未读取或上传文件…');
    void (async () => {
      try {
        const synchronized = await enqueueModelState(state, isCurrent, route);
        if (synchronized && isCurrent()) write('sync-status', '已提交能力摘要，供后续轮次使用；不能保证当前答复已经看到这些信息。未读取或上传文件。');
      } catch (error) {
        if (isCurrent()) write('sync-status', '能力摘要同步未确认：' + errorText(error) + ' 当前摘要仍可在组件详情查看。');
      }
    })();
  }
  const formatBytes = (bytes) => bytes.toLocaleString() + ' 字节（' + (bytes / 1048576).toFixed(2) + ' MiB）';
  const write = (id, text) => { el(id).textContent = text; };
  const errorText = (error) => typeof error?.message === 'string' ? error.message.slice(0, 500) : '宿主没有返回可读的错误详情。';
  const setStatus = (state, text) => {
    el('status').dataset.state = state;
    write('status', text);
    if (state === 'failure' || state === 'unavailable') el('details').open = true;
  };
  function controls() {
    el('upload').disabled = busy || probing || sending || !selectedFile || !hasUpload() || Boolean(uploadedFile);
    el('pick').disabled = busy || sending;
    el('clear').disabled = (busy && el('status').dataset.state === 'uploading') || sending;
    el('library').disabled = busy || !hasUpload();
    el('probe').disabled = busy || probing || sending;
    el('send').disabled = busy || sending || !uploadedFile || uploadedFile.referenceSent || !canSendReference();
    el('compat-send').disabled = busy || probing || sending || !canCompatibilityProbe();
  }
  function resumeAutomatic() {
    if (hasUpload() && selectedFile && !busy && !probing && !sending && !uploadedFile
      && currentUi.mode === 'automatic' && selectedSource.source === 'mcp' && !automaticAttempts.has(selectedSource.delivery_id)) void runAutomatic(generation);
  }
  function detectCapabilities() {
    if (restoreAutomaticAttempts() && currentFileData) restoreKnownSelection(currentFileData);
    write('capabilities-summary', JSON.stringify(capabilitySummary(), null, 2));
    write('upload-capability', hasUpload() ? 'uploadFile 可用；实际格式与大小限制待上传验证' : 'uploadFile 不可用：当前宿主不能通过此组件上传');
    write('library-capability', typeof host()?.selectFiles === 'function' ? 'selectFiles 可用；保存与加入对话仍待验证' : 'selectFiles 不可用或未注入');
    if (!bridgeReady) write('tool-capability', typeof host()?.callTool === 'function' ? '兼容接口可用；尚未实际调用' : '尚未验证');
    if (uploadedFile && !uploadedFile.referenceSent && (uploadedFile.referenceAttempt ?? 'not_attempted') === 'not_attempted'
      && !canSendReference() && !sending) write('send-status', bridgeReady ? referenceBlockedText : 'MCP Apps 尚未初始化完成，宿主文件引用支持情况未知；上传回执已保留。');
    if (!hasUpload() && !busy && !selectedFile && el('status').dataset.state !== 'restored') setStatus('unavailable', '当前宿主未提供原文件上传接口。可重新检测，或使用 ChatGPT 自带的附件上传入口。');
    if (hasUpload() && !busy && selectedFile && el('status').dataset.state === 'unavailable') setStatus('ready', currentUi.mode === 'automatic'
      ? '宿主上传接口现已可用，正在继续已授权原文件的自动处理。' : '宿主上传接口现已可用。所选原文件尚未上传，请点击上传验证。');
    if (!hasUpload() && !busy && selectedFile && el('status').dataset.state === 'ready') setStatus('unavailable', '当前宿主未提供 uploadFile，所选原文件尚未上传。');
    controls();
    refreshUploadedDiagnostics();
    refreshProbeDiagnostics();
    resumeAutomatic();
  }
  function clearSelection(resetDelivery = false, preserveReceipt = false) {
    generation++;
    cancelDelivery();
    selectedFile = null;
    selectedSha = null;
    selectedSource = { source: 'browser' };
    currentFileData = null;
    activeProbeData = null;
    currentUi = { mode: 'manual', compact: false, closeAfterSend: false };
    write('operation-mode', 'manual（手动）');
    el('details').open = true;
    uploadedFile = null;
    syncVersion++;
    if (resetDelivery) { lastDeliveryKey = undefined; lastDeliveryBytes = undefined; }
    el('pick').value = '';
    for (const id of ['device', 'workspace', 'path', 'filename', 'mime', 'size', 'digest']) write(id, '—');
    write('source', '尚未选择');
    write('compact-file', '');
    write('close-status', '');
    write('compat-status', '兼容性试发仅供手动验证未声明文件类型的宿主，不代表正式支持。每个上传回执最多试发一次。');
    if (!preserveReceipt) write('receipt', '');
    write('send-status', '文件引用：等待上传。发送引用后仍需确认 GPT 能否读取原文件。');
    write('message-ack-shape', '宿主回执形态：尚未采集。');
    setStatus('idle', '请选择文件，或从 WebCodex 工具带入已授权的本地原文件。');
    controls();
  }
  function displayFile(file, source, digest) {
    write('source', source);
    write('filename', file.name);
    write('compact-file', file.name + ' · ' + formatBytes(file.size));
    write('mime', file.type || 'application/octet-stream');
    write('size', formatBytes(file.size));
    write('digest', digest || '浏览器原始 File；没有执行文本提取或格式转换');
  }
  const label = (name, id) => [name, id].filter((x) => typeof x === 'string' && x.length).join(' / ').slice(0, 2048) || '—';
  function unpack(result) {
    const structured = result?.structuredContent;
    const data = structured?.data ?? structured;
    if (structured?.ok === false || !data || data.prototype !== true || !['capabilities', 'local-file'].includes(data.mode)) return null;
    return { ...data, device_id: data.device_id ?? structured?.source?.device_id, device_name: data.device_name ?? structured?.source?.device_name,
      instance_id: data.instance_id ?? structured?.source?.instance_id };
  }
  function probeWouldReplaceFile(result) {
    return unpack(result)?.mode === 'capabilities' && Boolean(selectedFile || uploadedFile);
  }
  function fileIdentity(result) {
    const data = unpack(result);
    if (result?.isError || !data || data.mode !== 'local-file') return null;
    return JSON.stringify([data.mode, data.device_id, data.device_name, data.instance_id, data.workspace_id, data.workspace_uid,
      data.workspace_name, data.path, data.name, data.mime_type, data.size_bytes, data.sha256, data.max_upload_bytes, data.inline_max_bytes,
      data.effective_local_file_max_bytes, data.snapshot_cache_max_bytes, data.delivery_id,
      data.ui?.mode, data.ui?.compact, data.ui?.close_after_send]);
  }
  function deliveryFields(result, data = unpack(result)) {
    return [result?.isError === true || result?.structuredContent?.ok === false,
      data?.mode, data?.device_id, data?.device_name, data?.instance_id, data?.workspace_id, data?.workspace_uid, data?.workspace_name,
      data?.path, data?.name, data?.mime_type, data?.size_bytes, data?.sha256, data?.max_upload_bytes,
      data?.inline_max_bytes, data?.effective_local_file_max_bytes, data?.snapshot_cache_max_bytes, data?.delivery_id,
      data?.ui?.mode, data?.ui?.compact, data?.ui?.close_after_send,
      result?._meta?.webcodexFile?.name, result?._meta?.webcodexFile?.mimeType, result?._meta?.webcodexFile?.sizeBytes, result?._meta?.webcodexFile?.sha256,
      result?._meta?.webcodexDelivery?.ticketId, result?._meta?.webcodexDelivery?.expiresAt, result?._meta?.webcodexDelivery?.chunkMaxBytes, result?._meta?.webcodexDelivery?.deliveryId];
  }
  function resultCandidates(metadata) {
    const candidates = [], seen = new Set(), queue = [{ value: metadata, depth: 0 }];
    while (queue.length) {
      const { value, depth } = queue.shift();
      if (!isCapabilityObject(value) || seen.has(value)) continue;
      // Reject incomplete scans: an unseen branch might contain a conflicting result.
      if (depth > 4 || candidates.length >= 12) return null;
      seen.add(value); candidates.push(value);
      for (const key of ['mcp_tool_result', 'call_tool_result']) {
        if (Object.prototype.hasOwnProperty.call(value, key) && isCapabilityObject(value[key])) queue.push({ value: value[key], depth: depth + 1 });
      }
    }
    return candidates;
  }
  function samePrivateFile(left, right) {
    for (const [key, fields] of [
      ['webcodexDelivery', ['ticketId', 'deliveryId', 'expiresAt', 'chunkMaxBytes']],
      ['webcodexFile', ['name', 'mimeType', 'sizeBytes', 'sha256', 'base64']],
    ]) {
      if (Boolean(left?.[key]) !== Boolean(right?.[key])) return false;
      if (fields.some(field => left?.[key]?.[field] !== right?.[key]?.[field])) return false;
    }
    return true;
  }
  function compatibilityEnvelope(output, metadata) {
    const candidates = resultCandidates(metadata);
    const envelopes = candidates?.filter(value => value.structuredContent !== undefined || value.isError === true) ?? [];
    const current = authoritativeResult ?? (output ? { structuredContent: output } : envelopes[0]);
    if (!current) return null;
    const visible = { structuredContent: current.structuredContent, isError: current.isError };
    const identity = fileIdentity(current);
    if (!identity) {
      if (!authoritativeResult && envelopes.some(value => value.isError === true || value.structuredContent?.ok === false)) return { ...visible, isError: true };
      return visible;
    }
    const withoutPrivateMetadata = () => {
      const selectedIdentity = fileIdentity({ structuredContent: currentFileData });
      // A same-file compatibility echo cannot revoke verified bytes, an upload
      // receipt, or an explicit clear. A genuinely new public toolOutput must
      // still replace the previous selection while waiting for its own ticket.
      if (identity === selectedIdentity || identity === lastCompatibilityIdentity
        || (!output && (selectedIdentity || lastCompatibilityIdentity))) return null;
      return visible;
    };
    // The standard bridge's current identity takes precedence over compatibility echoes.
    if (authoritativeResult && output && fileIdentity({ structuredContent: output }) !== identity) return null;
    if (!candidates || envelopes.some(value => fileIdentity(value) !== identity)) return withoutPrivateMetadata();
    const privateResults = envelopes.filter(value => value._meta?.webcodexFile || value._meta?.webcodexDelivery);
    let hidden = privateResults[0]?._meta;
    if (privateResults.some(value => !samePrivateFile(hidden, value._meta))) return withoutPrivateMetadata();
    // Legacy hosts pair a direct hidden-metadata object with the current toolOutput.
    // Never borrow an anonymous nested envelope's _meta or merge separate candidates.
    if (!hidden && output && candidates.length === 1 && !envelopes.length && (metadata?.webcodexFile || metadata?.webcodexDelivery)) hidden = metadata;
    return hidden ? { ...visible, _meta: hidden } : withoutPrivateMetadata();
  }
  function applyPolicy(data) {
    if (data.max_upload_bytes === undefined) return;
    if (!Number.isSafeInteger(data.max_upload_bytes) || data.max_upload_bytes < 1 || data.max_upload_bytes > PICK_RESOURCE_CEILING) throw new Error('组件上传策略配置无效，拒绝接受该工具结果。');
    pickLimit = data.max_upload_bytes;
    const localLimit = data.effective_local_file_max_bytes;
    if (localLimit !== undefined && (!Number.isSafeInteger(localLimit) || localLimit < 1 || localLimit > INLINE_LIMIT ||
        localLimit > pickLimit || [data.inline_max_bytes, data.snapshot_cache_max_bytes].some((limit) => limit !== undefined && (!Number.isSafeInteger(limit) || limit < localLimit)))) {
      throw new Error('本机原文件有效上限配置无效，拒绝接受该工具结果。');
    }
    const localPolicy = localLimit === undefined
      ? '此次响应未提供本机工作区原文件的有效上限；请查看服务状态。'
      : '本机工作区原文件有效上限为 ' + formatBytes(localLimit) + '（无其他快照占用缓存时）；已有文件占用缓存时可能暂时拒绝。';
    write('policy', localPolicy + '组件交给宿主上传的文件策略上限为 ' + formatBytes(pickLimit) + '，宿主可能另有限制。上传策略和分块读取均不会扩大本机原文件上限。');
  }
  function applyUi(data) {
    currentUi = { mode: data.ui?.mode === 'automatic' ? 'automatic' : 'manual', compact: data.ui?.compact === true,
      closeAfterSend: data.ui?.close_after_send === true };
    el('details').open = !currentUi.compact;
    write('operation-mode', currentUi.mode === 'automatic' ? 'automatic（自动）' : 'manual（手动）');
  }
  function acceptDeliveryOrder(result) {
    const data = unpack(result);
    if (!data?.delivery_id) return true;
    const key = data.device_id + '/' + data.delivery_id;
    if (!deliveryOrder.has(key)) deliveryOrder.set(key, ++latestDeliveryOrder);
    return deliveryOrder.get(key) === latestDeliveryOrder;
  }
  async function persistAutomaticState(state = lastModelSnapshot, isCurrent = () => true) {
    if (typeof host()?.setWidgetState !== 'function') return false;
    const persist = persistenceQueue.catch(() => {}).then(async () => {
      if (!isCurrent()) return false;
      const attempts = [...automaticAttempts].slice(-32).map(([deliveryId, attempt]) => ({ deliveryId, stage: attempt.stage }));
      await host().setWidgetState({ modelContent: state ?? { kind: 'webcodex_file_status', model_access: 'unverified' },
        privateContent: { webcodexAutomatic: attempts } });
      return isCurrent();
    });
    persistenceQueue = persist;
    return await persist;
  }
  async function recordAutomaticAttempt(deliveryId, stage, token = generation) {
    automaticAttempts.set(deliveryId, { stage });
    try { await persistAutomaticState(); return true; }
    catch (error) {
      if (generation === token) {
        write('close-status', '自动流程恢复状态未保存：' + errorText(error));
        el('details').open = true;
      }
      return false;
    }
  }
  function restoreAutomaticAttempts() {
    const records = host()?.widgetState?.privateContent?.webcodexAutomatic;
    if (!Array.isArray(records) || records.length > 32) return false;
    let changed = false;
    for (const record of records) {
      if (typeof record?.deliveryId === 'string' && /^[0-9a-f-]{36}$/i.test(record.deliveryId)
        && ['upload_started', 'upload_failed', 'send_started', 'send_failed', 'sent'].includes(record.stage) && !automaticAttempts.has(record.deliveryId)) {
        automaticAttempts.set(record.deliveryId, { stage: record.stage, restored: true });
        changed = true;
      }
    }
    return changed;
  }
  function restoreKnownSelection(data) {
    const record = automaticAttempts.get(data?.delivery_id);
    if (currentUi.mode !== 'automatic' || !record?.restored) return false;
    generation++;
    cancelDelivery();
    busy = false;
    selectedFile = null;
    uploadedFile = null;
    allowMetadataEnrichment = false;
    write('compact-file', typeof data.name === 'string' ? data.name.slice(0, 1024) : '原文件');
    write('filename', typeof data.name === 'string' ? data.name.slice(0, 1024) : '—');
    if (record.stage === 'sent') {
      setStatus('restored', '已恢复原文件引用发送完成的记录，不会重复读取、上传或发送。');
      write('send-status', '此前已记录引用发送完成；文件内容的回答请查看对话。');
    } else {
      setStatus('restored', '已恢复之前的自动尝试记录，结果需检查，不会重复操作。');
      el('details').open = true;
      write('send-status', '请先检查对话与文件库。需要重试时请重新打开原文件获取新凭据，或在此手动选择文件。');
    }
    controls();
    return true;
  }
  function validateFile(file) {
    if (!file || typeof file.name !== 'string' || !file.name.length || file.name.length > 1024 || /[\u0000-\u001f\u007f/\\]/.test(file.name)) throw new Error('原文件元数据缺失，或文件名称无效。');
    if (typeof file.mimeType !== 'string' || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.mimeType) || file.mimeType.length > 255) throw new Error('原文件 MIME 类型无效。');
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > INLINE_LIMIT) throw new Error('当前 MCP 原文件入口最多接收 7 MiB；分块不会扩大服务的文件总量上限。');
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('原文件 SHA-256 元数据无效。');
    if (!globalThis.crypto?.subtle?.digest || typeof globalThis.File !== 'function') throw new Error('当前组件环境缺少 SHA-256 或 File 支持，无法安全重建原文件。');
  }
  function decodeBytes(base64, expectedSize) {
    if (typeof base64 !== 'string' || base64.length !== 4 * Math.ceil(expectedSize / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('原文件 Base64 长度或编码无效。');
    const binary = atob(base64);
    if (binary.length !== expectedSize || btoa(binary) !== base64) throw new Error('原文件 Base64 内容不完整或不规范。');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  async function shaHex(bytes) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
  }
  function privateChunkEnvelope(result, args) {
    const candidates = resultCandidates(result);
    if (!candidates) throw new Error('文件分块响应包装超过检查范围，已停止读取。');
    if (candidates.some(value => (value.isError !== undefined && value.isError !== false) || value.structuredContent?.ok === false)) throw new Error('组件文件工具调用失败。');
    const envelopes = candidates.filter(value => value.structuredContent !== undefined);
    // Only a complete envelope may supply private bytes. An anonymous sibling's
    // _meta cannot be attached to another result's public source or chunk fields.
    const complete = envelopes.filter(value => typeof value._meta?.webcodexChunk?.base64 === 'string');
    const selected = complete[0], structured = selected?.structuredContent, chunk = structured?.data;
    if (structured?.ok !== true || structured?.source?.device_id !== args.expected_device_id
      || chunk?.ticket_id !== args.ticket_id || chunk?.offset !== args.offset) throw new Error('未收到与本次请求匹配的完整私有文件分块。');
    const fields = (value) => {
      const envelope = value?.structuredContent, data = envelope?.data;
      return [envelope?.ok, envelope?.source?.device_id, envelope?.source?.device_name, envelope?.source?.instance_id,
        data?.ticket_id, data?.offset, data?.size_bytes, data?.total_bytes, data?.next_offset, data?.eof, data?.sha256, data?.chunk_sha256];
    };
    const identity = fields(selected);
    if (envelopes.some(value => fields(value).some((field, index) => field !== identity[index]))) throw new Error('响应包装中的文件分块身份或范围冲突，已停止读取。');
    if (complete.some(value => value._meta.webcodexChunk.base64 !== selected._meta.webcodexChunk.base64)) throw new Error('响应包装中的文件分块原字节冲突，已停止读取。');
    // readDelivery still validates the original source instance, exact range,
    // per-chunk SHA-256 and whole-file SHA-256 before any upload is possible.
    return selected;
  }
  function callCompatibilityTool(name, args) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      const timeout = setTimeout(() => finish(reject, new Error('兼容工具宿主响应超时；本次调用结果未确认。')), HOST_REQUEST_TIMEOUT_MS);
      // Timing out does not cancel the host operation. Consume late settlements
      // without replaying the call or letting them change a newer selection.
      Promise.resolve().then(() => host().callTool(name, args)).then(
        result => finish(resolve, result), error => finish(reject, error));
    });
  }
  async function callAppTool(name, args) {
    let result;
    const standardCall = async () => {
      try { return await request('tools/call', { name, arguments: args }); }
      catch (error) {
        // A timeout is an unknown outcome; only a definite unsupported method allows fallback.
        if (error?.code === -32601 && typeof host()?.callTool === 'function') return await callCompatibilityTool(name, args);
        throw error;
      }
    };
    if (bridgeReady && hostCapabilities.serverTools) result = await standardCall();
    else if (typeof host()?.callTool === 'function') result = await callCompatibilityTool(name, args);
    else {
      await initializeBridge();
      if (!bridgeReady) throw new Error('当前宿主没有可用的工具调用桥接。');
      result = await standardCall();
    }
    const normalized = name === 'file_widget_read' ? privateChunkEnvelope(result, args)
      : result?.mcp_tool_result ?? result?.call_tool_result ?? result;
    if (normalized?.isError || normalized?.structuredContent?.ok === false) throw new Error(normalized?.structuredContent?.error?.message || '组件文件工具调用失败。');
    return normalized;
  }
  async function releaseDelivery(delivery) {
    if (!delivery || delivery.released) return;
    delivery.released = true;
    try { await callAppTool('file_widget_release', { ticket_id: delivery.ticketId, expected_device_id: delivery.deviceId }); } catch { /* Service TTL also bounds cleanup. */ }
  }
  function cancelDelivery() {
    if (activeDelivery) { void releaseDelivery(activeDelivery); activeDelivery = null; }
  }
  async function readDelivery(data, descriptor, token) {
    if (typeof descriptor.ticketId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(descriptor.ticketId)
      || typeof data.device_id !== 'string' || !data.device_id.length) throw new Error('文件读取凭据缺失或无效。');
    const delivery = { ticketId: descriptor.ticketId, deviceId: data.device_id, released: false };
    activeDelivery = delivery;
    try {
      if (typeof data.delivery_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.delivery_id)
        || descriptor.deliveryId !== data.delivery_id) throw new Error('文件交付标识不一致，请重新打开原文件。');
      const deadline = typeof descriptor.expiresAt === 'string' ? Date.parse(descriptor.expiresAt) : NaN;
      if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('文件读取凭据已过期，请重新打开原文件。');
      const chunkMax = descriptor.chunkMaxBytes;
      if (!Number.isSafeInteger(chunkMax) || chunkMax < 4096 || chunkMax > 262144) throw new Error('文件分块大小超出组件支持范围。');
      const bytes = new Uint8Array(data.size_bytes);
      let offset = 0;
      do {
        if (generation !== token || delivery.released) return null;
        if (Date.now() >= deadline) throw new Error('文件读取凭据已过期，请重新打开原文件。');
        setStatus('receiving', '正在读取完整原文件：' + formatBytes(offset) + ' / ' + formatBytes(data.size_bytes));
        const result = await callAppTool('file_widget_read', { ticket_id: delivery.ticketId, expected_device_id: delivery.deviceId, offset });
        if (generation !== token || delivery.released) return null;
        const envelope = result?.structuredContent;
        const chunk = envelope?.data;
        const expectedSize = Math.min(chunkMax, data.size_bytes - offset);
        const nextOffset = offset + expectedSize;
        const isLast = nextOffset === data.size_bytes;
        if (envelope?.source?.device_id !== data.device_id || (data.instance_id && envelope?.source?.instance_id !== data.instance_id)
          || chunk?.ticket_id !== delivery.ticketId || chunk?.offset !== offset || chunk?.size_bytes !== expectedSize
          || chunk?.total_bytes !== data.size_bytes || chunk?.sha256 !== data.sha256 || chunk?.eof !== isLast
          || chunk?.next_offset !== (isLast ? null : nextOffset)) throw new Error('文件分块身份、范围或完整文件元数据不一致。');
        if (typeof chunk.chunk_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(chunk.chunk_sha256)) throw new Error('文件分块 SHA-256 元数据无效。');
        const decoded = decodeBytes(result?._meta?.webcodexChunk?.base64, expectedSize);
        if (await shaHex(decoded) !== chunk.chunk_sha256) throw new Error('文件分块 SHA-256 不一致，已停止读取。');
        if (generation !== token || delivery.released) return null;
        bytes.set(decoded, offset);
        offset = nextOffset;
        if (isLast) break;
      } while (offset < data.size_bytes);
      return bytes;
    } finally {
      if (activeDelivery === delivery) activeDelivery = null;
      void releaseDelivery(delivery);
    }
  }
  function enqueueModelState(state, isCurrent, route) {
    const synchronize = modelSyncQueue.catch(() => {}).then(async () => {
      if (!isCurrent()) return false;
      const currentRoute = route ?? modelSyncRoute();
      if (currentRoute === 'structured' || currentRoute === 'text') {
        const result = await request('ui/update-model-context', currentRoute === 'structured' ? { structuredContent: state }
          : { content: [{ type: 'text', text: JSON.stringify(state) }] });
        if (!isCapabilityObject(result) || (result.isError !== undefined && result.isError !== false)) throw new Error('宿主没有确认接受模型状态。');
      } else if (currentRoute === 'widget_state') {
        if (!await persistAutomaticState(state, isCurrent)) return false;
      } else throw new Error('宿主未提供模型上下文同步接口。');
      return isCurrent();
    });
    modelSyncQueue = synchronize;
    return synchronize;
  }
  async function synchronizeUpload(snapshot) {
    const version = ++syncVersion;
    const isCurrent = () => version === syncVersion && generation === snapshot.generation && uploadedFile === snapshot;
    const handoff = handoffStatus(snapshot);
    const state = { kind: 'webcodex_file_upload', file_name: snapshot.name.slice(0, 512), size_bytes: snapshot.sizeBytes,
      sha256: snapshot.sha256, file_id: snapshot.fileId, upload_performed: true,
      file_reference_sent: snapshot.referenceSent, model_access: 'unverified', source: snapshot.source.source,
      reference_attempt: snapshot.referenceAttempt ?? 'not_attempted',
      reference_attempt_instruction: snapshot.referenceAttempt === 'compatibility_probe_started'
        ? 'A one-time manual compatibility experiment using a standard resource_link has started. The host did not declare file modalities; do not repeat this attempt.'
        : snapshot.referenceAttempt === 'compatibility_probe_accepted'
          ? 'The host accepted the compatibility experiment. This does not establish formal file-modality support or confirm access to the original body.'
          : snapshot.referenceAttempt === 'compatibility_probe_unconfirmed'
            ? 'The one-time compatibility experiment was not confirmed. Do not repeat this snapshot or infer body access from uploading again.'
            : 'No manual compatibility experiment has been attempted for this uploaded snapshot.',
      host_capabilities: capabilitySummary(), handoff_status: handoff,
      handoff_instruction: snapshot.referenceAttempt === 'compatibility_probe_started'
        ? 'A one-time compatibility experiment is in progress for undeclared file modalities. The result is pending; do not repeat this attempt or claim body access.'
        : snapshot.referenceAttempt === 'compatibility_probe_unconfirmed'
          ? 'A one-time compatibility experiment was attempted but not confirmed. This snapshot will not be retried. File-modality support and original body access remain unverified.'
          : handoff === 'host_file_reference_not_declared'
        ? 'This host did not declare resourceLink message support, so the default route stops before sending. This is not a host rejection result. Waiting or uploading again does not establish support. Do not claim to have read the original body.'
        : handoff === 'reference_sent' ? 'The host accepted the file-reference message; access to the original body remains unverified.'
        : handoff === 'host_initialization_pending' ? 'Host initialization is not complete, so file-reference support is unknown. The uploaded file reference has not been delivered.'
        : 'The original file was uploaded, but its reference has not been sent to the conversation.',
      device_id: typeof snapshot.source.device_id === 'string' ? snapshot.source.device_id.slice(0, 128) : undefined,
      workspace_id: typeof snapshot.source.workspace_id === 'string' ? snapshot.source.workspace_id.slice(0, 128) : undefined,
      delivery_id: typeof snapshot.source.delivery_id === 'string' ? snapshot.source.delivery_id.slice(0, 128) : undefined };
    lastModelSnapshot = state;
    if (isCurrent()) write('sync-status', '模型状态同步：正在发送少量上传状态…');
    try {
      const synchronized = await enqueueModelState(state, isCurrent);
      if (synchronized && isCurrent()) write('sync-status', '模型状态同步：已提交上传状态，供后续轮次使用；这不代表文件附件已可读。');
      return synchronized && isCurrent();
    } catch (error) {
      if (isCurrent()) write('sync-status', '模型状态同步未确认：' + errorText(error) + ' 文件上传回执仍然有效。');
      return false;
    }
  }
  async function receiveToolResult(result, preserveReceipt = false) {
    const data = unpack(result);
    const failed = result?.isError === true || result?.structuredContent?.ok === false;
    if (!data && !failed) return;
    if (probeWouldReplaceFile(result)) return;
    if (!acceptDeliveryOrder(result)) return;
    if ((busy && el('status').dataset.state === 'uploading') || sending) { pendingDelivery = result; return; }
    // Do not replay identical deliveries on globals/theme changes or bridge compatibility echoes.
    // Keep the binary reference private; do not serialize it into model context or widget state.
    const key = JSON.stringify(deliveryFields(result, data));
    const deliveryBytes = result?._meta?.webcodexFile?.base64;
    if (!failed && lastDeliveryKey === key && lastDeliveryBytes === deliveryBytes) {
      if (data?.mode === 'capabilities') refreshProbeDiagnostics();
      return;
    }
    lastDeliveryKey = key;
    lastDeliveryBytes = deliveryBytes;
    if (failed) {
      busy = false;
      clearSelection(false, preserveReceipt);
      setStatus('failure', '新的 MCP 工具调用失败，已清除之前选择的文件。请检查工具错误后重新选择。');
      return;
    }
    const token = ++generation;
    cancelDelivery();
    selectedFile = null;
    selectedSha = null;
    selectedSource = { source: 'mcp', device_id: data.device_id, workspace_id: data.workspace_id, delivery_id: data.delivery_id };
    currentFileData = data;
    activeProbeData = null;
    uploadedFile = null;
    syncVersion++;
    el('pick').value = '';
    busy = false;
    if (!preserveReceipt) write('receipt', '');
    write('device', label(data.device_name, data.device_id));
    write('workspace', label(data.workspace_name, data.workspace_id));
    write('path', typeof data.path === 'string' ? data.path.slice(0, 4096) : '—');
    for (const id of ['filename', 'mime', 'size', 'digest']) write(id, '—');
    try { applyPolicy(data); } catch (error) { setStatus('failure', errorText(error)); controls(); return; }
    applyUi(data);
    write('close-status', '');
    write('message-ack-shape', '宿主回执形态：尚未采集。');
    write('compat-status', '兼容性试发仅供手动验证未声明文件类型的宿主，不代表正式支持。每个上传回执最多试发一次。');
    if (data.mode === 'capabilities') {
      activeProbeData = data;
      write('source', '宿主能力验证；尚未选择文件');
      setStatus(hasUpload() ? 'idle' : 'unavailable', '能力探针已收到工具结果；未读取或上传文件。摘要会尝试提交供后续轮次使用，详情也可直接查看。');
      controls();
      refreshProbeDiagnostics();
      return;
    }
    if (restoreKnownSelection(data)) return;
    busy = true;
    write('source', '授权的 MCP 原文件；正在校验原始字节');
    setStatus('verifying', '正在验证 MCP 原文件大小和 SHA-256…');
    controls();
    const descriptor = result?._meta?.webcodexDelivery;
    let ticketClaimed = false;
    let readyForAutomatic = false;
    try {
      if (!descriptor && !result?._meta?.webcodexFile) throw new Error('已收到文件信息，但尚未收到匹配的组件私有读取凭据或原文件数据；原文件尚未读取或上传。');
      const file = descriptor ? { name: data.name, mimeType: data.mime_type, sizeBytes: data.size_bytes, sha256: data.sha256 } : result?._meta?.webcodexFile;
      validateFile(file);
      if (data.name !== file.name || data.mime_type !== file.mimeType || data.size_bytes !== file.sizeBytes || data.sha256 !== file.sha256) throw new Error('模型可见元数据与组件原文件元数据不一致。');
      ticketClaimed = Boolean(descriptor);
      const bytes = descriptor ? await readDelivery(data, descriptor, token) : decodeBytes(file.base64, file.sizeBytes);
      if (!bytes || generation !== token) return;
      setStatus('verifying', '原文件字节接收完成，正在验证完整 SHA-256…');
      const hash = await shaHex(bytes);
      if (generation !== token) return;
      if (hash !== file.sha256) throw new Error('SHA-256 不一致：已拒绝上传，需重新读取原文件。');
      selectedFile = new File([bytes], file.name, { type: file.mimeType });
      selectedSha = hash;
      // A verified file completes enrichment for this standard result. Later compatibility
      // echoes must not reset its selection or upload receipt; failed verification stays retryable.
      if (allowMetadataEnrichment && fileIdentity(result) === fileIdentity(authoritativeResult)) allowMetadataEnrichment = false;
      displayFile(selectedFile, 'MCP 授权原文件；原字节 SHA-256 校验通过', hash);
      setStatus(hasUpload() ? 'ready' : 'unavailable', hasUpload()
        ? (currentUi.mode === 'automatic' ? '原始字节校验通过，正在自动交给 GPT 处理。' : '原始字节校验通过。点击上传完整原文件后才会调用 ChatGPT 上传接口。')
        : '原始字节校验通过，但当前宿主未提供 uploadFile。');
      readyForAutomatic = true;
    } catch (error) {
      if (generation !== token) return;
      selectedFile = null;
      setStatus('failure', errorText(error));
    } finally {
      if (descriptor && !ticketClaimed && typeof descriptor.ticketId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(descriptor.ticketId) && typeof data.device_id === 'string')
        void releaseDelivery({ ticketId: descriptor.ticketId, deviceId: data.device_id, released: false });
      if (generation === token) {
        busy = false; controls();
        if (readyForAutomatic) void runAutomatic(token);
      }
    }
  }

  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('MCP Apps 宿主响应超时。'));
      }, HOST_REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  async function initializeBridge() {
    if (bridgeReady || initialization) return initialization;
    initialization = (async () => {
      try {
        if (window.parent === window) throw new Error('未在 MCP Apps 宿主中打开。');
        const response = await request('ui/initialize', {
          appInfo: { name: 'webcodex-file-feasibility', version: BUILD_VERSION },
          appCapabilities: {},
          protocolVersion: '2026-01-26'
        });
        if (!response || response.protocolVersion !== '2026-01-26') throw new Error('宿主没有协商支持的 MCP Apps 协议版本。');
        hostCapabilities = response.hostCapabilities ?? {};
        bridgeReady = true;
        notify('ui/notifications/initialized', {});
        write('bridge', 'MCP Apps 初始化成功');
        write('tool-capability', hostCapabilities.serverTools ? '宿主声明 serverTools 可用；尚未实际调用' : '宿主未声明 serverTools 支持；可点击检查工具通道实测');
      } catch (error) {
        write('bridge', errorText(error) + ' 可继续检测兼容上传接口。');
      } finally {
        initialization = null;
        detectCapabilities();
      }
    })();
    return initialization;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timeout);
      if (message.error) entry.reject(message.error); else entry.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      if (!unpack(message.params) && message.params?.isError !== true && message.params?.structuredContent?.ok !== false) return;
      if (probeWouldReplaceFile(message.params)) return;
      if (!acceptDeliveryOrder(message.params)) return;
      authoritativeResult = message.params;
      allowMetadataEnrichment = fileIdentity(message.params) !== null && !message.params?._meta?.webcodexFile && !message.params?._meta?.webcodexDelivery;
      void receiveToolResult(message.params);
      if (allowMetadataEnrichment) compatibilityResult(true);
    }
    if (message.method === 'ui/notifications/host-context-changed') detectCapabilities();
  });
  const compatibilityResult = (force = false) => {
    detectCapabilities();
    const output = host()?.toolOutput;
    const metadata = host()?.toolResponseMetadata;
    if (authoritativeResult) {
      if (!allowMetadataEnrichment || !fileIdentity(authoritativeResult)) return;
    }
    const result = compatibilityEnvelope(output, metadata);
    if (!result) return;
    if (authoritativeResult && !result._meta?.webcodexFile && !result._meta?.webcodexDelivery) return;
    // Reinspect globals even when the host mutates a wrapper in place. Compare only
    // recognized file fields and the private byte string; never serialize host metadata.
    const fields = deliveryFields(result), bytes = result._meta?.webcodexFile?.base64;
    // A newly delivered error must still invalidate a later browser selection, even
    // when its public error text is identical to an earlier failed invocation.
    if (result.isError === true || result.structuredContent?.ok === false) fields.push(result.structuredContent ?? metadata);
    if (force !== true && lastCompatibilityFields && fields.length === lastCompatibilityFields.length
      && fields.every((value, index) => value === lastCompatibilityFields[index]) && bytes === lastCompatibilityBytes) return;
    lastCompatibilityFields = fields;
    lastCompatibilityBytes = bytes;
    lastCompatibilityIdentity = fileIdentity(result);
    void receiveToolResult(result);
  };
  window.addEventListener('openai:set_globals', compatibilityResult);

  el('pick').addEventListener('change', () => {
    if (busy || sending) return;
    allowMetadataEnrichment = false;
    const file = el('pick').files?.[0];
    clearSelection();
    if (!file) return;
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > pickLimit) {
      setStatus('failure', '超出当前浏览器选择策略上限 ' + formatBytes(pickLimit) + '。此值不是 ChatGPT 的上传限额。');
      return;
    }
    selectedFile = file;
    displayFile(file, '用户在当前浏览器所在设备选择的原始文件', null);
    setStatus(hasUpload() ? 'ready' : 'unavailable', hasUpload() ? '已选择原始文件，尚未上传。点击上传验证宿主；成功后仍需加入当前对话。' : '已选择原始文件，但当前宿主未提供 uploadFile。');
    controls();
  });
  el('clear').addEventListener('click', () => {
    if (!sending && !(busy && el('status').dataset.state === 'uploading')) {
      busy = false; allowMetadataEnrichment = false; clearSelection(true); detectCapabilities();
    }
  });
  el('refresh').addEventListener('click', () => { detectCapabilities(); void initializeBridge(); });
  el('probe').addEventListener('click', async () => {
    if (busy || probing || sending) return;
    const token = generation;
    probing = true;
    controls();
    write('tool-capability', '正在调用只读能力探针…');
    try {
      const result = await callAppTool('file_widget_probe', {});
      const data = unpack(result);
      if (result?.isError || !data || data.mode !== 'capabilities') throw new Error('工具通道未返回有效的能力探针结果。');
      if (generation !== token) return;
      applyPolicy(data);
      if (!selectedFile && !uploadedFile) await receiveToolResult(result);
      write('tool-capability', 'file_widget_probe 调用成功；未读取本地文件');
    } catch (error) { if (generation === token) write('tool-capability', '调用失败：' + errorText(error)); }
    finally { probing = false; controls(); refreshProbeDiagnostics(); resumeAutomatic(); }
  });
  async function uploadSelected() {
    if (busy || probing || sending || !selectedFile || !hasUpload() || uploadedFile) return;
    if (!Number.isSafeInteger(selectedFile.size) || selectedFile.size < 0 || selectedFile.size > pickLimit) {
      selectedFile = null;
      setStatus('failure', '所选文件超过当前组件上传策略上限 ' + formatBytes(pickLimit) + '，已阻止上传。');
      controls();
      return;
    }
    const file = selectedFile;
    const token = generation;
    const attemptSource = { ...selectedSource };
    const attemptSha = selectedSha;
    let completed = null;
    const attemptedFile = file.name + '（' + formatBytes(file.size) + '）';
    const attemptedLocation = ['device', 'workspace', 'path'].map(id => el(id).textContent).filter(value => value && value !== '—').join(' / ');
    const saveToLibrary = el('library').checked;
    busy = true;
    setStatus('uploading', '正在调用 ChatGPT 上传接口。请等待宿主返回；此接口没有提供可靠的字节进度。');
    controls();
    try {
      const result = saveToLibrary ? await host().uploadFile(file, { library: true }) : await host().uploadFile(file);
      if (!result || typeof result.fileId !== 'string' || !result.fileId.trim() || result.fileId.length > 512) throw new Error('宿主未返回有效 fileId，无法确认上传成功。请先检查文件库，避免重复上传。');
      uploadedFile = { name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size,
        sha256: attemptSha, source: attemptSource, fileId: result.fileId, referenceSent: false, referenceAttempt: 'not_attempted', generation: token };
      completed = uploadedFile;
      write('receipt', '上次上传文件：' + attemptedFile + (attemptedLocation ? '\n来源：' + attemptedLocation : '')
        + '\n宿主返回的 fileId：' + result.fileId + '\n已上传，仍待确认加入当前对话。');
      setStatus('uploaded-awaiting-attachment', '宿主已返回上传成功。' + (saveToLibrary ? '已请求保存到文件库。' : '')
        + (bridgeReady && !canSendReference() ? '当前文件引用路线已阻断，继续等待或重复上传不会使正文可读。'
          : !bridgeReady ? 'MCP Apps 尚未初始化完成，文件引用支持情况未知；上传回执已保留。'
          : currentUi.mode === 'automatic' ? '正在继续交给 GPT 处理；模型读取仍待确认。' : '可点击“发送给 GPT 读取”发送原文件引用；对话附件及模型读取仍待确认。'));
      write('send-status', canSendReference()
        ? (currentUi.mode === 'automatic' ? '正在自动发送原文件引用；不会重复上传原文件。' : '文件引用尚未发送。请点击“发送给 GPT 读取”；不会重复上传原文件。')
        : bridgeReady ? referenceBlockedText : 'MCP Apps 尚未初始化完成，宿主文件引用支持情况未知；上传回执已保留。');
      if (bridgeReady && !canSendReference()) el('details').open = true;
      void synchronizeUpload(uploadedFile);
    } catch (error) {
      write('receipt', '上次上传尝试未确认：' + attemptedFile + (attemptedLocation ? '\n来源：' + attemptedLocation : '') + '\n' + errorText(error));
      setStatus('failure', '上传未确认：' + errorText(error) + ' 重试前请检查文件库，避免重复上传。');
    } finally {
      busy = false;
      if (pendingDelivery) {
        const next = pendingDelivery;
        pendingDelivery = null;
        await receiveToolResult(next, true);
      }
      controls();
    }
    return completed;
  }
  async function sendUploaded(expectedSnapshot = uploadedFile, token = generation, compatibilityProbe = false) {
    if (busy || probing || sending || !uploadedFile || uploadedFile !== expectedSnapshot || generation !== token || uploadedFile.referenceSent
      || !(compatibilityProbe ? canCompatibilityProbe(expectedSnapshot) : canSendReference())) return false;
    const snapshot = uploadedFile;
    const closeAfterSend = !compatibilityProbe && currentUi.closeAfterSend;
    let accepted = false;
    let ackObserved = false;
    let completionSaved = true;
    let finalSynchronized = false;
    sending = true;
    if (compatibilityProbe) {
      snapshot.referenceAttempt = 'compatibility_probe_started';
      write('compat-status', '已开始本回执唯一一次兼容性试发。仅发送标准文件引用；宿主尚未声明文件类型支持，结果待确认。');
    }
    controls();
    setStatus('uploaded-awaiting-attachment', '原文件已上传，正在交给 GPT 继续处理。');
    write('send-status', '正在向 GPT 发送原文件引用；文件不会再次上传。');
    write('message-ack-shape', '宿主回执形态：等待本次回应。');
    try {
      if (compatibilityProbe) void synchronizeUpload(snapshot);
      const content = [];
      if (!compatibilityProbe && isCapabilityObject(hostCapabilities.message.text)) content.push({ type: 'text', text: '请继续完成我刚才针对这个原文件的请求，直接依据文件内容回答。如果无法访问这个文件引用，请明确说明原因；不要把上传或发送成功当作已经读过正文。' });
      content.push({ type: 'resource_link', uri: snapshot.fileId, name: snapshot.name, mimeType: snapshot.mimeType, size: snapshot.sizeBytes });
      const result = await request('ui/message', { role: 'user', content });
      ackObserved = true;
      // Only fixed shape labels reach the diagnostic UI. Do not copy host keys,
      // payloads, error values, file contents or references into this description.
      const shape = result === null ? 'null' : result === undefined ? 'undefined'
        : Array.isArray(result) ? 'array' : typeof result === 'object' ? 'object' : 'primitive';
      const errorShape = shape !== 'object' || result.isError === undefined ? 'absent'
        : result.isError === false ? 'false' : result.isError === true ? 'true' : 'invalid';
      write('message-ack-shape', '宿主回执形态：result_shape=' + shape + '；is_error=' + errorShape + '。');
      if (!isCapabilityObject(result) || (result.isError !== undefined && result.isError !== false)) throw new Error('宿主没有确认接受文件引用消息。');
      snapshot.referenceSent = true;
      if (compatibilityProbe) {
        snapshot.referenceAttempt = 'compatibility_probe_accepted';
        write('compat-status', '宿主已接受本次兼容性试发。仍需实际验证正文能否读取；此结果不代表正式支持。不会重复试发或自动收起组件。');
      }
      accepted = true;
      if (automaticAttempts.has(snapshot.source.delivery_id)) completionSaved = await recordAutomaticAttempt(snapshot.source.delivery_id, 'sent', token);
      setStatus('uploaded-awaiting-attachment', '原文件引用已发送，等待 GPT 继续处理。');
      write('send-status', '原文件引用已发送，等待 GPT 确认能否读取并回答。消息接受回执不代表文件已经解析。');
      finalSynchronized = await synchronizeUpload(snapshot);
      if (!finalSynchronized && generation === token && uploadedFile === snapshot) {
        write('close-status', '原文件引用已发送，但最终状态同步未确认，组件保持打开。');
        el('details').open = true;
      }
    } catch (error) {
      if (!ackObserved) write('message-ack-shape', '宿主回执形态：未收到可检查结果（请求失败或超时）。');
      if (compatibilityProbe) {
        snapshot.referenceAttempt = 'compatibility_probe_unconfirmed';
        write('compat-status', '本次兼容性试发未确认：' + errorText(error) + ' 本回执不会再试发；原上传回执保留。');
      }
      if (automaticAttempts.has(snapshot.source.delivery_id)) await recordAutomaticAttempt(snapshot.source.delivery_id, 'send_failed', token);
      el('details').open = true;
      setStatus('uploaded-awaiting-attachment', '原文件已上传，发送引用未确认。请展开详情检查后再操作。');
      write('send-status', '文件引用发送未确认：' + errorText(error) + (compatibilityProbe
        ? ' 请检查对话中是否出现文件引用；本回执的兼容性试发不会重试，无需重新上传。'
        : ' 请先查看是否已经出现新消息；未出现再重试发送引用。无需重新上传文件。'));
      if (compatibilityProbe) await synchronizeUpload(snapshot);
    } finally {
      sending = false;
      if (pendingDelivery) {
        const next = pendingDelivery;
        pendingDelivery = null;
        await receiveToolResult(next, true);
      }
      controls();
    }
    if (accepted && completionSaved && finalSynchronized && closeAfterSend && generation === token && uploadedFile === snapshot && !pendingDelivery && typeof host()?.requestClose === 'function') {
      try {
        await host().requestClose();
        if (generation === token) write('close-status', '已请求宿主收起组件。');
      } catch (error) {
        if (generation === token) {
          write('close-status', '原文件引用已发送，但自动收起未成功：' + errorText(error));
          el('details').open = true;
        }
      }
    }
    return accepted;
  }
  async function runAutomatic(token) {
    const deliveryId = selectedSource.delivery_id;
    if (busy || probing || sending || !selectedFile || uploadedFile || generation !== token || currentUi.mode !== 'automatic' || selectedSource.source !== 'mcp'
      || typeof deliveryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(deliveryId)) return;
    const previous = automaticAttempts.get(deliveryId);
    if (previous) {
      if (previous.restored) {
        el('details').open = true;
        setStatus('ready', '已恢复之前的自动处理记录，不会重复上传或发送。请先检查对话和文件库，再决定是否手动操作。');
      }
      return;
    }
    if (!hasUpload()) {
      setStatus('unavailable', '正在等待宿主原文件上传接口；接口就绪后会继续本次已授权的自动处理。');
      controls();
      return;
    }
    const expectedFile = selectedFile;
    const savedUpload = await recordAutomaticAttempt(deliveryId, 'upload_started', token);
    if (generation !== token || selectedFile !== expectedFile || selectedSource.source !== 'mcp' || selectedSource.delivery_id !== deliveryId) return;
    if (!savedUpload) {
      setStatus('ready', '自动流程已停止：无法保存恢复状态。可展开详情检查后手动操作。');
      controls();
      return;
    }
    if (!hasUpload()) { setStatus('unavailable', '当前宿主不支持原文件上传，自动流程已停止。'); return; }
    const snapshot = await uploadSelected();
    if (!snapshot) {
      await recordAutomaticAttempt(deliveryId, 'upload_failed', token);
      if (generation === token) el('details').open = true;
      return;
    }
    if (generation !== token || uploadedFile !== snapshot || pendingDelivery) return;
    if (!bridgeReady) await initializeBridge();
    if (generation !== token || uploadedFile !== snapshot || pendingDelivery) return;
    if (!canSendReference()) {
      await recordAutomaticAttempt(deliveryId, 'send_failed', token);
      if (generation !== token || uploadedFile !== snapshot || pendingDelivery) return;
      el('details').open = true;
      setStatus('uploaded-awaiting-attachment', bridgeReady
        ? '文件已上传，但宿主未声明 resourceLink 消息支持。当前路线已阻断，继续等待或重复上传不会使正文可读。'
        : '文件已上传，但 MCP Apps 初始化未完成，尚不能判断文件引用能力。本次自动流程已停止；上传回执已保留。');
      write('send-status', bridgeReady ? referenceBlockedText : '文件引用未发送：MCP Apps 初始化未完成，宿主支持情况未知。请检查初始化状态；无需重复上传。');
      await synchronizeUpload(snapshot);
      return;
    }
    const savedSend = await recordAutomaticAttempt(deliveryId, 'send_started', token);
    if (generation !== token || uploadedFile !== snapshot || pendingDelivery) return;
    if (!savedSend) {
      setStatus('uploaded-awaiting-attachment', '原文件已上传，自动发送已停止：无法保存恢复状态。可展开详情检查后手动发送。');
      controls();
      return;
    }
    await sendUploaded(snapshot, token);
  }
  el('upload').addEventListener('click', () => uploadSelected());
  el('send').addEventListener('click', () => sendUploaded());
  el('compat-send').addEventListener('click', () => sendUploaded(uploadedFile, generation, true));
  write('version', BUILD_VERSION);
  write('operation-mode', 'manual（手动）');
  restoreAutomaticAttempts();
  compatibilityResult();
  void initializeBridge();
})();
</script>
</body>
</html>`;
}
