import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultUnifiedConfig, loadConfig, validateConfig } from '../src/config.js';
import { serializeConfig } from '../src/config-format.js';
import { App } from '../src/app.js';
import { startHttp } from '../src/http.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-transfer-mcp-'));
  const root = path.join(base, '论文 files'); await mkdir(root);
  const configPath = path.join(base, 'config.json');
  const raw = defaultUnifiedConfig(root, configPath);
  const config = { ...raw, limits: { ...raw.limits, fileTransferMaxBytes: 7 * 1024 * 1024 } };
  await writeFile(configPath, JSON.stringify(config));
  t.after(async () => {
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('webcodex-transfer-mcp-'));
    await rm(actual, { recursive: true, force: true });
  });
  return { root, configPath, config };
}
async function connect(configPath: string, mode: 'stdio' | 'http') {
  const client = new Client({ name: 'original-file-transfer-test', version: '1' });
  if (mode === 'stdio') {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--config', configPath], stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    return { client, close: () => client.close() };
  }
  const app = new App(await loadConfig(configPath)), token = randomUUID() + randomUUID();
  const http = await startHttp(app, { token, port: 0 });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  return { client, close: async () => { await client.close(); await http.close(); await app.close(); } };
}
function transferred(result: any, original: Buffer) {
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  const data = result.structuredContent.data;
  assert.equal(data.complete, true); assert.equal(data.size_bytes, original.length); assert.equal(data.sha256, sha(original));
  assert.equal(result.content.length, 2, 'Metadata and one native content item; no duplicated binary in JSON.');
  const native = result.content[1];
  const encoded = native.type === 'image' ? native.data : native.resource.blob;
  assert.equal(typeof encoded, 'string'); assert.deepEqual(Buffer.from(encoded, 'base64'), original);
  assert.equal(native.type === 'image' ? native.mimeType : native.resource.mimeType, data.mime_type);
  assert.ok(!Object.hasOwn(data, 'blob')); assert.ok(!Object.hasOwn(data, 'content'));
  if (encoded.length > 100) assert.ok(!result.content[0].text.includes(encoded));
  return { data, native };
}

for (const transport of ['stdio', 'http'] as const) test(`${transport} returns original file bytes as native MCP content without decoding or duplicating them`, async t => {
  const f = await fixture(t), connection = await connect(f.configPath, transport);
  try {
    const tools = (await connection.client.listTools()).tools;
    assert.equal(tools.length,72);
    assert.equal(tools.find(tool => tool.name === 'fs_read_file')?.annotations?.readOnlyHint, true);
    const bytes = Buffer.concat([Buffer.from([0, 255, 254, 128, 13, 10]), Buffer.from('中文\0\r\n')]);
    // These extensions test byte transport, not whether a document parser accepts the fixture.
    for (const name of ['原稿.pdf', '文档.docx', '数据.xlsx', '汇报.pptx', 'archive.zip', 'unknown.bin', 'old-encoding.txt']) {
      await writeFile(path.join(f.root, name), bytes);
      const result = await connection.client.callTool({ name: 'fs_read_file', arguments: { workspace_id: 'default', path: name } });
      const { native } = transferred(result, bytes); assert.equal(native.type, 'resource');
      assert.deepEqual(await readFile(path.join(f.root, name)), bytes);
    }
    await writeFile(path.join(f.root, 'image.png'), png);
    const image = transferred(await connection.client.callTool({ name: 'fs_read_file', arguments: { workspace_id: 'default', path: 'image.png' } }), png);
    assert.equal(image.native.type, 'image');
    await writeFile(path.join(f.root, 'code.txt'), 'line one\r\nline two\r\n');
    const read: any = await connection.client.callTool({ name: 'fs_read', arguments: { workspace_id: 'default', path: 'code.txt', start_line: 2, end_line: 2 } });
    assert.equal(read.structuredContent.ok, true); assert.equal(read.structuredContent.data.content, 'line two\r\n');
    const denied: any = await connection.client.callTool({ name: 'fs_read_file', arguments: { workspace_id: 'default', path: '../config.json' } });
    assert.equal(denied.isError, true); assert.equal(denied.content.length, 1);
    assert.equal(denied.structuredContent.error.code, 'PATH_DENIED');
  } finally { await connection.close(); }
});

test('complete 7 MiB transfer fits the default SDK stdio frame limit; larger files fail without partial content', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(7 * 1024 * 1024, 0xa7);
  await writeFile(path.join(f.root, 'boundary.bin'), bytes);
  await writeFile(path.join(f.root, 'oversized.bin'), Buffer.alloc(bytes.length + 1));
  const connection = await connect(f.configPath, 'stdio');
  try {
    transferred(await connection.client.callTool({ name: 'fs_read_file', arguments: { workspace_id: 'default', path: 'boundary.bin' } }), bytes);
    const denied: any = await connection.client.callTool({ name: 'fs_read_file', arguments: { workspace_id: 'default', path: 'oversized.bin' } });
    assert.equal(denied.isError, true); assert.equal(denied.content.length, 1);
    assert.equal(denied.structuredContent.error.code, 'FILE_TOO_LARGE');
    assert.equal(denied.structuredContent.data, undefined);
  } finally { await connection.close(); }
});

test('JSON and TOML accept the independent transfer limit and reject values exceeding the framing budget', async t => {
  const f = await fixture(t);
  for (const extension of ['json', 'toml'] as const) {
    const filename = f.configPath.replace(/\.json$/, '.' + extension);
    await writeFile(filename, serializeConfig(f.config, extension));
    const loaded = await loadConfig(filename);
    assert.equal(loaded.limits.fileTransferMaxBytes, 7 * 1024 * 1024);
  }
  for (const invalid of [0, -1, 7 * 1024 * 1024 + 1, 1.5, '4194304']) {
    await assert.rejects(validateConfig({ ...f.config, limits: { ...f.config.limits, fileTransferMaxBytes: invalid } }, f.configPath), { code: 'CONFIG_ERROR' });
  }
});
