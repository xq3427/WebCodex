import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultUnifiedConfig, validateConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { createMcpServer } from '../src/server.js';
import { FileImportService } from '../src/file-import.js';
import { AppError } from '../src/errors.js';
import { hash } from '../src/filesystem.js';
import type { downloadChatGptFile } from '../src/file-download.js';

const source = { download_url: 'https://files.oaiusercontent.com/test?sig=SYNTHETIC-IMPORT-SECRET', file_id: 'file-SYNTHETIC-PRIVATE-ID' };
const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

async function fixture(t: TestContext, download: typeof downloadChatGptFile = async () => binary) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-import-'));
  const root = path.join(base, '论文 workspace'); await mkdir(root);
  const configPath = path.join(base, 'config.json');
  const config = await validateConfig(defaultUnifiedConfig(root, configPath), configPath);
  const app = new App(config), service = new FileImportService(app.ctx, app.files, download);
  t.after(async () => {
    await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-import-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { app, service, root, config, request: { workspace_id: 'default', path: '论文重点.pptx', file: source, expected_sha256: null, idempotency_key: 'import-test' } };
}

test('host file objects save exact bytes once; receipts and durable diagnostics contain no source credentials', async t => {
  let downloads = 0;
  const f = await fixture(t, async (url, options) => { downloads++; assert.equal(url, source.download_url); assert.equal(options.maxBytes, 33554432); return binary; });
  const receipt = await f.service.import(f.request);
  assert.equal(receipt.verified, true); assert.equal(receipt.size_bytes, binary.length);
  assert.equal(receipt.sha256, hash(binary)); assert.equal(receipt.content_processing, 'none');
  assert.deepEqual(await readFile(path.join(f.root, f.request.path)), binary);
  assert.deepEqual(await f.service.import(f.request), receipt); assert.equal(downloads, 1);
  const diagnostic = JSON.stringify({ receipt, operations: f.app.store.db.prepare('SELECT * FROM operations').all(), file_operations: f.app.store.db.prepare('SELECT * FROM file_operations').all(), audit: f.app.store.db.prepare('SELECT * FROM audit_events').all() });
  for (const privatePart of ['SYNTHETIC-IMPORT-SECRET', source.download_url, source.file_id]) assert.ok(!diagnostic.includes(privatePart));
  await assert.rejects(f.service.import({ ...f.request, file: { ...source, file_id: 'another-file' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(downloads, 1);
});

test('policy and malformed references fail before downloading; filename metadata never controls destination', async t => {
  let downloads = 0;
  const f = await fixture(t, async () => { downloads++; return binary; });
  for (const file of [undefined, 'sandbox:/mnt/data/test.pptx', { file_id: 'file-x' }]) {
    await assert.rejects(f.service.import({ ...f.request, file: file as never }), { code: 'FILE_IMPORT_INVALID_ARGUMENT' });
  }
  for (const target of ['../escape.pptx', '.env', path.join(f.root, 'absolute.pptx')]) await assert.rejects(f.service.import({ ...f.request, path: target }), { code: 'PATH_DENIED' });
  await assert.rejects(f.service.import({ ...f.request, path: 'missing/child.pptx' }), { code: 'ENOENT' });
  f.config.workspaces[0].readOnly = true; f.app.ctx.config.workspaces[0].readOnly = true;
  await assert.rejects(f.service.import(f.request), { code: 'READ_ONLY' });
  assert.equal(downloads, 0);
  f.config.workspaces[0].readOnly = false; f.app.ctx.config.workspaces[0].readOnly = false;
  const saved = await f.service.import({ ...f.request, file: { ...source, file_name: '../../untrusted.exe' } });
  assert.equal(saved.path, f.request.path); assert.deepEqual(await readdir(f.root), [f.request.path]);
});

test('failed and oversized downloads never create or replace the destination', async t => {
  const f = await fixture(t, async () => { throw new AppError('FILE_IMPORT_DOWNLOAD_FAILED', 'Synthetic download failed.'); });
  await writeFile(path.join(f.root, f.request.path), binary);
  await assert.rejects(f.service.import({ ...f.request, expected_sha256: hash(binary) }), { code: 'FILE_IMPORT_DOWNLOAD_FAILED' });
  assert.deepEqual(await readFile(path.join(f.root, f.request.path)), binary);
  assert.equal((await f.app.files.changesList({ workspace_id: 'default' })).changes.length, 0);
  const oversized = new FileImportService(f.app.ctx, f.app.files, async () => Buffer.alloc(2048));
  f.app.ctx.config.limits.binaryWriteMaxBytes = 1024;
  await assert.rejects(oversized.import({ ...f.request, path: 'large.pptx', idempotency_key: 'too-large' }), { code: 'FILE_TOO_LARGE' });
  assert.deepEqual(await readdir(f.root), [f.request.path]);
});

test('an external edit while the file downloads causes a conflict, preserving that edit', async t => {
  let release!: (bytes: Buffer) => void, entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, () => { entered(); return new Promise(resolve => { release = resolve; }); });
  await writeFile(path.join(f.root, f.request.path), binary);
  const pending = f.service.import({ ...f.request, expected_sha256: hash(binary) });
  await began;
  const external = Buffer.from('External editor'); await writeFile(path.join(f.root, f.request.path), external);
  release(binary); await assert.rejects(pending, { code: 'VERSION_CONFLICT' });
  assert.deepEqual(await readFile(path.join(f.root, f.request.path)), external);
});

test('concurrent identical imports share one download; a different import is bounded', async t => {
  let release!: (bytes: Buffer) => void, entered!: () => void, downloads = 0;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, () => { downloads++; entered(); return new Promise(resolve => { release = resolve; }); });
  const first = f.service.import(f.request); await began;
  const retry = f.service.import(f.request);
  await assert.rejects(f.service.import({ ...f.request, path: 'second.pptx', idempotency_key: 'second' }), { code: 'FILE_IMPORT_BUSY' });
  release(binary); assert.deepEqual(await retry, await first); assert.equal(downloads, 1);
});

test('MCP advertises official fileParams schema and gates device, then imports and stats a binary with execution disabled', async t => {
  let downloads = 0;
  const f = await fixture(t, async () => { downloads++; return binary; });
  t.mock.method(f.app.fileImports, 'import', f.service.import.bind(f.service));
  const server = createMcpServer(f.app), client = new Client({ name: 'binary-writeback-acceptance', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  const tool = tools.find(tool => tool.name === 'fs_import_file')!;
  assert.deepEqual(tool._meta?.['openai/fileParams'], ['file']);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  const schema = tool.inputSchema.properties!.file as any;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
  assert.deepEqual(schema.required.sort(), ['download_url', 'file_id']);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>;
  const wrong = await call('fs_import_file', { ...f.request, expected_device_id: randomUUID() });
  assert.equal(wrong.structuredContent.error.code, 'DEVICE_MISMATCH'); assert.equal(downloads, 0);
  const missing = await call('fs_import_file', f.request); assert.equal(missing.isError, true); assert.equal(downloads, 0);
  const saved = await call('fs_import_file', { ...f.request, expected_device_id: f.app.identity.deviceId });
  assert.equal(saved.structuredContent.ok, true); assert.equal(saved.structuredContent.data.verified, true);
  const observed = await call('fs_stat', { workspace_id: 'default', path: f.request.path });
  assert.equal(observed.structuredContent.data.sha256, saved.structuredContent.data.sha256);
  assert.equal(observed.structuredContent.data.size_bytes, binary.length);
  assert.equal(f.config.execution.mode, 'disabled');
  assert.equal(f.app.status().capabilities.binary_file_import.host_verified, false);
});

test('binary import limits are configurable and independently bounded for portable configs', async t => {
  const f = await fixture(t);
  for (const limit of [1024, 32 * 1024 * 1024, 128 * 1024 * 1024]) {
    const config = await validateConfig({ ...defaultUnifiedConfig(f.root, f.config.configPath), limits: { binaryWriteMaxBytes: limit } }, f.config.configPath);
    assert.equal(config.limits.binaryWriteMaxBytes, limit); assert.equal(config.limits.writeMaxBytes, 1048576);
  }
  for (const invalid of [0, 1023, 134217729, 1.5, '33554432']) await assert.rejects(validateConfig({ ...defaultUnifiedConfig(f.root, f.config.configPath), limits: { binaryWriteMaxBytes: invalid } }, f.config.configPath), { code: 'CONFIG_ERROR' });
});
