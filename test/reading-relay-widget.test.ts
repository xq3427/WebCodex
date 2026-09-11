import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import { READING_RELAY_URI, renderReadingRelayWidget } from '../src/reading-relay-widget.js';
import { ReadingRelayStore } from '../src/reading-relay.js';
import { VERSION } from '../src/version.js';

type Handler = (event: any) => unknown;
class Element {
  textContent = '';
  dataset: Record<string, string> = {};
  set innerHTML(_value: string) { throw new Error('Dynamic HTML is forbidden'); }
}
const RELAY_ID = 'b2bba294-2f55-4394-aed0-81e051f34c39';
const REQUEST_ID = 'e6f11831-b988-45d5-be06-970f9c699c82';
const START = Date.parse('2026-09-11T00:00:00Z');
const envelope = (data: unknown) => ({ structuredContent: { ok: true, source: { device_id: 'synthetic-device' }, data } });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function view(overrides: Record<string, unknown> = {}) {
  const privateData = { relay_id: RELAY_ID, ticket: 'A'.repeat(43), challenge: 'B'.repeat(43),
    expires_at: new Date(START + 120_000).toISOString(), ...overrides };
  return { ...envelope({ prototype: true, relay_id: privateData.relay_id, expires_at: privateData.expires_at }),
    _meta: { webcodexReadingRelay: privateData } };
}

function harness(options: {
  host?: Record<string, any>;
  rpc?: (request: any) => unknown | Promise<unknown>;
  crypto?: unknown;
  serializeRpc?: boolean;
} = {}) {
  const html = renderReadingRelayWidget();
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const listeners = new Map<string, Handler[]>();
  const sent: any[] = [];
  const host = options.host ?? {};
  const timers = new Map<number, { at: number; callback: () => void }>();
  const digests: Promise<ArrayBuffer>[] = [];
  const crypto = options.crypto ?? { subtle: { digest(algorithm: string, bytes: Uint8Array<ArrayBuffer>) {
    const promise = webcrypto.subtle.digest(algorithm, bytes);
    digests.push(promise);
    return promise;
  } } };
  const settle = async () => { await Promise.all(digests); await flush(); };
  let timerId = 0, now = START;
  let deliver: (data: unknown) => Promise<void>;
  let rpcQueue: Promise<unknown> = Promise.resolve();
  const callServer = (request: unknown) => {
    const invoke = () => options.rpc?.(request);
    if (!options.serializeRpc) return Promise.resolve().then(invoke);
    const result = rpcQueue.then(invoke);
    rpcQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const parent = { postMessage(data: any, target: string) {
    assert.equal(target, '*');
    sent.push(data);
    if (options.rpc && data.method === 'tools/call') {
      callServer(data).then(
        result => deliver({ jsonrpc: '2.0', id: data.id, result }),
        error => deliver({ jsonrpc: '2.0', id: data.id, error: { code: error.code, message: error.message } }),
      );
    }
  } };
  const window = { parent, openai: host, addEventListener(name: string, handler: Handler) {
    listeners.set(name, [...listeners.get(name) ?? [], handler]);
  } };
  const script = html.match(/<script>\n([\s\S]+?)\n<\/script>/)?.[1];
  assert.ok(script);
  class Clock extends Date { static override now() { return now; } }
  vm.runInNewContext(script, {
    window, document: { getElementById: (id: string) => { assert.ok(elements.has(id)); return elements.get(id); } },
    Date: Clock, crypto, TextEncoder, Uint8Array,
    setTimeout(callback: () => void, delay = 0) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  }, { timeout: 3000 });
  const emit = async (name: string, event: unknown) => { for (const handler of listeners.get(name) ?? []) await handler(event); };
  const receive = (data: unknown, source: unknown = parent) => emit('message', { data, source });
  deliver = receive;
  return {
    html, sent, host, timers, receive,
    serverCall: (name: string, args: Record<string, unknown>) => callServer({ params: { name, arguments: args } }),
    get: (id: string) => elements.get(id)!,
    text: () => [...elements.values()].map(element => element.textContent).join('\n'),
    globals: async () => { await emit('openai:set_globals', {}); await settle(); },
    pagehide: async () => { await emit('pagehide', {}); await flush(); },
    result: async (value: unknown) => { await receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: value }); await settle(); },
    initialize: async (hostCapabilities: unknown = { serverTools: {} }, version = '2026-01-26') => {
      const init = sent.find(item => item.method === 'ui/initialize');
      assert.ok(init);
      await receive({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: version, hostCapabilities } });
      await settle();
    },
    advance: async (ms: number) => {
      const end = now + ms;
      let count = 0;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        assert.ok(++count < 1000, 'timer loop is bounded');
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

test('relay widget is self-contained, automatic, and does not use attachment or model-context APIs', () => {
  const html = renderReadingRelayWidget();
  assert.equal(READING_RELAY_URI, `ui://webcodex/reading-relay-${VERSION}.html`);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<button|<input|<script[^>]+src=|<link[^>]+href=|fetch\(|XMLHttpRequest|localStorage/);
  assert.doesNotMatch(html, /uploadFile|selectFiles|sendFollowUpMessage|updateModelContext|setWidgetState|ui\/message|imageIds/);
  assert.doesNotMatch(html, /等待模型调用|等待读取工具/);
});

test('standard bridge checks parent source, initializes once, and returns actual browser-generated text only through submit', async () => {
  const calls: any[] = [];
  const h = harness({ rpc: request => {
    calls.push(request.params);
    return envelope(request.params.name === 'reading_probe_poll' ? { status: 'pending', request_id: REQUEST_ID }
      : { accepted: true, duplicate: false });
  } });
  const init = h.sent[0];
  assert.equal(init.method, 'ui/initialize');
  assert.equal(init.params.appInfo.version, VERSION);
  await h.receive({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26', hostCapabilities: { serverTools: {} } } }, {});
  await h.result(view());
  assert.equal(calls.length, 0);
  await h.initialize();
  assert.equal(h.sent.filter(item => item.method === 'ui/notifications/initialized').length, 1);
  assert.deepEqual(calls.map(item => item.name), ['reading_probe_poll', 'reading_probe_submit']);
  const args = calls[1].arguments;
  const expected = 'WebCodex browser relay: ' + createHash('sha256').update('webcodex-reading-relay-v1:' + 'B'.repeat(43)).digest('hex');
  assert.equal(args.text, expected);
  assert.equal(args.relay_id, RELAY_ID);
  assert.equal(args.request_id, REQUEST_ID);
  assert.equal(args.ticket, 'A'.repeat(43));
  assert.equal(h.get('status').dataset.state, 'returned');
  assert.match(h.text(), /实际回答确认/);
  for (const secret of [expected, 'B'.repeat(43), 'A'.repeat(43), RELAY_ID]) assert.ok(!h.text().includes(secret));
  assert.equal(h.timers.size, 0);
});

test('duplicate tool results and compatibility globals do not start duplicate polls or race a pending submit', async () => {
  const calls: string[] = [];
  let acknowledge: ((result: unknown) => void) | undefined;
  const original = view();
  const h = harness({ host: { toolOutput: original.structuredContent, toolResponseMetadata: original._meta }, rpc: request => {
    calls.push(request.params.name);
    if (request.params.name === 'reading_probe_poll') return envelope({ status: 'pending', request_id: REQUEST_ID });
    return new Promise(resolve => { acknowledge = resolve; });
  } });
  await h.initialize();
  await h.result(original);
  await h.globals();
  await h.result(original);
  await h.advance(2500);
  assert.deepEqual(calls, ['reading_probe_poll', 'reading_probe_submit']);
  assert.equal(h.get('status').dataset.state, 'returning');
  assert.ok(acknowledge);
  acknowledge(envelope({ accepted: true, duplicate: false }));
  await flush();
  await h.advance(2500);
  assert.equal(calls.length, 2);
  assert.equal(h.get('status').dataset.state, 'returned');
});

test('idle polling is immediate, 500 ms apart, and stops when another component already completed', async () => {
  let polls = 0;
  const h = harness({ rpc: () => envelope({ status: ++polls < 3 ? 'idle' : 'complete' }) });
  await h.initialize();
  await h.result(view());
  assert.equal(polls, 1);
  await h.advance(499);
  assert.equal(polls, 1);
  await h.advance(1);
  assert.equal(polls, 2);
  await h.advance(500);
  assert.equal(polls, 3);
  assert.equal(h.get('status').dataset.state, 'returned');
  assert.equal(h.timers.size, 0);
});

test('OpenAI compatibility tool output and private metadata work when the standard host does not declare tools', async () => {
  const calls: string[] = [];
  const original = view();
  const h = harness({ host: {
    toolOutput: original.structuredContent, toolResponseMetadata: original._meta,
    callTool: async (name: string) => { calls.push(name); return envelope(name === 'reading_probe_poll'
      ? { status: 'pending', request_id: REQUEST_ID } : { accepted: true, duplicate: false }); },
  } });
  await h.initialize({});
  assert.deepEqual(calls, ['reading_probe_poll', 'reading_probe_submit']);
  assert.equal(h.get('status').dataset.state, 'returned');
  assert.equal(h.sent.filter(item => item.method === 'tools/call').length, 0);
});

test('compatibility-only hosts prepare eagerly before an unanswered standard initialization times out', async () => {
  const calls: string[] = [];
  const original = view();
  const h = harness({ host: {
    toolOutput: original.structuredContent, toolResponseMetadata: original._meta,
    callTool: async (name: string) => { calls.push(name); return envelope(name === 'reading_probe_poll'
      ? { status: 'pending', request_id: REQUEST_ID } : { accepted: true, duplicate: false }); },
  } });
  await h.result(original);
  assert.deepEqual(calls, ['reading_probe_poll', 'reading_probe_submit']);
  assert.equal(h.get('status').dataset.state, 'returned');
  assert.equal(h.timers.size, 0);
});

test('definite unsupported standard tool method permits compatibility fallback', async () => {
  let calls = 0;
  const h = harness({ host: { callTool: async () => { calls++; return envelope({ status: 'complete' }); } },
    rpc: () => { throw Object.assign(new Error('unsupported'), { code: -32601 }); } });
  await h.initialize();
  await h.result(view());
  assert.equal(calls, 1);
  assert.equal(h.get('status').dataset.state, 'returned');
});

test('standard call timeout is terminal and never replays through compatibility', async () => {
  let compatibilityCalls = 0;
  const h = harness({ host: { callTool: async () => { compatibilityCalls++; return envelope({ status: 'complete' }); } },
    rpc: () => new Promise(() => {}) });
  await h.initialize();
  await h.result(view());
  await h.advance(10000);
  assert.equal(h.get('status').dataset.state, 'failure');
  assert.match(h.get('diagnostics').textContent, /poll.*HOST_TIMEOUT/);
  assert.equal(compatibilityCalls, 0);
  assert.equal(h.timers.size, 0);
});

test('no standard tools or compatibility tools produces a clear terminal result', async () => {
  const h = harness();
  await h.initialize({});
  await h.result(view());
  assert.equal(h.get('status').dataset.state, 'failure');
  assert.equal(h.sent.filter(item => item.method === 'tools/call').length, 0);
});

test('malformed private data and cross-relay identities never poll or disclose host error strings', async () => {
  for (const invalid of [view({ ticket: '<script>secret</script>' }), view({ challenge: 'short' }), view({ relay_id: 'bad' }),
    { ...view(), structuredContent: { ok: true, data: { prototype: true, relay_id: 'other', expires_at: view()._meta.webcodexReadingRelay.expires_at } } }]) {
    let calls = 0;
    const h = harness({ rpc: () => { calls++; return envelope({ status: 'complete' }); } });
    await h.initialize();
    await h.result(invalid);
    assert.equal(calls, 0);
    assert.equal(h.get('status').dataset.state, 'failure');
    assert.doesNotMatch(h.text(), /<script>|secret/);
  }
});

test('expiry bounds all polling even if the server advertises a longer expiry', async () => {
  const h = harness({ rpc: () => envelope({ status: 'idle' }) });
  await h.initialize();
  await h.result(view({ expires_at: new Date(START + 600_000).toISOString() }));
  await h.advance(120_000);
  assert.equal(h.get('status').dataset.state, 'expired');
  assert.equal(h.timers.size, 0);
  assert.ok(h.sent.filter(item => item.method === 'tools/call').length <= 240);
});

test('expired metadata and unavailable WebCrypto fail before making any tool calls', async () => {
  for (const fixture of [{ options: {}, result: view({ expires_at: new Date(START - 1).toISOString() }), state: 'expired' },
    { options: { crypto: {} }, result: view(), state: 'failure' }]) {
    const h = harness(fixture.options);
    await h.initialize();
    await h.result(fixture.result);
    assert.equal(h.get('status').dataset.state, fixture.state);
    assert.equal(h.sent.filter(item => item.method === 'tools/call').length, 0);
  }
});

test('teardown acknowledges parent and cancels a pending request; late replies cannot submit', async () => {
  const h = harness();
  await h.initialize();
  await h.result(view());
  const poll = h.sent.find(item => item.method === 'tools/call');
  assert.ok(poll);
  await h.receive({ jsonrpc: '2.0', id: 91, method: 'ui/resource-teardown', params: {} }, {});
  assert.notEqual(h.get('status').dataset.state, 'closed');
  await h.receive({ jsonrpc: '2.0', id: 91, method: 'ui/resource-teardown', params: {} });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent.at(-1))), { jsonrpc: '2.0', id: 91, result: {} });
  await h.receive({ jsonrpc: '2.0', id: poll.id, result: envelope({ status: 'pending', request_id: REQUEST_ID }) });
  await h.result(view());
  assert.equal(h.get('status').dataset.state, 'closed');
  assert.equal(h.timers.size, 0);
  assert.equal(h.sent.filter(item => item.method === 'tools/call').length, 1);
});

test('pagehide cancels compatibility calls and consumes late settlements without updating the closed view', async () => {
  let resolveCall: ((value: unknown) => void) | undefined;
  const h = harness({ host: { callTool: () => new Promise(resolve => { resolveCall = resolve; }) } });
  await h.initialize({});
  await h.result(view());
  assert.ok(resolveCall);
  await h.pagehide();
  resolveCall(envelope({ status: 'pending', request_id: REQUEST_ID }));
  await flush();
  assert.equal(h.get('status').dataset.state, 'closed');
  assert.equal(h.timers.size, 0);
});

test('tool errors, invalid request ids and unconfirmed submission acknowledgments stop the relay', async () => {
  for (const responses of [
    [{ isError: true, structuredContent: { ok: false, error: { message: 'SECRET HOST CONTENT' } } }],
    [envelope({ status: 'pending', request_id: 'invalid' })],
    [envelope({ status: 'pending', request_id: REQUEST_ID }), envelope({ accepted: false, duplicate: false })],
  ]) {
    const h = harness({ rpc: () => responses.shift() });
    await h.initialize();
    await h.result(view());
    assert.equal(h.get('status').dataset.state, 'failure');
    assert.doesNotMatch(h.text(), /SECRET HOST CONTENT/);
    assert.equal(h.timers.size, 0);
  }
});

test('failure diagnostics preserve only known codes and fixed phases, never raw host error text or arbitrary codes', async () => {
  for (const fixture of [
    { phase: 'poll', code: 'RELAY_ACCESS_DENIED', shown: 'RELAY_ACCESS_DENIED', numeric: false },
    { phase: 'submit', code: 'RELAY_STALE_SUBMISSION', shown: 'RELAY_STALE_SUBMISSION', numeric: false },
    { phase: 'poll', code: -32601, shown: 'JSON_RPC_-32601', numeric: true },
    { phase: 'poll', code: 'RELAY_SECRET_TOKEN', shown: 'UNKNOWN_ERROR', numeric: false },
  ]) {
    const h = harness({ rpc: request => {
      if (fixture.phase === 'submit' && request.params.name === 'reading_probe_poll') {
        return envelope({ status: 'pending', request_id: REQUEST_ID });
      }
      if (fixture.numeric) throw Object.assign(new Error('SECRET HOST CONTENT'), { code: fixture.code });
      return { isError: true, structuredContent: { ok: false, error: { code: fixture.code, message: 'SECRET HOST CONTENT' } } };
    } });
    await h.initialize();
    await h.result(view());
    assert.equal(h.get('status').dataset.state, 'failure');
    assert.equal(h.get('diagnostics').textContent, '阶段：' + fixture.phase + ' · 错误码：' + fixture.shown);
    assert.doesNotMatch(h.text(), /SECRET HOST CONTENT|RELAY_SECRET_TOKEN/);
  }
  const digest = harness({ crypto: {} });
  await digest.initialize();
  await digest.result(view());
  assert.match(digest.get('diagnostics').textContent, /digest.*CRYPTO_UNAVAILABLE/);
  const initialization = harness();
  await initialization.result(view());
  await initialization.advance(10_000);
  assert.match(initialization.get('bridge').textContent, /HOST_TIMEOUT/);
});

test('browser script eagerly prepares text in the real store before any model read requests it', async () => {
  const binding = 'synthetic-widget-integration';
  const store = new ReadingRelayStore({ now: () => START });
  try {
    const created = store.create(binding);
    const h = harness({ rpc: request => {
      const { name, arguments: args } = request.params;
      const data = name === 'reading_probe_poll' ? store.poll(args.relay_id, args.ticket, binding)
        : store.submit(args.relay_id, args.ticket, args.request_id, args.text, binding);
      return envelope(data);
    } });
    await h.initialize();
    await h.result({ ...envelope({ prototype: true, relay_id: created.relay_id, expires_at: created.expires_at }),
      _meta: { webcodexReadingRelay: created } });
    const result = await store.read(created.relay_id, { binding });
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') throw new Error('The component did not eagerly prepare content');
    assert.equal(result.source, 'browser_component');
    assert.equal(result.text, 'WebCodex browser relay: ' + createHash('sha256')
      .update('webcodex-reading-relay-v1:' + created.challenge).digest('hex'));
    assert.equal(h.get('status').dataset.state, 'returned');
    const resultJson = JSON.stringify(result);
    for (const privateValue of [created.ticket, created.challenge]) assert.ok(!resultJson.includes(privateValue));
    assert.deepEqual(await store.read(created.relay_id, { binding }), result);
  } finally { store.dispose(); }
});

test('a serialized host can interleave immediate model status reads with automatic component preparation without deadlocking', async () => {
  const binding = 'synthetic-serialized-host';
  const store = new ReadingRelayStore({ now: () => START });
  let concurrent = 0, maxConcurrent = 0;
  const order: string[] = [];
  try {
    const created = store.create(binding);
    const h = harness({ serializeRpc: true, rpc: async request => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const { name, arguments: args } = request.params;
      order.push(name);
      try {
        // Both public and component calls use this one queue, as in the observed host.
        const data = name === 'reading_probe_read' ? await store.read(args.relay_id, { binding })
          : name === 'reading_probe_poll' ? store.poll(args.relay_id, args.ticket, binding)
          : store.submit(args.relay_id, args.ticket, args.request_id, args.text, binding);
        return envelope(data);
      } finally { concurrent--; }
    } });
    await h.initialize();
    const firstRead = h.serverCall('reading_probe_read', { relay_id: created.relay_id });
    const mounted = h.result({ ...envelope({ prototype: true, relay_id: created.relay_id, expires_at: created.expires_at }),
      _meta: { webcodexReadingRelay: created } });
    const first = await firstRead as ReturnType<typeof envelope>;
    assert.equal((first.structuredContent.data as { status: string }).status, 'pending');
    await mounted;
    const second = await h.serverCall('reading_probe_read', { relay_id: created.relay_id }) as ReturnType<typeof envelope>;
    const result = second.structuredContent.data as { status: string; text: string };
    assert.equal(result.status, 'ready');
    assert.match(result.text, /^WebCodex browser relay: [0-9a-f]{64}$/);
    assert.equal(maxConcurrent, 1);
    assert.deepEqual(order, ['reading_probe_read', 'reading_probe_poll', 'reading_probe_submit', 'reading_probe_read']);
    assert.equal(h.get('status').dataset.state, 'returned');
    assert.match(h.get('status').textContent, /已缓存/);
    assert.equal(h.timers.size, 0);
  } finally { store.dispose(); }
});
