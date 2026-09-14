import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { startHttp } from '../src/http.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type, 'ascii'), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function originalPng() {
  const width = 1024, height = 1024, rowSize = width * 3 + 1, pixels = Buffer.alloc(rowSize * height);
  let seed = 0x573eb831;
  for (let row = 0; row < height; row++) for (let col = 1; col < rowSize; col++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    pixels[row * rowSize + col] = seed & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
  assert.ok(bytes.length > 3 * 1024 * 1024, 'The synthetic original must exercise multi-MiB transfer, not a thumbnail.');
  return { bytes, pixels, width, height, digest: sha(bytes) };
}
const original = originalPng();
function verifyOriginalPng(bytes: Buffer) {
  assert.deepEqual(bytes, original.bytes, 'Every source byte, including PNG metadata and compressed image bytes, must survive unchanged.');
  assert.equal(sha(bytes), original.digest);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks: string[] = [], imageData: Buffer[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(offset + 8 + length), crc32(bytes.subarray(offset + 4, offset + 8 + length)));
    chunks.push(type);
    if (type === 'IHDR') {
      assert.equal(data.readUInt32BE(0), original.width); assert.equal(data.readUInt32BE(4), original.height);
      assert.equal(data[8], 8); assert.equal(data[9], 2);
    }
    if (type === 'IDAT') imageData.push(data);
    offset += 12 + length;
  }
  assert.equal(offset, bytes.length); assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual(inflateSync(Buffer.concat(imageData)), original.pixels, 'Pixel dimensions and every original RGB pixel must be preserved.');
}

async function fixture(t: TestContext, configuredChunkSize?: number) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-large-chunk-rpc-'));
  const root = path.join(base, '可写工作区'), readOnlyRoot = path.join(base, '只读工作区');
  await mkdir(root); await mkdir(readOnlyRoot);
  const configPath = path.join(base, 'config.json'), config = defaultUnifiedConfig(root, configPath);
  config.workspaces.push({ id: 'readonly', uid: randomUUID(), name: 'Read only', root: readOnlyRoot, readOnly: true });
  const raw = configuredChunkSize === undefined ? config : {
    ...config,
    // A large chunk must not be constrained by the unrelated inline/text limits,
    // including the HTTP request body's framing budget.
    limits: { ...config.limits, inlineBinaryWriteMaxBytes: 1024, writeMaxBytes: 1024 },
    binaryInputs: { chunkMaxBytes: configuredChunkSize },
  };
  await writeFile(configPath, JSON.stringify(raw));
  t.after(async () => {
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-large-chunk-rpc-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { root, readOnlyRoot, configPath, deviceId: config.device.id };
}
async function connect(configPath: string, mode: 'stdio' | 'http') {
  const client = new Client({ name: 'large-original-png-writeback-test', version: '1' });
  if (mode === 'stdio') {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--config', configPath], stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    try { await client.connect(transport); } catch (error) { await client.close(); throw error; }
    return { client, close: () => client.close() };
  }
  const app = new App(await loadConfig(configPath)), token = randomUUID() + randomUUID();
  const listener = await startHttp(app, { token, port: 0 });
  const close = async () => { await client.close(); await listener.close(); await app.close(); };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(listener.url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  } catch (error) { await close(); throw error; }
  return { client, close };
}
function successful(result: any) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent?.ok, true);
  return result.structuredContent.data;
}

for (const mode of ['stdio', 'http'] as const) for (const configuredChunkSize of [undefined, 262144]) {
  const chunkSize = configuredChunkSize ?? 65536;
  test(`${mode} writes an unchanged 1024x1024 multi-MiB PNG using ${chunkSize / 1024} KiB binary chunks`, async t => {
    const f = await fixture(t, configuredChunkSize), connection = await connect(f.configPath, mode);
    const raw = (name: string, args: Record<string, unknown> = {}) => connection.client.callTool({ name, arguments: args }) as Promise<any>;
    const call = async (name: string, args: Record<string, unknown> = {}) => successful(await raw(name, args));
    try {
      const tools = (await connection.client.listTools()).tools;
      assert.equal(tools.length,66);
      const chunkTool = tools.find(tool => tool.name === 'fs_write_binary_chunk')!;
      const schema = chunkTool.inputSchema.properties as Record<string, any>;
      assert.equal(schema.content_base64.maxLength, Math.ceil(chunkSize / 3) * 4);
      assert.equal(schema.size_bytes.maximum, 33554432);
      const status = await call('system_status');
      assert.equal(status.execution_mode, 'disabled');
      assert.equal(status.capabilities.binary_chunk_write.chunk_max_bytes, chunkSize);
      assert.equal(status.capabilities.binary_chunk_write.max_file_bytes, 33554432);
      assert.equal(status.capabilities.binary_chunk_write.cache_max_bytes, 67108864);

      const base = { workspace_id: 'default', path: '未经缩小的原图-🙂.png', expected_device_id: f.deviceId,
        content_sha256: original.digest, size_bytes: original.bytes.length, expected_sha256: null, idempotency_key: 'save-original-png' };
      const query = { workspace_id: base.workspace_id, expected_device_id: base.expected_device_id, idempotency_key: base.idempotency_key };
      const make = (offset: number) => {
        const bytes = original.bytes.subarray(offset, offset + chunkSize);
        return { ...base, offset_bytes: offset, content_base64: bytes.toString('base64'), chunk_sha256: sha(bytes) };
      };
      const deviceDenied = await raw('fs_write_binary_chunk', { ...make(0), expected_device_id: randomUUID() });
      assert.equal(deviceDenied.structuredContent.error.code, 'DEVICE_MISMATCH');
      const readOnlyDenied = await raw('fs_write_binary_chunk', { ...make(0), workspace_id: 'readonly' });
      assert.equal(readOnlyDenied.structuredContent.error.code, 'READ_ONLY');
      await assert.rejects(readFile(path.join(f.root, base.path)), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(f.readOnlyRoot, base.path)), { code: 'ENOENT' });

      if (configuredChunkSize === undefined) {
        const inlineDenied = await raw('fs_write_binary', { ...base, content_base64: original.bytes.toString('base64'),
          path: 'inline-must-not-save.png', idempotency_key: 'inline-original-denied' });
        assert.equal(inlineDenied.isError, true, 'A multi-MiB original must not bypass the unchanged 256 KiB inline limit.');
        await assert.rejects(readFile(path.join(f.root, 'inline-must-not-save.png')), { code: 'ENOENT' });
      } else {
        const inlineSchema = tools.find(tool => tool.name === 'fs_write_binary')!.inputSchema.properties as Record<string, any>;
        assert.equal(inlineSchema.size_bytes.maximum, 1024);
      }

      let finalRequest = make(0), saved: any;
      for (let offset = 0; offset < original.bytes.length; offset += chunkSize) {
        const request = make(offset), next = Math.min(offset + chunkSize, original.bytes.length);
        const result = await call('fs_write_binary_chunk', request);
        assert.equal(result.next_offset, next); assert.equal(result.chunk_max_bytes, chunkSize);
        if (next < original.bytes.length) {
          assert.equal(result.status, 'receiving'); assert.equal(result.whole_file_verified, false);
          await assert.rejects(readFile(path.join(f.root, base.path)), { code: 'ENOENT' });
          if (offset === 0) {
            const duplicate = await call('fs_write_binary_chunk', request);
            assert.equal(duplicate.next_offset, next);
            const progress = await call('fs_write_binary_status', query);
            assert.equal(progress.status, 'receiving'); assert.equal(progress.received_bytes, next);
            assert.equal(progress.total_bytes, original.bytes.length);
            assert.ok(!JSON.stringify(progress).includes(request.content_base64));
          }
        } else { saved = result; finalRequest = request; }
      }
      assert.equal(saved.status, 'saved'); assert.equal(saved.verified, true); assert.equal(saved.whole_file_verified, true);
      assert.equal(saved.size_bytes, original.bytes.length); assert.equal(saved.sha256, original.digest);
      verifyOriginalPng(await readFile(path.join(f.root, base.path)));
      const file = await call('fs_stat', { workspace_id: base.workspace_id, path: base.path });
      assert.equal(file.sha256, original.digest); assert.equal(file.size_bytes, original.bytes.length);
      const operation = await call('operation_status', { ...query, tool: 'fs_write_binary' });
      assert.equal(operation.stage, 'done'); assert.equal(operation.receipt.sha256, original.digest);
      assert.equal(operation.current_observation.sha256, original.digest);
      const complete = await call('fs_write_binary_status', query);
      assert.equal(complete.status, 'saved'); assert.equal(complete.receipt.sha256, original.digest);
      const duplicateFinal = await call('fs_write_binary_chunk', finalRequest);
      assert.equal(duplicateFinal.status, 'saved'); assert.equal(duplicateFinal.change_id, saved.change_id);
      verifyOriginalPng(await readFile(path.join(f.root, base.path)));
    } finally { await connection.close(); }
  });
}
