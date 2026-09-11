import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/server.js';
import { startHttp } from '../src/http.js';
import { LEGACY_READING_RELAY_URIS } from '../src/reading-relay-probe.js';
import { VERSION } from '../src/version.js';

type Connection = Awaited<ReturnType<typeof connect>>;

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-reading-relay-wire-'));
  const root = path.join(base, 'synthetic-workspace');
  await mkdir(root);
  const configPath = path.join(base, 'config.json');
  await writeFile(configPath, JSON.stringify(defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic relay device' })));
  const app = new App(await loadConfig(configPath));
  const connections: Connection[] = [];
  t.after(async () => {
    for (const connection of connections) await connection.close();
    await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-reading-relay-wire-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { app, async connect() { const connection = await connect(app); connections.push(connection); return connection; } };
}

async function connect(app: App) {
  const server = createMcpServer(app);
  const client = new Client({ name: 'reading-relay-wire-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try { await client.connect(clientTransport); }
  catch (error) { await server.close(); throw error; }
  return {
    client,
    async close() { await client.close(); await server.close(); },
  };
}

function data(result: any) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent?.ok, true);
  return result.structuredContent.data;
}

function expectedText(challenge: string) {
  return 'WebCodex browser relay: ' + createHash('sha256').update('webcodex-reading-relay-v1:' + challenge).digest('hex');
}

async function open(client: Client) {
  const result: any = await client.callTool({ name: 'reading_probe_open', arguments: {} });
  const opened = data(result);
  const privateData = result._meta?.webcodexReadingRelay;
  assert.equal(opened.prototype, true);
  assert.equal(privateData?.relay_id, opened.relay_id);
  assert.equal(typeof privateData.ticket, 'string');
  assert.equal(typeof privateData.challenge, 'string');
  assert.ok(privateData.ticket.length >= 32);
  assert.ok(privateData.challenge.length >= 32);
  const modelOutput = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
  for (const hidden of [privateData.ticket, privateData.challenge, expectedText(privateData.challenge)]) {
    assert.equal(modelOutput.includes(hidden), false, 'Opening the component must not leak the answer or private capability to the model.');
  }
  return { result, opened, privateData };
}

function read(client: Client, relayId: string) {
  return client.callTool({ name: 'reading_probe_read', arguments: { relay_id: relayId } });
}

async function command(client: Client, relay: { relay_id: string; ticket: string }) {
  const result = data(await client.callTool({ name: 'reading_probe_poll', arguments: { relay_id: relay.relay_id, ticket: relay.ticket } }));
  assert.equal(result.status, 'pending');
  assert.equal(typeof result.request_id, 'string');
  return result;
}

function pendingData(result: unknown, relayId: string, remaining: number) {
  assert.deepEqual(data(result), {
    relay_id: relayId, status: 'pending', retry_after_ms: 1_000, pending_reads_remaining: remaining,
  }, 'A read without submitted content must immediately report bounded pending state and no answer.');
}

function readyData(result: any, relay: { relay_id: string; ticket: string; challenge: string }, requestId: string) {
  const received = data(result);
  assert.deepEqual(received, {
    relay_id: relay.relay_id, status: 'ready', request_id: requestId,
    text: expectedText(relay.challenge), source: 'browser_component',
  });
  assert.ok(result.content.some((item: any) => item.type === 'text' && item.text.includes(received.text)), 'The answer must exist in ordinary model-visible tool content.');
  assert.equal(JSON.stringify(result).includes(relay.ticket), false);
  assert.equal(JSON.stringify(result).includes(relay.challenge), false);
  return received;
}

async function submit(client: Client, relay: { relay_id: string; ticket: string; challenge: string }, requestId: string) {
  return client.callTool({ name: 'reading_probe_submit', arguments: {
    relay_id: relay.relay_id, ticket: relay.ticket, request_id: requestId, text: expectedText(relay.challenge),
  } });
}

test('reading relay advertises a model open/read pair and component-only poll/submit with private initialization', async t => {
  const f = await fixture(t), connection = await f.connect();
  const tools = (await connection.client.listTools()).tools;
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const opener: any = byName.get('reading_probe_open');
  const reader: any = byName.get('reading_probe_read');
  assert.ok(opener); assert.ok(reader);
  const resourceUri = opener._meta?.ui?.resourceUri;
  assert.equal(typeof resourceUri, 'string');
  assert.equal(opener._meta['openai/outputTemplate'], resourceUri);
  assert.ok(opener._meta.ui.visibility.includes('model'));
  assert.equal(reader._meta?.ui?.resourceUri, undefined, 'Reading results must not create a second component.');
  assert.equal(reader._meta?.['openai/outputTemplate'], undefined);
  for (const name of ['reading_probe_poll', 'reading_probe_submit']) {
    const tool: any = byName.get(name);
    assert.ok(tool);
    assert.deepEqual(tool._meta?.ui?.visibility, ['app']);
    assert.equal(tool._meta?.['openai/visibility'], 'private');
    assert.equal(tool._meta?.['openai/widgetAccessible'], true);
  }
  const resource: any = await connection.client.readResource({ uri: resourceUri });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.equal(typeof resource.contents[0].text, 'string');
  assert.ok(resource.contents[0].text.includes(`const BUILD_VERSION = ${JSON.stringify(VERSION)}`));
  assert.ok(LEGACY_READING_RELAY_URIS.includes('ui://webcodex/reading-relay-0.14.0-preview.3.html'));
  for (const uri of LEGACY_READING_RELAY_URIS) {
    const legacy: any = await connection.client.readResource({ uri });
    assert.equal(legacy.contents[0].uri, uri);
    assert.equal(legacy.contents[0].mimeType, resource.contents[0].mimeType);
    assert.equal(legacy.contents[0].text, resource.contents[0].text, 'Cached resource addresses must load the corrected component.');
  }
  await open(connection.client);
});

test('serialized host dispatch completes read, poll, submit and final read without overlapping tool calls', { timeout: 4_000 }, async t => {
  const f = await fixture(t), connection = await f.connect();
  const { privateData } = await open(connection.client);
  // Deliberately await each full response before dispatching the next request,
  // as the observed ChatGPT host does. A waiting read blocks this whole chain.
  pendingData(await read(connection.client, privateData.relay_id), privateData.relay_id, 5);
  const work = await command(connection.client, privateData);
  const submitted = data(await submit(connection.client, privateData, work.request_id));
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.duplicate, false);
  const received = readyData(await read(connection.client, privateData.relay_id), privateData, work.request_id);
  assert.deepEqual(data(await read(connection.client, privateData.relay_id)), received);
  assert.equal(data(await submit(connection.client, privateData, work.request_id)).duplicate, true);
});

test('component can poll and submit eagerly before the first model read', async t => {
  const f = await fixture(t), connection = await f.connect();
  const { privateData } = await open(connection.client);
  const work = await command(connection.client, privateData);
  data(await submit(connection.client, privateData, work.request_id));
  readyData(await read(connection.client, privateData.relay_id), privateData, work.request_id);
  const completed = data(await connection.client.callTool({ name: 'reading_probe_poll', arguments: {
    relay_id: privateData.relay_id, ticket: privateData.ticket,
  } }));
  assert.equal(completed.status, 'complete');
});

test('pending reads have a finite retry budget without preventing later component submission or cached ready reads', async t => {
  const f = await fixture(t), connection = await f.connect();
  const { privateData } = await open(connection.client);
  const work = await command(connection.client, privateData);
  for (let remaining = 5; remaining >= 0; remaining--) {
    pendingData(await read(connection.client, privateData.relay_id), privateData.relay_id, remaining);
  }
  const exhausted: any = await read(connection.client, privateData.relay_id);
  assert.equal(exhausted.isError, true);
  assert.equal(exhausted.structuredContent.error.code, 'RELAY_READ_LIMIT');
  assert.equal((await command(connection.client, privateData)).request_id, work.request_id);
  data(await submit(connection.client, privateData, work.request_id));
  for (let attempt = 0; attempt < 8; attempt++) readyData(await read(connection.client, privateData.relay_id), privateData, work.request_id);
});

test('relay survives closing its opening MCP server and completes across fresh servers sharing the same App', async t => {
  const f = await fixture(t), opener = await f.connect();
  const { privateData } = await open(opener.client);
  await opener.close();
  const model = await f.connect(), component = await f.connect();
  pendingData(await read(model.client, privateData.relay_id), privateData.relay_id, 5);
  const work = await command(component.client, privateData);
  data(await submit(component.client, privateData, work.request_id));
  readyData(await read(model.client, privateData.relay_id), privateData, work.request_id);
});

test('real stateless HTTP supports serialized read, component poll and submit, then readable cached content', { timeout: 4_000 }, async t => {
  const f = await fixture(t), token = randomBytes(32).toString('hex');
  const listener = await startHttp(f.app, { token, port: 0 });
  const client = new Client({ name: 'reading-relay-http-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(listener.url), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }));
    const { privateData } = await open(client);
    pendingData(await read(client, privateData.relay_id), privateData.relay_id, 5);
    const work = await command(client, privateData);
    data(await submit(client, privateData, work.request_id));
    readyData(await read(client, privateData.relay_id), privateData, work.request_id);
  } finally {
    await client.close();
    await listener.close();
  }
});

test('a request ID from another probe cannot complete this probe or manufacture ready state', async t => {
  const f = await fixture(t), connection = await f.connect();
  const first = await open(connection.client), second = await open(connection.client);
  const firstWork = await command(connection.client, first.privateData);
  const secondWork = await command(connection.client, second.privateData);
  const stale: any = await submit(connection.client, second.privateData, firstWork.request_id);
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, 'RELAY_STALE_SUBMISSION');
  pendingData(await read(connection.client, second.privateData.relay_id), second.privateData.relay_id, 5);
  data(await submit(connection.client, second.privateData, secondWork.request_id));
  readyData(await read(connection.client, second.privateData.relay_id), second.privateData, secondWork.request_id);
});

test('App close and restart never promote unsubmitted work to success or accept old relay credentials', async t => {
  const f = await fixture(t), connection = await f.connect();
  const { privateData } = await open(connection.client);
  const work = await command(connection.client, privateData);
  pendingData(await read(connection.client, privateData.relay_id), privateData.relay_id, 5);
  await f.app.close();
  const result: any = await read(connection.client, privateData.relay_id);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'SERVICE_CLOSING');
  assert.throws(() => f.app.store.db.prepare('SELECT 1'), /closed|not open/i);
  const restarted = new App(f.app.config);
  let fresh: Connection | undefined;
  try {
    fresh = await connect(restarted);
    assert.notEqual(restarted.instanceId, f.app.instanceId);
    const missing: any = await read(fresh.client, privateData.relay_id);
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.error.code, 'RELAY_NOT_FOUND');
    const stale: any = await submit(fresh.client, privateData, work.request_id);
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.error.code, 'RELAY_ACCESS_DENIED');
    const next = await open(fresh.client);
    pendingData(await read(fresh.client, next.privateData.relay_id), next.privateData.relay_id, 5);
  } finally {
    await fresh?.close();
    await restarted.close();
  }
});
