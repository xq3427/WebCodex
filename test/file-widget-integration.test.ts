import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultUnifiedConfig, loadConfig, validateConfig } from '../src/config.js';
import { serializeConfig } from '../src/config-format.js';
import { App } from '../src/app.js';
import { startHttp } from '../src/http.js';
import { FILE_WIDGET_URI, FILE_WIDGET_MIME_TYPE } from '../src/file-widget.js';
import { DEFAULT_WIDGET_UPLOAD_BYTES, MAX_WIDGET_UPLOAD_BYTES } from '../src/file-widget-probe.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const inlineLimit = 7 * 1024 * 1024;
const syntheticConfigKey = 'synthetic-widget-config-key-never-return';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

async function fixture(t: TestContext, uploadLimit?: number) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-widget-mcp-'));
  const root = path.join(base, '原文件 workspace');
  await mkdir(root);
  const configPath = path.join(base, 'config.json');
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic widget device' });
  raw.tunnel.apiKey = syntheticConfigKey;
  const config = { ...raw, limits: { ...raw.limits, fileTransferMaxBytes: inlineLimit, ...(uploadLimit === undefined ? {} : { fileWidgetUploadMaxBytes: uploadLimit }) } };
  await writeFile(configPath, serializeConfig(config, 'json'));
  t.after(async () => {
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-widget-mcp-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { base, root, configPath, config, deviceId: config.device.id };
}

async function connect(configPath: string, mode: 'stdio' | 'http') {
  const client = new Client({ name: 'file-widget-wire-test', version: '1' });
  if (mode === 'stdio') {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, 'serve', '--config', configPath], stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    try { await client.connect(transport); }
    catch (error) { await transport.close(); throw error; }
    return { client, close: () => client.close() };
  }
  const app = new App(await loadConfig(configPath)), token = randomUUID() + randomUUID();
  let http: Awaited<ReturnType<typeof startHttp>> | undefined;
  try {
    http = await startHttp(app, { token, port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const owned = http;
    return { client, close: async () => { try { await client.close(); } finally { try { await owned.close(); } finally { await app.close(); } } } };
  } catch (error) { await http?.close(); await app.close(); throw error; }
}

function occurrences(value: unknown, expected: string): number {
  if (typeof value === 'string') return value === expected ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + occurrences(item, expected), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((total, item) => total + occurrences(item, expected), 0);
  return 0;
}

function noBinaryFields(value: unknown) {
  if (Array.isArray(value)) { for (const item of value) noBinaryFields(item); return; }
  if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) {
    assert.ok(!['base64', 'blob', 'webcodexFile', 'webcodexChunk'].includes(name), `Unexpected binary field: ${name}`);
    noBinaryFields(child);
  }
}

async function localFile(client: Client, result: any, original: Buffer, filename: string, expectedDevice: string, expectedMime: string) {
  assert.equal(result.isError, undefined); assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.source.device_id, expectedDevice);
  assert.equal(result.content.length, 1); assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const data = result.structuredContent.data, delivery = result._meta?.webcodexDelivery;
  assert.equal(data.mode, 'local-file'); assert.equal(data.prototype, true);
  assert.equal(data.name, filename); assert.equal(data.size_bytes, original.length); assert.equal(data.sha256, digest(original));
  assert.equal(data.mime_type, expectedMime); assert.equal(data.content_processing, 'none');
  assert.equal(data.content_processing_scope, 'server_only'); assert.equal(data.model_access, 'unverified');
  assert.ok(['automatic', 'manual'].includes(data.ui.mode));
  assert.equal(typeof data.ui.compact, 'boolean'); assert.equal(typeof data.ui.close_after_send, 'boolean');
  assert.match(data.next_step, data.ui.mode === 'automatic' ? /automatically uploads once/i : /user click/i);
  assert.match(data.next_step, /not that ChatGPT cannot parse/i);
  assert.equal(data.upload_performed, false); assert.equal(data.host_upload_support, 'unverified'); assert.equal(data.client_attachment_support, 'unverified');
  assert.equal(data.upload_state_scope, 'tool_invocation_snapshot'); assert.equal(data.delivery, 'component-only-chunks');
  assert.match(data.delivery_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  noBinaryFields(result);
  const initialJson = JSON.stringify(result);
  assert.ok(Buffer.byteLength(initialJson) < 16 * 1024, 'The entire model-initiated response, including _meta, must remain metadata-sized.');
  if (original.length) assert.equal(initialJson.includes(original.toString('base64')), false);
  assert.deepEqual(Object.keys(result._meta).sort(), ['webcodexDelivery']);
  assert.deepEqual(Object.keys(delivery).sort(), ['chunkMaxBytes', 'deliveryId', 'expiresAt', 'ticketId']);
  assert.equal(delivery.deliveryId, data.delivery_id);
  assert.match(delivery.ticketId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify({ content: result.content, structuredContent: result.structuredContent }).includes(delivery.ticketId), false);
  assert.equal(new Date(delivery.expiresAt).toISOString(), delivery.expiresAt);
  assert.ok(Date.parse(delivery.expiresAt) > Date.now()); assert.equal(delivery.chunkMaxBytes, 65536);
  assert.equal(JSON.stringify(result).includes(syntheticConfigKey), false);
  const identity = { ticket_id: delivery.ticketId, expected_device_id: expectedDevice };
  denied(await client.callTool({ name: 'file_widget_read', arguments: { ...identity, expected_device_id: randomUUID(), offset: 0 } }), 'DEVICE_MISMATCH');
  const chunks: Buffer[] = [];
  let offset = 0;
  while (true) {
    // HTTP serves each call in a fresh MCP request; this also checks that tickets
    // belong to the App rather than one request-scoped McpServer.
    const chunk: any = await client.callTool({ name: 'file_widget_read', arguments: { ...identity, offset } });
    assert.equal(chunk.isError, undefined); assert.equal(chunk.structuredContent.ok, true);
    assert.equal(chunk.structuredContent.source.device_id, expectedDevice);
    assert.equal(chunk.content.length, 1); assert.equal(chunk.content[0].type, 'text');
    assert.deepEqual(JSON.parse(chunk.content[0].text), chunk.structuredContent);
    const metadata = chunk.structuredContent.data, encoded = chunk._meta?.webcodexChunk?.base64;
    assert.equal(typeof encoded, 'string');
    const bytes = Buffer.from(encoded, 'base64');
    assert.equal(bytes.toString('base64'), encoded);
    const end = Math.min(original.length, offset + delivery.chunkMaxBytes), eof = end === original.length;
    assert.deepEqual(metadata, { ticket_id: delivery.ticketId, offset, size_bytes: end - offset, total_bytes: original.length,
      next_offset: eof ? null : end, eof, sha256: data.sha256, chunk_sha256: digest(bytes) });
    assert.deepEqual(bytes, original.subarray(offset, end));
    assert.ok(bytes.length <= delivery.chunkMaxBytes);
    assert.deepEqual(Object.keys(chunk._meta), ['webcodexChunk']); assert.deepEqual(Object.keys(chunk._meta.webcodexChunk), ['base64']);
    assert.equal(occurrences(chunk, encoded), 1, 'A chunk is encoded once, only in app-visible metadata.');
    const modelVisible = { content: chunk.content, structuredContent: chunk.structuredContent };
    noBinaryFields(modelVisible);
    if (encoded) assert.equal(JSON.stringify(modelVisible).includes(encoded), false);
    assert.ok(Buffer.byteLength(JSON.stringify(modelVisible)) < 16 * 1024);
    assert.equal(JSON.stringify(chunk).includes(syntheticConfigKey), false);
    chunks.push(bytes);
    if (eof) break;
    assert.ok(typeof metadata.next_offset === 'number');
    assert.ok(metadata.next_offset > offset); offset = metadata.next_offset;
  }
  assert.deepEqual(Buffer.concat(chunks), original); assert.equal(digest(Buffer.concat(chunks)), data.sha256);
  const released: any = await client.callTool({ name: 'file_widget_release', arguments: identity });
  assert.equal(released.isError, undefined); assert.equal(released.structuredContent.ok, true);
  assert.deepEqual(released.structuredContent.data, { released: true }); noBinaryFields(released);
  denied(await client.callTool({ name: 'file_widget_release', arguments: identity }), 'FILE_WIDGET_TICKET_NOT_FOUND');
  denied(await client.callTool({ name: 'file_widget_read', arguments: { ...identity, offset: 0 } }), 'FILE_WIDGET_TICKET_NOT_FOUND');
  return data;
}

function denied(result: any, code: string) {
  assert.equal(result.isError, true); assert.equal(result.structuredContent.ok, false); assert.equal(result.structuredContent.error.code, code);
  assert.equal(result.structuredContent.data, undefined); assert.equal(result._meta, undefined); noBinaryFields(result);
  assert.equal(result.content.length, 1); assert.equal(result.content[0].type, 'text');
  assert.equal(JSON.stringify(result).includes(syntheticConfigKey), false);
}

for (const transport of ['stdio', 'http'] as const) {
  test(`${transport} applies configured file interaction settings while keeping probes manual`, async t => {
    const f = await fixture(t), bytes = Buffer.from('Synthetic automatic-mode transport fixture.');
    await writeFile(path.join(f.root, 'mode.bin'), bytes);
    for (const setting of [
      { mode: 'manual', compact: true, closeAfterSend: false },
      { mode: 'automatic', compact: false, closeAfterSend: false },
    ] as const) {
      await writeFile(f.configPath, serializeConfig({ ...f.config, fileWidget: setting }, 'json'));
      const connection = await connect(f.configPath, transport);
      try {
        const args = { workspace_id: 'default', path: 'mode.bin', expected_device_id: f.deviceId };
        const result: any = await connection.client.callTool({ name: 'fs_open_file', arguments: args });
        const data = await localFile(connection.client, result, bytes, 'mode.bin', f.deviceId, 'application/octet-stream');
        assert.deepEqual(data.ui, { mode: setting.mode, compact: setting.compact, close_after_send: setting.closeAfterSend });
        const status: any = await connection.client.callTool({ name: 'system_status', arguments: {} });
        assert.deepEqual(status.structuredContent.data.file_widget.ui, data.ui);
        const probe: any = await connection.client.callTool({ name: 'file_widget_probe', arguments: args });
        const diagnostic = await localFile(connection.client, probe, bytes, 'mode.bin', f.deviceId, 'application/octet-stream');
        assert.deepEqual(diagnostic.ui, { mode: 'manual', compact: false, close_after_send: false });
        assert.deepEqual(await readFile(path.join(f.root, 'mode.bin')), bytes);
      } finally { await connection.close(); }
    }
  });

  test(`${transport} discovers a self-contained file component and a no-argument capability probe without changing files or claiming upload`, async t => {
    const f = await fixture(t), sentinel = Buffer.from('Synthetic original file stays unchanged.\r\n中文\0');
    await writeFile(path.join(f.root, 'sentinel.bin'), sentinel);
    const configBefore = await readFile(f.configPath), connection = await connect(f.configPath, transport);
    try {
      const tools = (await connection.client.listTools()).tools;
      assert.equal(tools.length, 65);
      const tool = tools.find(item => item.name === 'file_widget_probe')!;
      assert.ok(tool); assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.annotations?.openWorldHint, false);
      const metadata = tool._meta as any;
      assert.equal(metadata.ui.resourceUri, FILE_WIDGET_URI); assert.deepEqual(metadata.ui.visibility, ['model', 'app']);
      assert.equal(metadata['openai/outputTemplate'], FILE_WIDGET_URI); assert.equal(metadata['openai/widgetAccessible'], true);
      for (const name of ['file_widget_read', 'file_widget_release']) {
        const privateTool = tools.find(item => item.name === name)!;
        assert.ok(privateTool);
        assert.deepEqual((privateTool._meta as any).ui.visibility, ['app']);
        assert.equal((privateTool._meta as any)['openai/visibility'], 'private');
        assert.equal((privateTool._meta as any)['openai/widgetAccessible'], true);
        assert.equal(privateTool.inputSchema.additionalProperties, false);
        const required = name === 'file_widget_read' ? ['expected_device_id', 'offset', 'ticket_id'] : ['expected_device_id', 'ticket_id'];
        assert.deepEqual(privateTool.inputSchema.required?.slice().sort(), required);
        if (name === 'file_widget_release') assert.equal(privateTool.inputSchema.properties?.offset, undefined);
      }
      for (const [name, args] of [
        ['file_widget_read', { ticket_id: 't'.repeat(43), expected_device_id: f.deviceId }],
        ['file_widget_release', { ticket_id: 't'.repeat(43), expected_device_id: f.deviceId, offset: 0 }],
      ] as const) {
        const rejected = await connection.client.callTool({ name, arguments: args });
        assert.equal(rejected.isError, true); noBinaryFields(rejected);
      }
      const resources = (await connection.client.listResources()).resources;
      const resource = resources.find(item => item.uri === FILE_WIDGET_URI)!;
      assert.ok(resource); assert.equal(resource.mimeType, FILE_WIDGET_MIME_TYPE);
      const read: any = await connection.client.readResource({ uri: FILE_WIDGET_URI });
      assert.equal(read.contents.length, 1);
      const contents = read.contents[0];
      assert.equal(contents.uri, FILE_WIDGET_URI); assert.equal(contents.mimeType, FILE_WIDGET_MIME_TYPE);
      assert.match(contents.text, /^<!doctype html>/i); assert.match(contents.text, /<script>/i); assert.match(contents.text, /<\/html>\s*$/i);
      assert.doesNotMatch(contents.text, /<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=|@import\s|\bimport\s*\([^)]*["']https?:/i);
      assert.equal(contents.text.includes(syntheticConfigKey), false);
      assert.deepEqual(contents._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
      assert.deepEqual(contents._meta['openai/widgetCSP'], { connect_domains: [], resource_domains: [] });
      assert.match(contents._meta['openai/widgetDescription'], /upload is not proof of attachment/i);
      const probe: any = await connection.client.callTool({ name: 'file_widget_probe', arguments: {} });
      assert.equal(probe.isError, undefined); assert.equal(probe.structuredContent.ok, true); assert.equal(probe._meta, undefined); noBinaryFields(probe);
      assert.equal(probe.structuredContent.source.device_id, f.deviceId);
      const { next_step: probeNextStep, ...probeData } = probe.structuredContent.data;
      assert.deepEqual(probeData, { prototype: true, mode: 'capabilities', max_upload_bytes: 100 * 1024 * 1024, inline_max_bytes: inlineLimit,
        max_upload_bytes_scope: 'component_upload_policy', snapshot_cache_max_bytes: 32 * 1024 * 1024,
        effective_local_file_max_bytes: inlineLimit, effective_local_file_limit_scope: 'per_file_with_empty_cache',
        host_upload_support: 'unverified', client_attachment_support: 'unverified', content_processing: 'none', content_processing_scope: 'server_only', model_access: 'unverified', upload_performed: false, upload_state_scope: 'tool_invocation_snapshot', delivery: 'component-only-chunks', ui: { mode: 'manual', compact: false, close_after_send: false } });
      assert.equal(typeof probeNextStep, 'string');
      assert.match(probeNextStep, /capability summary/);
      assert.match(probeNextStep, /does not require selecting or uploading any file/);
      assert.deepEqual(JSON.parse(probe.content[0].text), probe.structuredContent);
      assert.equal(JSON.stringify(probe).includes(syntheticConfigKey), false);
      assert.deepEqual(await readFile(path.join(f.root, 'sentinel.bin')), sentinel);
      assert.deepEqual(await readFile(f.configPath), configBefore);
    } finally { await connection.close(); }
  });

  test(`${transport} opens a synthetic 1.6 MiB document with a metadata-only response and preserves its ticket across private chunk calls`, async t => {
    const f = await fixture(t), filename = '要讲 中文 % +# 🧪.pdf';
    // Transport fixture only; it deliberately does not claim to prove host PDF parsing.
    const bytes = Buffer.alloc(Math.floor(1.6 * 1024 * 1024), 0xa5);
    Buffer.from('%PDF-1.7\r\nSynthetic original bytes\0\xff', 'latin1').copy(bytes);
    await writeFile(path.join(f.root, filename), bytes);
    const connection = await connect(f.configPath, transport);
    try {
      const tools = (await connection.client.listTools()).tools;
      const open = tools.find(item => item.name === 'fs_open_file')!;
      const raw = tools.find(item => item.name === 'fs_read_file')!;
      assert.deepEqual(open.inputSchema.required?.slice().sort(), ['expected_device_id', 'path', 'workspace_id']);
      assert.equal(open.inputSchema.additionalProperties, false);
      assert.equal(open.annotations?.readOnlyHint, true); assert.equal(open.annotations?.openWorldHint, false);
      assert.equal((open._meta as any).ui.resourceUri, FILE_WIDGET_URI);
      assert.match(open.description!, /PDF text reading use document_open then document_read/);
      assert.match(open.description!, /explicitly requested component experiments/);
      assert.match(open.description!, /Do not automatically route document requests/);
      assert.match(open.description!, /acknowledgment does not prove parsing/);
      assert.match(open.description!, /Never claim a summary from metadata/);
      assert.match(raw.description!, /PDF text reading use document_open then document_read/);
      assert.match(raw.description!, /does not prove readable contents/);
      assert.match(connection.client.getInstructions()!, /content_processing:none describes server-side processing only/);
      const args = { workspace_id: 'default', path: filename, expected_device_id: f.deviceId };
      const result = await connection.client.callTool({ name: 'fs_open_file', arguments: args });
      await localFile(connection.client, result, bytes, filename, f.deviceId, 'application/pdf');
      const status: any = await connection.client.callTool({ name: 'system_status', arguments: {} });
      assert.equal(status.structuredContent.data.file_widget.tool, 'fs_open_file');
      assert.equal(status.structuredContent.data.file_widget.probe_tool, 'file_widget_probe');
      assert.deepEqual(status.structuredContent.data.file_widget.ui, { mode: 'automatic', compact: true, close_after_send: true });
      assert.deepEqual((result.structuredContent as any).data.ui, status.structuredContent.data.file_widget.ui);
      denied(await connection.client.callTool({ name: 'fs_open_file', arguments: { ...args, expected_device_id: randomUUID() } }), 'DEVICE_MISMATCH');
      denied(await connection.client.callTool({ name: 'fs_open_file', arguments: { ...args, path: '../config.json' } }), 'PATH_DENIED');
      denied(await connection.client.callTool({ name: 'fs_open_file', arguments: { ...args, path: 'missing.pdf' } }), 'NOT_FOUND');
      for (const missing of [{}, { workspace_id: 'default', path: filename }]) {
        const rejected = await connection.client.callTool({ name: 'fs_open_file', arguments: missing });
        assert.equal(rejected.isError, true); noBinaryFields(rejected);
        assert.equal(JSON.stringify(rejected).includes(bytes.toString('base64')), false);
      }
      assert.deepEqual(await readFile(path.join(f.root, filename)), bytes);
    } finally { await connection.close(); }
    const database = new DatabaseSync(path.join(f.base, 'state', 'webcodex.sqlite'), { readOnly: true });
    try {
      const audits = database.prepare("SELECT event, details FROM audit_events WHERE event IN ('fs_open_file','tool_error')").all();
      assert.ok(audits.some(row => row.event === 'fs_open_file' && JSON.parse(String(row.details)).path === filename));
      assert.ok(audits.some(row => row.event === 'tool_error' && JSON.parse(String(row.details)).tool === 'fs_open_file'));
      assert.equal(JSON.stringify(audits).includes(bytes.toString('base64')), false);
      assert.equal(JSON.stringify(audits).includes(syntheticConfigKey), false);
    } finally { database.close(); }
  });

  test(`${transport} transports original PNG and binary bytes only through private chunks and enforces complete local-file authorization`, async t => {
    const f = await fixture(t), binary = Buffer.concat([Buffer.from([0, 255, 254, 128, 13, 10]), Buffer.from('完整原文件\0\r\n'.repeat(20))]);
    await Promise.all([writeFile(path.join(f.root, '图片.png'), png), writeFile(path.join(f.root, '文档.bin'), binary), writeFile(path.join(f.root, '.env'), syntheticConfigKey), mkdir(path.join(f.root, '.codex'))]);
    await writeFile(path.join(f.root, '.codex', 'auth.json'), syntheticConfigKey);
    const outside = path.join(f.base, 'outside.bin'); await writeFile(outside, binary); await link(outside, path.join(f.root, 'hard-linked.bin'));
    const configBefore = await readFile(f.configPath), connection = await connect(f.configPath, transport);
    const request = (args: Record<string, unknown>) => connection.client.callTool({ name: 'file_widget_probe', arguments: args });
    try {
      for (const [filename, bytes, mime] of [['图片.png', png, 'image/png'], ['文档.bin', binary, 'application/octet-stream']] as const) {
        const result = await request({ workspace_id: 'default', path: filename, expected_device_id: f.deviceId });
        const data = await localFile(connection.client, result, bytes, filename, f.deviceId, mime);
        assert.equal(data.workspace_id, 'default'); assert.equal(data.workspace_uid, f.config.workspaces[0].uid); assert.equal(data.workspace_name, f.config.workspaces[0].name);
        if (filename === '图片.png') {
          const repeated = await request({ workspace_id: 'default', path: filename, expected_device_id: f.deviceId });
          const again = await localFile(connection.client, repeated, bytes, filename, f.deviceId, mime);
          assert.equal(again.sha256, data.sha256);
          assert.notEqual(again.delivery_id, data.delivery_id, 'Opening the same file again must get a new public delivery identity.');
        }
        assert.deepEqual(await readFile(path.join(f.root, filename)), bytes);
      }
      for (const args of [{ workspace_id: 'default' }, { path: '文档.bin' }, { workspace_id: 'default', path: '文档.bin' }, { workspace_id: 'default', expected_device_id: f.deviceId }, { path: '文档.bin', expected_device_id: f.deviceId }]) denied(await request(args), 'INVALID_ARGUMENT');
      denied(await request({ workspace_id: 'default', path: '文档.bin', expected_device_id: randomUUID() }), 'DEVICE_MISMATCH');
      denied(await request({ expected_device_id: randomUUID() }), 'DEVICE_MISMATCH');
      denied(await request({ workspace_id: 'unregistered', path: '文档.bin', expected_device_id: f.deviceId }), 'WORKSPACE_NOT_FOUND');
      for (const unsafe of ['../config.json', '..\\outside.bin', path.join(f.root, '文档.bin'), '.env', '.codex/auth.json', 'hard-linked.bin']) denied(await request({ workspace_id: 'default', path: unsafe, expected_device_id: f.deviceId }), 'PATH_DENIED');
      denied(await request({ workspace_id: 'default', path: 'not-present.bin', expected_device_id: f.deviceId }), 'NOT_FOUND');
      assert.deepEqual(await readFile(f.configPath), configBefore);
      assert.deepEqual(await readFile(path.join(f.root, '文档.bin')), binary); assert.deepEqual(await readFile(outside), binary);
    } finally { await connection.close(); }
    const database = new DatabaseSync(path.join(f.base, 'state', 'webcodex.sqlite'), { readOnly: true });
    try {
      const errors = database.prepare("SELECT details FROM audit_events WHERE event='tool_error'").all()
        .map(row => JSON.parse(String(row.details)));
      for (const code of ['DEVICE_MISMATCH', 'PATH_DENIED', 'INVALID_ARGUMENT']) {
        assert.ok(errors.some(entry => entry.tool === 'file_widget_probe' && entry.code === code));
      }
      for (const entry of errors) assert.deepEqual(Object.keys(entry).sort(), ['code', 'tool']);
      assert.ok(!JSON.stringify(errors).includes(binary.toString('base64')));
      assert.ok(!JSON.stringify(errors).includes(syntheticConfigKey));
    } finally { database.close(); }
  });
}

test('widget opens exactly 7 MiB with a metadata-sized stdio response and reads private chunks, while larger local files fail without bytes', async t => {
  const f = await fixture(t), boundary = Buffer.alloc(inlineLimit, 0xb7);
  await Promise.all([writeFile(path.join(f.root, 'boundary.bin'), boundary), writeFile(path.join(f.root, 'oversized.bin'), Buffer.alloc(inlineLimit + 1, 0xc6))]);
  const connection = await connect(f.configPath, 'stdio');
  try {
    const result = await connection.client.callTool({ name: 'fs_open_file', arguments: { workspace_id: 'default', path: 'boundary.bin', expected_device_id: f.deviceId } });
    await localFile(connection.client, result, boundary, 'boundary.bin', f.deviceId, 'application/octet-stream');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024, 'Opening a 7 MiB file must not add original bytes to the initial frame.');
    const failure: any = await connection.client.callTool({ name: 'fs_open_file', arguments: { workspace_id: 'default', path: 'oversized.bin', expected_device_id: f.deviceId } });
    denied(failure, 'FILE_TOO_LARGE'); assert.equal(failure.structuredContent.error.details.limit, inlineLimit);
    assert.equal(failure.structuredContent.error.details.size_bytes, inlineLimit + 1);
    assert.deepEqual(await readFile(path.join(f.root, 'boundary.bin')), boundary);
    const after: any = await connection.client.callTool({ name: 'file_widget_probe', arguments: {} });
    assert.equal(after.structuredContent.data.mode, 'capabilities', 'Large-frame errors must leave the MCP connection usable.');
  } finally { await connection.close(); }
});

test('optional widget upload limits load in JSON/TOML, default to 100 MiB and reject values outside 1 byte through 512 MiB', async t => {
  const f = await fixture(t);
  assert.equal(DEFAULT_WIDGET_UPLOAD_BYTES, 100 * 1024 * 1024); assert.equal(MAX_WIDGET_UPLOAD_BYTES, 512 * 1024 * 1024);
  for (const format of ['json', 'toml'] as const) {
    const filename = path.join(f.base, 'limit-check.' + format);
    await writeFile(filename, serializeConfig(f.config, format));
    const omitted = await loadConfig(filename);
    assert.equal(omitted.limits.fileWidgetUploadMaxBytes ?? DEFAULT_WIDGET_UPLOAD_BYTES, 100 * 1024 * 1024);
    for (const size of [1, MAX_WIDGET_UPLOAD_BYTES]) {
      await writeFile(filename, serializeConfig({ ...f.config, limits: { ...f.config.limits, fileWidgetUploadMaxBytes: size } }, format));
      const loaded = await loadConfig(filename);
      assert.equal(loaded.limits.fileWidgetUploadMaxBytes, size); assert.equal(loaded.limits.fileTransferMaxBytes, inlineLimit);
      assert.equal(loaded.execution.mode, 'disabled');
    }
  }
  for (const invalid of [0, -1, MAX_WIDGET_UPLOAD_BYTES + 1, 1.5, '104857600', null]) await assert.rejects(validateConfig({ ...f.config, limits: { ...f.config.limits, fileWidgetUploadMaxBytes: invalid } }, f.configPath), { code: 'CONFIG_ERROR' });
});

test('HTTP widget upload limit below the inline limit is advertised and rejects the complete local file without claiming a host upload', async t => {
  const f = await fixture(t, 1);
  await Promise.all([writeFile(path.join(f.root, 'one.bin'), Buffer.from([0xa7])), writeFile(path.join(f.root, 'two.bin'), Buffer.from([0xa7, 0xb8]))]);
  const connection = await connect(f.configPath, 'http');
  try {
    const capability: any = await connection.client.callTool({ name: 'file_widget_probe', arguments: {} });
    assert.equal(capability.structuredContent.data.max_upload_bytes, 1); assert.equal(capability.structuredContent.data.inline_max_bytes, inlineLimit);
    await localFile(connection.client, await connection.client.callTool({ name: 'file_widget_probe', arguments: { workspace_id: 'default', path: 'one.bin', expected_device_id: f.deviceId } }), Buffer.from([0xa7]), 'one.bin', f.deviceId, 'application/octet-stream');
    const rejected: any = await connection.client.callTool({ name: 'file_widget_probe', arguments: { workspace_id: 'default', path: 'two.bin', expected_device_id: f.deviceId } });
    denied(rejected, 'FILE_TOO_LARGE'); assert.equal(rejected.structuredContent.error.details.limit, 1);
    assert.equal(rejected.structuredContent.error.details.size_bytes, 2);
    assert.deepEqual(await readFile(path.join(f.root, 'two.bin')), Buffer.from([0xa7, 0xb8]));
  } finally { await connection.close(); }
});

test('stdio reports the effective component limit for default inline, smaller upload policy, and smaller snapshot cache', async t => {
  const cases = [
    { inline: undefined, upload: 100 * 1024 * 1024, cache: undefined, effective: 4 * 1024 * 1024, rejected: 8 * 1024 * 1024, code: 'FILE_TOO_LARGE' },
    { inline: inlineLimit, upload: 1024, cache: undefined, effective: 1024, rejected: 1025, code: 'FILE_TOO_LARGE' },
    { inline: inlineLimit, upload: 100 * 1024 * 1024, cache: 512, effective: 512, rejected: 513, code: 'FILE_WIDGET_CACHE_FULL' },
  ];
  for (const item of cases) {
    const f = await fixture(t);
    const limits = { ...f.config.limits, fileTransferMaxBytes: item.inline,
      fileWidgetUploadMaxBytes: item.upload, fileWidgetCacheMaxBytes: item.cache };
    await writeFile(f.configPath, serializeConfig({ ...f.config, limits }, 'json'));
    const accepted = Buffer.alloc(16, 0xa7);
    await writeFile(path.join(f.root, 'small.bin'), accepted);
    await writeFile(path.join(f.root, 'over-limit.bin'), Buffer.alloc(item.rejected, 0xc6));
    const connection = await connect(f.configPath, 'stdio');
    try {
      const capability: any = await connection.client.callTool({ name: 'file_widget_probe', arguments: {} });
      assert.equal(capability.structuredContent.ok, true);
      const reported = capability.structuredContent.data;
      assert.equal(reported.max_upload_bytes, item.upload);
      assert.equal(reported.max_upload_bytes_scope, 'component_upload_policy');
      assert.equal(reported.inline_max_bytes, item.inline ?? 4 * 1024 * 1024);
      assert.equal(reported.snapshot_cache_max_bytes, item.cache ?? 32 * 1024 * 1024);
      assert.equal(reported.effective_local_file_max_bytes, item.effective);
      assert.equal(reported.effective_local_file_limit_scope, 'per_file_with_empty_cache');
      assert.equal(reported.model_access, 'unverified');
      const status: any = await connection.client.callTool({ name: 'system_status', arguments: {} });
      for (const field of ['max_upload_bytes', 'max_upload_bytes_scope', 'inline_max_bytes', 'snapshot_cache_max_bytes', 'effective_local_file_max_bytes', 'effective_local_file_limit_scope']) {
        assert.equal(status.structuredContent.data.file_widget[field], reported[field], `system_status must expose the same ${field} as the component route.`);
      }
      const args = { workspace_id: 'default', path: 'small.bin', expected_device_id: f.deviceId };
      const opened: any = await connection.client.callTool({ name: 'fs_open_file', arguments: args });
      assert.equal(opened.structuredContent.data.effective_local_file_max_bytes, item.effective);
      noBinaryFields(opened);
      await connection.client.callTool({ name: 'file_widget_release', arguments: {
        ticket_id: opened._meta.webcodexDelivery.ticketId, expected_device_id: f.deviceId } });
      const rejected: any = await connection.client.callTool({ name: 'fs_open_file', arguments: { ...args, path: 'over-limit.bin' } });
      denied(rejected, item.code);
      assert.equal(rejected.structuredContent.error.details.effective_local_file_max_bytes, item.effective);
      assert.equal(rejected.structuredContent.error.details.max_upload_bytes, item.upload);
      assert.equal(rejected.structuredContent.error.details.effective_local_file_limit_scope, 'per_file_with_empty_cache');
      if (item.cache) {
        const raw: any = await connection.client.callTool({ name: 'fs_read_file', arguments: { workspace_id: 'default', path: 'over-limit.bin' } });
        assert.equal(raw.structuredContent.ok, true, 'Inline transfer is independent of component cache capacity.');
        assert.equal(raw.structuredContent.data.effective_local_file_max_bytes, inlineLimit);
        assert.equal(raw.structuredContent.data.effective_local_file_limit_scope, 'inline_transfer');
      }
    } finally { await connection.close(); }
  }
});

test('occupied component cache is reported as runtime capacity rather than lowering the static single-file limit', async t => {
  const f = await fixture(t);
  await writeFile(f.configPath, serializeConfig({ ...f.config, limits: { ...f.config.limits, fileWidgetCacheMaxBytes: 16 } }, 'json'));
  await writeFile(path.join(f.root, 'fits.bin'), Buffer.alloc(16, 0xa7));
  const connection = await connect(f.configPath, 'stdio');
  try {
    const args = { workspace_id: 'default', path: 'fits.bin', expected_device_id: f.deviceId };
    const opened: any = await connection.client.callTool({ name: 'fs_open_file', arguments: args });
    assert.equal(opened.structuredContent.data.effective_local_file_max_bytes, 16);
    const blocked: any = await connection.client.callTool({ name: 'fs_open_file', arguments: args });
    denied(blocked, 'FILE_WIDGET_CACHE_FULL');
    assert.equal(blocked.structuredContent.error.details.effective_local_file_max_bytes, 16);
    assert.match(blocked.structuredContent.error.message, /active snapshots can reduce available capacity/);
    await connection.client.callTool({ name: 'file_widget_release', arguments: {
      ticket_id: opened._meta.webcodexDelivery.ticketId, expected_device_id: f.deviceId } });
    const retry: any = await connection.client.callTool({ name: 'fs_open_file', arguments: args });
    assert.equal(retry.structuredContent.ok, true);
    assert.equal(retry.structuredContent.data.effective_local_file_max_bytes, 16);
  } finally { await connection.close(); }
});
