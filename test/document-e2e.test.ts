import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Blob, File } from 'node:buffer';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/server.js';

type Json = Record<string, any>;
type HostMode = 'flat' | 'nested' | 'flat-null-omitted' | 'nested-null-omitted' | 'nested-outer-null-omitted';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const modelVisible = (result: Json) => JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
function data(result: Json) {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent?.error));
  assert.equal(result.structuredContent?.ok, true);
  return result.structuredContent.data;
}

/** A real four-page PDF with padding large enough to require several MCP chunks. */
function makePdf(texts: string[], chinese = false) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '',
    chinese ? '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  if (chinese) objects.push('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>');
  const kids: string[] = [];
  for (const text of texts) {
    const pageId = objects.length + 1;
    const encoded = chinese ? '<' + [...text].map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '>'
      : '(' + text.replace(/[\\()]/g, '\\$&') + ')';
    const stream = 'BT /F1 12 Tf 72 720 Td ' + encoded + ' Tj ET';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (pageId + 1) + ' 0 R >>',
      '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream');
    kids.push(pageId + ' 0 R');
  }
  objects[1] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + texts.length + ' >>';
  let pdf = '%PDF-1.4\n%' + 'synthetic padding '.repeat(36000) + '\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (index + 1) + ' 0 obj\n' + objects[index] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n'
    + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf);
}

class Element {
  textContent = '';
  dataset: Record<string, string> = {};
  set innerHTML(_value: string) { throw new Error('The document UI must not assign dynamic HTML.'); }
}

/** Only the host bridge is simulated: every tool request reaches the real SDK and App. */
function browser(html: string, call: (name: string, args: Json) => Promise<Json>, mode: HostMode) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const listeners = new Map<string, Array<(event: any) => unknown>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const bridgeErrors: unknown[] = [];
  let forbiddenCalls = 0;
  let omittedNulls = 0;
  const wrapped = mode.startsWith('nested');
  const omitNulls = mode === 'flat-null-omitted' || mode === 'nested-null-omitted';
  const jsonBoundary = (value: unknown, stripNulls: boolean) => JSON.parse(JSON.stringify(value, (_key, item) => {
    if (stripNulls && item === null) { omittedNulls++; return undefined; }
    return item;
  }));
  const emit = async (name: string, event: unknown) => {
    for (const handler of listeners.get(name) ?? []) await handler(event);
  };
  // Simulate an actual JSON boundary. The null-omitting modes model a bounded
  // transport variation; they are not a claim about the real ChatGPT host.
  const receive = (message: unknown) => emit('message', { source: parent, data: jsonBoundary(message, omitNulls) });
  const parent = { postMessage(message: Json, target: string) {
    assert.equal(target, '*');
    if (message.method === 'ui/initialize') {
      queueMicrotask(() => {
        void receive({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2026-01-26', hostCapabilities: { serverTools: {} } } }).catch(error => bridgeErrors.push(error));
      });
    } else if (message.method === 'tools/call') {
      assert.ok(['document_widget_poll', 'document_widget_chunk', 'document_widget_submit'].includes(message.params.name),
        'The current component must not require a font or CMap MCP round trip.');
      void call(message.params.name, message.params.arguments).then(
        result => receive({ jsonrpc: '2.0', id: message.id, result: wrapped ? {
          structuredContent: jsonBoundary(result.structuredContent, mode === 'nested-outer-null-omitted'), mcp_tool_result: result,
        } : result }),
        error => { bridgeErrors.push(error); return receive({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Synthetic bridge failure' } }); },
      ).catch(error => bridgeErrors.push(error));
    }
  } };
  const window = { parent, openai: {}, location: { href: 'https://synthetic.invalid/' }, addEventListener(name: string, handler: (event: any) => unknown) {
    listeners.set(name, [...listeners.get(name) ?? [], handler]);
  } };
  class DOMMatrix { a = 1; b = 0; c = 0; d = 1; e = 0; f = 0; }
  function forbidden() { forbiddenCalls++; throw new Error('The bundled text reader must not use network, workers or canvas.'); }
  const context = vm.createContext({
    window, document: { baseURI: 'https://synthetic.invalid/', getElementById: (id: string) => elements.get(id), createElement: forbidden },
    navigator: { userAgent: 'SyntheticBrowser', platform: 'Win32', language: 'en-US' },
    DOMMatrix, Blob, File, crypto: webcrypto, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Uint8ClampedArray,
    ArrayBuffer, DataView, TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers, DOMException,
    ReadableStream, WritableStream, TransformStream, AbortController, AbortSignal, EventTarget, structuredClone, queueMicrotask,
    performance, atob, btoa, Date, fetch: forbidden, XMLHttpRequest: forbidden, Worker: forbidden,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout(callback: () => void, ms = 0) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
      timers.add(timer); return timer;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) { clearTimeout(timer); timers.delete(timer); },
  }, { codeGeneration: { strings: false, wasm: false } });
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInContext(script, context, { timeout: 10000 });
  return {
    async open(result: Json) { await receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }); },
    state() { return elements.get('webcodex-document-status')?.dataset.state; },
    details() { return [...elements.values()].map(element => element.textContent).join('\n'); },
    assertHealthy() {
      assert.deepEqual(bridgeErrors, []); assert.equal(forbiddenCalls, 0);
      if (mode.includes('null-omitted')) assert.ok(omittedNulls >= 1, 'The original-file EOF response must cross the null-omitting boundary.');
    },
    async close() {
      await emit('pagehide', {});
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

const hostCases: Array<{ mode: HostMode; chinese: boolean }> =
  (['flat', 'nested', 'flat-null-omitted', 'nested-null-omitted', 'nested-outer-null-omitted'] as const).map(mode => ({ mode, chinese: false }));
hostCases.push({ mode: 'nested-null-omitted', chinese: true });
for (const { mode, chinese } of hostCases) {
test(`actual SDK and original chunks return ${chinese ? 'Chinese' : 'English'} PDF text through serialized ${mode} results without asset RPCs`, { timeout: 20000 }, async () => {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-document-e2e-'));
  const root = path.join(base, '合成文档 workspace');
  const filename = '完整四页原文件.pdf';
  const marker = (chinese ? '中文论文独立校验' : 'Unpredictable PDF title ') + randomBytes(12).toString('hex');
  const texts = [marker, (chinese ? '第二页正文' : 'Second page body ') + randomBytes(8).toString('hex'),
    (chinese ? '第三页正文' : 'Third page body ') + randomBytes(8).toString('hex'),
    (chinese ? '第四页后续校验' : 'Fourth page continuation ') + randomBytes(8).toString('hex')];
  const original = makePdf(texts, chinese), sha256 = createHash('sha256').update(original).digest('hex');
  let app: App | undefined, client: Client | undefined, server: ReturnType<typeof createMcpServer> | undefined;
  let widget: ReturnType<typeof browser> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  try {
    await mkdir(root);
    await writeFile(path.join(root, filename), original);
    const configPath = path.join(base, 'config.json');
    await writeFile(configPath, JSON.stringify(defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic full PDF pipeline' })));
    app = new App(await loadConfig(configPath)); server = createMcpServer(app);
    client = new Client({ name: 'actual-document-pipeline-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    const sdk = client;
    const records: Array<{ name: string; args: Json; result: Json }> = [];
    let inFlight = 0, maxInFlight = 0;
    const call = (name: string, args: Json): Promise<Json> => {
      const task = queue.then(async () => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const result = await sdk.callTool({ name, arguments: args }) as Json;
          records.push({ name, args, result });
          return result;
        } finally { inFlight--; }
      });
      queue = task.then(() => undefined, () => undefined);
      return task;
    };
    const tools = (await sdk.listTools()).tools;
    const opener: any = tools.find(tool => tool.name === 'document_open');
    const resource: any = await sdk.readResource({ uri: opener._meta.ui.resourceUri });
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    const openedResult = await call('document_open', { workspace_id: 'default', path: filename, expected_device_id: app.identity.deviceId });
    const opened = data(openedResult), privateData = openedResult._meta.webcodexDocument;
    assert.equal(opened.sha256, sha256); assert.equal(opened.size_bytes, original.length);
    for (const text of texts) assert.equal(modelVisible(openedResult).includes(text), false, 'The answer must not be supplied in opening metadata.');
    assert.equal(modelVisible(openedResult).includes(privateData.ticket), false);
    assert.equal(JSON.stringify(openedResult).includes('ticket_id'), false);
    const args = { document_id: opened.document_id, workspace_id: 'default', expected_device_id: app.identity.deviceId };
    const firstPageArgs = { ...args, start_page: 1, page_count: 1 };
    const pending = data(await call('document_read', firstPageArgs));
    assert.equal(pending.status, 'pending'); assert.equal('pages' in pending, false);
    widget = browser(resource.contents[0].text, call, mode);
    await widget.open(openedResult);
    const waitSubmissions = async (count: number) => {
      const deadline = Date.now() + 10000;
      while (records.filter(record => record.name === 'document_widget_submit' && record.result.structuredContent?.ok === true).length < count && Date.now() < deadline) {
        if (['failure', 'expired', 'closed'].includes(widget!.state() ?? '')) assert.fail(widget!.details());
        await delay(5);
      }
      assert.equal(records.filter(record => record.name === 'document_widget_submit' && record.result.structuredContent?.ok === true).length, count, widget!.details());
    };
    await waitSubmissions(1);
    const firstResult = await call('document_read', args), first = data(firstResult);
    assert.equal(first.status, 'ready'); assert.equal(first.total_pages, 4); assert.equal(first.next_start_page, 4);
    assert.deepEqual(first.pages.map((page: Json) => page.text), texts.slice(0, 3));
    assert.ok(first.pages.every((page: Json, index: number) => page.page_number === index + 1 && !page.truncated && page.text_layer === 'present'));
    assert.equal(first.source, 'browser_pdfjs_text_layer'); assert.equal(first.text_verification, 'component_reported');
    assert.equal(first.native_attachment, false); assert.equal(first.sha256, sha256);
    assert.ok(firstResult.content.some((item: Json) => item.type === 'text' && item.text.includes(marker)));
    const subset = data(await call('document_read', firstPageArgs));
    assert.equal(subset.status, 'ready');
    assert.deepEqual(subset.pages.map((page: Json) => page.text), [texts[0]]);
    assert.equal(records.filter(record => record.name === 'document_widget_submit').length, 1, 'A complete cached page must not wait for another component submission.');
    const fourthArgs = { ...args, start_page: 4, page_count: 1 };
    assert.equal(data(await call('document_read', fourthArgs)).status, 'pending');
    await waitSubmissions(2);
    const fourth = data(await call('document_read', fourthArgs));
    assert.equal(fourth.status, 'ready'); assert.equal(fourth.next_start_page, null);
    assert.deepEqual(fourth.pages.map((page: Json) => [page.page_number, page.text]), [[4, texts[3]]]);
    assert.deepEqual(data(await call('document_read', args)), first);
    const chunks = records.filter(record => record.name === 'document_widget_chunk');
    assert.ok(chunks.length >= 3, 'The complete original must pass through multiple actual MCP chunk requests.');
    assert.deepEqual(chunks.map(record => record.args.offset), [0, 262144, 524288]);
    assert.equal(records.filter(record => record.name === 'document_widget_asset').length, 0,
      'All actual PDF.js font and CMap data must already be bundled, even when their RPC never arrives.');
    for (const record of records) {
      assert.equal(modelVisible(record.result).includes(privateData.ticket), false);
      if (record.result._meta?.base64) assert.equal(modelVisible(record.result).includes(record.result._meta.base64), false);
      assert.equal(record.result.isError, undefined, record.name);
    }
    assert.equal(maxInFlight, 1, 'Model and component tool calls must share a strictly serialized host queue.');
    widget.assertHealthy();
  } finally {
    await widget?.close();
    await queue;
    await client?.close(); await server?.close(); await app?.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-document-e2e-'));
    await rm(actual, { recursive: true, force: true });
  }
});
}
