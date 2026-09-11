import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { FILE_SAVE_WIDGET_MIME_TYPE, FILE_SAVE_WIDGET_URI, renderFileSaveWidget } from '../src/file-save-widget.js';
import { VERSION } from '../src/version.js';

type Handler = (event: any) => unknown;
class Element {
  textContent = '';
  dataset: Record<string, string> = {};
  set innerHTML(_value: string) { assert.fail('Dynamic HTML must not be used.'); }
}
const DEVICE = '706d92c4-47fa-4015-b785-de4d87a9ce55';
const TICKET = 'T'.repeat(43), FILE_ID = 'file-SYNTHETIC-PRIVATE-REFERENCE';
const URL = 'https://files.oaiusercontent.com/SYNTHETIC?sig=PRIVATE-URL-SECRET';
const SOURCE = { device_id: DEVICE, device_name: 'Synthetic device', instance_id: 'synthetic-instance' };
const PATH = '原文件 <script>alert(1)</script>.png';
const SIZE = 2341397;
const result = (data: Record<string, unknown>) => ({ structuredContent: { ok: true, source: SOURCE, data } });
const saved = (overrides: Record<string, unknown> = {}) => result({ status: 'saved', verified: true, path: PATH, size_bytes: SIZE,
  workspace_id: 'images', idempotency_key: 'save-original', content_sha256: 'a'.repeat(64), sha256: 'a'.repeat(64), ...overrides });
const opened = (metadata: Record<string, unknown> = {}) => ({
  ...result({ status: 'awaiting_host_file', path: PATH, size_bytes: SIZE, workspace_id: 'images', idempotency_key: 'save-original', content_sha256: 'a'.repeat(64) }),
  _meta: { webcodexFileSave: { ticket: TICKET, file_id: FILE_ID, workspace_id: 'images', expected_device_id: DEVICE,
    idempotency_key: 'save-original', expires_at: '2026-09-11T00:10:00Z', ...metadata } },
});
const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };

function harness(options: { host?: Record<string, any>; rpc?: (request: any) => unknown | Promise<unknown> } = {}) {
  const html = renderFileSaveWidget(), host = options.host ?? {};
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const listeners = new Map<string, Handler[]>(), sent: any[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let timerId = 0, now = Date.parse('2026-09-11T00:00:00Z'), deliver: (value: unknown) => Promise<void>;
  const parent = { postMessage(data: any, target: string) {
    assert.equal(target, '*'); sent.push(data);
    if (data.method === 'tools/call' && options.rpc) Promise.resolve().then(() => options.rpc!(data)).then(
      response => deliver({ jsonrpc: '2.0', id: data.id, result: response }),
      error => deliver({ jsonrpc: '2.0', id: data.id, error: { code: error.code, message: error.message } }),
    );
  } };
  const window = { parent, openai: host, addEventListener(name: string, handler: Handler) { listeners.set(name, [...listeners.get(name) ?? [], handler]); } };
  class Clock extends Date { static override now() { return now; } }
  const script = html.match(/<script>\n([\s\S]+?)\n<\/script>/)?.[1]; assert.ok(script);
  vm.runInNewContext(script, {
    window, document: { getElementById(id: string) { assert.ok(elements.has(id)); return elements.get(id); } }, Date: Clock,
    fetch: () => assert.fail('The component cannot fetch a file.'), atob: () => assert.fail('The component cannot relay Base64.'),
    setTimeout(callback: () => void, delay = 0) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  }, { timeout: 3000 });
  const emit = async (name: string, event: unknown) => { for (const handler of listeners.get(name) ?? []) await handler(event); };
  const receive = (value: unknown, source: unknown = parent) => emit('message', { source, data: value });
  deliver = receive;
  return {
    html, host, sent, timers, receive, get: (id: string) => elements.get(id)!,
    text: () => [...elements.values()].map(element => element.textContent).join('\n'),
    calls: () => sent.filter(message => message.method === 'tools/call').map(message => message.params),
    initialize: async (protocol = '2026-01-26') => {
      const request = sent.find(message => message.method === 'ui/initialize'); assert.ok(request);
      await receive({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: protocol, hostCapabilities: { serverTools: {} } } }); await flush();
    },
    result: async (value: unknown) => { await receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: value }); await flush(); },
    globals: async () => { await emit('openai:set_globals', {}); await flush(); },
    close: async () => { await emit('pagehide', {}); await flush(); },
    advance: async (ms: number) => {
      const end = now + ms; let count = 0;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        assert.ok(++count < 2000, 'Timer polling is bounded.'); now = due[1].at; timers.delete(due[0]); due[1].callback(); await flush();
      }
      now = end; await flush();
    },
  };
}

function privateNeverDisplayed(h: ReturnType<typeof harness>) {
  for (const secret of [TICKET, FILE_ID, URL, 'PRIVATE-URL-SECRET']) assert.ok(!h.text().includes(secret), secret);
  for (const message of h.sent.filter(message => message.method !== 'tools/call')) for (const secret of [TICKET, FILE_ID, URL]) assert.ok(!JSON.stringify(message).includes(secret));
}

test('file save component is static, compact and contains no selection, upload, network download or model relay', () => {
  const html = renderFileSaveWidget();
  assert.equal(FILE_SAVE_WIDGET_URI, `ui://webcodex/file-save-${encodeURIComponent(VERSION)}.html`);
  assert.equal(FILE_SAVE_WIDGET_MIME_TYPE, 'text/html;profile=mcp-app');
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<button|<input|<script[^>]+src=|<link[^>]+href=|fetch\(|XMLHttpRequest|uploadFile|selectFiles|sendFollowUpMessage|updateModelContext|setWidgetState|ui\/message|content_base64|atob\(|btoa\(|localStorage/);
  assert.match(html, /getFileDownloadUrl\(\{ fileId:/);
});

test('automatic save initializes first, resolves the real private file ID once, and accepts only a verified saved result', async () => {
  let resolutions = 0;
  const h = harness({ host: { getFileDownloadUrl: async (args: any) => {
    resolutions++; assert.deepEqual(JSON.parse(JSON.stringify(args)), { fileId: FILE_ID }); return { downloadUrl: URL };
  } }, rpc: request => { assert.equal(request.params.name, 'file_save_widget_complete'); return saved(); } });
  const init = h.sent[0]; assert.equal(init.method, 'ui/initialize'); assert.equal(init.params.appInfo.version, VERSION);
  await h.result(opened()); assert.equal(resolutions, 0);
  await h.receive({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26' } }, {});
  assert.equal(resolutions, 0);
  await h.initialize(); assert.equal(resolutions, 1);
  assert.equal(h.sent.filter(message => message.method === 'ui/notifications/initialized').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls())), [{ name: 'file_save_widget_complete', arguments: { ticket: TICKET, download_url: URL, expected_device_id: DEVICE } }]);
  assert.equal(h.get('status').dataset.state, 'saved'); assert.equal(h.get('path').textContent, PATH);
  assert.match(h.get('size').textContent, /2,341,397/); assert.equal(h.get('version').textContent, VERSION);
  await h.result(opened()); await h.globals(); assert.equal(resolutions, 1); assert.equal(h.calls().length, 1);
  privateNeverDisplayed(h);
});

test('late metadata from direct globals enriches an earlier public result and duplicate events cannot start another transfer', async () => {
  let resolutions = 0;
  const h = harness({ host: { getFileDownloadUrl: async () => { resolutions++; return { downloadUrl: URL }; } }, rpc: () => saved() });
  await h.initialize(); const full = opened(); await h.result({ structuredContent: full.structuredContent });
  assert.equal(resolutions, 0);
  h.host.toolResponseMetadata = full._meta; await h.globals();
  await h.result(full); await h.globals(); assert.equal(resolutions, 1); assert.equal(h.calls().length, 1);
  assert.equal(h.get('status').dataset.state, 'saved'); privateNeverDisplayed(h);
});

test('wrapped toolResponseMetadata works before initialization and does not expose private file values', async () => {
  let resolutions = 0;
  const h = harness({ host: { toolResponseMetadata: { mcp_tool_result: { call_tool_result: opened() } },
    getFileDownloadUrl: async () => { resolutions++; return { downloadUrl: URL }; } }, rpc: () => ({ call_tool_result: saved() }) });
  assert.equal(resolutions, 0); await h.initialize(); assert.equal(resolutions, 1);
  assert.equal(h.get('status').dataset.state, 'saved'); privateNeverDisplayed(h);
});

test('current globals are checked before a stale wrapped metadata result can bind or submit its ticket', async () => {
  const current = opened(), stale = opened({ ticket: 'S'.repeat(43), file_id: 'file-STALE-REFERENCE' });
  stale.structuredContent.data.path = 'stale.png';
  const h = harness({ host: { toolOutput: current.structuredContent, toolResponseMetadata: { mcp_tool_result: stale },
    getFileDownloadUrl: () => assert.fail('A mismatched old reference must never resolve.') } });
  await h.initialize(); await h.advance(20000);
  assert.equal(h.get('status').dataset.state, 'failed'); assert.equal(h.get('path').textContent, PATH);
  assert.equal(h.calls().length, 0, 'Do not even fail an old ticket belonging to another operation.');
  assert.match(h.text(), /HOST_FILE_REFERENCE_UNAVAILABLE/); privateNeverDisplayed(h);
});

test('late stale metadata is rejected against the current standard public result without touching either ticket', async () => {
  const h = harness({ host: { getFileDownloadUrl: () => assert.fail('An unrelated reference must never resolve.') } });
  await h.initialize(); const current = opened(), stale = opened({ ticket: 'S'.repeat(43) });
  stale.structuredContent.data.idempotency_key = 'old-operation';
  await h.result({ structuredContent: current.structuredContent });
  h.host.toolResponseMetadata = stale; await h.globals();
  assert.equal(h.get('status').dataset.state, 'failed'); assert.equal(h.calls().length, 0); privateNeverDisplayed(h);
});

test('an output arriving before initialization is cross-checked against previously received metadata', async () => {
  const stale = opened({ ticket: 'S'.repeat(43), file_id: 'file-STALE-REFERENCE' });
  stale.structuredContent.data.path = 'stale.png';
  const h = harness({ host: { toolResponseMetadata: stale,
    getFileDownloadUrl: () => assert.fail('Initialization must validate the now-available current output.') } });
  h.host.toolOutput = opened().structuredContent;
  await h.initialize(); assert.equal(h.get('status').dataset.state, 'failed'); assert.equal(h.calls().length, 0); privateNeverDisplayed(h);
});

test('a standard tool result supplies the authoritative reference instead of stale globals', async () => {
  let resolutions = 0;
  const h = harness({ host: { getFileDownloadUrl: async () => { resolutions++; return { downloadUrl: URL }; } }, rpc: () => saved() });
  await h.initialize(); const stale = opened({ ticket: 'S'.repeat(43), file_id: 'file-STALE-REFERENCE' });
  stale.structuredContent.data.path = 'stale.png';
  h.host.toolOutput = stale.structuredContent; h.host.toolResponseMetadata = stale;
  await h.result(opened());
  assert.equal(resolutions, 1); assert.equal(h.calls()[0].arguments.ticket, TICKET);
  assert.equal(h.get('status').dataset.state, 'saved'); privateNeverDisplayed(h);
});

test('late host file API injection is bounded and can begin automatically without a user action', async () => {
  let resolutions = 0;
  const h = harness({ rpc: () => saved() }); await h.initialize(); await h.result(opened());
  await h.advance(1000); assert.equal(h.calls().length, 0);
  h.host.getFileDownloadUrl = async () => { resolutions++; return { downloadUrl: URL }; };
  await h.globals(); assert.equal(resolutions, 1); assert.equal(h.get('status').dataset.state, 'saved');
});

test('an unavailable host API reports a fixed private failure and never attempts a file download or complete call', async () => {
  const h = harness({ rpc: request => result({ status: 'failed', error_code: request.params.arguments.error_code }) });
  await h.initialize(); await h.result(opened()); await h.advance(5000);
  assert.deepEqual(h.calls().map(call => call.name), ['file_save_widget_fail']);
  assert.equal(h.calls()[0].arguments.error_code, 'HOST_FILE_API_UNAVAILABLE');
  assert.equal(h.get('status').dataset.state, 'failed'); assert.match(h.text(), /HOST_FILE_API_UNAVAILABLE/); privateNeverDisplayed(h);
});

test('missing initialization never resolves a file and reports its bounded failure through the private tool', async () => {
  let resolutions = 0;
  const h = harness({ host: { getFileDownloadUrl: async () => { resolutions++; return { downloadUrl: URL }; } },
    rpc: () => result({ status: 'failed', error_code: 'HOST_FILE_API_UNAVAILABLE' }) });
  await h.result(opened()); await h.advance(10000);
  assert.equal(resolutions, 0); assert.equal(h.calls().length, 1); assert.equal(h.calls()[0].name, 'file_save_widget_fail');
  assert.equal(h.calls()[0].arguments.error_code, 'HOST_FILE_API_UNAVAILABLE');
});

test('missing or sandbox file IDs are not fabricated or passed to the host resolver', async () => {
  for (const file_id of [undefined, '', 'sandbox:/mnt/data/original.png']) {
    const h = harness({ host: { getFileDownloadUrl: () => assert.fail('No real file ID is available.') }, rpc: () => result({ status: 'failed' }) });
    await h.initialize(); await h.result(opened({ file_id }));
    assert.deepEqual(h.calls().map(call => call.name), ['file_save_widget_fail']);
    assert.equal(h.calls()[0].arguments.error_code, 'HOST_FILE_REFERENCE_UNAVAILABLE'); privateNeverDisplayed(h);
  }
});

test('host API rejection and unsupported response shapes expose only the fixed resolution error', async () => {
  for (const reply of [() => Promise.reject(new Error(URL)), () => Promise.resolve(URL), () => Promise.resolve({ url: URL }), () => Promise.resolve({ downloadUrl: 123 })]) {
    const h = harness({ host: { getFileDownloadUrl: reply }, rpc: () => result({ status: 'failed' }) });
    await h.initialize(); await h.result(opened());
    assert.equal(h.calls().length, 1); assert.equal(h.calls()[0].name, 'file_save_widget_fail');
    assert.equal(h.calls()[0].arguments.error_code, 'HOST_FILE_RESOLUTION_FAILED'); privateNeverDisplayed(h);
  }
});

test('only a definite tools/call method-not-found result permits one compatibility submission', async () => {
  const fallback: any[] = [];
  const h = harness({ host: { getFileDownloadUrl: async () => ({ downloadUrl: URL }),
    callTool: async (name: string, args: unknown) => { fallback.push({ name, args }); return { mcp_tool_result: saved() }; } },
    rpc: () => { throw Object.assign(new Error('synthetic unsupported method'), { code: -32601 }); } });
  await h.initialize(); await h.result(opened()); await h.result(opened());
  assert.equal(fallback.length, 1); assert.equal(fallback[0].name, 'file_save_widget_complete');
  assert.equal(fallback[0].args.download_url, URL); assert.equal(h.calls().length, 1);
  assert.equal(h.get('status').dataset.state, 'saved'); privateNeverDisplayed(h);
});

test('a timed-out complete call is reported unknown without another submission or late-result overwrite', async () => {
  let release!: (value: unknown) => void, resolutions = 0;
  const completed = new Promise(resolve => { release = resolve; });
  const h = harness({ host: { getFileDownloadUrl: async () => { resolutions++; return { downloadUrl: URL }; },
    callTool: () => assert.fail('A timeout must not switch transports.') }, rpc: request => request.params.name === 'file_save_widget_complete'
    ? completed : result({ status: 'unknown', error_code: 'FILE_SAVE_TRANSFER_UNCERTAIN' }) });
  await h.initialize(); await h.result(opened()); assert.equal(h.get('status').dataset.state, 'saving');
  await h.advance(75000); assert.equal(h.get('status').dataset.state, 'uncertain');
  assert.deepEqual(h.calls().map(call => call.name), ['file_save_widget_complete', 'file_save_widget_fail']);
  assert.equal(h.calls()[1].arguments.error_code, 'FILE_SAVE_TRANSFER_UNCERTAIN');
  release(saved()); await flush(); await h.result(opened()); await h.globals();
  assert.equal(h.get('status').dataset.state, 'uncertain'); assert.equal(resolutions, 1); assert.equal(h.calls().length, 2); privateNeverDisplayed(h);
});

test('a compatibility complete timeout does not replay a file or accept a late success', async () => {
  const fallback: string[] = [];
  let release!: (value: unknown) => void;
  const h = harness({ host: { getFileDownloadUrl: async () => ({ downloadUrl: URL }),
    callTool: (name: string) => {
      fallback.push(name);
      return name === 'file_save_widget_complete' ? new Promise(resolve => { release = resolve; }) : result({ status: 'unknown' });
    } }, rpc: () => { throw Object.assign(new Error('synthetic unsupported method'), { code: -32601 }); } });
  await h.initialize(); await h.result(opened()); await h.advance(75000);
  assert.deepEqual(fallback, ['file_save_widget_complete', 'file_save_widget_fail']);
  assert.equal(h.get('status').dataset.state, 'uncertain');
  release(saved()); await flush(); await h.result(opened()); await h.globals();
  assert.equal(h.get('status').dataset.state, 'uncertain');
  assert.deepEqual(fallback, ['file_save_widget_complete', 'file_save_widget_fail']); privateNeverDisplayed(h);
});

test('an authoritative saved response to a failure report wins over an earlier unknown component result', async () => {
  const h = harness({ host: { getFileDownloadUrl: async () => ({ downloadUrl: URL }) }, rpc: request => request.params.name === 'file_save_widget_complete'
    ? new Promise(() => {}) : saved() });
  await h.initialize(); await h.result(opened()); await h.advance(75000);
  assert.equal(h.get('status').dataset.state, 'saved'); assert.equal(h.calls().filter(call => call.name === 'file_save_widget_complete').length, 1);
});

test('pending or failed complete results never masquerade as a verified save', async () => {
  for (const [reply, state] of [[result({ status: 'pending' }), 'pending'], [result({ status: 'unknown' }), 'uncertain'],
    [result({ status: 'failed', error_code: 'FILE_IMPORT_SOURCE_DENIED' }), 'failed']] as const) {
    const h = harness({ host: { getFileDownloadUrl: async () => ({ downloadUrl: URL }) }, rpc: () => reply });
    await h.initialize(); await h.result(opened()); assert.equal(h.get('status').dataset.state, state);
    assert.equal(h.calls().length, 1); assert.ok(!h.get('status').textContent.includes('已保存')); privateNeverDisplayed(h);
  }
});

test('saved receipts require verified bytes, matching destination, size and device', async () => {
  for (const reply of [saved({ verified: false }), saved({ path: 'another.png' }), saved({ size_bytes: SIZE - 1 }),
    { structuredContent: { ...saved().structuredContent, source: { ...SOURCE, device_id: 'wrong-device' } } }]) {
    const h = harness({ host: { getFileDownloadUrl: async () => ({ downloadUrl: URL }) }, rpc: request => request.params.name === 'file_save_widget_complete'
      ? reply : result({ status: 'unknown' }) });
    await h.initialize(); await h.result(opened()); assert.equal(h.get('status').dataset.state, 'uncertain');
    assert.equal(h.calls().filter(call => call.name === 'file_save_widget_complete').length, 1);
    assert.equal(h.calls()[1].arguments.error_code, 'FILE_SAVE_TRANSFER_UNCERTAIN');
  }
});

test('a saved receipt accepts equivalent safe workspace-relative Windows separators', async () => {
  const expected = opened(); expected.structuredContent.data.path = '.\\images\\original.png';
  const h = harness({ host: { getFileDownloadUrl: async () => ({ downloadUrl: URL }) }, rpc: () => saved({ path: 'images/original.png' }) });
  await h.initialize(); await h.result(expected);
  assert.equal(h.get('status').dataset.state, 'saved'); assert.equal(h.calls().length, 1);
  assert.equal(h.get('path').textContent, 'images/original.png'); privateNeverDisplayed(h);
});

test('a saved receipt binds source hash, workspace and operation key and never collapses parent traversal', async () => {
  for (const override of [{ sha256: 'b'.repeat(64) }, { workspace_id: 'other' }, { workspace_id: undefined },
    { idempotency_key: 'other-save' }, { idempotency_key: undefined }, { path: '../' + PATH }]) {
    const h = harness({ host: { getFileDownloadUrl: async () => ({ downloadUrl: URL }) }, rpc: request => request.params.name === 'file_save_widget_complete'
      ? saved(override) : result({ status: 'unknown' }) });
    await h.initialize(); await h.result(opened());
    assert.equal(h.get('status').dataset.state, 'uncertain');
    assert.deepEqual(h.calls().map(call => call.name), ['file_save_widget_complete', 'file_save_widget_fail']); privateNeverDisplayed(h);
  }
});

test('an original-file mismatch keeps the backend error code without claiming an uncertain or successful save', async () => {
  const h = harness({ host: { getFileDownloadUrl: async () => ({ downloadUrl: URL }) },
    rpc: () => result({ status: 'failed', error_code: 'FILE_IMPORT_ORIGINAL_MISMATCH' }) });
  await h.initialize(); await h.result(opened());
  assert.equal(h.get('status').dataset.state, 'failed');
  assert.equal(h.get('diagnostics').textContent, '错误码：FILE_IMPORT_ORIGINAL_MISMATCH');
  assert.equal(h.calls().length, 1); assert.ok(!h.text().includes('FILE_SAVE_TRANSFER_UNCERTAIN')); privateNeverDisplayed(h);
});

test('already-saved open results need no private metadata or new host resolution', async () => {
  const h = harness({ host: { getFileDownloadUrl: () => assert.fail('An existing receipt needs no new download URL.') } });
  await h.result(saved()); await h.initialize(); assert.equal(h.get('status').dataset.state, 'saved');
  assert.equal(h.calls().length, 0); privateNeverDisplayed(h);
});

test('conflicting wrappers cannot combine a public target with another private ticket', async () => {
  const h = harness({ host: { getFileDownloadUrl: () => assert.fail('Conflicting metadata must not resolve.') } });
  await h.initialize(); const bad = opened(); bad.structuredContent.data.path = 'different.png';
  await h.result({ mcp_tool_result: opened(), call_tool_result: bad }); await h.advance(15000);
  assert.equal(h.calls().length, 0); assert.equal(h.get('status').dataset.state, 'failed');
  assert.match(h.text(), /HOST_FILE_REFERENCE_UNAVAILABLE/); privateNeverDisplayed(h);
});

test('contradictory status, verification or hash wrappers cannot be treated as an authoritative saved receipt', async () => {
  for (const bad of [saved({ status: 'pending' }), saved({ verified: false }), saved({ sha256: 'b'.repeat(64) }),
    { ...saved(), isError: true }]) {
    const h = harness({ host: { getFileDownloadUrl: async () => ({ downloadUrl: URL }) }, rpc: request => request.params.name === 'file_save_widget_complete'
      ? { mcp_tool_result: saved(), call_tool_result: bad } : result({ status: 'unknown' }) });
    await h.initialize(); await h.result(opened());
    assert.equal(h.get('status').dataset.state, 'uncertain');
    assert.deepEqual(h.calls().map(call => call.name), ['file_save_widget_complete', 'file_save_widget_fail']); privateNeverDisplayed(h);
  }
});

test('anonymous nested metadata without its matching public result is not borrowed', async () => {
  const h = harness({ host: { getFileDownloadUrl: () => assert.fail('Anonymous metadata is not a matched host reference.') } });
  await h.initialize(); const full = opened();
  await h.result({ structuredContent: full.structuredContent, result: { _meta: full._meta } });
  h.host.toolResponseMetadata = { result: { _meta: full._meta } }; await h.globals(); await h.advance(15000);
  assert.equal(h.calls().length, 0); assert.equal(h.get('status').dataset.state, 'failed');
  assert.match(h.text(), /HOST_FILE_REFERENCE_UNAVAILABLE/); privateNeverDisplayed(h);
});

test('closing the component while resolving does not later submit a file', async () => {
  let release!: (value: unknown) => void;
  const h = harness({ host: { getFileDownloadUrl: () => new Promise(resolve => { release = resolve; }) } });
  await h.initialize(); await h.result(opened()); await h.close(); release({ downloadUrl: URL }); await flush();
  assert.equal(h.calls().length, 0);
});
