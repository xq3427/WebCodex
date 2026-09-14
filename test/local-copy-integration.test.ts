import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultUnifiedConfig } from '../src/config.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// A valid synthetic PDF with a large comment. No user paper or host file download is used.
function syntheticPdf(size: number): Buffer {
  const render = (padding: number) => {
    let text = '%PDF-1.4\n';
    const offsets = [0];
    const stream = 'BT /F1 18 Tf 40 180 Td (WebCodex local copy acceptance) Tj ET\n';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    for (const [index, object] of objects.entries()) {
      offsets.push(Buffer.byteLength(text));
      text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    text += '%' + 'x'.repeat(padding) + '\n';
    const xrefOffset = Buffer.byteLength(text);
    text += 'xref\n0 6\n0000000000 65535 f \n';
    for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
    text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(text);
  };
  let padding = size - 1000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const bytes = render(padding);
    if (bytes.length === size) return bytes;
    padding += size - bytes.length;
  }
  throw new Error('Synthetic PDF fixture could not reach the requested byte size.');
}

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-local-copy-mcp-'));
  const sourceRoot = path.join(base, '只读论文 source files');
  const targetRoot = path.join(base, '代码项目 target files');
  await Promise.all([mkdir(sourceRoot), mkdir(targetRoot)]);
  const configPath = path.join(base, 'config.json');
  const raw = defaultUnifiedConfig(targetRoot, configPath);
  raw.workspaces.push({ id: 'papers', uid: randomUUID(), name: '只读论文', root: sourceRoot, readOnly: true });
  assert.equal(raw.execution.mode, 'disabled');
  await writeFile(configPath, JSON.stringify(raw));
  const bytes = syntheticPdf(1_610_783), filename = '合成论文 原件.pdf';
  await writeFile(path.join(sourceRoot, filename), bytes);
  const client = new Client({ name: 'local-copy-stdio-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--config', configPath], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  t.after(async () => {
    await client.close();
    const actual = await realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-local-copy-mcp-'));
    await rm(actual, { recursive: true, force: true });
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(JSON.stringify(result).length < 32_768, 'Copy and stat return bounded metadata, not original bytes.');
    return result.structuredContent as any;
  };
  const input = {
    workspace_id: 'default', path: '论文 副本.pdf', source_workspace_id: 'papers', source_path: filename,
    expected_source_sha256: hash(bytes), expected_sha256: null, idempotency_key: 'copy-local-pdf', expected_device_id: raw.device.id,
  };
  return { client, call, input, bytes, sourceRoot, targetRoot, filename };
}

test('stdio copies a 1.6 MiB PDF across Chinese workspace paths with execution disabled and a read-only source', async t => {
  const f = await fixture(t), tools = (await f.client.listTools()).tools;
  assert.equal(tools.length,66);
  const copy = tools.find(tool => tool.name === 'fs_copy');
  assert.ok(copy, 'Local copy is publicly discoverable over MCP.');
  assert.equal(copy.annotations?.readOnlyHint, false);
  for (const required of Object.keys(f.input)) assert.ok(copy.inputSchema.required?.includes(required), required);
  for (const forbidden of ['file', 'download_url', 'content', 'content_base64', 'executable']) {
    assert.ok(!Object.hasOwn(copy.inputSchema.properties ?? {}, forbidden));
  }
  const operation = tools.find(tool => tool.name === 'operation_status');
  assert.ok(operation);
  assert.ok((operation.inputSchema.properties?.tool as { enum?: string[] }).enum?.includes('fs_copy'));
  assert.equal((await f.call('system_status')).data.execution_mode, 'disabled');
  const workspaces = (await f.call('workspace_list')).data.workspaces;
  assert.equal(workspaces.find((workspace: any) => workspace.workspace_id === 'papers').read_only, true);

  const sourceBefore = await f.call('fs_stat', { workspace_id: 'papers', path: f.filename });
  assert.equal(sourceBefore.ok, true);
  assert.equal(sourceBefore.data.size_bytes, f.bytes.length);
  assert.equal(sourceBefore.data.sha256, f.input.expected_source_sha256);
  const saved = await f.call('fs_copy', f.input);
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  assert.equal(saved.data.size_bytes, f.bytes.length);
  assert.equal(saved.data.sha256, sourceBefore.data.sha256);
  assert.equal(saved.data.verified, true);
  assert.equal(typeof saved.data.change_id, 'string');
  assert.deepEqual(await readFile(path.join(f.targetRoot, f.input.path)), f.bytes);
  assert.deepEqual(await readFile(path.join(f.sourceRoot, f.filename)), f.bytes);
  const target = await f.call('fs_stat', { workspace_id: 'default', path: f.input.path });
  assert.equal(target.data.sha256, sourceBefore.data.sha256);
  assert.equal(target.data.size_bytes, sourceBefore.data.size_bytes);

  const status = await f.call('operation_status', {
    workspace_id: 'default', expected_device_id: f.input.expected_device_id, tool: 'fs_copy', idempotency_key: f.input.idempotency_key,
  });
  assert.equal(status.ok, true, JSON.stringify(status.error));
  assert.equal(status.data.stage, 'done');
  assert.equal(status.data.receipt.change_id, saved.data.change_id);
  assert.equal(status.data.receipt.sha256, sourceBefore.data.sha256);
  const beforeRetry = await stat(path.join(f.targetRoot, f.input.path));
  const repeated = await f.call('fs_copy', f.input);
  assert.equal(repeated.ok, true, JSON.stringify(repeated.error));
  assert.equal(repeated.data.change_id, saved.data.change_id);
  assert.equal((await stat(path.join(f.targetRoot, f.input.path))).mtimeMs, beforeRetry.mtimeMs);
  assert.equal((await f.call('changes_list', { workspace_id: 'default' })).data.changes.length, 1);
  assert.equal((await f.call('fs_stat', { workspace_id: 'papers', path: f.filename })).data.sha256, sourceBefore.data.sha256);
});

test('stdio local copy enforces target device and write permissions without creating a destination', async t => {
  const f = await fixture(t);
  const wrongDevice = await f.call('fs_copy', { ...f.input, expected_device_id: randomUUID() });
  assert.equal(wrongDevice.ok, false);
  assert.equal(wrongDevice.error.code, 'DEVICE_MISMATCH');
  await assert.rejects(stat(path.join(f.targetRoot, f.input.path)), { code: 'ENOENT' });
  const readOnly = await f.call('fs_copy', { ...f.input, workspace_id: 'papers', idempotency_key: 'copy-read-only-target' });
  assert.equal(readOnly.ok, false);
  assert.equal(readOnly.error.code, 'READ_ONLY');
  await assert.rejects(stat(path.join(f.sourceRoot, f.input.path)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(f.sourceRoot, f.filename)), f.bytes);
});
