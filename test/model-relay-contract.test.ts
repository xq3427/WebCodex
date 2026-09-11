import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, validateConfig } from '../src/config.js';
import { AppError, errorResult } from '../src/errors.js';
import { FILE_ROUTES, MODEL_RELAY_GUIDANCE } from '../src/file-routing.js';
import { hash } from '../src/filesystem.js';
import { createMcpServer } from '../src/server.js';
import { SERVER_INSTRUCTIONS } from '../src/server-instructions.js';

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-model-relay-contract-'));
  const root = path.join(base, 'synthetic-workspace'); await mkdir(root);
  const configPath = path.join(base, 'config.json');
  const app = new App(await validateConfig(defaultUnifiedConfig(root, configPath), configPath));
  const server = createMcpServer(app), client = new Client({ name: 'model-relay-contract', version: '1' });
  t.after(async () => {
    await client.close(); await server.close(); await app.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-model-relay-contract-'));
    await rm(actual, { recursive: true, force: true });
  });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args);
    assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.structuredContent?.ok, true);
    return result.structuredContent.data;
  };
  return { app, root, client, call, raw, owner: { workspace_id: 'default', expected_device_id: app.identity.deviceId } };
}

test('MCP discovery distinguishes configured byte limits from unverified model-mediated file relay', async t => {
  const f = await fixture(t), tools = (await f.client.listTools()).tools, status = await f.call('system_status');
  assert.equal(tools.length, 65);
  for (const capability of [status.capabilities.file_routes.binary, status.capabilities.file_routes.images, status.capabilities.binary_chunk_write]) {
    assert.equal(capability.model_relay_verified, false);
    assert.equal(capability.large_file_model_relay_recommended, false);
    assert.equal(capability.requires_complete_payload_within_host_limits, true);
    assert.equal(capability.server_limit_is_not_host_context_limit, true);
    assert.equal(capability.on_model_output_truncation, 'stop_before_submit');
  }
  assert.equal(status.capabilities.file_routes.binary.default_write, 'fs_save_file');
  assert.equal(status.capabilities.file_routes.binary.default_write_condition, 'actual_host_file_reference_and_original_hash_available');
  assert.equal(status.capabilities.file_routes.binary.chunk_write, 'fs_write_binary_chunk', 'Retain the bounded fallback without promising host relay.');
  assert.equal(status.capabilities.binary_chunk_write.chunk_max_bytes, 65536);
  assert.equal(status.capabilities.binary_chunk_write.max_file_bytes, 33554432);
  const chunkTool = tools.find(tool => tool.name === 'fs_write_binary_chunk')!;
  assert.ok(chunkTool.description!.includes(MODEL_RELAY_GUIDANCE));
  const schema = chunkTool.inputSchema.properties as Record<string, any>;
  assert.equal(schema.content_base64.maxLength, 87384); assert.equal(schema.size_bytes.maximum, 33554432);
  assert.match(chunkTool.description!, /exactly chunk_max_bytes bytes for every non-final chunk/);
  assert.match(tools.find(tool => tool.name === 'fs_import_file')!.description!, /only when complete original bytes and hashes can be relayed without truncation/);
  assert.ok(SERVER_INSTRUCTIONS.length <= 5500);
  assert.match(SERVER_INSTRUCTIONS.slice(0, 512), /fs_save_file using an actual host file reference/);
  assert.match(SERVER_INSTRUCTIONS, /If Code Interpreter truncates output before MCP submission, stop/);
  assert.ok(SERVER_INSTRUCTIONS.includes(MODEL_RELAY_GUIDANCE));
  assert.doesNotMatch(FILE_ROUTES.binary, /Default generated-file writeback/);
  assert.match(FILE_ROUTES.binary, /Never resize, downsample, lower quality, reencode, regenerate or guess bytes/);
  assert.match(FILE_ROUTES.binary, /Only status=saved and verified=true/);
  assert.match(FILE_ROUTES.binary, /destination hash and one key/);
});

test('actual rejected imports return conditional relay recovery without beginning a fallback write', async t => {
  const f = await fixture(t), previous = Buffer.from('Existing synthetic destination must remain unchanged.');
  const relative = 'existing.png'; await writeFile(path.join(f.root, relative), previous);
  for (const [index, download_url] of ['sandbox:/mnt/data/SYNTHETIC.png', 'https://unapproved.example.invalid/SYNTHETIC.png'].entries()) {
    const result = await f.raw('fs_import_file', { ...f.owner, path: relative,
      file: { download_url, file_id: 'SYNTHETIC_ONLY_FILE' }, expected_sha256: hash(previous), idempotency_key: 'denied-relay-' + index });
    assert.equal(result.isError, true);
    const error = result.structuredContent.error;
    assert.equal(error.code, 'FILE_IMPORT_SOURCE_DENIED'); assert.equal(error.retryable, false);
    assert.ok(error.recovery.instruction.includes(MODEL_RELAY_GUIDANCE));
    assert.match(error.recovery.instruction, /Only if complete original slices and hashes fit host output\/tool limits without truncation/);
    assert.ok(!error.recovery.tools.includes('fs_import_file'));
    assert.ok(!JSON.stringify(result).includes(download_url));
  }
  const malformed = errorResult(new AppError('FILE_IMPORT_INVALID_ARGUMENT', 'Synthetic invalid file descriptor.'));
  assert.ok(malformed.error.recovery.instruction.includes(MODEL_RELAY_GUIDANCE));
  assert.match(malformed.error.recovery.instruction, /only available as a fallback when complete original slices and hashes can be relayed as tool arguments without truncation/);
  assert.deepEqual(await readFile(path.join(f.root, relative)), previous);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM binary_input_sessions').get()!.n, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM file_changes').get()!.n, 0);
});

test('guidance changes preserve rejection of incomplete Base64 and undersized non-final chunks', async t => {
  const f = await fixture(t), previous = Buffer.from('Original synthetic target'), whole = Buffer.alloc(131072, 0x79);
  const relative = 'unchanged.png'; await writeFile(path.join(f.root, relative), previous);
  const base = { ...f.owner, path: relative, offset_bytes: 0, size_bytes: whole.length, content_sha256: hash(whole),
    expected_sha256: hash(previous), idempotency_key: 'invalid-original-fragment' };
  const small = whole.subarray(0, 4096);
  for (const content_base64 of ['eXl5[...]', small.toString('base64')]) {
    // Deliberate invalid requests verify the server boundary. This is not a
    // claim that a model can detect or successfully forward a host-truncated payload.
    const result = await f.raw('fs_write_binary_chunk', { ...base, content_base64, chunk_sha256: hash(small) });
    assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'BINARY_CHUNK_INVALID');
  }
  assert.deepEqual(await readFile(path.join(f.root, relative)), previous);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM binary_input_sessions').get()!.n, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM file_operations').get()!.n, 0);
});
