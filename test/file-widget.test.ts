import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import { FILE_WIDGET_MIME_TYPE, FILE_WIDGET_URI, renderFileWidget } from '../src/file-widget.js';
import { VERSION } from '../src/version.js';

type Handler = (event: any) => unknown;
class Element {
  textContent = '';
  disabled = false;
  checked = false;
  value = '';
  files: any[] = [];
  dataset: Record<string, string> = {};
  listeners = new Map<string, Handler[]>();
  set innerHTML(_value: string) { throw new Error('Dynamic HTML injection is forbidden'); }
  addEventListener(name: string, handler: Handler) {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]);
  }
  async trigger(name: string) {
    for (const handler of this.listeners.get(name) ?? []) await handler({ target: this });
  }
}

function harness(host: Record<string, any> = {}, options: { digest?: (algorithm: string, bytes: Uint8Array) => Promise<ArrayBuffer>; rpc?: (request: any) => unknown | Promise<unknown> } = {}) {
  const html = renderFileWidget();
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.get('status')!.dataset.state = 'idle';
  const listeners = new Map<string, Handler[]>();
  const sent: any[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0, decodeCalls = 0;
  let deliver: ((data: unknown) => Promise<void>) | undefined;
  const parent = { postMessage: (data: any, target: string) => {
    assert.equal(target, '*'); sent.push(data);
    if (options.rpc && data.id !== undefined && data.method !== 'ui/initialize') {
      Promise.resolve().then(() => options.rpc!(data)).then(
        result => deliver?.({ jsonrpc: '2.0', id: data.id, result }),
        error => deliver?.({ jsonrpc: '2.0', id: data.id, error: { message: error.message, code: error.code } }),
      );
    }
  } };
  const window = {
    parent, openai: host,
    addEventListener(name: string, handler: Handler) { listeners.set(name, [...listeners.get(name) ?? [], handler]); }
  };
  const script = html.match(/<script>\n([\s\S]+?)\n<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    window, document: { getElementById: (id: string) => { assert.ok(elements.has(id)); return elements.get(id); } },
    File, Uint8Array,
    crypto: options.digest ? { subtle: { digest: options.digest } } : webcrypto,
    atob: (value: string) => { decodeCalls++; return atob(value); }, btoa,
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  }, { timeout: 3000 });
  const emit = async (name: string, event: unknown) => { for (const handler of listeners.get(name) ?? []) await handler(event); };
  const receive = (data: unknown, source: unknown = parent) => emit('message', { source, data });
  deliver = receive;
  const get = (id: string) => elements.get(id)!;
  return {
    html, sent, host, get, receive,
    globals: () => emit('openai:set_globals', {}),
    get decodeCalls() { return decodeCalls; },
    initialize: async (protocolVersion = '2026-01-26', hostCapabilities: Record<string, unknown> = { serverTools: {} }) => {
      const request = sent.find(item => item.method === 'ui/initialize');
      assert.ok(request);
      await receive({ jsonrpc: '2.0', id: request.id, result: { protocolVersion, hostCapabilities } });
      await new Promise(resolve => setImmediate(resolve));
    },
    result: (result: unknown) => receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    select: async (file: any) => { get('pick').files = [file]; await get('pick').trigger('change'); },
    expireTimers: () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } },
  };
}

function original(bytes: Buffer, overrides: Record<string, unknown> = {}) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = { name: '报告 <test>.pdf', mimeType: 'application/pdf', sizeBytes: bytes.length, sha256, base64: bytes.toString('base64'), ...overrides };
  return {
    structuredContent: { prototype: true, mode: 'local-file', device_id: 'd1', device_name: '设备 A', workspace_id: 'paper', workspace_name: '论文',
      name: file.name, mime_type: file.mimeType, size_bytes: file.sizeBytes, sha256: file.sha256, client_attachment_support: 'unverified' },
    _meta: { webcodexFile: file },
  };
}

function ticketFile(bytes: Buffer, name = '分块原文.pdf') {
  const legacy = original(bytes, { name });
  return {
    structuredContent: { ok: true, source: { device_id: 'd1', device_name: '设备 A', instance_id: 'instance-1' },
      data: { ...legacy.structuredContent, path: '论文/' + name, delivery_id: '11111111-2222-4333-8444-555555555555', max_upload_bytes: 100 * 1024 * 1024 } },
    _meta: { webcodexDelivery: { ticketId: 'A'.repeat(43), deliveryId: '11111111-2222-4333-8444-555555555555',
      expiresAt: new Date(Date.now() + 300000).toISOString(), chunkMaxBytes: 4096 } },
  };
}

function ticketTool(bytes: Buffer, ticket: ReturnType<typeof ticketFile>, calls: any[], edit?: (result: any) => any) {
  return async (name: string, args: any) => {
    calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
    assert.equal(args.ticket_id, ticket._meta.webcodexDelivery.ticketId);
    assert.equal(args.expected_device_id, 'd1');
    if (name === 'file_widget_release') return { structuredContent: { ok: true, data: { released: true } } };
    assert.equal(name, 'file_widget_read');
    const chunk = bytes.subarray(args.offset, args.offset + ticket._meta.webcodexDelivery.chunkMaxBytes);
    const next = args.offset + chunk.length;
    const result = { structuredContent: { ok: true, source: ticket.structuredContent.source, data: {
      ticket_id: args.ticket_id, offset: args.offset, size_bytes: chunk.length, total_bytes: bytes.length,
      next_offset: next === bytes.length ? null : next, eof: next === bytes.length, sha256: ticket.structuredContent.data.sha256,
      chunk_sha256: createHash('sha256').update(chunk).digest('hex'),
    } }, _meta: { webcodexChunk: { base64: chunk.toString('base64') } } };
    return edit ? edit(result) : result;
  };
}

async function waitState(h: ReturnType<typeof harness>, state: string) {
  const deadline = Date.now() + 2000;
  while (h.get('status').dataset.state !== state && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(h.get('status').dataset.state, state, h.get('status').textContent);
}

test('widget is a static self-contained MCP Apps resource with no external script or binary data', () => {
  const html = renderFileWidget();
  assert.equal(FILE_WIDGET_URI, `ui://webcodex/file-feasibility-${encodeURIComponent(VERSION)}.html`);
  assert.equal(FILE_WIDGET_MIME_TYPE, 'text/html;profile=mcp-app');
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|fetch\(|XMLHttpRequest|localStorage|imageIds/);
  assert.doesNotMatch(html, /\bsendFollowUpMessage\s*(?:\?\.)?\s*\(/, 'Compatibility capability detection must not become a follow-up-message fallback.');
});

test('bridge verifies parent source, negotiates before ready and sends initialized once', async () => {
  const h = harness({ uploadFile: async () => ({ fileId: 'unused' }) });
  assert.equal(h.sent.length, 1);
  const request = h.sent[0];
  assert.equal(request.method, 'ui/initialize');
  assert.equal(request.params.protocolVersion, '2026-01-26');
  assert.deepEqual(JSON.parse(JSON.stringify(request.params.appCapabilities)), {});
  await h.receive({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2026-01-26' } }, {});
  assert.equal(h.sent.length, 1);
  await h.initialize();
  assert.equal(h.sent[1].method, 'ui/notifications/initialized');
  assert.match(h.get('bridge').textContent, /初始化成功/);
  await h.get('refresh').trigger('click');
  assert.equal(h.sent.filter(item => item.method === 'ui/initialize').length, 1);
});

test('unsupported bridge versions and timeouts retain truthful compatibility fallback', async () => {
  const h = harness();
  await h.initialize('2099-01-01');
  assert.equal(h.sent.filter(item => item.method === 'ui/notifications/initialized').length, 0);
  assert.match(h.get('bridge').textContent, /没有协商支持/);
  assert.equal(h.get('status').dataset.state, 'unavailable');
  assert.equal(h.get('upload').disabled, true);
  const timeout = harness({ uploadFile: async () => ({ fileId: 'unused' }) });
  timeout.expireTimers();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(timeout.get('bridge').textContent, /超时/);
  assert.match(timeout.get('upload-capability').textContent, /uploadFile 可用/);
});

test('MCP original bytes are verified before explicit upload and remain private to the component', async () => {
  const calls: any[] = [];
  const h = harness({ uploadFile: async (...args: any[]) => { calls.push(args); return { fileId: 'file_verified' }; }, selectFiles() {} });
  await h.initialize();
  const bytes = Buffer.from([0, 255, 254, 13, 10, 123, 99, 0]);
  await h.result(original(bytes));
  await waitState(h, 'ready');
  assert.equal(calls.length, 0);
  assert.equal(h.get('upload').disabled, false);
  assert.equal(h.get('filename').textContent, '报告 <test>.pdf');
  assert.match(h.get('digest').textContent, /^[0-9a-f]{64}$/);
  h.get('library').checked = true;
  await h.get('upload').trigger('click');
  assert.equal(calls.length, 1);
  assert.deepEqual(Buffer.from(await calls[0][0].arrayBuffer()), bytes);
  assert.equal(calls[0][0].type, 'application/pdf');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { library: true });
  assert.equal(h.get('status').dataset.state, 'uploaded-awaiting-attachment');
  assert.match(h.get('status').textContent, /路线已阻断/);
  assert.equal(h.get('upload').disabled, true);
  await h.get('upload').trigger('click');
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(h.sent).includes(bytes.toString('base64')), false);
  assert.equal(JSON.stringify(h.sent).includes('file_verified'), false);
});

test('empty original files preserve exact bytes and validate the empty digest', async () => {
  const calls: File[] = [];
  const h = harness({ uploadFile: async (file: File) => { calls.push(file); return { fileId: 'empty' }; } });
  await h.result(original(Buffer.alloc(0)));
  await waitState(h, 'ready');
  await h.get('upload').trigger('click');
  assert.equal(calls[0].size, 0);
});

test('invalid or mismatched original file data never enables upload', async () => {
  const cases = [
    { sha256: '0'.repeat(64) },
    { base64: 'YR==' }, // noncanonical encoding of "a"
    { base64: '!!!!' },
    { sizeBytes: 7 * 1024 * 1024 + 1 },
    { mimeType: 'application/pdf; unsafe=1' },
    { name: '../report.pdf' },
  ];
  for (const override of cases) {
    const h = harness({ uploadFile: async () => { assert.fail('Rejected file was uploaded'); } });
    await h.result(original(Buffer.from('a'), override));
    await waitState(h, 'failure');
    assert.equal(h.get('upload').disabled, true);
    await h.get('upload').trigger('click');
    if ('sizeBytes' in override) assert.equal(h.decodeCalls, 0);
  }
  const h = harness({ uploadFile: async () => { assert.fail('Metadata mismatch was uploaded'); } });
  const mismatch = original(Buffer.from('exact'));
  mismatch.structuredContent.name = 'other.pdf';
  await h.result(mismatch);
  await waitState(h, 'failure');
  assert.match(h.get('status').textContent, /元数据不一致/);
  assert.equal(h.decodeCalls, 0);
});

test('browser-selected files above 7 MiB upload as the same original File without local decoding', async () => {
  let uploaded: File | undefined;
  let argCount = 0;
  const h = harness({ uploadFile: async (...args: any[]) => { uploaded = args[0]; argCount = args.length; return { fileId: 'file_large' }; } });
  const file = new File([Buffer.alloc(15 * 1024 * 1024, 0x5a)], '大文件.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  await h.select(file);
  assert.equal(h.get('status').dataset.state, 'ready');
  assert.equal(uploaded, undefined);
  await h.get('upload').trigger('click');
  assert.equal(uploaded, file);
  assert.equal(argCount, 1);
  assert.equal(h.decodeCalls, 0);
  assert.equal(h.get('status').dataset.state, 'uploaded-awaiting-attachment');
});

test('configured policy comes from wrapped tool metadata and bounds browser files before upload', async () => {
  const h = harness({ uploadFile: async () => { assert.fail('Oversized file was uploaded'); } });
  await h.result({ structuredContent: { ok: true, source: { device_id: 'device-2', device_name: '设备 B' }, data: {
    prototype: true, mode: 'capabilities', max_upload_bytes: 12 * 1024 * 1024,
  } } });
  assert.equal(h.get('device').textContent, '设备 B / device-2');
  assert.match(h.get('policy').textContent, /12\.00 MiB/);
  await h.select({ name: 'large.pdf', type: 'application/pdf', size: 13 * 1024 * 1024 });
  assert.equal(h.get('status').dataset.state, 'failure');
  assert.equal(h.get('upload').disabled, true);
  await h.get('upload').trigger('click');
  const normal = harness({ uploadFile: async () => ({ fileId: 'unused' }) });
  await normal.select({ name: 'too-big.pdf', size: 100 * 1024 * 1024 + 1 });
  assert.equal(normal.get('status').dataset.state, 'failure');
  assert.match(normal.get('status').textContent, /100\.00 MiB/);
});

test('invalid upload policy cannot override the component resource ceiling', async () => {
  const h = harness({ uploadFile: async () => ({ fileId: 'unused' }) });
  await h.result({ structuredContent: { prototype: true, mode: 'capabilities', max_upload_bytes: 512 * 1024 * 1024 + 1 } });
  assert.equal(h.get('status').dataset.state, 'failure');
  assert.match(h.get('status').textContent, /策略配置无效/);
});

test('component displays the effective local limit separately from its upload policy and refreshes changed limits', async () => {
  const h = harness();
  const data = { prototype: true, mode: 'capabilities', max_upload_bytes: 100 * 1024 * 1024,
    inline_max_bytes: 4 * 1024 * 1024, snapshot_cache_max_bytes: 32 * 1024 * 1024,
    effective_local_file_max_bytes: 4 * 1024 * 1024, effective_local_file_limit_scope: 'per_file_with_empty_cache' };
  await h.result({ structuredContent: { ok: true, data } });
  assert.match(h.get('policy').textContent, /本机工作区原文件有效上限为 .*4\.00 MiB/);
  assert.match(h.get('policy').textContent, /交给宿主上传的文件策略上限为 .*100\.00 MiB/);
  assert.match(h.get('policy').textContent, /无其他快照占用缓存时/);
  assert.match(h.get('policy').textContent, /不会扩大本机原文件上限/);
  await h.result({ structuredContent: { ok: true, data: { ...data,
    snapshot_cache_max_bytes: 2 * 1024 * 1024, effective_local_file_max_bytes: 2 * 1024 * 1024 } } });
  assert.match(h.get('policy').textContent, /本机工作区原文件有效上限为 .*2\.00 MiB/);
  assert.equal(h.decodeCalls, 0);
});

test('component rejects an effective local limit larger than its declared inline limit', async () => {
  const h = harness();
  await h.result({ structuredContent: { prototype: true, mode: 'capabilities', max_upload_bytes: 100 * 1024 * 1024,
    inline_max_bytes: 1024, effective_local_file_max_bytes: 2048 } });
  assert.equal(h.get('status').dataset.state, 'failure');
  assert.match(h.get('status').textContent, /本机原文件有效上限配置无效/);
});

test('read-only tool probe uses MCP Apps tools/call and checks the response', async () => {
  const states: any[] = [];
  let uploads = 0;
  const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'unused' }; },
    setWidgetState: (state: unknown) => { states.push(structuredClone(state)); } });
  await h.initialize();
  const pending = h.get('probe').trigger('click');
  const request = h.sent.find(item => item.method === 'tools/call');
  assert.ok(request);
  assert.equal(request.params.name, 'file_widget_probe');
  assert.deepEqual(JSON.parse(JSON.stringify(request.params.arguments)), {});
  await h.receive({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { ok: true, data: { prototype: true, mode: 'capabilities', max_upload_bytes: 20 * 1024 * 1024 } } } });
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.get('tool-capability').textContent, /调用成功；未读取本地文件/);
  assert.match(h.get('policy').textContent, /20\.00 MiB/);
  assert.equal(states.length, 1);
  assert.equal(states[0].modelContent.kind, 'webcodex_host_capabilities');
  assert.equal(states[0].modelContent.component_version, h.get('version').textContent);
  assert.equal(Object.hasOwn(states[0].modelContent, 'device_id'), false); assert.equal(Object.hasOwn(states[0].modelContent, 'instance_id'), false);
  assert.equal(states[0].modelContent.host_capabilities.initialization, 'ready');
  assert.equal(states[0].modelContent.upload_performed, false); assert.equal(states[0].modelContent.file_read_performed, false);
  assert.equal(states[0].modelContent.context_scope, 'future_turns');
  assert.equal(uploads, 0); assert.equal(h.decodeCalls, 0); assert.equal(h.sent.some(item => item.method === 'ui/message'), false);
  assert.deepEqual(h.sent.filter(item => item.method === 'tools/call').map(item => item.params.name), ['file_widget_probe']);
});

test('compatibility host supports tool results and explicit probe without standard bridge', async () => {
  let called = 0;
  const h = harness({
    toolOutput: { prototype: true, mode: 'capabilities', max_upload_bytes: 32 * 1024 * 1024 },
    uploadFile: async () => ({ fileId: 'unused' }),
    callTool: async (name: string, args: any) => {
      called++;
      assert.equal(name, 'file_widget_probe');
      assert.deepEqual(JSON.parse(JSON.stringify(args)), {});
      return { structuredContent: { prototype: true, mode: 'capabilities' } };
    },
  });
  assert.match(h.get('policy').textContent, /32\.00 MiB/);
  await h.get('probe').trigger('click');
  assert.equal(called, 1);
  assert.match(h.get('tool-capability').textContent, /调用成功/);
});

test('compatibility original metadata works, but does not overwrite a newer standard result', async () => {
  const first = original(Buffer.from('first'));
  const newer = original(Buffer.from('NEW_STANDARD_ORIGINAL_92461'), { name: 'newer-standard.pdf' });
  newer.structuredContent.device_id = 'newer-device'; newer.structuredContent.device_name = '';
  const h = harness({ uploadFile: async () => ({ fileId: 'unused' }), toolOutput: first.structuredContent, toolResponseMetadata: first._meta });
  await waitState(h, 'ready');
  await h.result(newer); await waitState(h, 'ready');
  h.host.toolOutput = structuredClone(first.structuredContent); h.host.toolResponseMetadata = structuredClone(first._meta);
  await h.globals();
  assert.equal(h.get('device').textContent, 'newer-device');
  assert.equal(h.get('status').dataset.state, 'ready');
  assert.equal(h.get('filename').textContent, 'newer-standard.pdf'); assert.equal(h.get('digest').textContent, newer.structuredContent.sha256);
  assert.equal(h.get('upload').disabled, false);
});

test('compatibility accepts full MCP envelopes under documented metadata wrappers', async () => {
  for (const wrapper of ['mcp_tool_result', 'call_tool_result']) {
    const file = original(Buffer.from(wrapper));
    const h = harness({ uploadFile: async () => ({ fileId: 'unused' }), toolOutput: file.structuredContent,
      toolResponseMetadata: { status: 'success', [wrapper]: file } });
    await waitState(h, 'ready');
    assert.equal(h.get('upload').disabled, false);
    assert.equal(h.get('digest').textContent, file.structuredContent.sha256);
  }
});

test('nested and mixed compatibility envelopes recover only the matching complete ticket result', async () => {
  const wrappers = [
    (file: any) => ({ status: 'success', call_tool_result: { mcp_tool_result: file } }),
    (file: any) => ({ mcp_tool_result: { structuredContent: file.structuredContent }, call_tool_result: file }),
    (file: any) => ({ mcp_tool_result: file, call_tool_result: { structuredContent: file.structuredContent } }),
  ];
  for (const standardFirst of [false, true]) for (const wrap of wrappers) {
    const bytes = Buffer.alloc(5001, 0x83), ticket = ticketFile(bytes), calls: any[] = [], uploads: File[] = [];
    const h = harness({ callTool: ticketTool(bytes, ticket, calls), uploadFile: async (file: File) => { uploads.push(file); return { fileId: 'wrapped-original' }; } });
    if (standardFirst) await h.result({ structuredContent: ticket.structuredContent });
    // Also exercise metadata-only initialization without the toolOutput convenience global.
    if (standardFirst) h.host.toolOutput = ticket.structuredContent;
    h.host.toolResponseMetadata = wrap(ticket);
    await h.globals();
    await waitState(h, 'ready');
    assert.deepEqual(calls.map(call => call.name), ['file_widget_read', 'file_widget_read', 'file_widget_release']);
    assert.equal(uploads.length, 0);
    await h.get('upload').trigger('click');
    assert.equal(uploads.length, 1);
    assert.deepEqual(Buffer.from(await uploads[0].arrayBuffer()), bytes);
    const publicMessages = JSON.stringify(h.sent);
    assert.equal(publicMessages.includes(ticket._meta.webcodexDelivery.ticketId), false);
    assert.equal(publicMessages.includes(bytes.toString('base64')), false);
    assert.equal(h.sent.some(message => message.method === 'ui/message'), false);
  }
});

test('matching sibling envelopes cannot borrow anonymous metadata or merge conflicting file identities and tickets', async () => {
  const edits: ((file: any) => any)[] = [
    file => ({ _meta: file._meta }),
    file => { file.structuredContent.data.path = 'older.pdf'; return file; },
    file => { file.structuredContent.data.device_id = 'older-device'; return file; },
    file => { file.structuredContent.source.instance_id = 'older-instance'; return file; },
    file => { file.structuredContent.data.workspace_uid = 'older-workspace'; return file; },
    file => { file.structuredContent.data.delivery_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; return file; },
    file => { file._meta.webcodexDelivery.ticketId = 'B'.repeat(43); return file; },
    file => ({ ...file, isError: true }),
  ];
  for (const edit of edits) {
    const bytes = Buffer.from('current synthetic PDF'), ticket = ticketFile(bytes), calls: any[] = [];
    const other = edit(structuredClone(ticket));
    const h = harness({ callTool: ticketTool(bytes, ticket, calls), uploadFile: async () => { assert.fail('Conflicting result uploaded'); } });
    await h.result({ structuredContent: ticket.structuredContent });
    h.host.toolOutput = ticket.structuredContent;
    h.host.toolResponseMetadata = {
      mcp_tool_result: other.structuredContent ? ticket : { structuredContent: ticket.structuredContent },
      call_tool_result: other,
    };
    await h.globals();
    assert.equal(calls.length, 0);
    assert.equal(h.decodeCalls, 0);
    assert.equal(h.get('upload').disabled, true);
    h.host.toolResponseMetadata = { mcp_tool_result: { structuredContent: ticket.structuredContent }, call_tool_result: ticket };
    await h.globals();
    await waitState(h, 'ready');
    assert.deepEqual(calls.map(call => call.name), ['file_widget_read', 'file_widget_release']);
  }
});

test('in-place hidden ticket arrival is received once and theme echoes preserve upload and explicit clear', async () => {
  for (const standardFirst of [false, true]) {
    const bytes = Buffer.from('same outer object'), ticket = ticketFile(bytes), calls: any[] = [];
    let uploads = 0;
    const metadata: any = { status: 'success', mcp_tool_result: { structuredContent: ticket.structuredContent } };
    const h = harness({ callTool: ticketTool(bytes, ticket, calls), uploadFile: async () => { uploads++; return { fileId: 'same-object-receipt' }; } });
    if (standardFirst) await h.result({ structuredContent: ticket.structuredContent });
    h.host.toolOutput = ticket.structuredContent;
    h.host.toolResponseMetadata = metadata;
    await h.globals();
    await waitState(h, 'failure');
    assert.match(h.get('status').textContent, /尚未收到匹配的组件私有读取凭据/);
    assert.equal(calls.length, 0);
    metadata.mcp_tool_result._meta = ticket._meta;
    await h.globals();
    await waitState(h, 'ready');
    await h.globals();
    await h.get('upload').trigger('click');
    const receipt = h.get('receipt').textContent;
    await h.globals();
    assert.equal(h.get('receipt').textContent, receipt);
    assert.equal(uploads, 1);
    assert.deepEqual(calls.map(call => call.name), ['file_widget_read', 'file_widget_release']);
    await h.get('clear').trigger('click');
    await h.globals();
    assert.equal(h.get('status').dataset.state, 'idle');
    assert.equal(h.get('filename').textContent, '—');
    assert.equal(uploads, 1);
    assert.equal(calls.length, 2);
  }
});

test('untrusted same-file compatibility echoes preserve the uploaded receipt, send capability and explicit clear', async () => {
  const corruptions = [
    (metadata: any, ticket: any) => { metadata.call_tool_result = { ...ticket, isError: true }; },
    (metadata: any, ticket: any) => {
      const stale = structuredClone(ticket); stale.structuredContent.source.instance_id = 'old-instance';
      metadata.call_tool_result = stale;
    },
    (metadata: any, ticket: any) => {
      const conflicting = structuredClone(ticket); conflicting._meta.webcodexDelivery.ticketId = 'B'.repeat(43);
      metadata.call_tool_result = conflicting;
    },
    (metadata: any) => {
      let deep: any = {};
      for (let index = 0; index < 6; index++) deep = { call_tool_result: deep };
      metadata.call_tool_result = deep;
    },
    (metadata: any, ticket: any) => { metadata.mcp_tool_result = { structuredContent: ticket.structuredContent }; },
  ];
  for (const corrupt of corruptions) {
    const bytes = Buffer.from('keep this uploaded original'), ticket = ticketFile(bytes), calls: any[] = [];
    let uploads = 0;
    const metadata: any = { mcp_tool_result: { call_tool_result: ticket } };
    const h = harness({ callTool: ticketTool(bytes, ticket, calls),
      uploadFile: async () => { uploads++; return { fileId: 'sediment://keep-original-receipt' }; }, setWidgetState() {} },
    { rpc: async request => { assert.equal(request.method, 'ui/message'); return {}; } });
    await h.initialize('2026-01-26', { message: { resourceLink: {} } });
    h.host.toolOutput = ticket.structuredContent;
    h.host.toolResponseMetadata = metadata;
    await h.globals();
    await waitState(h, 'ready');
    await h.get('upload').trigger('click');
    const receipt = h.get('receipt').textContent;
    corrupt(metadata, ticket);
    await h.globals();
    assert.equal(h.get('status').dataset.state, 'uploaded-awaiting-attachment');
    assert.equal(h.get('receipt').textContent, receipt);
    assert.equal(h.get('filename').textContent, ticket.structuredContent.data.name);
    assert.equal(h.get('digest').textContent, ticket.structuredContent.data.sha256);
    assert.equal(h.get('send').disabled, false);
    assert.equal(uploads, 1);
    assert.deepEqual(calls.map(call => call.name), ['file_widget_read', 'file_widget_release']);
    await h.get('send').trigger('click');
    const messages = h.sent.filter(message => message.method === 'ui/message');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].params.content[0].uri, 'sediment://keep-original-receipt');
    await h.get('clear').trigger('click');
    await h.globals();
    assert.equal(h.get('status').dataset.state, 'idle');
    assert.equal(h.get('receipt').textContent, '');
    assert.equal(h.get('filename').textContent, '—');
    assert.equal(uploads, 1);
    assert.equal(calls.length, 2);
  }
});

test('a genuinely new compatibility toolOutput invalidates the old upload while waiting for its matching ticket', async () => {
  const oldBytes = Buffer.from('first file'), newBytes = Buffer.from('second independent file');
  const first = ticketFile(oldBytes, 'first.pdf'), next = ticketFile(newBytes, 'second.pdf'), calls: any[] = [], uploads: File[] = [];
  next.structuredContent.data.delivery_id = next._meta.webcodexDelivery.deliveryId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  next._meta.webcodexDelivery.ticketId = 'B'.repeat(43);
  const oldTool = ticketTool(oldBytes, first, calls), newTool = ticketTool(newBytes, next, calls);
  const metadata: any = { mcp_tool_result: { call_tool_result: first } };
  const h = harness({ callTool: (name: string, args: any) => (args.ticket_id === first._meta.webcodexDelivery.ticketId ? oldTool : newTool)(name, args),
    uploadFile: async (file: File) => { uploads.push(file); return { fileId: 'sediment://file-' + uploads.length }; }, setWidgetState() {} },
  { rpc: async request => { assert.equal(request.method, 'ui/message'); return {}; } });
  await h.initialize('2026-01-26', { message: { resourceLink: {} } });
  h.host.toolOutput = first.structuredContent;
  h.host.toolResponseMetadata = metadata;
  await h.globals();
  await waitState(h, 'ready');
  await h.get('upload').trigger('click');
  h.host.toolOutput = next.structuredContent;
  await h.globals();
  await waitState(h, 'failure');
  assert.equal(h.get('receipt').textContent, '');
  assert.equal(h.get('send').disabled, true);
  assert.equal(h.get('upload').disabled, true);
  assert.equal(h.get('path').textContent, next.structuredContent.data.path);
  await h.get('send').trigger('click');
  assert.equal(h.sent.some(message => message.method === 'ui/message'), false);
  assert.equal(uploads.length, 1);
  assert.equal(calls.length, 2);
  metadata.mcp_tool_result.call_tool_result = next;
  await h.globals();
  await waitState(h, 'ready');
  await h.get('upload').trigger('click');
  assert.equal(uploads.length, 2);
  assert.deepEqual(Buffer.from(await uploads[1].arrayBuffer()), newBytes);
  assert.equal(h.get('filename').textContent, 'second.pdf');
  assert.match(h.get('receipt').textContent, /file-2/);
  assert.deepEqual(calls.map(call => call.name), ['file_widget_read', 'file_widget_release', 'file_widget_read', 'file_widget_release']);
});

test('compatibility traversal ignores unknown wrappers and rejects incomplete depth or node scans', async () => {
  const wrappers = [
    (file: any) => ({ unrelated_result: file }),
    (file: any) => { let value = file; for (let index = 0; index < 6; index++) value = { mcp_tool_result: value }; return value; },
    (file: any) => {
      const tree = (depth: number): any => depth === 0 ? { structuredContent: file.structuredContent }
        : { mcp_tool_result: tree(depth - 1), call_tool_result: tree(depth - 1) };
      // Even a complete candidate found early must not bypass an uninspected branch.
      return { mcp_tool_result: file, call_tool_result: tree(3) };
    },
  ];
  for (const wrap of wrappers) {
    const bytes = Buffer.from('bounded metadata'), ticket = ticketFile(bytes), calls: any[] = [];
    const h = harness({ toolOutput: ticket.structuredContent, toolResponseMetadata: wrap(ticket),
      callTool: ticketTool(bytes, ticket, calls), uploadFile: async () => { assert.fail('Uninspected metadata uploaded'); } });
    await waitState(h, 'failure');
    assert.equal(calls.length, 0);
    assert.equal(h.decodeCalls, 0);
  }
  const bytes = Buffer.from('aliased metadata'), ticket = ticketFile(bytes), calls: any[] = [];
  const cycle: any = { mcp_tool_result: ticket, call_tool_result: ticket };
  cycle.call_tool_result = { mcp_tool_result: cycle, call_tool_result: ticket };
  const h = harness({ toolOutput: ticket.structuredContent, toolResponseMetadata: cycle,
    callTool: ticketTool(bytes, ticket, calls), uploadFile: async () => ({ fileId: 'unused' }) });
  await waitState(h, 'ready');
  assert.deepEqual(calls.map(call => call.name), ['file_widget_read', 'file_widget_release']);
});

test('theme globals and repeated result deliveries preserve uploaded receipt and prevent duplicate upload', async () => {
  const file = original(Buffer.from('receipt'));
  let count = 0;
  const h = harness({ uploadFile: async () => { count++; return { fileId: 'retain-me' }; }, toolOutput: file.structuredContent,
    toolResponseMetadata: { mcp_tool_result: file } });
  await waitState(h, 'ready');
  await h.get('upload').trigger('click');
  const receipt = h.get('receipt').textContent;
  h.host.theme = 'dark';
  await h.globals();
  assert.equal(h.get('status').dataset.state, 'uploaded-awaiting-attachment');
  assert.equal(h.get('receipt').textContent, receipt);
  h.host.toolResponseMetadata = { mcp_tool_result: structuredClone(file) };
  await h.globals();
  await h.result(structuredClone(file));
  await h.get('upload').trigger('click');
  assert.equal(count, 1);
  assert.equal(h.get('upload').disabled, true);
  assert.equal(h.get('receipt').textContent, receipt);
});

test('theme-only globals do not clear browser-selected files after capability initialization', async () => {
  const h = harness({ uploadFile: async () => ({ fileId: 'unused' }), toolOutput: { prototype: true, mode: 'capabilities' } });
  await h.select(new File(['paper'], 'selected.pdf'));
  await h.globals();
  assert.equal(h.get('filename').textContent, 'selected.pdf');
  assert.equal(h.get('status').dataset.state, 'ready');
});

test('explicit clear permits the same original file to be delivered again intentionally', async () => {
  const h = harness({ uploadFile: async () => ({ fileId: 'unused' }) });
  const file = original(Buffer.from('repeatable'));
  await h.result(file);
  await waitState(h, 'ready');
  await h.get('clear').trigger('click');
  assert.equal(h.get('upload').disabled, true);
  await h.result(structuredClone(file));
  await waitState(h, 'ready');
  assert.equal(h.get('upload').disabled, false);
  assert.equal(h.decodeCalls, 2);
});

test('new tool errors invalidate previous selection including wrapped compatibility errors', async () => {
  for (const compatibility of [false, true]) {
    const h = harness({ uploadFile: async () => { assert.fail('Stale selection uploaded'); } });
    await h.select(new File(['old'], 'old.pdf'));
    if (compatibility) {
      h.host.toolOutput = { ok: false, error: { code: 'FILE_NOT_FOUND' } };
      h.host.toolResponseMetadata = { mcp_tool_result: { isError: true, structuredContent: h.host.toolOutput } };
      await h.globals();
    } else await h.result({ isError: true, structuredContent: { ok: false, error: { code: 'FILE_NOT_FOUND' } } });
    assert.equal(h.get('status').dataset.state, 'failure');
    assert.equal(h.get('upload').disabled, true);
    assert.equal(h.get('filename').textContent, '—');
    await h.get('upload').trigger('click');
  }
});

test('compatibility error echoes preserve a later browser selection but a new error invocation clears it', async () => {
  const h = harness({ uploadFile: async () => { assert.fail('Selection surviving a new error uploaded'); } });
  const error = { ok: false, error: { code: 'FILE_NOT_FOUND' } };
  h.host.toolOutput = error;
  h.host.toolResponseMetadata = { mcp_tool_result: { isError: true, structuredContent: error } };
  await h.globals();
  assert.equal(h.get('status').dataset.state, 'failure');
  await h.select(new File(['browser selection'], 'selected.pdf'));
  await h.globals();
  assert.equal(h.get('status').dataset.state, 'ready');
  h.host.toolOutput = structuredClone(error);
  h.host.toolResponseMetadata = { call_tool_result: { isError: true, structuredContent: h.host.toolOutput } };
  await h.globals();
  assert.equal(h.get('status').dataset.state, 'failure');
  assert.equal(h.get('filename').textContent, '—');
  assert.equal(h.get('upload').disabled, true);
});

test('MCP source relative path is visible and final upload enforces configured policy', async () => {
  const h = harness({ uploadFile: async () => { assert.fail('MCP upload exceeded component policy'); } });
  const result = original(Buffer.from('more than one byte'));
  await h.result({ ...result, structuredContent: { ...result.structuredContent, path: '目录 A/报告 <test>.pdf', max_upload_bytes: 1 } });
  await waitState(h, 'ready');
  assert.equal(h.get('path').textContent, '目录 A/报告 <test>.pdf');
  await h.get('upload').trigger('click');
  assert.equal(h.get('status').dataset.state, 'failure');
  assert.match(h.get('status').textContent, /超过当前组件上传策略/);
});

test('late digest completion cannot replace a newer capability result', async () => {
  let finish!: (value: ArrayBuffer) => void;
  const hash = createHash('sha256').update('old').digest();
  const h = harness({ uploadFile: async () => ({ fileId: 'unused' }) }, { digest: async () => new Promise(resolve => { finish = resolve; }) });
  await h.result(original(Buffer.from('old')));
  assert.equal(h.get('status').dataset.state, 'verifying');
  await h.result({ structuredContent: { prototype: true, mode: 'capabilities' } });
  finish(Uint8Array.from(hash).buffer);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.get('status').dataset.state, 'idle');
  assert.equal(h.get('upload').disabled, true);
});

test('host upload failures and missing file IDs never claim attachment or successful upload', async () => {
  for (const uploadFile of [async () => { throw new Error('<img src=x> host rejected'); }, async () => ({})]) {
    const h = harness({ uploadFile });
    await h.select(new File(['data'], 'a.pdf'));
    await h.get('upload').trigger('click');
    assert.equal(h.get('status').dataset.state, 'failure');
    assert.match(h.get('status').textContent, /上传未确认/);
    assert.match(h.get('receipt').textContent, /上次上传尝试未确认：a\.pdf/);
  }
});

test('upload locks double submission and applies the latest queued result after completion', async () => {
  let finish!: (value: { fileId: string }) => void;
  let count = 0;
  const h = harness({ uploadFile: () => { count++; return new Promise(resolve => { finish = resolve; }); } });
  await h.select(new File(['data'], 'current.pdf'));
  const upload = h.get('upload').trigger('click');
  assert.equal(h.get('status').dataset.state, 'uploading');
  assert.equal(h.get('pick').disabled, true);
  await h.get('upload').trigger('click');
  await h.result(original(Buffer.from('superseded'), { name: 'superseded.pdf' }));
  await h.result(original(Buffer.from('replacement'), { name: 'next.pdf' }));
  assert.equal(h.get('filename').textContent, 'current.pdf');
  finish({ fileId: 'confirmed' });
  await upload;
  assert.equal(count, 1);
  assert.equal(h.get('status').dataset.state, 'ready');
  assert.equal(h.get('filename').textContent, 'next.pdf');
  assert.match(h.get('receipt').textContent, /上次上传文件：current\.pdf/);
  assert.match(h.get('receipt').textContent, /confirmed/);
  assert.doesNotMatch(h.get('receipt').textContent, /next\.pdf|superseded\.pdf/);
});

test('matching hidden metadata can arrive after a standard result without file bytes', async () => {
  const h = harness({ uploadFile: async () => ({ fileId: 'unused' }) });
  const result = original(Buffer.from('late metadata'));
  await h.result({ structuredContent: result.structuredContent });
  await waitState(h, 'failure');
  h.host.toolOutput = result.structuredContent;
  h.host.toolResponseMetadata = { mcp_tool_result: result };
  await h.globals();
  await waitState(h, 'ready');
  assert.equal(h.get('upload').disabled, false);
  assert.equal(h.get('digest').textContent, result.structuredContent.sha256);
});

test('successful metadata enrichment closes the gate so changed echoes cannot reset an uploaded file', async () => {
  const h = harness({ uploadFile: async () => ({ fileId: 'keep-receipt' }) });
  const result = original(Buffer.from('a'));
  await h.result({ structuredContent: result.structuredContent });
  h.host.toolOutput = result.structuredContent;
  h.host.toolResponseMetadata = { mcp_tool_result: result };
  await h.globals();
  await waitState(h, 'ready');
  await h.get('upload').trigger('click');
  const receipt = h.get('receipt').textContent;
  const decodeCalls = h.decodeCalls;
  h.host.toolResponseMetadata = { mcp_tool_result: { ...result,
    _meta: { webcodexFile: { ...result._meta.webcodexFile, base64: Buffer.from('z').toString('base64') } } } };
  await h.globals();
  assert.equal(h.get('status').dataset.state, 'uploaded-awaiting-attachment');
  assert.equal(h.get('receipt').textContent, receipt);
  assert.match(receipt, /keep-receipt/);
  assert.equal(h.get('upload').disabled, true);
  assert.equal(h.decodeCalls, decodeCalls);
});

test('failed metadata enrichment keeps the gate open for corrected matching bytes', async () => {
  const h = harness({ uploadFile: async () => ({ fileId: 'unused' }) });
  const result = original(Buffer.from('a'));
  await h.result({ structuredContent: result.structuredContent });
  h.host.toolOutput = result.structuredContent;
  h.host.toolResponseMetadata = { mcp_tool_result: { ...result,
    _meta: { webcodexFile: { ...result._meta.webcodexFile, base64: Buffer.from('z').toString('base64') } } } };
  await h.globals();
  await waitState(h, 'failure');
  assert.match(h.get('status').textContent, /SHA-256 不一致/);
  h.host.toolResponseMetadata = { mcp_tool_result: result };
  await h.globals();
  await waitState(h, 'ready');
  assert.equal(h.get('upload').disabled, false);
  assert.equal(h.get('digest').textContent, result.structuredContent.sha256);
  assert.equal(h.decodeCalls, 2);
});

test('metadata enrichment rejects old file, device, workspace, instance and error envelopes', async () => {
  const base = original(Buffer.from('current'));
  const structured = { ok: true, source: { device_id: 'd1', device_name: 'Device', instance_id: 'i1' },
    data: { ...base.structuredContent, workspace_uid: 'uid1', path: 'current.pdf' } };
  const current = { ...base, structuredContent: structured };
  const staleResults = [
    { ...current, structuredContent: { ...structured, data: { ...structured.data, name: 'old.pdf' } } },
    { ...current, structuredContent: { ...structured, data: { ...structured.data, device_id: 'old-device' } } },
    { ...current, structuredContent: { ...structured, data: { ...structured.data, workspace_uid: 'old-uid' } } },
    { ...current, structuredContent: { ...structured, source: { ...structured.source, instance_id: 'old-instance' } } },
    { ...current, isError: true },
  ];
  for (const stale of staleResults) {
    const h = harness({ uploadFile: async () => ({ fileId: 'unused' }) });
    await h.result({ structuredContent: structured });
    h.host.toolOutput = structured;
    h.host.toolResponseMetadata = { mcp_tool_result: stale };
    await h.globals();
    assert.equal(h.get('status').dataset.state, 'failure');
    assert.equal(h.get('upload').disabled, true);
    assert.equal(h.decodeCalls, 0);
  }
});

test('older compatibility metadata cannot override a newer standard error or user selection', async () => {
  for (const next of ['error', 'selection', 'clear']) {
    const h = harness({ uploadFile: async () => ({ fileId: 'unused' }) });
    const result = original(Buffer.from('old metadata'));
    await h.result({ structuredContent: result.structuredContent });
    if (next === 'error') await h.result({ isError: true, structuredContent: { ok: false } });
    if (next === 'selection') await h.select(new File(['manual'], 'manual.pdf'));
    if (next === 'clear') await h.get('clear').trigger('click');
    h.host.toolOutput = result.structuredContent;
    h.host.toolResponseMetadata = { mcp_tool_result: result };
    await h.globals();
    assert.equal(h.decodeCalls, 0);
    assert.equal(h.get('filename').textContent, next === 'selection' ? 'manual.pdf' : '—');
    assert.equal(h.get('status').dataset.state, next === 'selection' ? 'ready' : next === 'error' ? 'failure' : 'idle');
  }
});

test('metadata already present when standard public data arrives can enrich without another globals event', async () => {
  const h = harness({ uploadFile: async () => ({ fileId: 'unused' }) });
  const result = original(Buffer.from('already delivered'));
  h.host.toolOutput = result.structuredContent;
  h.host.toolResponseMetadata = { mcp_tool_result: result };
  await h.globals();
  await waitState(h, 'ready');
  await h.result({ structuredContent: result.structuredContent });
  await waitState(h, 'ready');
  assert.equal(h.get('upload').disabled, false);
});

test('queued new tool errors invalidate the old file after an unsuccessful upload', async () => {
  let rejectUpload!: (error: Error) => void;
  let calls = 0;
  const h = harness({ uploadFile: () => { calls++; return new Promise((_resolve, reject) => { rejectUpload = reject; }); } });
  await h.select(new File(['old'], 'old.pdf'));
  const upload = h.get('upload').trigger('click');
  await h.result({ isError: true, structuredContent: { ok: false, error: { code: 'FILE_NOT_FOUND' } } });
  rejectUpload(new Error('Host upload interrupted'));
  await upload;
  assert.equal(h.get('status').dataset.state, 'failure');
  assert.match(h.get('status').textContent, /新的 MCP 工具调用失败/);
  assert.equal(h.get('filename').textContent, '—');
  assert.equal(h.get('upload').disabled, true);
  assert.match(h.get('receipt').textContent, /上次上传尝试未确认：old\.pdf/);
  await h.get('upload').trigger('click');
  assert.equal(calls, 1);
});

test('ticket delivery reads private chunks over standard tools/call and verifies exact original bytes', async () => {
  const bytes = Buffer.from(Array.from({ length: 10000 }, (_, index) => index % 256));
  const ticket = ticketFile(bytes);
  const calls: any[] = [], uploads: File[] = [];
  const tool = ticketTool(bytes, ticket, calls);
  const h = harness({ uploadFile: async (file: File) => { uploads.push(file); return { fileId: 'sediment://file_original' }; } },
    { rpc: request => { assert.equal(request.method, 'tools/call'); return tool(request.params.name, request.params.arguments); } });
  await h.initialize();
  assert.match(h.get('tool-capability').textContent, /serverTools 可用/);
  assert.equal(JSON.stringify(ticket).includes(bytes.toString('base64')), false);
  await h.result(ticket);
  await waitState(h, 'ready');
  assert.deepEqual(calls.filter(call => call.name === 'file_widget_read').map(call => call.args.offset), [0, 4096, 8192]);
  assert.equal(calls.filter(call => call.name === 'file_widget_release').length, 1);
  assert.equal(uploads.length, 0);
  assert.equal(h.get('filename').textContent, '分块原文.pdf');
  await h.get('upload').trigger('click');
  assert.equal(uploads.length, 1);
  assert.deepEqual(Buffer.from(await uploads[0].arrayBuffer()), bytes);
  assert.equal(h.sent.some(item => item.method === 'ui/message'), false);
  assert.equal(JSON.stringify(h.sent).includes(bytes.subarray(0, 4096).toString('base64')), false);
});

for (const route of ['standard', 'compatibility'] as const) test(`${route} ticket delivery completes the exact 1610783-byte tail and preserves every original byte`, async () => {
  const bytes = Buffer.alloc(1610783, 0xa5), ticket = ticketFile(bytes);
  ticket._meta.webcodexDelivery.chunkMaxBytes = 65536;
  const calls: any[] = [], uploads: File[] = [], tool = ticketTool(bytes, ticket, calls);
  const h = harness({ ...(route === 'compatibility' ? { callTool: tool } : {}),
    uploadFile: async (file: File) => { uploads.push(file); return { fileId: 'synthetic-exact-tail' }; } },
  { rpc: request => tool(request.params.name, request.params.arguments) });
  await h.initialize('2026-01-26', route === 'standard' ? { serverTools: {} } : {});
  await h.result(ticket);
  await waitState(h, 'ready');
  assert.deepEqual(calls.filter(call => call.name === 'file_widget_read').map(call => call.args.offset),
    Array.from({ length: 25 }, (_, index) => index * 65536));
  assert.equal(bytes.length - 24 * 65536, 37919);
  assert.equal(calls.filter(call => call.name === 'file_widget_release').length, 1);
  assert.equal(uploads.length, 0);
  await h.get('upload').trigger('click');
  assert.equal(uploads.length, 1);
  assert.deepEqual(Buffer.from(await uploads[0].arrayBuffer()), bytes);
});

for (const route of ['compatibility', 'unsupported-standard-fallback'] as const) test(`${route} missing tail response times out, releases once and ignores a late response after a new selection`, async () => {
  const bytes = Buffer.alloc(1610783, 0x63), ticket = ticketFile(bytes);
  ticket._meta.webcodexDelivery.chunkMaxBytes = 65536;
  const calls: any[] = [], uploads: File[] = [], tool = ticketTool(bytes, ticket, calls);
  let finishTail: (() => void) | undefined;
  const h = harness({
    callTool: async (name: string, args: any) => {
      const result = await tool(name, args);
      if (name === 'file_widget_read' && args.offset === 1572864)
        return new Promise(resolve => { finishTail = () => resolve(result); });
      return result;
    },
    uploadFile: async (file: File) => { uploads.push(file); return { fileId: 'synthetic-new-selection' }; },
  }, { rpc: () => { throw Object.assign(new Error('Method unsupported'), { code: -32601 }); } });
  await h.initialize('2026-01-26', route === 'compatibility' ? {} : { serverTools: {} });
  await h.result(ticket);
  const deadline = Date.now() + 2000;
  while (!finishTail && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(finishTail, 'The first 24 complete chunks must reach the pending final chunk.');
  assert.equal(h.get('status').dataset.state, 'receiving');
  assert.match(h.get('status').textContent, /1,572,864/);
  h.expireTimers();
  await waitState(h, 'failure');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.get('status').textContent, /兼容工具宿主响应超时/);
  assert.equal(calls.filter(call => call.name === 'file_widget_read').length, 25, 'Timeout must not repeat the read through another bridge.');
  assert.equal(calls.filter(call => call.name === 'file_widget_release').length, 1);
  assert.equal(h.get('clear').disabled, false);
  assert.equal(h.get('probe').disabled, false);
  assert.equal(uploads.length, 0);
  assert.equal(h.sent.some(message => message.method === 'ui/message'), false);

  const replacement = Buffer.from('New selection remains current.');
  await h.result(original(replacement, { name: 'new-selection.pdf' }));
  await waitState(h, 'ready');
  finishTail();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.get('status').dataset.state, 'ready');
  assert.equal(h.get('filename').textContent, 'new-selection.pdf');
  assert.equal(calls.filter(call => call.name === 'file_widget_release').length, 1);
  assert.equal(uploads.length, 0);
  await h.get('upload').trigger('click');
  assert.equal(uploads.length, 1);
  assert.deepEqual(Buffer.from(await uploads[0].arrayBuffer()), replacement);
});

test('empty ticket files read one EOF chunk and release the ticket', async () => {
  const bytes = Buffer.alloc(0), ticket = ticketFile(bytes), calls: any[] = [];
  const h = harness({ callTool: ticketTool(bytes, ticket, calls), uploadFile: async () => ({ fileId: 'unused' }) });
  await h.result(ticket);
  await waitState(h, 'ready');
  assert.equal(calls.filter(call => call.name === 'file_widget_read').length, 1);
  assert.equal(calls.filter(call => call.name === 'file_widget_release').length, 1);
  assert.match(h.get('size').textContent, /^0 字节/);
});

for (const [label, wrap] of [
  ['nested', (chunk: any) => ({ call_tool_result: { mcp_tool_result: chunk } })],
  ['mixed siblings', (chunk: any) => ({ mcp_tool_result: { structuredContent: chunk.structuredContent }, call_tool_result: chunk })],
] as const) test(`private chunk ${label} envelopes preserve exact bytes through both tool bridges`, async () => {
  for (const standard of [false, true]) {
    const bytes = Buffer.alloc(5001, 0x95), ticket = ticketFile(bytes), calls: any[] = [], uploads: File[] = [];
    const tool = ticketTool(bytes, ticket, calls, wrap);
    const h = harness({ ...(standard ? {} : { callTool: tool }),
      uploadFile: async (file: File) => { uploads.push(file); return { fileId: 'private-wrapped-original' }; } },
    { rpc: request => { assert.equal(request.method, 'tools/call'); return tool(request.params.name, request.params.arguments); } });
    if (standard) await h.initialize();
    await h.result(ticket);
    await waitState(h, 'ready');
    assert.deepEqual(calls.map(call => call.name), ['file_widget_read', 'file_widget_read', 'file_widget_release']);
    assert.equal(uploads.length, 0);
    await h.get('upload').trigger('click');
    assert.equal(uploads.length, 1);
    assert.deepEqual(Buffer.from(await uploads[0].arrayBuffer()), bytes);
    assert.equal(h.sent.some(message => message.method === 'ui/message'), false);
    assert.equal(JSON.stringify(h.sent).includes(bytes.subarray(0, 4096).toString('base64')), false);
  }
});

test('private chunk normalization rejects anonymous, conflicting, failed and uninspected wrapped results before decoding', async () => {
  const edits = [
    (chunk: any) => ({ unknown_result: chunk }),
    (chunk: any) => ({ mcp_tool_result: { structuredContent: chunk.structuredContent }, call_tool_result: { _meta: chunk._meta } }),
    (chunk: any) => { const other = structuredClone(chunk); other.structuredContent.source.device_id = 'another-device'; return { mcp_tool_result: chunk, call_tool_result: other }; },
    (chunk: any) => { const other = structuredClone(chunk); other.structuredContent.source.instance_id = 'older-instance'; return { mcp_tool_result: chunk, call_tool_result: other }; },
    (chunk: any) => { const other = structuredClone(chunk); other.structuredContent.data.offset++; return { mcp_tool_result: chunk, call_tool_result: other }; },
    (chunk: any) => { const other = structuredClone(chunk); other.structuredContent.data.ticket_id = 'B'.repeat(43); return { mcp_tool_result: chunk, call_tool_result: other }; },
    (chunk: any) => { const other = structuredClone(chunk); other._meta.webcodexChunk.base64 = Buffer.from('conflicting bytes').toString('base64'); return { mcp_tool_result: chunk, call_tool_result: other }; },
    (chunk: any) => ({ mcp_tool_result: chunk, call_tool_result: { mcp_tool_result: { isError: true, structuredContent: { ok: false } } } }),
    (chunk: any) => { let nested = chunk; for (let index = 0; index < 6; index++) nested = { call_tool_result: nested }; return nested; },
    (chunk: any) => {
      const tree = (depth: number): any => depth === 0 ? { structuredContent: chunk.structuredContent }
        : { mcp_tool_result: tree(depth - 1), call_tool_result: tree(depth - 1) };
      return { mcp_tool_result: chunk, call_tool_result: tree(3) };
    },
  ];
  for (const edit of edits) {
    const bytes = Buffer.from('private transport fixture'), ticket = ticketFile(bytes), calls: any[] = [];
    const h = harness({ callTool: ticketTool(bytes, ticket, calls, edit), uploadFile: async () => { assert.fail('Untrusted chunk uploaded'); } });
    await h.result(ticket);
    await waitState(h, 'failure');
    assert.deepEqual(calls.map(call => call.name), ['file_widget_read', 'file_widget_release']);
    assert.equal(h.decodeCalls, 0);
    assert.equal(h.get('upload').disabled, true);
    assert.equal(h.sent.some(message => message.method === 'ui/message'), false);
  }
});

test('ticket chunk identity, range, whole hash and per-chunk hash failures stop transfer and release', async () => {
  const bytes = Buffer.alloc(6000, 0x35);
  const edits = [
    (result: any) => { result.structuredContent.data.ticket_id = 'wrong'; },
    (result: any) => { result.structuredContent.data.offset++; },
    (result: any) => { result.structuredContent.data.next_offset = 0; },
    (result: any) => { result.structuredContent.data.size_bytes--; },
    (result: any) => { result.structuredContent.data.sha256 = '0'.repeat(64); },
    (result: any) => { result.structuredContent.data.chunk_sha256 = '0'.repeat(64); },
    (result: any) => { result.structuredContent.source = { device_id: 'wrong' }; },
    (result: any) => { result._meta.webcodexChunk.base64 += 'AAAA'; },
  ];
  for (const edit of edits) {
    const ticket = ticketFile(bytes), calls: any[] = [];
    const h = harness({ callTool: ticketTool(bytes, ticket, calls, result => { edit(result); return result; }), uploadFile: async () => { assert.fail('Invalid bytes uploaded'); } });
    await h.result(ticket);
    await waitState(h, 'failure');
    assert.equal(h.get('upload').disabled, true);
    assert.equal(calls.filter(call => call.name === 'file_widget_read').length, 1);
    assert.equal(calls.filter(call => call.name === 'file_widget_release').length, 1);
  }
});

test('ticket delivery verifies the final whole-file hash independently of valid chunk hashes', async () => {
  const bytes = Buffer.from('real bytes'), ticket = ticketFile(bytes), calls: any[] = [];
  ticket.structuredContent.data.sha256 = '0'.repeat(64);
  const h = harness({ callTool: ticketTool(bytes, ticket, calls), uploadFile: async () => ({ fileId: 'unused' }) });
  await h.result(ticket);
  await waitState(h, 'failure');
  assert.match(h.get('status').textContent, /SHA-256 不一致/);
  assert.equal(calls.at(-1).name, 'file_widget_release');
});

test('expired or mismatched delivery tickets are released without reading any chunks', async () => {
  for (const invalid of ['expired', 'delivery', 'chunk-size']) {
    const bytes = Buffer.from('data'), ticket = ticketFile(bytes), calls: any[] = [];
    if (invalid === 'expired') ticket._meta.webcodexDelivery.expiresAt = '2000-01-01T00:00:00.000Z';
    if (invalid === 'delivery') ticket._meta.webcodexDelivery.deliveryId = 'different-delivery';
    if (invalid === 'chunk-size') ticket._meta.webcodexDelivery.chunkMaxBytes = 262145;
    const h = harness({ callTool: ticketTool(bytes, ticket, calls), uploadFile: async () => ({ fileId: 'unused' }) });
    await h.result(ticket);
    await waitState(h, 'failure');
    assert.deepEqual(calls.map(call => call.name), ['file_widget_release']);
    assert.equal(h.decodeCalls, 0);
  }
});

test('cancelled ticket reads cannot overwrite newer state and release exactly once', async () => {
  const bytes = Buffer.from('cancel me'), ticket = ticketFile(bytes), calls: any[] = [];
  const tool = ticketTool(bytes, ticket, calls);
  let finish!: (result: unknown) => void;
  const h = harness({ callTool: async (name: string, args: any) => {
    const result = await tool(name, args);
    if (name === 'file_widget_read') return new Promise(resolve => { finish = () => resolve(result); });
    return result;
  }, uploadFile: async () => ({ fileId: 'unused' }) });
  await h.result(ticket);
  await waitState(h, 'receiving');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.get('clear').disabled, false);
  await h.get('clear').trigger('click');
  await new Promise(resolve => setImmediate(resolve));
  h.expireTimers();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.get('status').dataset.state, 'idle', 'A cancelled request timeout must not replace the cleared state.');
  finish(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.get('status').dataset.state, 'idle');
  assert.equal(h.get('filename').textContent, '—');
  assert.equal(h.get('upload').disabled, true);
  assert.equal(calls.filter(call => call.name === 'file_widget_release').length, 1);
});

test('late ticket metadata requires the exact public delivery_id even when the file hash matches', async () => {
  const bytes = Buffer.from('same file'), oldTicket = ticketFile(bytes), current = structuredClone(oldTicket), calls: any[] = [];
  current.structuredContent.data.delivery_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  current._meta.webcodexDelivery.deliveryId = current.structuredContent.data.delivery_id;
  current._meta.webcodexDelivery.ticketId = 'B'.repeat(43);
  const h = harness({ callTool: ticketTool(bytes, current, calls), uploadFile: async () => ({ fileId: 'unused' }) });
  await h.result({ structuredContent: current.structuredContent });
  h.host.toolOutput = current.structuredContent;
  h.host.toolResponseMetadata = { mcp_tool_result: oldTicket };
  await h.globals();
  assert.equal(calls.length, 0);
  h.host.toolResponseMetadata = { mcp_tool_result: current };
  await h.globals();
  await waitState(h, 'ready');
  assert.equal(calls[0].args.ticket_id, 'B'.repeat(43));
});

test('upload synchronizes bounded metadata and sends a resource_link only on a separate user click', async () => {
  const bytes = Buffer.from('SECRET ORIGINAL CONTENT NEVER IN MODEL CONTEXT');
  let uploadCount = 0;
  const h = harness({ uploadFile: async () => { uploadCount++; return { fileId: 'sediment://file_upload_ref' }; } }, { rpc: async request => {
    assert.ok(['ui/update-model-context', 'ui/message'].includes(request.method));
    return {};
  } });
  await h.initialize('2026-01-26', { serverTools: {}, updateModelContext: { structuredContent: {} }, message: { text: {}, resourceLink: {} } });
  await h.result(original(bytes));
  await waitState(h, 'ready');
  await h.get('upload').trigger('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sent.filter(item => item.method === 'ui/message').length, 0);
  const firstSync = h.sent.find(item => item.method === 'ui/update-model-context');
  assert.ok(firstSync);
  assert.equal(firstSync.params.structuredContent.upload_performed, true);
  assert.equal(firstSync.params.structuredContent.file_reference_sent, false);
  assert.equal(firstSync.params.structuredContent.model_access, 'unverified');
  assert.equal(firstSync.params.structuredContent.source, 'mcp');
  assert.equal(firstSync.params.structuredContent.device_id, 'd1');
  assert.equal(firstSync.params.structuredContent.workspace_id, 'paper');
  assert.ok(JSON.stringify(firstSync).length < 2048);
  assert.equal(h.get('send').disabled, false);
  await h.get('send').trigger('click');
  await h.get('send').trigger('click');
  await h.get('upload').trigger('click');
  const messages = h.sent.filter(item => item.method === 'ui/message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].params.role, 'user');
  assert.equal(messages[0].params.content[0].type, 'text');
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].params.content[1])), {
    type: 'resource_link', uri: 'sediment://file_upload_ref', name: '报告 <test>.pdf', mimeType: 'application/pdf', size: bytes.length,
  });
  assert.equal(uploadCount, 1);
  assert.equal(h.get('send').disabled, true);
  assert.match(h.get('send-status').textContent, /引用已发送.*不代表文件已经解析/);
  const outgoing = JSON.stringify(h.sent);
  assert.equal(outgoing.includes(bytes.toString()), false);
  assert.equal(outgoing.includes(bytes.toString('base64')), false);
  assert.equal(outgoing.includes('webcodexFile'), false);
  assert.equal(h.sent.filter(item => item.method === 'ui/update-model-context').at(-1).params.structuredContent.file_reference_sent, true);
});

test('unsupported file-reference messages are never replaced by raw content or a fake success', async () => {
  const states: any[] = [];
  const bytes = Buffer.from('UNSUPPORTED_REFERENCE_PRIVATE_BYTES_94267');
  const h = harness({ uploadFile: async () => ({ fileId: 'sediment://file_no_message' }), setWidgetState: (state: unknown) => states.push(state) });
  await h.initialize('2026-01-26', { serverTools: {}, message: { text: {} } });
  await h.select(new File([bytes], '原文.docx'));
  await h.get('upload').trigger('click');
  assert.equal(h.get('send').disabled, true);
  await h.get('send').trigger('click');
  assert.equal(h.sent.some(item => item.method === 'ui/message'), false);
  assert.match(h.get('send-status').textContent, /未声明 resourceLink/);
  assert.equal(states.length, 1);
  assert.equal(states[0].modelContent.upload_performed, true);
  assert.equal(states[0].modelContent.model_access, 'unverified');
  assert.equal(states[0].modelContent.source, 'browser');
  assert.equal(JSON.stringify(states).includes(bytes.toString()), false);
  assert.equal(JSON.stringify(states).includes(bytes.toString('base64')), false);
  assert.doesNotMatch(JSON.stringify(states), /webcodexChunk|ticketId/);
});

test('context synchronization failure preserves the successful upload and does not reupload', async () => {
  let uploads = 0;
  const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://file_still_uploaded' }; } },
    { rpc: async () => { throw new Error('context rejected'); } });
  await h.initialize('2026-01-26', { updateModelContext: { text: {} } });
  await h.select(new File(['data'], 'still.pdf'));
  await h.get('upload').trigger('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.get('status').dataset.state, 'uploaded-awaiting-attachment');
  assert.match(h.get('receipt').textContent, /file_still_uploaded/);
  assert.match(h.get('sync-status').textContent, /同步未确认.*回执仍然有效/);
  await h.get('upload').trigger('click');
  assert.equal(uploads, 1);
});

test('rejected reference sends can be retried without another upload and lock concurrent clicks', async () => {
  let uploads = 0, attempts = 0;
  let finish!: (result: unknown) => void;
  const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://file_retry_send' }; } }, { rpc: async request => {
    assert.equal(request.method, 'ui/message');
    attempts++;
    if (attempts === 1) return { isError: true };
    return new Promise(resolve => { finish = resolve; });
  } });
  await h.initialize('2026-01-26', { message: { text: {}, resourceLink: {} } });
  await h.select(new File(['data'], 'retry.pdf'));
  await h.get('upload').trigger('click');
  await h.get('send').trigger('click');
  assert.equal(h.get('send').disabled, false);
  assert.match(h.get('send-status').textContent, /发送未确认/);
  const sending = h.get('send').trigger('click');
  await new Promise(resolve => setImmediate(resolve));
  await h.get('send').trigger('click');
  assert.equal(attempts, 2);
  finish({});
  await sending;
  assert.equal(h.get('send').disabled, true);
  assert.equal(uploads, 1);
});

test('tool calls prefer compatibility when serverTools is absent and only fallback on method-not-found', async () => {
  let compatibility = 0;
  const fallback = async () => { compatibility++; return { structuredContent: { prototype: true, mode: 'capabilities' } }; };
  const absent = harness({ callTool: fallback });
  await absent.initialize('2026-01-26', {});
  await absent.get('probe').trigger('click');
  assert.equal(compatibility, 1);
  assert.equal(absent.sent.filter(item => item.method === 'tools/call').length, 0);
  const unsupported = harness({ callTool: fallback }, { rpc: async () => { throw Object.assign(new Error('unsupported method'), { code: -32601 }); } });
  await unsupported.initialize();
  await unsupported.get('probe').trigger('click');
  assert.equal(compatibility, 2);
  assert.equal(unsupported.sent.filter(item => item.method === 'tools/call').length, 1);
  const timedOut = harness({ callTool: fallback });
  await timedOut.initialize();
  const probe = timedOut.get('probe').trigger('click');
  timedOut.expireTimers();
  await probe;
  assert.equal(compatibility, 2);
  assert.match(timedOut.get('tool-capability').textContent, /超时/);
});

test('ambiguous message responses retain upload and instruct checking before retry', async () => {
  for (const response of [undefined, null, false, { isError: 'false' }]) {
    const h = harness({ uploadFile: async () => ({ fileId: 'sediment://file_ambiguous' }) }, { rpc: async () => response });
    await h.initialize('2026-01-26', { message: { text: {}, resourceLink: {} } });
    await h.select(new File(['data'], 'original.pdf'));
    await h.get('upload').trigger('click');
    await h.get('send').trigger('click');
    assert.match(h.get('send-status').textContent, /先查看是否已经出现新消息/);
    assert.equal(h.get('status').dataset.state, 'uploaded-awaiting-attachment');
    assert.equal(h.get('upload').disabled, true);
    assert.equal(h.get('send').disabled, false);
  }
});

test('message acknowledgment diagnostics expose finite shapes while preserving the existing acceptance gate', async () => {
  const secret = 'HOST_PRIVATE_PAYLOAD_MUST_NOT_APPEAR_61417';
  const circular: any = { privatePayload: secret }; circular.self = circular;
  const cases: { response: unknown; shape: string; error: string; accepted: boolean }[] = [
    { response: undefined, shape: 'undefined', error: 'absent', accepted: false },
    { response: null, shape: 'null', error: 'absent', accepted: false },
    { response: [secret], shape: 'array', error: 'absent', accepted: false },
    { response: false, shape: 'primitive', error: 'absent', accepted: false },
    { response: secret, shape: 'primitive', error: 'absent', accepted: false },
    { response: { isError: true, details: secret }, shape: 'object', error: 'true', accepted: false },
    { response: { isError: secret }, shape: 'object', error: 'invalid', accepted: false },
    { response: { isError: null }, shape: 'object', error: 'invalid', accepted: false },
    { response: {}, shape: 'object', error: 'absent', accepted: true },
    { response: { isError: undefined }, shape: 'object', error: 'absent', accepted: true },
    { response: { isError: false, privatePayload: secret }, shape: 'object', error: 'false', accepted: true },
    { response: circular, shape: 'object', error: 'absent', accepted: true },
  ];
  for (const example of cases) {
    let uploads = 0, messages = 0;
    const states: any[] = [];
    const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://shape-check' }; }, setWidgetState: (state: any) => states.push(state) },
      { rpc: async request => { assert.equal(request.method, 'ui/message'); messages++; return example.response; } });
    await h.initialize('2026-01-26', { message: { resourceLink: {} } });
    await h.select(new File(['synthetic file'], 'original.pdf'));
    await h.get('upload').trigger('click');
    const receipt = h.get('receipt').textContent;
    await h.get('send').trigger('click');
    const diagnostic = `宿主回执形态：result_shape=${example.shape}；is_error=${example.error}。`;
    assert.equal(h.get('message-ack-shape').textContent, diagnostic);
    assert.equal(h.get('send').disabled, example.accepted);
    assert.match(h.get('send-status').textContent, example.accepted ? /原文件引用已发送/ : /发送未确认/);
    assert.equal(h.get('receipt').textContent, receipt);
    await h.globals();
    await h.get('refresh').trigger('click');
    assert.equal(h.get('message-ack-shape').textContent, diagnostic);
    assert.equal(uploads, 1);
    assert.equal(messages, 1);
    assert.equal(JSON.stringify({ states, requests: h.sent, diagnostic }).includes(secret), false);
    await h.select(new File(['next selection'], 'next.pdf'));
    assert.equal(h.get('message-ack-shape').textContent, '宿主回执形态：尚未采集。');
  }
});

test('a missing message acknowledgment is diagnosed without an automatic retry or losing the upload', async () => {
  const h = harness({ uploadFile: async () => ({ fileId: 'sediment://missing-ack' }) });
  await h.initialize('2026-01-26', { message: { resourceLink: {} } });
  await h.select(new File(['data'], 'original.pdf'));
  await h.get('upload').trigger('click');
  const receipt = h.get('receipt').textContent;
  const sending = h.get('send').trigger('click');
  h.expireTimers();
  await sending;
  assert.equal(h.get('message-ack-shape').textContent, '宿主回执形态：未收到可检查结果（请求失败或超时）。');
  assert.equal(h.get('receipt').textContent, receipt);
  assert.equal(h.get('upload').disabled, true);
  await h.globals();
  assert.equal(h.sent.filter(message => message.method === 'ui/message').length, 1);
});
