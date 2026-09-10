import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPatch } from 'diff';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultUnifiedConfig } from '../src/config.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const data = (result: any): any => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent?.ok, true);
  return result.structuredContent.data;
};
const tooLarge = (result: any) => {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, 'FILE_TOO_LARGE', JSON.stringify(result));
};

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-patch-contract-'));
  const root = path.join(base, '中文项目'), configPath = path.join(base, 'config.json');
  await mkdir(root);
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic patch contract' });
  raw.limits.writeMaxBytes = 1024;
  await writeFile(configPath, JSON.stringify(raw));
  const client = new Client({ name: 'patch-contract-regression', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--config', configPath], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  t.after(async () => {
    await client.close();
    const resolved = await realpath(base);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('webcodex-patch-contract-'));
    await rm(resolved, { recursive: true, force: true });
  });
  await client.connect(transport);
  const owner = { workspace_id: 'default', expected_device_id: raw.device.id };
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { root, client, owner, call };
}

test('stdio single-file patch accepts the audited 1575-byte diff between 701-byte files at a 1024-byte write limit', async t => {
  const f = await fixture(t), file = 'patch-contract-1024.txt';
  const before = 'A'.repeat(700) + '\n', after = 'B'.repeat(700) + '\n';
  await writeFile(path.join(f.root, file), before);
  const original = data(await f.call('fs_read', { workspace_id: 'default', path: file }));
  const patch = createPatch(file, before, after);
  assert.equal(Buffer.byteLength(before), 701); assert.equal(Buffer.byteLength(after), 701);
  assert.equal(Buffer.byteLength(patch), 1575);
  const input = { ...f.owner, path: file, patch, expected_sha256: original.sha256 };
  const preview = data(await f.call('fs_apply_patch', { ...input, dry_run: true, idempotency_key: 'preview-large-diff' }));
  assert.equal(preview.dry_run, true); assert.equal(preview.change_id, null); assert.equal(preview.sha256, sha(after));
  assert.equal(await readFile(path.join(f.root, file), 'utf8'), before);
  const applied = data(await f.call('fs_apply_patch', { ...input, idempotency_key: 'apply-large-diff' }));
  assert.ok(applied.change_id); assert.equal(applied.sha256, sha(after));
  assert.equal(await readFile(path.join(f.root, file), 'utf8'), after);

  const tools = (await f.client.listTools()).tools;
  assert.equal((tools.find(tool => tool.name === 'fs_apply_patch')!.inputSchema.properties!.patch as any).maxLength, 2048);
  const variants = ((tools.find(tool => tool.name === 'fs_batch_preview')!.inputSchema.properties!.changes as any).items.anyOf as any[]);
  assert.equal(variants.find(entry => entry.properties.op.const === 'patch').properties.patch.maxLength, 2048);
});

test('stdio single and batch patches enforce the final UTF-8 file limit at exactly 1024 bytes', async t => {
  const f = await fixture(t), before = '原文\n';
  const exact = '文'.repeat(341) + '\n', oversized = '文'.repeat(341) + 'a\n';
  assert.equal(Buffer.byteLength(exact), 1024); assert.equal(Buffer.byteLength(oversized), 1025);
  for (const route of ['single', 'batch']) {
    const file = route + '-中文.txt'; await writeFile(path.join(f.root, file), before);
    const rejectedPatch = createPatch(file, before, oversized);
    assert.ok(Buffer.byteLength(rejectedPatch) < 2048, 'Rejection must concern output bytes, not the patch input budget.');
    const rejected = { ...f.owner, path: file, patch: rejectedPatch, expected_sha256: sha(before) };
    if (route === 'single') {
      tooLarge(await f.call('fs_apply_patch', { ...rejected, dry_run: true, idempotency_key: 'output-too-large-preview' }));
      tooLarge(await f.call('fs_apply_patch', { ...rejected, idempotency_key: 'output-too-large-apply' }));
    } else {
      const changes = [{ op: 'patch', path: file, patch: rejectedPatch, expected_sha256: sha(before) }];
      tooLarge(await f.call('fs_batch_preview', { workspace_id: 'default', changes }));
      tooLarge(await f.call('fs_batch_apply', { ...f.owner, changes, expected_plan_sha256: '0'.repeat(64), idempotency_key: 'batch-output-too-large' }));
    }
    assert.equal(await readFile(path.join(f.root, file), 'utf8'), before);
    const patch = createPatch(file, before, exact);
    if (route === 'single') {
      const preview = data(await f.call('fs_apply_patch', { ...rejected, patch, dry_run: true, idempotency_key: 'exact-output-preview' }));
      assert.equal(preview.sha256, sha(exact)); assert.equal(await readFile(path.join(f.root, file), 'utf8'), before);
      data(await f.call('fs_apply_patch', { ...rejected, patch, idempotency_key: 'exact-output-apply' }));
    } else {
      const changes = [{ op: 'patch', path: file, patch, expected_sha256: sha(before) }];
      const preview = data(await f.call('fs_batch_preview', { workspace_id: 'default', changes }));
      const applied = data(await f.call('fs_batch_apply', { ...f.owner, changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'batch-exact-output' }));
      assert.equal(applied.status, 'applied');
    }
    const bytes = await readFile(path.join(f.root, file));
    assert.equal(bytes.length, 1024); assert.equal(bytes.toString('utf8'), exact); assert.equal(sha(bytes), sha(exact));
  }
});

/** Pad a valid optional diff header; changed file contents stay within the write limit. */
function patchAtBytes(file: string, before: string, after: string, bytes: number) {
  const patch = createPatch(file, before, after, 'old', 'new');
  const padding = bytes - Buffer.byteLength(patch);
  assert.ok(padding >= 0);
  const padded = patch.replace('\told\n', '\told' + 'x'.repeat(padding) + '\n');
  assert.equal(Buffer.byteLength(padded), bytes);
  return padded;
}

test('stdio single and batch patches count UTF-8 input bytes rather than UTF-16 string length', async t => {
  const f = await fixture(t), before = '甲'.repeat(300) + '\n', after = '乙'.repeat(300) + '\n';
  assert.equal(Buffer.byteLength(before), 901); assert.equal(Buffer.byteLength(after), 901);
  for (const route of ['single', 'batch']) {
    const file = route + '-utf8.txt'; await writeFile(path.join(f.root, file), before);
    const exact = patchAtBytes(file, before, after, 2048), oversized = patchAtBytes(file, before, after, 2049);
    assert.ok(oversized.length < 2048, 'The character-count schema alone must not be able to enforce this byte boundary.');
    if (route === 'single') {
      const input = { ...f.owner, path: file, expected_sha256: sha(before) };
      tooLarge(await f.call('fs_apply_patch', { ...input, patch: oversized, dry_run: true, idempotency_key: 'utf8-input-too-large-preview' }));
      tooLarge(await f.call('fs_apply_patch', { ...input, patch: oversized, idempotency_key: 'utf8-input-too-large-apply' }));
      assert.equal(await readFile(path.join(f.root, file), 'utf8'), before);
      const preview = data(await f.call('fs_apply_patch', { ...input, patch: exact, dry_run: true, idempotency_key: 'utf8-input-exact-preview' }));
      assert.equal(preview.sha256, sha(after));
      data(await f.call('fs_apply_patch', { ...input, patch: exact, idempotency_key: 'utf8-input-exact-apply' }));
    } else {
      const changes = [{ op: 'patch', path: file, patch: oversized, expected_sha256: sha(before) }];
      tooLarge(await f.call('fs_batch_preview', { workspace_id: 'default', changes }));
      tooLarge(await f.call('fs_batch_apply', { ...f.owner, changes, expected_plan_sha256: '0'.repeat(64), idempotency_key: 'batch-utf8-input-too-large' }));
      assert.equal(await readFile(path.join(f.root, file), 'utf8'), before);
      changes[0].patch = exact;
      const preview = data(await f.call('fs_batch_preview', { workspace_id: 'default', changes }));
      const result = data(await f.call('fs_batch_apply', { ...f.owner, changes, expected_plan_sha256: preview.plan_sha256, idempotency_key: 'batch-utf8-input-exact' }));
      assert.equal(result.status, 'applied');
    }
    const bytes = await readFile(path.join(f.root, file)); assert.equal(bytes.toString('utf8'), after); assert.equal(sha(bytes), sha(after));
  }
});
