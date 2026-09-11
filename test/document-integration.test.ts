import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/server.js';
import { DOCUMENT_WIDGET_URI, LEGACY_DOCUMENT_WIDGET_URIS } from '../src/document-widget.js';
import { startHttp } from '../src/http.js';

type Connection = Awaited<ReturnType<typeof connect>>;
async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-document-wire-'));
  const root = path.join(base, 'synthetic-workspace'); await mkdir(root);
  const configPath = path.join(base, 'config.json');
  await writeFile(configPath, JSON.stringify(defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic PDF wire device' })));
  await copyFile(path.resolve('test/fixtures/webcodex-reading-check.pdf'), path.join(root, '合成原件.pdf'));
  const app = new App(await loadConfig(configPath)), connections: Connection[] = [];
  t.after(async () => {
    for (const connection of connections) await connection.close();
    await app.close();
    const actual = await realpath(base); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-document-wire-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { app, root, async connect() { const connection = await connect(app); connections.push(connection); return connection; } };
}
async function connect(app: App) {
  const server = createMcpServer(app), client = new Client({ name: 'document-wire-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try { await client.connect(clientTransport); } catch (error) { await server.close(); throw error; }
  return { client, async close() { await client.close(); await server.close(); } };
}
const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>;
function data(result: any) { assert.equal(result.isError, undefined); assert.equal(result.structuredContent?.ok, true); return result.structuredContent.data; }
function modelOutput(result: any) { return JSON.stringify({ content: result.content, structuredContent: result.structuredContent }); }
async function open(client: Client, app: App) {
  const result = await call(client, 'document_open', { workspace_id: 'default', path: '合成原件.pdf', expected_device_id: app.identity.deviceId });
  const opened = data(result), metadata = result._meta?.webcodexDocument;
  assert.equal(metadata.document_id, opened.document_id); assert.match(metadata.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(modelOutput(result).includes(metadata.ticket), false);
  assert.deepEqual(Object.keys(metadata.file).sort(), ['chunk_max_bytes', 'expires_at']);
  assert.equal(JSON.stringify(result).includes('ticket_id'), false, 'No shared raw-file ticket may be forwarded even in component metadata.');
  return { result, opened, metadata };
}
type Opened = Awaited<ReturnType<typeof open>>;
const privateArgs = (view: Opened) => ({ document_id: view.opened.document_id, ticket: view.metadata.ticket, expected_device_id: view.metadata.expected_device_id });
const readArgs = (view: Opened) => ({ document_id: view.opened.document_id, workspace_id: view.opened.workspace_id, expected_device_id: view.metadata.expected_device_id });

async function reconstruct(client: Client, view: Opened) {
  const chunks: Buffer[] = []; let offset = 0;
  for (let count = 0; count < 64; count++) {
    const result = await call(client, 'document_widget_chunk', { ...privateArgs(view), offset });
    const chunk = data(result), encoded = result._meta?.base64;
    assert.equal(typeof encoded, 'string');
    assert.equal(modelOutput(result).includes(encoded), encoded.length === 0);
    const bytes = Buffer.from(encoded, 'base64');
    assert.equal(bytes.length, chunk.size_bytes); assert.equal(chunk.offset, offset);
    assert.ok(bytes.length <= 262144); assert.equal(chunk.sha256, view.opened.sha256);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), chunk.chunk_sha256);
    chunks.push(bytes);
    if (chunk.eof) {
      assert.equal(chunk.next_offset, null);
      const complete = Buffer.concat(chunks);
      assert.equal(complete.length, view.opened.size_bytes); assert.equal(createHash('sha256').update(complete).digest('hex'), view.opened.sha256);
      return complete;
    }
    assert.ok(chunk.next_offset > offset); offset = chunk.next_offset;
  }
  assert.fail('Original-file delivery exceeded the bounded test iteration count.');
}
async function submitSyntheticParserResult(client: Client, view: Opened) {
  const work = data(await call(client, 'document_widget_poll', privateArgs(view)));
  assert.equal(work.status, 'pending'); assert.equal(work.request.start_page, 1); assert.equal(work.request.page_count, 3);
  // These wire tests simulate the component parser. Actual PDF.js extraction has
  // independent runtime coverage and is not inferred from this synthetic text.
  const pages = [{ page_number: 1, text: 'Synthetic component page text for MCP transport verification.', truncated: false, text_layer: 'present' }];
  const args = { ...privateArgs(view), request_id: work.request.request_id, sha256: view.opened.sha256, total_pages: 1, pages };
  const acknowledged = data(await call(client, 'document_widget_submit', args));
  assert.deepEqual(acknowledged, { accepted: true, duplicate: false });
  const result = await call(client, 'document_read', readArgs(view)), ready = data(result);
  assert.equal(ready.status, 'ready'); assert.deepEqual(ready.pages, pages); assert.equal(ready.sha256, view.opened.sha256);
  assert.equal(ready.source, 'browser_pdfjs_text_layer'); assert.equal(ready.native_attachment, false);
  assert.ok(result.content.some((item: any) => item.type === 'text' && item.text.includes(pages[0].text)));
  assert.equal(JSON.stringify(result).includes(view.metadata.ticket), false); assert.equal(JSON.stringify(result).includes('ticket_id'), false);
  assert.equal(data(await call(client, 'document_widget_submit', args)).duplicate, true);
  return ready;
}

test('document tools advertise two model tools, four private component tools and a self-contained UI resource', async t => {
  const f = await fixture(t), connection = await f.connect(), tools = (await connection.client.listTools()).tools;
  const documentTools = tools.filter(tool => tool.name.startsWith('document_'));
  assert.equal(documentTools.length, 6);
  const opener: any = documentTools.find(tool => tool.name === 'document_open'), reader: any = documentTools.find(tool => tool.name === 'document_read');
  assert.ok(opener._meta.ui.visibility.includes('model')); assert.equal(opener._meta['openai/outputTemplate'], opener._meta.ui.resourceUri);
  assert.equal(reader._meta?.['openai/outputTemplate'], undefined);
  for (const tool of documentTools.filter(tool => tool.name.startsWith('document_widget_')) as any[]) {
    assert.deepEqual(tool._meta.ui.visibility, ['app']); assert.equal(tool._meta['openai/visibility'], 'private'); assert.equal(tool._meta['openai/widgetAccessible'], true);
  }
  const resource: any = await connection.client.readResource({ uri: opener._meta.ui.resourceUri });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app'); assert.equal(typeof resource.contents[0].text, 'string');
  assert.deepEqual(resource.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  await open(connection.client, f.app);
});

test('serialized MCP calls deliver exact original bytes privately then page text through ordinary model content', { timeout: 10000 }, async t => {
  const f = await fixture(t), connection = await f.connect(), view = await open(connection.client, f.app);
  const pending = data(await call(connection.client, 'document_read', readArgs(view)));
  assert.equal(pending.status, 'pending'); assert.equal(pending.retry_after_ms, 2000); assert.equal('pages' in pending, false);
  const bytes = await reconstruct(connection.client, view);
  assert.deepEqual(bytes, await readFile(path.join(f.root, '合成原件.pdf')));
  const ready = await submitSyntheticParserResult(connection.client, view);
  assert.deepEqual(data(await call(connection.client, 'document_read', readArgs(view))), ready);
  const diagnostics = JSON.stringify(f.app.store.db.prepare('SELECT method,tool,outcome,error_code FROM mcp_diagnostics').all());
  assert.equal(diagnostics.includes(view.metadata.ticket), false); assert.equal(diagnostics.includes(bytes.toString('base64')), false);
});

test('stateless HTTP supports strictly serialized original chunks, component submission and model page reads', { timeout: 10000 }, async t => {
  const f = await fixture(t), token = randomBytes(32).toString('hex'), listener = await startHttp(f.app, { token, port: 0 });
  const client = new Client({ name: 'document-http-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(listener.url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const view = await open(client, f.app);
    assert.equal(data(await call(client, 'document_read', readArgs(view))).status, 'pending');
    await reconstruct(client, view);
    await submitSyntheticParserResult(client, view);
  } finally { await client.close(); await listener.close(); }
});

test('prepared PDF state survives closing opening MCP server and using fresh servers for model and component', async t => {
  const f = await fixture(t), opener = await f.connect(), view = await open(opener.client, f.app);
  await opener.close();
  const component = await f.connect(); await reconstruct(component.client, view); await submitSyntheticParserResult(component.client, view);
  await component.close();
  const model = await f.connect(); assert.equal(data(await call(model.client, 'document_read', readArgs(view))).status, 'ready');
});

test('bad workspace, device, private capability and malformed page submissions produce real tool failures', async t => {
  const f = await fixture(t), connection = await f.connect(), view = await open(connection.client, f.app);
  for (const [name, args, code] of [
    ['document_read', { ...readArgs(view), workspace_id: 'other' }, 'DOCUMENT_NOT_FOUND'],
    ['document_read', { ...readArgs(view), expected_device_id: randomUUID() }, 'DEVICE_MISMATCH'],
    ['document_widget_chunk', { ...privateArgs(view), ticket: randomBytes(32).toString('base64url'), offset: 0 }, 'DOCUMENT_ACCESS_DENIED'],
  ] as Array<[string, Record<string, unknown>, string]>) {
    const result = await call(connection.client, name, args); assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, code);
  }
  const request = data(await call(connection.client, 'document_widget_poll', privateArgs(view))).request;
  const incomplete = await call(connection.client, 'document_widget_submit', { ...privateArgs(view), request_id: request.request_id, sha256: view.opened.sha256, total_pages: 3, pages: [] });
  assert.equal(incomplete.isError, true); assert.equal(incomplete.structuredContent.error.code, 'DOCUMENT_INVALID_RESULT');
  const malformed = await call(connection.client, 'document_widget_submit', { ...privateArgs(view), request_id: request.request_id, sha256: view.opened.sha256, error_code: 'PDF_PARSE_FAILED', password: 'unrequested' });
  assert.equal(malformed.isError, true);
  assert.equal(data(await call(connection.client, 'document_read', readArgs(view))).status, 'pending');
  await submitSyntheticParserResult(connection.client, view);
});

test('private bundled assets require document authorization and never leak bytes into model content', async t => {
  const f = await fixture(t), connection = await f.connect(), view = await open(connection.client, f.app);
  const result = await call(connection.client, 'document_widget_asset', { ...privateArgs(view), kind: 'standardFontDataUrl', filename: 'LiberationSans-Regular.ttf', offset: 0 });
  const asset = data(result), encoded = result._meta?.base64;
  assert.equal(typeof encoded, 'string'); assert.ok(encoded.length > 0); assert.equal(modelOutput(result).includes(encoded), false);
  assert.equal(Buffer.from(encoded, 'base64').length, asset.size_bytes);
  const forged = await call(connection.client, 'document_widget_asset', { ...privateArgs(view), ticket: randomBytes(32).toString('base64url'), kind: 'standardFontDataUrl', filename: 'LiberationSans-Regular.ttf', offset: 0 });
  assert.equal(forged.isError, true); assert.equal(forged.structuredContent.error.code, 'DOCUMENT_ACCESS_DENIED');
  const traversal = await call(connection.client, 'document_widget_asset', { ...privateArgs(view), kind: 'standardFontDataUrl', filename: '../config.json', offset: 0 });
  assert.equal(traversal.isError, true);
});

test('App shutdown never returns prepared PDF content or accepts stale document capabilities', async t => {
  const f = await fixture(t), connection = await f.connect(), view = await open(connection.client, f.app);
  await f.app.close();
  const result = await call(connection.client, 'document_read', readArgs(view));
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'SERVICE_CLOSING');
  const restarted = new App(f.app.config); let fresh: Connection | undefined;
  try {
    fresh = await connect(restarted);
    const stale = await call(fresh.client, 'document_widget_poll', privateArgs(view));
    assert.equal(stale.isError, true); assert.equal(stale.structuredContent.error.code, 'DOCUMENT_NOT_FOUND');
  } finally { await fresh?.close(); await restarted.close(); }
});


test('an accepted component failure reaches every ordinary page query without further pending responses', async t => {
  const f = await fixture(t), c = await f.connect(), view = await open(c.client, f.app);
  const first = { ...readArgs(view), start_page: 1, page_count: 1 };
  const fourth = { ...readArgs(view), start_page: 4, page_count: 1 };
  assert.equal(data(await call(c.client, 'document_read', first)).status, 'pending');
  assert.equal(data(await call(c.client, 'document_read', fourth)).status, 'pending');
  const work = data(await call(c.client, 'document_widget_poll', privateArgs(view)));
  data(await call(c.client, 'document_widget_submit', { ...privateArgs(view), request_id: work.request.request_id,
    sha256: view.opened.sha256, error_code: 'FILE_INTEGRITY_ERROR' }));
  for (const args of [first, fourth, readArgs(view)]) {
    const result = await call(c.client, 'document_read', args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.error.code, 'FILE_INTEGRITY_ERROR');
    assert.equal(result.structuredContent.error.details.scope, 'document');
    assert.equal(result.structuredContent.error.retryable, false);
    assert.ok(result.content.some((item: any) => item.type === 'text' && item.text.includes('FILE_INTEGRITY_ERROR')));
    assert.equal('data' in result.structuredContent, false);
    assert.equal(JSON.stringify(result).includes(view.metadata.ticket), false);
  }
});

test('actual SDK exposes fixed component diagnostics in model-visible errors without private capabilities or binary data', async t => {
  const f = await fixture(t), c = await f.connect(), view = await open(c.client, f.app);
  const work = data(await call(c.client, 'document_widget_poll', privateArgs(view)));
  const original = await reconstruct(c.client, view);
  const diagnostics = { component_version: '0.15.0-preview.2', phase: 'file', code: 'FILE_INTEGRITY_ERROR', detail_code: 'CHUNK_END_MISMATCH' };
  const submission = { ...privateArgs(view), request_id: work.request.request_id, sha256: view.opened.sha256,
    error_code: 'FILE_INTEGRITY_ERROR', failure_diagnostics: diagnostics };
  assert.deepEqual(data(await call(c.client, 'document_widget_submit', submission)), { accepted: true, duplicate: false });
  assert.deepEqual(data(await call(c.client, 'document_widget_submit', submission)), { accepted: true, duplicate: true });
  const changed = await call(c.client, 'document_widget_submit', { ...submission,
    failure_diagnostics: { ...diagnostics, detail_code: 'FILE_SHA256_MISMATCH' } });
  assert.equal(changed.isError, true); assert.equal(changed.structuredContent.error.code, 'DOCUMENT_RESULT_CONFLICT');
  for (const range of [{ start_page: 1, page_count: 1 }, { start_page: 4, page_count: 1 }]) {
    const result = await call(c.client, 'document_read', { ...readArgs(view), ...range });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'FILE_INTEGRITY_ERROR');
    const details = result.structuredContent.error.details;
    assert.deepEqual(details.component_diagnostics, { source: 'component_reported', ...diagnostics });
    assert.equal(details.progress.complete_original_served, true);
    assert.equal(details.progress.failure_observed_stage, 'awaiting_page_result');
    const text = result.content.find((item: any) => item.type === 'text')?.text;
    assert.deepEqual(JSON.parse(text).error.details.component_diagnostics, details.component_diagnostics);
    for (const hidden of [view.metadata.ticket, view.opened.sha256, view.opened.path, original.toString('base64')]) {
      assert.equal(JSON.stringify(result).includes(hidden), false);
    }
  }
});

test('actual SDK rejects unknown diagnostic fields and values and success reports carrying failure diagnostics', async t => {
  const f = await fixture(t), c = await f.connect(), view = await open(c.client, f.app);
  const work = data(await call(c.client, 'document_widget_poll', privateArgs(view)));
  const base = { ...privateArgs(view), request_id: work.request.request_id, sha256: view.opened.sha256 };
  const diagnostics = { component_version: '0.15.0-preview.2', phase: 'file', code: 'FILE_INTEGRITY_ERROR' };
  for (const invalid of [
    null, [], {}, { ...diagnostics, message: 'unrequested message' },
    { ...diagnostics, component_version: '0.15.0-preview.2\n' },
    { ...diagnostics, component_version: '0.15.0+private-path' },
    { ...diagnostics, phase: 'submit' }, { ...diagnostics, code: 'raw exception' },
    { ...diagnostics, detail_code: 'raw exception detail' },
  ]) {
    const result = await call(c.client, 'document_widget_submit', { ...base, error_code: 'FILE_INTEGRITY_ERROR', failure_diagnostics: invalid });
    assert.equal(result.isError, true);
  }
  const contaminated = await call(c.client, 'document_widget_submit', { ...base, total_pages: 1,
    pages: [{ page_number: 1, text: 'Synthetic valid page', truncated: false, text_layer: 'present' }], failure_diagnostics: diagnostics });
  assert.equal(contaminated.isError, true); assert.equal(contaminated.structuredContent.error.code, 'DOCUMENT_INVALID_RESULT');
  assert.equal(data(await call(c.client, 'document_read', readArgs(view))).status, 'pending');
  await submitSyntheticParserResult(c.client, view);
});

test('the prior document resource address serves the corrected current component', async t => {
  const f = await fixture(t), c = await f.connect();
  const current: any = await c.client.readResource({ uri: DOCUMENT_WIDGET_URI });
  for (const uri of LEGACY_DOCUMENT_WIDGET_URIS) {
    const result: any = await c.client.readResource({ uri });
    assert.equal(result.contents[0].uri, uri);
    assert.equal(result.contents[0].text, current.contents[0].text);
  }
});
