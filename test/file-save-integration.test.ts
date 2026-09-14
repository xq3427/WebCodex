import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, validateConfig } from '../src/config.js';
import { hash } from '../src/filesystem.js';
import { createMcpServer } from '../src/server.js';

const originalSize = 2_341_397;
const syntheticFileId = 'file-SYNTHETIC_SAVE_ONLY_20260911';
const syntheticUrl = 'https://files.oaiusercontent.com/SYNTHETIC_SAVE_ONLY_20260911/original.png?signature=synthetic-private';

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, bytes: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), bytes]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
function syntheticPng(size: number, color = 0x78) {
  const width = 64, height = 64, rowSize = width * 3 + 1, pixels = Buffer.alloc(rowSize * height, color);
  for (let row = 0; row < height; row++) pixels[row * rowSize] = 0;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = pngChunk('IHDR', ihdr), image = pngChunk('IDAT', deflateSync(pixels)), end = pngChunk('IEND', Buffer.alloc(0));
  const paddingSize = size - signature.length - header.length - image.length - end.length - 12;
  assert.ok(paddingSize >= 0);
  // A valid private ancillary chunk sets the exact byte count. The actual image
  // remains a complete, CRC-checked and decompressible PNG, not a fake signature.
  const bytes = Buffer.concat([signature, header, pngChunk('wcTx', Buffer.alloc(paddingSize, color)), image, end]);
  assert.equal(bytes.length, size);
  return { bytes, pixels, width, height, sha256: hash(bytes) };
}
function verifyPng(bytes: Buffer, expected: ReturnType<typeof syntheticPng>) {
  assert.deepEqual(bytes, expected.bytes); assert.equal(hash(bytes), expected.sha256);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const names: string[] = [], imageData: Buffer[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(offset + 8 + length), crc32(bytes.subarray(offset + 4, offset + 8 + length)));
    names.push(type);
    if (type === 'IHDR') {
      assert.equal(data.readUInt32BE(0), expected.width); assert.equal(data.readUInt32BE(4), expected.height);
      assert.equal(data[8], 8); assert.equal(data[9], 2);
    }
    if (type === 'IDAT') imageData.push(data);
    offset += length + 12;
  }
  assert.equal(offset, bytes.length); assert.deepEqual(names, ['IHDR', 'wcTx', 'IDAT', 'IEND']);
  assert.deepEqual(inflateSync(Buffer.concat(imageData)), expected.pixels);
}
function publicMetadata(result: any, secrets: string[] = []) {
  const value = { content: result.content, structuredContent: result.structuredContent };
  const serialized = JSON.stringify(value);
  assert.ok(Buffer.byteLength(serialized) < 32_768, 'The model receives bounded metadata, not the original file or a model-generated Base64 relay.');
  for (const secret of [syntheticFileId, syntheticUrl, ...secrets]) assert.equal(serialized.includes(secret), false, 'Private host file references must not enter model-visible output.');
  const inspect = (object: any) => {
    if (!object || typeof object !== 'object') return;
    for (const [key, child] of Object.entries(object)) {
      assert.ok(!['file_id', 'download_url', 'ticket', 'base64', 'content_base64'].includes(key), key);
      inspect(child);
    }
  };
  inspect(value);
  assert.equal(result.content?.some((item: any) => item.type === 'image' || item.type === 'resource'), false);
}
function success(result: any) {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent?.error));
  assert.equal(result.structuredContent?.ok, true);
  return result.structuredContent.data;
}
function saved(result: any, expected: ReturnType<typeof syntheticPng>) {
  const data = success(result);
  assert.equal(data.status, 'saved'); assert.equal(data.verified, true);
  assert.equal(data.sha256, expected.sha256); assert.equal(data.size_bytes, expected.bytes.length);
  assert.equal(data.receipt.sha256, expected.sha256); assert.equal(data.receipt.size_bytes, expected.bytes.length);
  assert.equal(data.receipt.verified, true);
  return data;
}
async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-file-save-mcp-'));
  const root = path.join(base, '原图回写 workspace'); await mkdir(root);
  const configPath = path.join(base, 'config.json'), config = await validateConfig(defaultUnifiedConfig(root, configPath), configPath);
  const app = new App(config), server = createMcpServer(app), client = new Client({ name: 'file-save-simulated-host', version: '1' });
  t.after(async () => {
    await client.close(); await server.close(); await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-file-save-mcp-'));
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const previous = syntheticPng(2667, 0x28), original = syntheticPng(originalSize), relative = '中文原图 原件.png';
  const destination = path.join(root, relative); await writeFile(destination, previous.bytes);
  const owner = { workspace_id: 'default', expected_device_id: app.identity.deviceId };
  const input = { ...owner, path: relative, file_id: syntheticFileId, size_bytes: original.bytes.length,
    content_sha256: original.sha256, expected_sha256: previous.sha256, idempotency_key: 'save-original-via-private-widget' };
  const query = { ...owner, idempotency_key: input.idempotency_key };
  const unchanged = async (expected = previous) => {
    verifyPng(await readFile(destination), expected);
    const observation = success(await raw('fs_stat', { workspace_id: owner.workspace_id, path: relative }));
    assert.equal(observation.size_bytes, expected.bytes.length); assert.equal(observation.sha256, expected.sha256);
  };
  return { app, client, raw, previous, original, destination, input, owner, query, unchanged };
}

test('file save exposes the optional native file-parameter schema and keeps completion tools component-only', async t => {
  const f = await fixture(t), tools = (await f.client.listTools()).tools;
  assert.equal(tools.length,66);
  const open = tools.find(tool => tool.name === 'fs_save_file')!, status = tools.find(tool => tool.name === 'fs_save_file_status')!;
  assert.ok(open); assert.ok(status); assert.equal(open.annotations?.readOnlyHint, false);
  assert.deepEqual(open._meta?.['openai/fileParams'], ['file']);
  const schema = open.inputSchema.properties?.file as any;
  assert.ok(schema); assert.equal(schema.type, 'object');
  assert.deepEqual(Object.keys(schema.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
  assert.deepEqual(schema.required.slice().sort(), ['download_url', 'file_id']);
  assert.equal(schema.additionalProperties, false);
  assert.ok(!open.inputSchema.required?.includes('file'));
  assert.ok(!open.inputSchema.required?.includes('file_id'));
  for (const key of ['workspace_id', 'path', 'size_bytes', 'content_sha256', 'expected_sha256', 'idempotency_key', 'expected_device_id'])
    assert.ok(open.inputSchema.required?.includes(key), key);
  for (const name of ['file_save_widget_complete', 'file_save_widget_fail']) {
    const tool = tools.find(item => item.name === name)!; assert.ok(tool);
    assert.deepEqual((tool._meta?.ui as any)?.visibility, ['app']);
    assert.equal(tool._meta?.['openai/widgetAccessible'], true);
  }
  const { file_id: _unused, ...withoutSource } = f.input;
  for (const input of [withoutSource, { ...f.input, file: { file_id: syntheticFileId, download_url: syntheticUrl } }]) {
    const rejected = await f.raw('fs_save_file', input); assert.equal(rejected.isError, true);
    publicMetadata(rejected); await f.unchanged();
  }
});

test('private completion saves the exact 2341397-byte PNG through real MCP tools while preserving the old image until commit', async t => {
  const f = await fixture(t);
  let downloads = 0, finishDownload!: () => void, reportStarted!: () => void;
  const started = new Promise<void>(resolve => { reportStarted = resolve; });
  const waiting = new Promise<void>(resolve => { finishDownload = resolve; });
  (f.app.fileImports as any).download = async (url: string, options: { maxBytes: number }) => {
    downloads++; assert.equal(url, syntheticUrl); assert.ok(options.maxBytes >= originalSize);
    reportStarted(); await waiting; return f.original.bytes;
  };
  const opened = await f.raw('fs_save_file', f.input), openedData = success(opened), privateData = opened._meta?.webcodexFileSave;
  assert.ok(privateData); assert.equal(privateData.file_id, syntheticFileId);
  assert.equal(privateData.workspace_id, f.owner.workspace_id); assert.equal(privateData.expected_device_id, f.owner.expected_device_id);
  assert.equal(privateData.idempotency_key, f.input.idempotency_key);
  assert.equal(typeof privateData.ticket, 'string'); assert.ok(privateData.ticket.length >= 32);
  assert.ok(Date.parse(privateData.expires_at) > Date.now());
  assert.notEqual(openedData.status, 'saved'); assert.notEqual(openedData.verified, true);
  publicMetadata(opened, [privateData.ticket]); assert.equal(downloads, 0); await f.unchanged();
  assert.equal(openedData.status_arguments.expected_device_id, f.input.expected_device_id);
  const before = await f.raw(openedData.status_tool, openedData.status_arguments);
  assert.notEqual(success(before).status, 'saved'); publicMetadata(before, [privateData.ticket]);

  const completion = f.raw('file_save_widget_complete', { ticket: privateData.ticket,
    download_url: syntheticUrl, expected_device_id: f.owner.expected_device_id });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([started, completion.then(() => { throw new Error('Completion returned before starting the injected download.'); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The private download did not start.')), 5000); })]);
    await f.unchanged();
  } finally { if (timer) clearTimeout(timer); finishDownload(); }
  const completed = await completion, receipt = saved(completed, f.original);
  publicMetadata(completed, [privateData.ticket]); verifyPng(await readFile(f.destination), f.original);
  const observation = success(await f.raw('fs_stat', { workspace_id: f.owner.workspace_id, path: f.input.path }));
  assert.equal(observation.size_bytes, originalSize); assert.equal(observation.sha256, f.original.sha256);
  const status = await f.raw('fs_save_file_status', f.query);
  assert.equal(saved(status, f.original).receipt.change_id, receipt.receipt.change_id); publicMetadata(status, [privateData.ticket]);
  const repeated = await f.raw('fs_save_file', f.input);
  assert.equal(saved(repeated, f.original).receipt.change_id, receipt.receipt.change_id); publicMetadata(repeated, [privateData.ticket]);
  assert.equal(downloads, 1, 'An identical public retry must return the verified receipt without another download or write.');
});

test('native file objects need only file_id and download_url and preserve exact PNG bytes without a model Base64 relay', async t => {
  const f = await fixture(t); let downloads = 0;
  (f.app.fileImports as any).download = async (url: string) => { downloads++; assert.equal(url, syntheticUrl); return f.original.bytes; };
  const { file_id: _unused, ...input } = f.input;
  const result = await f.raw('fs_save_file', { ...input, file: { file_id: syntheticFileId, download_url: syntheticUrl } });
  saved(result, f.original); publicMetadata(result); assert.equal(downloads, 1);
  verifyPng(await readFile(f.destination), f.original);
  saved(await f.raw('fs_save_file_status', f.query), f.original);
});

for (const mismatch of ['source-sha256', 'source-size'] as const) test(`private completion rejects ${mismatch} without changing the existing PNG`, async t => {
  const f = await fixture(t), wrongOriginal = syntheticPng(originalSize, 0x93);
  (f.app.fileImports as any).download = async () => mismatch === 'source-sha256' ? wrongOriginal.bytes : f.original.bytes;
  const opened = await f.raw('fs_save_file', mismatch === 'source-size' ? { ...f.input, size_bytes: originalSize + 1 } : f.input);
  success(opened); const ticket = opened._meta?.webcodexFileSave?.ticket; assert.equal(typeof ticket, 'string');
  const rejected = await f.raw('file_save_widget_complete', { ticket, download_url: syntheticUrl, expected_device_id: f.owner.expected_device_id });
  const failure = success(rejected);
  assert.equal(failure.status, 'failed'); assert.equal(failure.error_code, 'FILE_IMPORT_ORIGINAL_MISMATCH');
  assert.notEqual(failure.verified, true); assert.equal(failure.receipt, undefined);
  publicMetadata(rejected, [ticket]); await f.unchanged();
  const status = await f.raw('fs_save_file_status', f.query);
  assert.equal(success(status).status, 'failed'); assert.equal(success(status).error_code, 'FILE_IMPORT_ORIGINAL_MISMATCH'); publicMetadata(status, [ticket]);
  const changes = success(await f.raw('changes_list', { workspace_id: f.owner.workspace_id }));
  assert.equal(changes.changes.length, 0);
});

for (const edited of ['before-download', 'during-download'] as const) test(`private completion rechecks expected_sha256 when edited ${edited} and leaves the newer PNG intact`, async t => {
  const f = await fixture(t), changed = syntheticPng(3117, 0x59);
  let downloads = 0;
  (f.app.fileImports as any).download = async () => {
    downloads++;
    if (edited === 'during-download') await writeFile(f.destination, changed.bytes);
    return f.original.bytes;
  };
  const opened = await f.raw('fs_save_file', f.input); success(opened);
  const ticket = opened._meta?.webcodexFileSave?.ticket; assert.equal(typeof ticket, 'string');
  if (edited === 'before-download') await writeFile(f.destination, changed.bytes);
  const rejected = await f.raw('file_save_widget_complete', { ticket, download_url: syntheticUrl, expected_device_id: f.owner.expected_device_id });
  const failure = success(rejected);
  assert.equal(failure.status, 'failed'); assert.equal(failure.error_code, 'VERSION_CONFLICT');
  assert.notEqual(failure.verified, true); assert.equal(failure.receipt, undefined);
  assert.equal(downloads, edited === 'before-download' ? 0 : 1);
  publicMetadata(rejected, [ticket]); await f.unchanged(changed);
  const status = await f.raw('fs_save_file_status', f.query);
  assert.equal(success(status).status, 'failed'); assert.equal(success(status).error_code, 'VERSION_CONFLICT'); publicMetadata(status, [ticket]);
});
