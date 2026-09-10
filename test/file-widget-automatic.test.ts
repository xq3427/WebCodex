import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import { renderFileWidget } from '../src/file-widget.js';

type Handler = (event: any) => unknown;
class Element {
  textContent = ''; disabled = false; checked = false; value = ''; open = true;
  files: any[] = []; dataset: Record<string, string> = {};
  listeners = new Map<string, Handler[]>();
  set innerHTML(_value: string) { throw new Error('Dynamic HTML injection is forbidden'); }
  addEventListener(name: string, handler: Handler) { this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]); }
  async trigger(name: string) { for (const handler of this.listeners.get(name) ?? []) await handler({ target: this }); }
}

/** Isolated browser simulation; no App, real files, live state or host network. */
function harness(host: Record<string, any> = {}, options: { rpc?: (request: any) => unknown | Promise<unknown> } = {}) {
  const html = renderFileWidget();
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.get('status')!.dataset.state = 'idle';
  const listeners = new Map<string, Handler[]>(), timers = new Map<number, () => void>();
  const sent: any[] = [], states: any[] = [];
  let timerId = 0, deliver: ((data: unknown) => Promise<void>) | undefined;
  if (!Object.hasOwn(host, 'setWidgetState')) host.setWidgetState = (state: unknown) => { states.push(structuredClone(state)); host.widgetState = state; };
  const parent = { postMessage: (request: any, target: string) => {
    assert.equal(target, '*'); sent.push(request);
    if (request.id !== undefined && request.method !== 'ui/initialize') {
      Promise.resolve().then(() => options.rpc ? options.rpc(request) : {}).then(
        result => deliver?.({ jsonrpc: '2.0', id: request.id, result }),
        error => deliver?.({ jsonrpc: '2.0', id: request.id, error: { message: error.message, code: error.code } }),
      );
    }
  } };
  const script = html.match(/<script>\n([\s\S]+?)\n<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    window: { parent, openai: host, addEventListener(name: string, handler: Handler) { listeners.set(name, [...listeners.get(name) ?? [], handler]); } },
    document: { getElementById: (id: string) => { assert.ok(elements.has(id)); return elements.get(id); } },
    File, Uint8Array, crypto: webcrypto, atob, btoa,
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  }, { timeout: 3000 });
  const emit = async (name: string, event: unknown) => { for (const handler of listeners.get(name) ?? []) await handler(event); };
  const receive = (data: unknown) => emit('message', { source: parent, data });
  deliver = receive;
  const get = (id: string) => elements.get(id)!;
  return {
    host, sent, states, get,
    initialize: async (capabilities: Record<string, unknown> = { message: { text: {}, resourceLink: {} } }, protocolVersion = '2026-01-26') => {
      const request = sent.find(item => item.method === 'ui/initialize'); assert.ok(request);
      await receive({ jsonrpc: '2.0', id: request.id, result: { protocolVersion, hostCapabilities: capabilities } });
      await flush();
    },
    result: (result: unknown) => receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    globals: () => emit('openai:set_globals', {}),
    select: async (file: File) => { get('pick').files = [file]; await get('pick').trigger('change'); },
    expireTimers: () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } },
  };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(check(), label);
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function original(bytes: Buffer, name = '原文件.pdf', ui = { mode: 'automatic', compact: true, close_after_send: true }): any {
  return {
    structuredContent: { ok: true, source: { device_id: 'device-1', instance_id: 'instance-1' }, data: {
      prototype: true, mode: 'local-file', device_id: 'device-1', instance_id: 'instance-1', workspace_id: 'default',
      path: name, name, mime_type: 'application/pdf', size_bytes: bytes.length, sha256: sha(bytes), delivery_id: randomUUID(), ui,
    } },
    _meta: { webcodexFile: { name, mimeType: 'application/pdf', sizeBytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') } },
  };
}
function ticketFile(bytes: Buffer): any {
  const result = original(bytes);
  result._meta = { webcodexDelivery: { ticketId: 'A'.repeat(43), deliveryId: result.structuredContent.data.delivery_id,
    expiresAt: new Date(Date.now() + 300000).toISOString(), chunkMaxBytes: 4096 } };
  return result;
}
const messages = (h: ReturnType<typeof harness>) => h.sent.filter(item => item.method === 'ui/message');
const capabilitySummary = (h: ReturnType<typeof harness>) => JSON.parse(h.get('capabilities-summary').textContent);
const contextStates = (h: ReturnType<typeof harness>) => h.sent.filter(item => item.method === 'ui/update-model-context')
  .map(item => JSON.parse(item.params.structuredContent ? JSON.stringify(item.params.structuredContent) : item.params.content[0].text));
const capabilityProbe = () => ({ structuredContent: { ok: true, source: { device_id: 'device-1', instance_id: 'instance-1' },
  data: { prototype: true, mode: 'capabilities', device_id: 'device-1', ui: { mode: 'manual', compact: false, close_after_send: false } } } });

test('automatic MCP delivery verifies original chunks, uploads and sends exactly once without clicks', async () => {
  const bytes = Buffer.alloc(9001, 0xa3), result = ticketFile(bytes), uploads: File[] = [], calls: any[] = [];
  let closes = 0;
  const h = harness({ uploadFile: async (file: File) => { uploads.push(file); return { fileId: 'sediment://automatic-original' }; },
    requestClose: async () => { closes++; }, callTool: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'file_widget_release') return { structuredContent: { ok: true, data: { released: true } } };
      assert.equal(name, 'file_widget_read');
      const chunk = bytes.subarray(args.offset, args.offset + 4096), next = args.offset + chunk.length;
      return { structuredContent: { ok: true, source: result.structuredContent.source, data: {
        ticket_id: args.ticket_id, offset: args.offset, size_bytes: chunk.length, total_bytes: bytes.length,
        next_offset: next === bytes.length ? null : next, eof: next === bytes.length, sha256: sha(bytes), chunk_sha256: sha(chunk),
      } }, _meta: { webcodexChunk: { base64: chunk.toString('base64') } } };
    } });
  await h.initialize(); await h.result(result);
  await waitFor(() => closes === 1, 'Automatic handoff should finish and request close.');
  assert.equal(uploads.length, 1); assert.deepEqual(Buffer.from(await uploads[0].arrayBuffer()), bytes);
  assert.deepEqual(calls.filter(call => call.name === 'file_widget_read').map(call => call.args.offset), [0, 4096, 8192]);
  assert.equal(calls.filter(call => call.name === 'file_widget_release').length, 1);
  assert.equal(messages(h).length, 1);
  assert.equal(messages(h)[0].params.content[1].uri, 'sediment://automatic-original');
  assert.equal(h.get('version').textContent, h.sent.find(item => item.method === 'ui/initialize').params.appInfo.version);
  assert.match(h.get('version').textContent, /^0\.\d+\.\d+-preview\.\d+$/);
  assert.match(h.get('operation-mode').textContent, /^automatic/);
  assert.equal(h.get('details').open, false);
  assert.equal(h.get('send').disabled, true);
  assert.equal(h.host.widgetState.modelContent.handoff_status, 'reference_sent');
  const outgoing = JSON.stringify([h.sent, h.states]);
  assert.equal(outgoing.includes(bytes.toString('base64')), false);
  assert.equal(JSON.stringify(h.states).includes('A'.repeat(43)), false);
  await h.result(structuredClone(result));
  h.host.toolOutput = result.structuredContent; h.host.toolResponseMetadata = result._meta;
  await h.globals(); await h.globals(); await flush();
  assert.equal(uploads.length, 1); assert.equal(messages(h).length, 1); assert.equal(closes, 1);
});

test('manual policy, capability probe and browser selection never start automatic uploads or messages', async () => {
  const uploads: File[] = [];
  const h = harness({ uploadFile: async (file: File) => { uploads.push(file); return { fileId: 'sediment://manual-only' }; } });
  await h.initialize();
  await h.result(original(Buffer.from('manual MCP'), 'manual.pdf', { mode: 'manual', compact: false, close_after_send: false }));
  await waitFor(() => h.get('status').dataset.state === 'ready', 'Manual MCP file must become ready.');
  assert.match(h.get('operation-mode').textContent, /^manual/);
  assert.equal(uploads.length, 0); assert.equal(messages(h).length, 0);
  await h.result({ structuredContent: { prototype: true, mode: 'capabilities', ui: { mode: 'manual', compact: false, close_after_send: false } } });
  await flush(); assert.equal(uploads.length, 0);
  await h.select(new File(['browser original'], 'browser.pdf', { type: 'application/pdf' }));
  assert.match(h.get('operation-mode').textContent, /^manual/);
  await flush(); assert.equal(uploads.length, 0);
  await h.get('upload').trigger('click'); await flush();
  assert.equal(uploads.length, 1); assert.equal(uploads[0].name, 'browser.pdf'); assert.equal(messages(h).length, 0);
  assert.equal(h.host.widgetState.modelContent.handoff_status, 'uploaded_awaiting_reference');
});

test('hosts without widget-state persistence still automate once within the current component instance', async () => {
  let uploads = 0;
  const result = original(Buffer.from('no widget-state API'));
  const h = harness({ setWidgetState: undefined, uploadFile: async () => { uploads++; return { fileId: 'sediment://memory-only' }; } });
  await h.initialize(); await h.result(result);
  await waitFor(() => /引用已发送/.test(h.get('send-status').textContent), 'Standard messages should work without widget-state persistence.');
  await h.result(structuredClone(result));
  h.host.toolOutput = result.structuredContent; h.host.toolResponseMetadata = result._meta;
  await h.globals(); await h.globals(); await flush();
  assert.equal(uploads, 1); assert.equal(messages(h).length, 1); assert.equal(h.states.length, 0);
  assert.equal(messages(h)[0].params.content[1].uri, 'sediment://memory-only');
});

test('restored automatic stages stop before reading released tickets and never repeat host side effects', async () => {
  for (const stage of ['upload_started', 'upload_failed', 'send_started', 'send_failed', 'sent']) {
    const result = ticketFile(Buffer.from('already attempted'));
    let reads = 0, uploads = 0;
    const h = harness({ widgetState: { privateContent: { webcodexAutomatic: [{ deliveryId: result.structuredContent.data.delivery_id, stage }] } },
      uploadFile: async () => { uploads++; return { fileId: 'unused' }; }, callTool: async () => { reads++; throw new Error('Ticket already released'); } });
    await h.initialize(); await h.result(result); await flush();
    assert.equal(reads, 0, stage); assert.equal(uploads, 0, stage); assert.equal(messages(h).length, 0, stage);
    assert.equal(h.get('status').dataset.state, 'restored', stage);
    assert.match(h.get('status').textContent, stage === 'sent' ? /发送完成/ : /需检查/);
  }
});

test('widget state arriving after an unavailable ticket restores the known result without a second read', async () => {
  const result = ticketFile(Buffer.from('late state'));
  let reads = 0;
  const h = harness({ uploadFile: async () => { assert.fail('Restored original must not upload again'); },
    callTool: async (name: string) => { if (name === 'file_widget_read') { reads++; throw new Error('Ticket already released'); } return {}; } });
  await h.initialize(); await h.result(result);
  await waitFor(() => h.get('status').dataset.state === 'failure', 'Old ticket must initially be unavailable.');
  h.host.widgetState = { privateContent: { webcodexAutomatic: [{ deliveryId: result.structuredContent.data.delivery_id, stage: 'sent' }] } };
  await h.globals(); await flush();
  assert.equal(reads, 1); assert.equal(h.get('status').dataset.state, 'restored'); assert.equal(messages(h).length, 0);
});

test('uncertain automatic uploads and rejected sends are not retried by tool echoes or capability refreshes', async () => {
  for (const failure of ['upload', 'send']) {
    const result = original(Buffer.from(failure)); let uploads = 0, closes = 0;
    const h = harness({ uploadFile: async () => { uploads++; if (failure === 'upload') throw new Error('Upload outcome unknown'); return { fileId: 'sediment://retained' }; },
      requestClose: async () => { closes++; } }, { rpc: async request => request.method === 'ui/message' ? { isError: true } : {} });
    await h.initialize(); await h.result(result);
    await waitFor(() => failure === 'upload' ? h.get('status').dataset.state === 'failure' : /发送未确认/.test(h.get('send-status').textContent), failure + ' failure should remain visible.');
    await h.result(structuredClone(result)); await h.get('refresh').trigger('click');
    h.host.toolOutput = result.structuredContent; h.host.toolResponseMetadata = result._meta;
    await h.globals(); await flush();
    assert.equal(uploads, 1, failure); assert.equal(messages(h).length, failure === 'send' ? 1 : 0); assert.equal(closes, 0);
    assert.equal(h.get('details').open, true);
    if (failure === 'send') { assert.equal(h.get('upload').disabled, true); assert.equal(h.get('send').disabled, false); }
  }
});

test('message timeouts keep the successful upload and never cause an automatic resend or close', async () => {
  let uploads = 0, closes = 0;
  const result = original(Buffer.from('uncertain message'));
  const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://uncertain-send' }; }, requestClose: async () => { closes++; } },
    { rpc: async request => request.method === 'ui/message' ? new Promise(() => {}) : {} });
  await h.initialize(); await h.result(result);
  await waitFor(() => messages(h).length === 1, 'Automatic reference should be attempted.');
  h.expireTimers();
  await waitFor(() => /发送未确认/.test(h.get('send-status').textContent), 'Timeout should retain an uncertain result.');
  await h.result(structuredClone(result)); await h.globals(); await flush();
  assert.equal(uploads, 1); assert.equal(messages(h).length, 1); assert.equal(closes, 0);
  assert.match(h.get('send-status').textContent, /先查看/);
});

test('missing resource-link capability keeps the upload available and never substitutes a text-only message', async () => {
  let uploads = 0, closes = 0;
  const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://no-resource-link' }; }, requestClose: async () => { closes++; } });
  await h.initialize({ message: { text: {} } }); await h.result(original(Buffer.from('native original')));
  await waitFor(() => /路线已阻断/.test(h.get('status').textContent), 'Missing capability must stop automatic sending.');
  assert.equal(uploads, 1); assert.equal(messages(h).length, 0); assert.equal(closes, 0); assert.equal(h.get('details').open, true);
  assert.match(h.get('receipt').textContent, /sediment:\/\/no-resource-link/);
});

test('a queued new delivery survives an older echo and the old upload cannot send or close the new file', async () => {
  const first = original(Buffer.from('first original'), 'first.pdf'), second = original(Buffer.from('second original'), 'second.pdf');
  const uploads: string[] = []; let finish!: (value: unknown) => void, closes = 0;
  const h = harness({ uploadFile: async (file: File) => {
    uploads.push(file.name);
    if (file.name === 'first.pdf') return new Promise(resolve => { finish = resolve; });
    return { fileId: 'sediment://second' };
  }, requestClose: async () => { closes++; } });
  await h.initialize(); await h.result(first);
  await waitFor(() => uploads.length === 1, 'First upload must be pending.');
  await h.result(second); await h.result(structuredClone(first));
  finish({ fileId: 'sediment://first' });
  await waitFor(() => closes === 1, 'Newest delivery should finish its own handoff.');
  assert.deepEqual(uploads, ['first.pdf', 'second.pdf']);
  assert.equal(messages(h).length, 1); assert.equal(messages(h)[0].params.content[1].name, 'second.pdf');
  assert.equal(h.get('filename').textContent, 'second.pdf');
});

test('close policy is honored and a rejected close preserves a single completed reference send', async () => {
  for (const closeAfterSend of [false, true]) {
    let closes = 0, uploads = 0;
    const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://close-policy' }; },
      requestClose: async () => { closes++; throw new Error('Close denied by host'); } });
    const result = original(Buffer.from('close'), 'close.pdf', { mode: 'automatic', compact: true, close_after_send: closeAfterSend });
    await h.initialize(); await h.result(result);
    await waitFor(() => /引用已发送/.test(h.get('send-status').textContent), 'Reference must be accepted.');
    if (closeAfterSend) await waitFor(() => /自动收起未成功/.test(h.get('close-status').textContent), 'Rejected close must remain visible.');
    await h.result(structuredClone(result)); await flush();
    assert.equal(closes, closeAfterSend ? 1 : 0); assert.equal(uploads, 1); assert.equal(messages(h).length, 1);
    assert.equal(h.get('send').disabled, true);
  }
});

test('asynchronous state persistence rejection stops before any automatic upload or message', async () => {
  let uploads = 0, writes = 0;
  const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'unused' }; },
    setWidgetState: async () => { writes++; throw new Error('State save rejected asynchronously'); } });
  await h.initialize(); await h.result(original(Buffer.from('persist first')));
  await waitFor(() => writes > 0 && /未保存/.test(h.get('close-status').textContent), 'State failure should be caught and visible.');
  await flush(); assert.equal(uploads, 0); assert.equal(messages(h).length, 0); assert.equal(h.get('details').open, true);
});

test('late browser selection while automatic state is saving cannot be uploaded by the previous MCP request', async () => {
  let finish!: () => void, writes = 0; const uploads: string[] = [];
  const h = harness({ uploadFile: async (file: File) => { uploads.push(file.name); return { fileId: 'unused' }; },
    setWidgetState: async () => { writes++; if (writes === 1) await new Promise<void>(resolve => { finish = resolve; }); } });
  await h.initialize(); await h.result(original(Buffer.from('old original'), 'old.pdf'));
  await waitFor(() => writes === 1, 'Automatic preparation should be waiting on durable state.');
  await h.get('clear').trigger('click');
  await h.select(new File(['browser selection'], 'browser-late.pdf', { type: 'application/pdf' }));
  finish(); await flush(); await flush();
  assert.deepEqual(uploads, []); assert.equal(messages(h).length, 0);
  assert.equal(h.get('filename').textContent, 'browser-late.pdf'); assert.equal(h.get('status').dataset.state, 'ready');
});

test('a newer MCP result arriving during state persistence invalidates the old automatic continuation', async () => {
  let finish!: () => void, writes = 0; const uploads: string[] = [];
  const h = harness({ uploadFile: async (file: File) => { uploads.push(file.name); return { fileId: 'sediment://latest' }; },
    setWidgetState: async () => { writes++; if (writes === 1) await new Promise<void>(resolve => { finish = resolve; }); } });
  await h.initialize(); await h.result(original(Buffer.from('old'), 'old.pdf'));
  await waitFor(() => writes === 1, 'Old delivery must pause before its upload.');
  await h.result(original(Buffer.from('latest'), 'latest.pdf'));
  finish();
  await waitFor(() => messages(h).length === 1, 'Newest delivery should continue after the state write completes.');
  assert.deepEqual(uploads, ['latest.pdf']); assert.equal(messages(h)[0].params.content[1].name, 'latest.pdf');
});

test('late uploadFile injection resumes an unstarted authorized delivery once after globals or bridge initialization', async () => {
  for (const event of ['globals', 'initialize']) {
    let uploads = 0;
    const result = original(Buffer.from('late host capability'), 'late-api.pdf');
    const h = harness();
    if (event === 'globals') await h.initialize();
    await h.result(result);
    await waitFor(() => h.get('filename').textContent === 'late-api.pdf' && h.get('status').dataset.state === 'unavailable', 'Verified original should wait for upload capability.');
    await flush();
    assert.equal(h.states.some(state => state.privateContent?.webcodexAutomatic?.some((attempt: any) => attempt.deliveryId === result.structuredContent.data.delivery_id)), false,
      'An absent upload API must not persist an upload attempt that never started.');
    h.host.uploadFile = async () => { uploads++; return { fileId: 'sediment://late-capability' }; };
    if (event === 'globals') await h.globals(); else await h.initialize();
    await waitFor(() => /引用已发送/.test(h.get('send-status').textContent), event + ' should continue the waiting automatic delivery.');
    await h.globals(); await h.globals(); await h.result(structuredClone(result)); await flush();
    assert.equal(uploads, 1, event); assert.equal(messages(h).length, 1, event);
  }
});

test('globals updates during an already started upload never replay the original through a newly injected API', async () => {
  let finish!: (value: unknown) => void, uploads = 0;
  const result = original(Buffer.from('started before globals'));
  const h = harness({ uploadFile: () => { uploads++; return new Promise(resolve => { finish = resolve; }); } });
  await h.initialize(); await h.result(result);
  await waitFor(() => uploads === 1, 'Original upload should already be in flight.');
  h.host.uploadFile = async () => { uploads++; return { fileId: 'sediment://must-not-repeat' }; };
  await h.globals(); await h.globals(); await h.result(structuredClone(result)); await flush();
  assert.equal(uploads, 1); assert.equal(messages(h).length, 0);
  finish({ fileId: 'sediment://original-attempt' });
  await waitFor(() => /引用已发送/.test(h.get('send-status').textContent), 'Started upload should complete its original continuation.');
  await h.globals(); await flush();
  assert.equal(uploads, 1); assert.equal(messages(h).length, 1);
  assert.equal(messages(h)[0].params.content[1].uri, 'sediment://original-attempt');
});

test('late upload capability and a restored sent record in the same globals update cannot restart the delivery', async () => {
  let uploads = 0;
  const result = original(Buffer.from('already sent in an earlier mount'), 'restored-with-api.pdf');
  const h = harness(); await h.initialize(); await h.result(result);
  await waitFor(() => h.get('filename').textContent === 'restored-with-api.pdf' && h.get('status').dataset.state === 'unavailable', 'Original should be waiting for host capability.');
  h.host.widgetState = { privateContent: { webcodexAutomatic: [{ deliveryId: result.structuredContent.data.delivery_id, stage: 'sent' }] } };
  h.host.uploadFile = async () => { uploads++; return { fileId: 'sediment://must-not-duplicate-restored' }; };
  await h.globals(); await h.globals(); await flush();
  assert.equal(uploads, 0); assert.equal(messages(h).length, 0);
  assert.equal(h.get('status').dataset.state, 'restored'); assert.match(h.get('status').textContent, /发送完成/);
});

test('automatic close waits for the final standard model-context ACK and keeps selection locked while it is pending', async () => {
  let finish!: () => void, finalPending = false, contextSent = false, closes = 0;
  const statesAtClose: boolean[] = [], uploads: string[] = [];
  const h = harness({ uploadFile: async (file: File) => { uploads.push(file.name); return { fileId: 'sediment://standard-context' }; },
    requestClose: () => { closes++; statesAtClose.push(contextSent); } }, { rpc: async request => {
      if (request.method === 'ui/update-model-context' && request.params.structuredContent.file_reference_sent === true) {
        finalPending = true; await new Promise<void>(resolve => { finish = resolve; }); contextSent = true;
      }
      return {};
    } });
  await h.initialize({ message: { text: {}, resourceLink: {} }, updateModelContext: { structuredContent: {} } });
  await h.result(original(Buffer.from('final context'), 'context.pdf'));
  await waitFor(() => finalPending, 'Final model-context update should be waiting for its ACK.');
  await flush();
  assert.equal(closes, 0, 'Message ACK alone must not close the component before its final context update.');
  assert.equal(h.get('pick').disabled, true);
  await h.select(new File(['unapproved automatic browser selection'], 'new-browser.pdf'));
  assert.equal(h.get('filename').textContent, 'context.pdf', 'A picker event must not replace a file during its pending handoff.');
  finish(); await waitFor(() => closes === 1, 'Component should close only after the final state is acknowledged.');
  assert.deepEqual(statesAtClose, [true]); assert.deepEqual(uploads, ['context.pdf']); assert.equal(messages(h).length, 1);
});

test('rejected final model context keeps the sent receipt visible without closing or repeating the file reference', async () => {
  let closes = 0, uploads = 0;
  const result = original(Buffer.from('accepted reference, rejected context'));
  const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://context-rejected' }; }, requestClose: () => { closes++; } },
    { rpc: async request => {
      if (request.method === 'ui/update-model-context' && request.params.structuredContent.file_reference_sent === true) throw new Error('Final context rejected');
      return {};
    } });
  await h.initialize({ message: { text: {}, resourceLink: {} }, updateModelContext: { structuredContent: {} } });
  await h.result(result);
  await waitFor(() => /同步未确认/.test(h.get('sync-status').textContent), 'Rejected final context should remain distinguishable from a rejected message.');
  await h.globals(); await h.result(structuredClone(result)); await flush();
  assert.equal(closes, 0); assert.equal(uploads, 1); assert.equal(messages(h).length, 1);
  assert.match(h.get('receipt').textContent, /sediment:\/\/context-rejected/);
  assert.match(h.get('send-status').textContent, /引用已发送/); assert.equal(h.get('send').disabled, true);
  assert.equal(h.get('details').open, true);
});

test('automatic close also waits for fallback widget state to contain the completed file-reference status', async () => {
  let finish!: () => void, finalPending = false, closes = 0;
  const statesAtClose: unknown[] = [];
  const h = harness({ uploadFile: async () => ({ fileId: 'sediment://fallback-final-state' }),
    setWidgetState: async (state: any) => {
      if (state.modelContent.file_reference_sent === true) { finalPending = true; await new Promise<void>(resolve => { finish = resolve; }); }
      h.host.widgetState = state;
    },
    requestClose: () => { closes++; statesAtClose.push(h.host.widgetState?.modelContent?.file_reference_sent); } });
  await h.initialize(); await h.result(original(Buffer.from('fallback state')));
  await waitFor(() => finalPending, 'Final fallback state should be waiting on the host.');
  await flush(); assert.equal(closes, 0);
  assert.equal(h.host.widgetState.modelContent.file_reference_sent, false);
  finish(); await waitFor(() => closes === 1, 'Fallback state must be completed before close.');
  assert.deepEqual(statesAtClose, [true]); assert.equal(messages(h).length, 1);
});

test('a new delivery queued during final context synchronization prevents the old file from closing its component', async () => {
  const first = original(Buffer.from('old pending context'), 'old-context.pdf'), second = original(Buffer.from('new pending context'), 'new-context.pdf');
  let finish!: () => void, oldPending = false;
  const uploads: string[] = [], closedFiles: string[] = [];
  const h = harness({ uploadFile: async (file: File) => { uploads.push(file.name); return { fileId: 'sediment://' + file.name }; },
    requestClose: () => { closedFiles.push(h.get('filename').textContent); } }, { rpc: async request => {
      const state = request.params?.structuredContent;
      if (request.method === 'ui/update-model-context' && state.file_name === 'old-context.pdf' && state.file_reference_sent === true) {
        oldPending = true; await new Promise<void>(resolve => { finish = resolve; });
      }
      return {};
    } });
  await h.initialize({ message: { text: {}, resourceLink: {} }, updateModelContext: { structuredContent: {} } });
  await h.result(first); await waitFor(() => oldPending, 'Old final context should be pending.');
  await h.result(second); await h.result(structuredClone(first));
  assert.deepEqual(closedFiles, []);
  finish();
  await waitFor(() => closedFiles.length === 1, 'The new delivery should complete its own close.');
  assert.deepEqual(closedFiles, ['new-context.pdf']); assert.deepEqual(uploads, ['old-context.pdf', 'new-context.pdf']);
  assert.equal(messages(h).length, 2);
  assert.equal(messages(h)[1].params.content[1].name, 'new-context.pdf');
});

test('capability diagnostics distinguish initialization, absent declarations, empty objects and each named modality', async () => {
  const initial = harness();
  assert.deepEqual(capabilitySummary(initial), { initialization: 'not_ready', message: { declaration: 'absent', modalities: [] },
    update_model_context: { declaration: 'absent', modalities: [] },
    compatibility: { uploadFile: false, getFileDownloadUrl: false, selectFiles: false, sendFollowUpMessage: false } });
  const cases: Array<{ value: unknown; declaration: string; modalities: string[] }> = [
    { value: undefined, declaration: 'absent', modalities: [] }, { value: null, declaration: 'absent', modalities: [] },
    { value: [], declaration: 'absent', modalities: [] }, { value: 'untrusted', declaration: 'absent', modalities: [] },
    { value: {}, declaration: 'empty', modalities: [] },
    ...['text', 'image', 'audio', 'resource', 'resourceLink', 'structuredContent'].map(modality => ({ value: { [modality]: {} }, declaration: 'modalities', modalities: [modality] })),
  ];
  for (const entry of cases) {
    const h = harness(); await h.initialize({ message: entry.value, updateModelContext: entry.value });
    const summary = capabilitySummary(h), expected = { declaration: entry.declaration, modalities: entry.modalities };
    assert.equal(summary.initialization, 'ready'); assert.deepEqual(summary.message, expected); assert.deepEqual(summary.update_model_context, expected);
    assert.deepEqual(Object.keys(summary).sort(), ['compatibility', 'initialization', 'message', 'update_model_context']);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 1024); assert.equal(messages(h).length, 0);
  }
});

test('capability summaries copy only named modalities and API booleans without invoking helpers or exposing arbitrary host values', async () => {
  const marker = 'PRIVATE_HOST_VALUE_' + 'q'.repeat(12000);
  const forbidden = () => { assert.fail('Capability detection must never invoke file helpers or follow-up messaging'); };
  const h = harness({ uploadFile: async () => ({ fileId: 'sediment://legitimate-upload-receipt' }), getFileDownloadUrl: forbidden,
    selectFiles: forbidden, sendFollowUpMessage: forbidden, secret: marker });
  const richObject = { token: marker, fileId: 'sediment://private-host-id', downloadUrl: 'https://private.invalid/signed?secret=private-host',
    toJSON() { assert.fail('Arbitrary host values must not be serialized'); } };
  await h.initialize({ message: { text: richObject, image: richObject, audio: richObject, resource: richObject,
    resourceLink: richObject, structuredContent: richObject, unknownModality: richObject, _meta: richObject },
    updateModelContext: { structuredContent: richObject, unknownModality: richObject }, experimental: richObject });
  const summary = capabilitySummary(h);
  assert.deepEqual(summary.message.modalities, ['text', 'image', 'audio', 'resource', 'resourceLink', 'structuredContent']);
  assert.deepEqual(summary.update_model_context.modalities, ['structuredContent']);
  assert.deepEqual(summary.compatibility, { uploadFile: true, getFileDownloadUrl: true, selectFiles: true, sendFollowUpMessage: true });
  await h.select(new File(['ORIGINAL_BODY_DO_NOT_COPY_TO_DIAGNOSTICS'], 'whitelist.pdf', { type: 'application/pdf' }));
  await h.get('upload').trigger('click');
  await waitFor(() => contextStates(h).length > 0, 'Upload status should include the sanitized capabilities.');
  assert.deepEqual(contextStates(h).at(-1).host_capabilities, summary);
  const serialized = JSON.stringify([summary, h.sent, h.states]);
  assert.doesNotMatch(serialized, /PRIVATE_HOST_VALUE_|private-host-id|private\.invalid|unknownModality|ORIGINAL_BODY_DO_NOT_COPY_TO_DIAGNOSTICS/);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 1024); assert.equal(messages(h).length, 0);
});

test('invalid resource-link declarations remain blocked consistently in diagnostics and automatic or manual handoff', async () => {
  const declarations: unknown[] = [undefined, {}, { text: {} }, { resource: {} }, { resourceLink: true }, { resourceLink: [] }, { resourceLink: 'yes' }];
  for (const mode of ['automatic', 'manual']) for (const message of declarations) {
    let uploads = 0, closes = 0;
    const bytes = Buffer.from('ORIGINAL_FILE_BYTES_STAY_OUT_OF_DIAGNOSTICS'), result = original(bytes, 'blocked.pdf', { mode, compact: true, close_after_send: true });
    const forbidden = () => { assert.fail('A diagnostic-only release must not invent a compatibility file handoff'); };
    const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://blocked-receipt' }; },
      getFileDownloadUrl: forbidden, selectFiles: forbidden, sendFollowUpMessage: forbidden, requestClose: () => { closes++; } });
    await h.initialize({ message, updateModelContext: { structuredContent: {} } }); await h.result(result);
    if (mode === 'manual') {
      await waitFor(() => h.get('status').dataset.state === 'ready', 'Manual original should be ready before explicit upload.');
      await h.get('upload').trigger('click');
    }
    await waitFor(() => contextStates(h).some(state => state.handoff_status === 'host_file_reference_not_declared'), 'Model context must receive the fixed blocked status.');
    await flush(); await h.globals(); await h.globals(); await h.result(structuredClone(result)); await h.get('upload').trigger('click'); await flush();
    const state = contextStates(h).at(-1);
    assert.equal(state.handoff_status, 'host_file_reference_not_declared'); assert.equal(state.upload_performed, true);
    assert.equal(state.file_reference_sent, false); assert.equal(state.model_access, 'unverified');
    assert.match(state.handoff_instruction, /default route stops before sending/);
    assert.match(state.handoff_instruction, /not a host rejection/); assert.deepEqual(state.host_capabilities, capabilitySummary(h));
    assert.equal(state.host_capabilities.message.modalities.includes('resourceLink'), false);
    assert.equal(uploads, 1); assert.equal(messages(h).length, 0); assert.equal(closes, 0);
    assert.match(h.get('send-status').textContent, /路线已阻断/); assert.match(h.get('receipt').textContent, /sediment:\/\/blocked-receipt/);
    assert.equal(h.get('upload').disabled, true); assert.equal(h.get('send').disabled, true);
    assert.equal(JSON.stringify([h.sent, h.states]).includes(bytes.toString('base64')), false);
  }
});

test('manual upload before bridge initialization refreshes pending context to blocked without another upload or message', async () => {
  let uploads = 0;
  const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://pre-initialization' }; } });
  await h.select(new File(['early browser original'], 'early.pdf', { type: 'application/pdf' }));
  await h.get('upload').trigger('click');
  await waitFor(() => h.states.some(state => state.modelContent?.handoff_status === 'host_initialization_pending'), 'Pre-initialization status must stay unknown.');
  assert.equal(capabilitySummary(h).initialization, 'not_ready'); assert.equal(messages(h).length, 0);
  await h.initialize({ message: { text: {} }, updateModelContext: { structuredContent: {} } });
  await waitFor(() => contextStates(h).at(-1)?.handoff_status === 'host_file_reference_not_declared', 'Initialization must refresh the already uploaded receipt.');
  assert.equal(contextStates(h).at(-1).host_capabilities.initialization, 'ready');
  assert.equal(uploads, 1); assert.equal(messages(h).length, 0); assert.match(h.get('receipt').textContent, /pre-initialization/);
  const syncCount = contextStates(h).length;
  await h.globals(); await h.globals(); await flush();
  assert.equal(contextStates(h).length, syncCount, 'Unchanged theme globals must not resend identical diagnostics.');
});

test('failed automatic bridge initialization remains unknown instead of asserting that file references are unsupported', async () => {
  let uploads = 0;
  const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://unknown-bridge' }; } });
  await h.result(original(Buffer.from('unknown host bridge'), 'unknown.pdf'));
  await waitFor(() => uploads === 1, 'Compatibility upload should complete while initialization is pending.');
  await flush(); await flush();
  await h.initialize({ message: { resourceLink: {} } }, 'unsupported-protocol');
  await waitFor(() => /初始化/.test(h.get('send-status').textContent), 'A failed negotiation must report initialization uncertainty.');
  await flush();
  assert.equal(h.host.widgetState.modelContent.handoff_status, 'host_initialization_pending');
  assert.equal(capabilitySummary(h).initialization, 'not_ready');
  assert.doesNotMatch(h.get('send-status').textContent, /未声明 resourceLink|路线已阻断/);
  assert.equal(uploads, 1); assert.equal(messages(h).length, 0);
});

test('late optional host API injection refreshes a blocked receipt with booleans only and never retries file operations', async () => {
  let uploads = 0;
  const h = harness(); await h.initialize({ message: {}, updateModelContext: { structuredContent: {} } });
  await h.result(original(Buffer.from('late upload capability'), 'late-diagnostics.pdf'));
  await waitFor(() => h.get('filename').textContent === 'late-diagnostics.pdf' && h.get('status').dataset.state === 'unavailable', 'Original should wait for the upload API.');
  h.host.uploadFile = async () => { uploads++; return { fileId: 'sediment://late-diagnostics' }; };
  await h.globals();
  await waitFor(() => contextStates(h).at(-1)?.handoff_status === 'host_file_reference_not_declared', 'Late upload API should complete upload and publish the blocked route.');
  h.host.getFileDownloadUrl = () => { assert.fail('Diagnostic refresh must not fetch a file URL'); };
  h.host.sendFollowUpMessage = () => { assert.fail('Diagnostic refresh must not send a fallback message'); };
  await h.globals();
  await waitFor(() => contextStates(h).at(-1)?.host_capabilities.compatibility.getFileDownloadUrl === true, 'Optional API changes should refresh the current diagnostic state.');
  assert.deepEqual(contextStates(h).at(-1).host_capabilities.compatibility,
    { uploadFile: true, getFileDownloadUrl: true, selectFiles: false, sendFollowUpMessage: true });
  const syncCount = contextStates(h).length;
  await h.globals(); await h.globals(); await flush();
  assert.equal(contextStates(h).length, syncCount); assert.equal(uploads, 1); assert.equal(messages(h).length, 0);
});

test('a queued diagnostic update from an older delivery cannot overwrite the newer file after synchronization resumes', async () => {
  let finish!: () => void, oldPending = false;
  const completed: any[] = [], uploads: string[] = [];
  const h = harness({ uploadFile: async (file: File) => { uploads.push(file.name); return { fileId: 'sediment://' + file.name }; } }, { rpc: async request => {
    if (request.method === 'ui/update-model-context') {
      const state = request.params.structuredContent;
      if (state.file_name === 'older.pdf' && !oldPending) { oldPending = true; await new Promise<void>(resolve => { finish = resolve; }); }
      completed.push(structuredClone(state));
    }
    return {};
  } });
  await h.initialize({ message: { text: {} }, updateModelContext: { structuredContent: {} } });
  await h.result(original(Buffer.from('older original'), 'older.pdf'));
  await waitFor(() => oldPending, 'Old context update must be in flight.');
  await h.result(original(Buffer.from('newer original'), 'newer.pdf'));
  await waitFor(() => uploads.length === 2, 'New file should upload while the previous context response is pending.');
  finish();
  await waitFor(() => completed.at(-1)?.file_name === 'newer.pdf', 'Latest completed context must belong to the newer original.');
  await h.globals(); await flush();
  assert.deepEqual(uploads, ['older.pdf', 'newer.pdf']); assert.equal(messages(h).length, 0);
  assert.equal(completed.at(-1).handoff_status, 'host_file_reference_not_declared');
  const newerIndex = completed.findIndex(state => state.file_name === 'newer.pdf');
  assert.equal(completed.slice(newerIndex).some(state => state.file_name === 'older.pdf'), false);
  assert.equal(h.get('filename').textContent, 'newer.pdf'); assert.match(h.get('receipt').textContent, /sediment:\/\/newer\.pdf/);
});

test('resource-link-only hosts receive the original reference without an undeclared text modality', async () => {
  for (const textCapability of [undefined, true, [], {}]) {
    let uploads = 0;
    const bytes = Buffer.from('RESOURCE_LINK_ONLY_ORIGINAL_82319');
    const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://resource-link-only' }; },
      sendFollowUpMessage: () => { assert.fail('Resource-link-only delivery must not use a follow-up helper'); } });
    await h.initialize({ message: { resourceLink: {}, text: textCapability } });
    await h.result(original(bytes, 'resource-only.pdf'));
    await waitFor(() => /引用已发送/.test(h.get('send-status').textContent), 'A declared resource link should be accepted without a text capability.');
    const content = messages(h)[0].params.content;
    const textDeclared = textCapability !== null && typeof textCapability === 'object' && !Array.isArray(textCapability);
    assert.equal(content.length, textDeclared ? 2 : 1);
    if (textDeclared) assert.equal(content[0].type, 'text');
    assert.deepEqual(JSON.parse(JSON.stringify(content.at(-1))), { type: 'resource_link', uri: 'sediment://resource-link-only',
      name: 'resource-only.pdf', mimeType: 'application/pdf', size: bytes.length });
    assert.equal(uploads, 1); assert.equal(messages(h).length, 1);
    assert.equal(JSON.stringify(h.sent).includes(bytes.toString()), false);
    assert.equal(JSON.stringify(h.sent).includes(bytes.toString('base64')), false);
  }
});

test('an empty component never publishes model context merely from initialization or capability refresh', async () => {
  for (const standardContext of [false, true]) {
    const h = harness();
    await h.initialize({ message: { text: {} }, ...(standardContext ? { updateModelContext: { structuredContent: {} } } : {}) });
    await h.globals(); await h.globals(); await h.get('refresh').trigger('click'); await flush();
    assert.equal(contextStates(h).length, 0); assert.equal(h.states.length, 0);
    assert.equal(messages(h).length, 0); assert.equal(h.sent.some(item => item.method === 'tools/call'), false);
  }
});

test('an explicit capability probe publishes a bounded whitelist in either initialization order without file operations', async () => {
  for (const probeFirst of [false, true]) for (const contextModality of ['structuredContent', 'text']) {
    const marker = 'PRIVATE_PROBE_INPUT_' + 'q'.repeat(12000);
    const forbidden = () => { assert.fail('Capability synchronization must not read files, upload, close, or send helper messages'); };
    const h = harness({ uploadFile: forbidden, getFileDownloadUrl: forbidden, selectFiles: forbidden,
      sendFollowUpMessage: forbidden, callTool: forbidden, requestClose: forbidden });
    const probe = { ...capabilityProbe(), _meta: { private_value: marker, signedUrl: 'https://private.invalid/probe-secret' } };
    if (probeFirst) {
      probe.structuredContent.data.device_id = 'device-1-' + 'd'.repeat(240);
      probe.structuredContent.source.instance_id = 'instance-1-' + 'i'.repeat(240);
    }
    const capabilities = { message: { text: { secret: marker }, unknown: { secret: marker } }, updateModelContext: { [contextModality]: {} } };
    if (probeFirst) { await h.result(probe); await flush(); await h.initialize(capabilities); }
    else { await h.initialize(capabilities); await h.result(probe); }
    await waitFor(() => contextStates(h).at(-1)?.host_capabilities?.initialization === 'ready' && /已提交/.test(h.get('sync-status').textContent),
      'Probe must publish and receive acknowledgement for the negotiated summary in either arrival order.');
    const state = contextStates(h).at(-1);
    assert.deepEqual(state, { kind: 'webcodex_host_capabilities', component_version: h.get('version').textContent,
      device_id: probe.structuredContent.data.device_id.slice(0, 128), instance_id: probe.structuredContent.source.instance_id.slice(0, 128),
      host_capabilities: capabilitySummary(h),
      upload_performed: false, file_read_performed: false, model_access: 'unverified', context_scope: 'future_turns' });
    assert.ok(Buffer.byteLength(JSON.stringify(state)) < 1536);
    assert.match(h.get('sync-status').textContent, /已提交/);
    assert.match(h.get('sync-status').textContent, /能力/);
    assert.equal(messages(h).length, 0); assert.equal(h.sent.some(item => item.method === 'tools/call'), false);
    assert.doesNotMatch(JSON.stringify([h.sent, h.states]), /PRIVATE_PROBE_INPUT_|private\.invalid|probe-secret|signedUrl/);
    const syncCount = contextStates(h).length + h.states.length;
    await h.globals(); await h.globals(); await h.result(structuredClone(probe)); await flush();
    assert.equal(contextStates(h).length + h.states.length, syncCount, 'Repeated globals and tool echoes must not duplicate the same diagnostic submission.');
  }
});

test('capability probes preserve an existing selection or upload receipt through tool results and the probe button', async () => {
  for (const uploaded of [false, true]) for (const viaButton of [false, true]) {
    let uploads = 0;
    const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://keep-this-receipt' }; } }, { rpc: request => {
      if (request.method === 'tools/call') {
        assert.equal(request.params.name, 'file_widget_probe'); assert.deepEqual(JSON.parse(JSON.stringify(request.params.arguments)), {});
        return capabilityProbe();
      }
      return {};
    } });
    await h.initialize({ serverTools: {}, message: { text: {} }, updateModelContext: { structuredContent: {} } });
    await h.select(new File(['KEEP_SELECTED_ORIGINAL_BYTES_73549'], 'keep-original.pdf', { type: 'application/pdf' }));
    if (uploaded) {
      await h.get('upload').trigger('click');
      await waitFor(() => contextStates(h).at(-1)?.file_name === 'keep-original.pdf', 'Upload receipt should synchronize before the capability probe.');
    }
    const before = { name: h.get('filename').textContent, status: h.get('status').textContent, receipt: h.get('receipt').textContent,
      uploadDisabled: h.get('upload').disabled, contexts: contextStates(h).length, states: h.states.length };
    if (viaButton) await h.get('probe').trigger('click'); else await h.result(capabilityProbe());
    await h.globals(); await flush();
    assert.equal(h.get('filename').textContent, before.name); assert.equal(h.get('status').textContent, before.status);
    assert.equal(h.get('receipt').textContent, before.receipt); assert.equal(h.get('upload').disabled, before.uploadDisabled);
    assert.equal(contextStates(h).length, before.contexts); assert.equal(h.states.length, before.states);
    assert.equal(uploads, uploaded ? 1 : 0); assert.equal(messages(h).length, 0);
    if (uploaded) assert.equal(contextStates(h).at(-1).kind, 'webcodex_file_upload');
  }
});

test('a delayed capability context cannot overwrite a later original upload or its synchronization status', async () => {
  let finish!: () => void, probePending = false, uploads = 0;
  const completed: any[] = [];
  const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://after-probe' }; } }, { rpc: async request => {
    if (request.method === 'ui/update-model-context') {
      const state = request.params.structuredContent;
      if (state.kind === 'webcodex_host_capabilities') {
        probePending = true; await new Promise<void>(resolve => { finish = resolve; });
      }
      completed.push(structuredClone(state));
    }
    return {};
  } });
  await h.initialize({ message: { text: {} }, updateModelContext: { structuredContent: {} } });
  await h.result(capabilityProbe());
  await waitFor(() => probePending, 'Probe context request should be awaiting its response.');
  await h.result(original(Buffer.from('AFTER_PROBE_ORIGINAL_92863'), 'after-probe.pdf', { mode: 'manual', compact: false, close_after_send: false }));
  await waitFor(() => h.get('status').dataset.state === 'ready', 'Later original must replace the diagnostic generation while its response is pending.');
  await h.get('upload').trigger('click'); assert.equal(uploads, 1);
  finish();
  await waitFor(() => completed.at(-1)?.kind === 'webcodex_file_upload', 'Latest completed model context must be the uploaded file.');
  await flush(); await h.globals(); await flush();
  assert.equal(completed.at(-1).file_name, 'after-probe.pdf');
  const uploadIndex = completed.findIndex(state => state.kind === 'webcodex_file_upload');
  assert.equal(completed.slice(uploadIndex).some(state => state.kind === 'webcodex_host_capabilities'), false);
  assert.match(h.get('sync-status').textContent, /已提交上传状态/);
  assert.match(h.get('receipt').textContent, /sediment:\/\/after-probe/);
  assert.equal(uploads, 1); assert.equal(messages(h).length, 0);
});

test('a late widget-state API synchronizes an already requested capability probe once without invoking unrelated helpers', async () => {
  const h = harness({ setWidgetState: undefined });
  await h.initialize({ message: { text: {} }, updateModelContext: {} }); await h.result(capabilityProbe());
  await waitFor(() => /未确认/.test(h.get('sync-status').textContent), 'A missing synchronization route must be reported instead of claiming submission.');
  assert.equal(contextStates(h).length, 0); assert.equal(h.states.length, 0);
  const states: any[] = [];
  h.host.setWidgetState = async (state: unknown) => { states.push(structuredClone(state)); h.host.widgetState = state; };
  h.host.getFileDownloadUrl = () => { assert.fail('Late detection must not fetch a file URL'); };
  await h.globals();
  await waitFor(() => states.at(-1)?.modelContent?.kind === 'webcodex_host_capabilities' && /已提交/.test(h.get('sync-status').textContent),
    'Late context API should synchronize the outstanding diagnostic request.');
  assert.equal(states.at(-1).modelContent.host_capabilities.compatibility.getFileDownloadUrl, true);
  assert.equal(states.at(-1).modelContent.upload_performed, false); assert.equal(states.at(-1).modelContent.file_read_performed, false);
  assert.match(h.get('sync-status').textContent, /已提交/);
  await h.globals(); await h.globals(); await flush();
  assert.equal(states.length, 1); assert.equal(contextStates(h).length, 0); assert.equal(messages(h).length, 0);
});

test('failed or unsupported capability synchronization never claims an upload receipt or retries on unchanged globals', async () => {
  for (const failure of ['rpc-rejection', 'rpc-error-result', 'rpc-empty-result', 'rpc-array-result', 'fallback-rejection', 'unsupported']) {
    let attempts = 0;
    const host: Record<string, any> = { setWidgetState: undefined };
    if (failure === 'fallback-rejection') host.setWidgetState = async () => { attempts++; throw new Error('Synthetic capability persistence denied'); };
    const h = harness(host, { rpc: request => {
      assert.equal(request.method, 'ui/update-model-context'); attempts++;
      if (failure === 'rpc-rejection') throw new Error('Synthetic capability update denied');
      return failure === 'rpc-error-result' ? { isError: true } : failure === 'rpc-array-result' ? [] : null;
    } });
    await h.initialize({ message: { text: {} }, ...(failure.startsWith('rpc-') ? { updateModelContext: { structuredContent: {} } } : {}) });
    await h.result(capabilityProbe());
    await waitFor(() => /未确认/.test(h.get('sync-status').textContent), failure + ' must remain visibly unconfirmed.');
    assert.doesNotMatch(h.get('sync-status').textContent, /已提交|上传回执仍然有效|等待上传结果/);
    const before = attempts;
    await h.globals(); await h.globals(); await h.result(capabilityProbe()); await flush();
    assert.equal(attempts, before, 'An unchanged failed route must not retry due to theme or result echoes.');
    assert.equal(attempts, failure === 'unsupported' ? 0 : 1); assert.equal(messages(h).length, 0);
    assert.equal(h.get('receipt').textContent, ''); assert.equal(h.get('upload').disabled, true);
  }
});

test('a failed bridge retains an unknown capability summary in a requested fallback diagnostic', async () => {
  const h = harness();
  await h.result(capabilityProbe()); await h.initialize({ message: { resourceLink: {} } }, 'unsupported-protocol');
  await waitFor(() => h.states.at(-1)?.modelContent?.kind === 'webcodex_host_capabilities', 'Fallback may report capability uncertainty when initialization fails.');
  const state = h.states.at(-1).modelContent;
  assert.equal(state.host_capabilities.initialization, 'not_ready');
  assert.deepEqual(state.host_capabilities.message, { declaration: 'absent', modalities: [] });
  assert.equal(state.upload_performed, false); assert.equal(state.file_read_performed, false);
  assert.equal(state.model_access, 'unverified'); assert.equal(messages(h).length, 0);
  assert.equal(contextStates(h).length, 0); assert.match(h.get('bridge').textContent, /没有协商支持/);
});

test('manual compatibility reference probing requires an uploaded file and an initialized message declaration without known modalities', async () => {
  const cases: Array<{ declaration: unknown; enabled: boolean }> = [
    { declaration: {}, enabled: true }, { declaration: { unknownExtension: {} }, enabled: true },
    { declaration: { resourceLink: true }, enabled: true }, { declaration: undefined, enabled: false },
    { declaration: null, enabled: false }, { declaration: true, enabled: false }, { declaration: [], enabled: false },
    { declaration: 'yes', enabled: false }, { declaration: { text: {} }, enabled: false },
    { declaration: { resource: {} }, enabled: false }, { declaration: { resourceLink: {} }, enabled: false },
  ];
  for (const { declaration, enabled } of cases) {
    let uploads = 0;
    const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://compatibility-gate' }; } });
    assert.equal(h.get('compat-send').disabled, true);
    await h.select(new File(['COMPATIBILITY_GATE_ORIGINAL_48927'], 'compatibility-gate.pdf', { type: 'application/pdf' }));
    assert.equal(h.get('compat-send').disabled, true);
    await h.get('upload').trigger('click'); await flush();
    assert.equal(h.get('compat-send').disabled, true, 'An uploaded receipt before initialization must not enable an experimental reference send.');
    await h.get('compat-send').trigger('click'); assert.equal(messages(h).length, 0);
    await h.initialize({ message: declaration });
    assert.equal(h.get('compat-send').disabled, !enabled);
    if (!enabled) { await h.get('compat-send').trigger('click'); assert.equal(messages(h).length, 0); }
    assert.equal(uploads, 1); assert.equal(messages(h).length, 0);
  }
});

test('an empty-declaration compatibility send is manual, resource-link-only and one-shot after ACK, rejection or timeout', async () => {
  for (const outcome of ['accepted', 'rejected', 'error-result', 'empty-result', 'array-result', 'timeout']) {
    let finish!: () => void, uploads = 0, closes = 0;
    const bytes = Buffer.from('COMPATIBILITY_ONESHOT_PRIVATE_ORIGINAL_93175'), result = original(bytes, 'one-shot.pdf');
    const h = harness({ uploadFile: async () => { uploads++; return { fileId: 'sediment://one-shot' }; },
      requestClose: () => { closes++; },
      sendFollowUpMessage: () => { assert.fail('Compatibility probing must use the standard message interface'); },
      getFileDownloadUrl: () => { assert.fail('Compatibility probing must not obtain a signed URL'); } }, { rpc: async request => {
      if (request.method === 'ui/message') {
        await new Promise<void>(resolve => { finish = resolve; });
        if (outcome === 'rejected') throw new Error('Synthetic compatibility message denied');
        if (outcome === 'error-result') return { isError: true };
        if (outcome === 'empty-result') return null;
        if (outcome === 'array-result') return [];
      }
      return {};
    } });
    await h.initialize({ message: {}, updateModelContext: { structuredContent: {} } }); await h.result(result);
    await waitFor(() => contextStates(h).at(-1)?.reference_attempt === 'not_attempted' && !h.get('compat-send').disabled,
      'Automatic upload should stop before an undeclared message modality.');
    assert.equal(uploads, 1); assert.equal(messages(h).length, 0); assert.equal(closes, 0);
    const pending = h.get('compat-send').trigger('click');
    await waitFor(() => messages(h).length === 1, 'Only the explicit compatibility button may send this reference.');
    await h.get('compat-send').trigger('click'); await h.globals();
    assert.equal(messages(h).length, 1); assert.equal(h.get('compat-send').disabled, true);
    assert.deepEqual(JSON.parse(JSON.stringify(messages(h)[0].params.content)), [{ type: 'resource_link', uri: 'sediment://one-shot',
      name: 'one-shot.pdf', mimeType: 'application/pdf', size: bytes.length }]);
    assert.equal(contextStates(h).some(state => state.reference_attempt === 'compatibility_probe_started'), true);
    if (outcome === 'timeout') h.expireTimers(); else finish();
    await pending;
    const expected = outcome === 'accepted' ? 'compatibility_probe_accepted' : 'compatibility_probe_unconfirmed';
    await waitFor(() => contextStates(h).at(-1)?.reference_attempt === expected, outcome + ' should synchronize a truthful final attempt status.');
    const state = contextStates(h).at(-1);
    assert.equal(state.file_reference_sent, outcome === 'accepted'); assert.equal(state.model_access, 'unverified');
    assert.equal(state.upload_performed, true); assert.equal(state.file_id, 'sediment://one-shot');
    assert.match(state.handoff_instruction, outcome === 'accepted' ? /accepted.*unverified/ : /attempted but not confirmed/);
    const finalStatus = h.get('send-status').textContent;
    await h.get('compat-send').trigger('click'); await h.globals(); await h.globals(); await h.result(structuredClone(result)); await flush();
    assert.equal(uploads, 1); assert.equal(messages(h).length, 1); assert.equal(closes, 0);
    assert.equal(h.get('send-status').textContent, finalStatus, 'Capability refresh must not erase the outcome of the manual compatibility attempt.');
    assert.equal(h.get('compat-send').disabled, true); assert.match(h.get('receipt').textContent, /sediment:\/\/one-shot/);
    assert.equal(JSON.stringify([h.sent, h.states]).includes(bytes.toString()), false);
    assert.equal(JSON.stringify([h.sent, h.states]).includes(bytes.toString('base64')), false);
  }
});

test('a queued new original survives an in-flight compatibility send and receives a fresh unsent receipt', async () => {
  let finish!: () => void, closes = 0;
  const uploads: string[] = [];
  const first = original(Buffer.from('OLD_COMPATIBILITY_ORIGINAL_51738'), 'old-compatibility.pdf');
  const second = original(Buffer.from('NEW_COMPATIBILITY_ORIGINAL_67219'), 'new-compatibility.pdf');
  const h = harness({ uploadFile: async (file: File) => { uploads.push(file.name); return { fileId: 'sediment://' + file.name }; },
    requestClose: () => { closes++; } }, { rpc: async request => {
    if (request.method === 'ui/message') await new Promise<void>(resolve => { finish = resolve; });
    return {};
  } });
  await h.initialize({ message: {}, updateModelContext: { structuredContent: {} } }); await h.result(first);
  await waitFor(() => contextStates(h).at(-1)?.reference_attempt === 'not_attempted' && !h.get('compat-send').disabled,
    'First automatic upload should await a manual compatibility send.');
  const pending = h.get('compat-send').trigger('click');
  await waitFor(() => messages(h).length === 1, 'First reference request must be in flight.');
  await h.result(second); await h.result(structuredClone(first));
  assert.equal(h.get('filename').textContent, 'old-compatibility.pdf');
  finish(); await pending;
  await waitFor(() => contextStates(h).at(-1)?.file_name === 'new-compatibility.pdf', 'Queued new original must retain its own receipt after the old send completes.');
  await flush(); await h.globals(); await flush();
  const state = contextStates(h).at(-1);
  assert.equal(state.reference_attempt, 'not_attempted'); assert.equal(state.file_reference_sent, false);
  assert.equal(state.file_id, 'sediment://new-compatibility.pdf'); assert.equal(state.model_access, 'unverified');
  assert.deepEqual(uploads, ['old-compatibility.pdf', 'new-compatibility.pdf']);
  assert.equal(messages(h).length, 1); assert.equal(closes, 0); assert.equal(h.get('compat-send').disabled, false);
  assert.equal(h.get('filename').textContent, 'new-compatibility.pdf'); assert.match(h.get('receipt').textContent, /sediment:\/\/new-compatibility\.pdf/);
});
