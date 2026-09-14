import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import dns from 'node:dns/promises';
import https from 'node:https';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, validateConfig } from '../src/config.js';
import { hash } from '../src/filesystem.js';
import { createMcpServer } from '../src/server.js';

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, bytes: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), bytes]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
function syntheticPng(width: number, height: number, targetSize: number, noise: boolean) {
  const rowSize = width * 3 + 1, pixels = Buffer.alloc(rowSize * height);
  let seed = 0x26c984ed;
  for (let row = 0; row < height; row++) for (let col = 1; col < rowSize; col++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    pixels[row * rowSize + col] = noise ? seed & 0xff : 0x78;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = chunk('IHDR', ihdr), image = chunk('IDAT', deflateSync(pixels)), end = chunk('IEND', Buffer.alloc(0));
  const paddingSize = targetSize - signature.length - header.length - image.length - end.length - 12;
  assert.ok(paddingSize >= 0);
  // A private ancillary chunk makes both synthetic PNGs exactly the reported
  // byte counts without using the user's file, hash, or original image content.
  const padding = chunk('wcTx', Buffer.alloc(paddingSize, 0xa5));
  const bytes = Buffer.concat([signature, header, padding, image, end]);
  assert.equal(bytes.length, targetSize);
  return { bytes, pixels, width, height, sha256: hash(bytes) };
}
function verifyPng(actual: Buffer, expected: ReturnType<typeof syntheticPng>) {
  assert.deepEqual(actual, expected.bytes); assert.equal(hash(actual), expected.sha256);
  assert.deepEqual(actual.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const names: string[] = [], imageData: Buffer[] = [];
  let offset = 8;
  while (offset < actual.length) {
    const size = actual.readUInt32BE(offset), type = actual.subarray(offset + 4, offset + 8).toString('ascii');
    const data = actual.subarray(offset + 8, offset + 8 + size);
    assert.equal(actual.readUInt32BE(offset + 8 + size), crc32(actual.subarray(offset + 4, offset + 8 + size)));
    names.push(type);
    if (type === 'IHDR') {
      assert.equal(data.readUInt32BE(0), expected.width); assert.equal(data.readUInt32BE(4), expected.height);
      assert.equal(data[8], 8); assert.equal(data[9], 2);
    }
    if (type === 'IDAT') imageData.push(data);
    offset += size + 12;
  }
  assert.equal(offset, actual.length); assert.deepEqual(names, ['IHDR', 'wcTx', 'IDAT', 'IEND']);
  assert.deepEqual(inflateSync(Buffer.concat(imageData)), expected.pixels);
}

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-import-chunk-recovery-'));
  const root = path.join(base, '合成图片'); await mkdir(root);
  const configPath = path.join(base, 'config.json'), config = await validateConfig(defaultUnifiedConfig(root, configPath), configPath);
  const app = new App(config), server = createMcpServer(app), client = new Client({ name: 'import-chunk-recovery', version: '1' });
  t.after(async () => {
    await client.close(); await server.close(); await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-import-chunk-recovery-'));
    await rm(actual, { recursive: true, force: true });
  });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args);
    assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.structuredContent?.ok, true);
    return result.structuredContent.data;
  };
  return { app, root, client, raw, call };
}

for (const scenario of [
  { reason: 'host_not_allowed', url: 'https://unapproved.example.invalid/SYNTHETIC_ONLY_ORIGINAL.png' },
  { reason: 'sandbox_reference', url: 'sandbox:/mnt/data/SYNTHETIC_ONLY_ORIGINAL.png' },
] as const) test(`an import rejected for ${scenario.reason} preserves the old PNG before a separate original-byte transfer overwrites and restores it`, async t => {
  const f = await fixture(t), original = syntheticPng(1024, 500, 1565188, true), previous = syntheticPng(64, 64, 2667, false);
  t.mock.method(dns, 'lookup', async () => { assert.fail('Rejected import references must not perform a DNS lookup.'); });
  t.mock.method(https, 'request', () => { assert.fail('Rejected import references must not perform a network request.'); });
  const relative = '原图回写-合成验收.png', destination = path.join(f.root, relative);
  await writeFile(destination, previous.bytes);
  const owner = { workspace_id: 'default', expected_device_id: f.app.identity.deviceId };
  const importKey = 'rejected-import', transferKey = 'original-bytes-after-rejected-import';
  const source = { download_url: scenario.url, file_id: 'SYNTHETIC_ONLY_FILE' };
  const denied = await f.raw('fs_import_file', { ...owner, path: relative, file: source,
    expected_sha256: previous.sha256, idempotency_key: importKey });
  assert.equal(denied.isError, true);
  const error = denied.structuredContent.error;
  assert.equal(error.code, 'FILE_IMPORT_SOURCE_DENIED'); assert.equal(error.retryable, false);
  assert.equal(error.details.stage, 'source_url'); assert.equal(error.details.reason, scenario.reason);
  assert.match(error.message, /fs_import_file/); assert.match(error.message, /download/i);
  for (const tool of ['operation_status', 'system_status', 'fs_stat', 'fs_write_binary_chunk']) assert.ok(error.recovery.tools.includes(tool), tool);
  assert.ok(!error.recovery.tools.includes('fs_import_file'), 'Recovery must not recommend repeating the rejected import route.');
  assert.match(error.recovery.instruction, /(?:unavailable|cannot access|inaccessible)/i);
  for (const privateValue of [source.download_url, source.file_id]) assert.ok(!JSON.stringify(denied).includes(privateValue));
  const failed = await f.call('operation_status', { ...owner, tool: 'fs_import_file', idempotency_key: importKey });
  assert.equal(failed.stage, 'failed'); assert.equal(failed.retryable, false); assert.equal(failed.receipt, null);
  assert.equal(failed.content_bytes, null); assert.equal(failed.content_sha256, null); assert.deepEqual(failed.changes, []);
  assert.equal(failed.error.code, 'FILE_IMPORT_SOURCE_DENIED');
  assert.deepEqual(await readFile(destination), previous.bytes);
  assert.equal((await f.call('changes_list', { workspace_id: owner.workspace_id })).changes.length, 0);

  // Reading error recovery and metadata cannot create a source or alter a file.
  // Only the independently available synthetic original below supplies bytes.
  const tools = (await f.client.listTools()).tools; assert.equal(tools.length,66);
  const status = await f.call('system_status');
  assert.equal(status.capabilities.file_routes.binary.default_write, 'fs_save_file');
  assert.equal(status.capabilities.file_routes.binary.chunk_write, 'fs_write_binary_chunk');
  assert.equal(status.capabilities.binary_chunk_write.chunk_max_bytes, 65536);
  assert.ok(status.capabilities.binary_chunk_write.max_file_bytes >= original.bytes.length);
  assert.equal(status.execution_mode, 'disabled');
  const oldStat = await f.call('fs_stat', { workspace_id: owner.workspace_id, path: relative });
  assert.equal(oldStat.sha256, previous.sha256); assert.equal(oldStat.size_bytes, 2667);
  assert.deepEqual(await readFile(destination), previous.bytes);
  const query = { ...owner, idempotency_key: transferKey };
  const base = { ...query, path: relative, expected_sha256: oldStat.sha256, content_sha256: original.sha256, size_bytes: original.bytes.length };
  let saved: any, count = 0;
  for (let offset = 0; offset < original.bytes.length; offset += 65536) {
    const bytes = original.bytes.subarray(offset, offset + 65536);
    const result = await f.call('fs_write_binary_chunk', { ...base, offset_bytes: offset, content_base64: bytes.toString('base64'), chunk_sha256: hash(bytes) });
    count++; assert.equal(result.next_offset, offset + bytes.length);
    if (offset + bytes.length < original.bytes.length) {
      assert.equal(result.status, 'receiving'); assert.equal(result.whole_file_verified, false);
      assert.deepEqual(await readFile(destination), previous.bytes, 'Staging must preserve the existing thumbnail until the verified final commit.');
    } else { saved = result; assert.equal(bytes.length, 57860); }
  }
  assert.equal(count, 24); assert.equal(saved.status, 'saved'); assert.equal(saved.verified, true);
  assert.equal(saved.whole_file_verified, true); assert.equal(saved.sha256, original.sha256); assert.equal(saved.size_bytes, 1565188);
  verifyPng(await readFile(destination), original);
  const finalStat = await f.call('fs_stat', { workspace_id: owner.workspace_id, path: relative });
  assert.equal(finalStat.sha256, original.sha256); assert.equal(finalStat.size_bytes, original.bytes.length);
  const operation = await f.call('operation_status', { ...query, tool: 'fs_write_binary' });
  assert.equal(operation.stage, 'done'); assert.equal(operation.receipt.sha256, original.sha256);
  assert.equal(operation.changes.length, 1); assert.equal(operation.changes[0].change_id, saved.change_id);
  const completed = await f.call('fs_write_binary_status', query);
  assert.equal(completed.status, 'saved'); assert.equal(completed.receipt.verified, true);
  assert.equal(completed.receipt.sha256, original.sha256);
  const imported = await f.call('operation_status', { ...owner, tool: 'fs_import_file', idempotency_key: importKey });
  assert.equal(imported.stage, 'failed'); assert.deepEqual(imported.changes, []);
  assert.equal(imported.current_observation.sha256, original.sha256, 'Current file observations must be distinct from the failed import receipt.');

  const preview = await f.call('changes_preview', { workspace_id: owner.workspace_id, change_id: saved.change_id });
  assert.equal(preview.diff_kind, 'binary'); assert.equal(preview.operation, 'modify');
  assert.equal(preview.current_sha256, original.sha256); assert.equal(preview.restore_sha256, previous.sha256);
  assert.equal(preview.current_size_bytes, 1565188); assert.equal(preview.restore_size_bytes, 2667);
  const restored = await f.call('changes_restore', { ...owner, change_id: saved.change_id, expected_sha256: original.sha256, idempotency_key: 'restore-previous-synthetic-png' });
  assert.equal(restored.verified, true); assert.equal(restored.sha256, previous.sha256); assert.equal(restored.size_bytes, 2667);
  verifyPng(await readFile(destination), previous);
});
