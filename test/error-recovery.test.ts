import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/app.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { AppError, errorResult } from '../src/errors.js';
import { createMcpServer } from '../src/server.js';

async function fixture(t: TestContext) {
  const parent = await fs.realpath(tmpdir());
  const base = await fs.mkdtemp(path.join(parent, 'webcodex-error-recovery-'));
  const root = path.join(base, 'project 中文');
  const readOnly = path.join(base, 'read-only');
  const offline = path.join(base, 'offline');
  const disabled = path.join(base, 'disabled');
  await Promise.all([root, readOnly, offline, disabled].map(directory => fs.mkdir(directory)));
  const configPath = path.join(base, 'config.json');
  const raw = defaultUnifiedConfig(root, configPath, { deviceName: 'Synthetic error recovery device' });
  const configured = {
    ...raw,
    workspaces: [
      ...raw.workspaces,
      { id: 'read-only', uid: randomUUID(), name: 'Read-only fixture', root: readOnly, readOnly: true },
      { id: 'offline', uid: randomUUID(), name: 'Offline fixture', root: offline, readOnly: false, onUnavailable: 'skip' },
      { id: 'disabled', uid: randomUUID(), name: 'Disabled fixture', root: disabled, readOnly: false, enabled: false },
    ],
  };
  await fs.writeFile(configPath, JSON.stringify(configured));
  await fs.writeFile(path.join(root, 'existing.txt'), 'original fixture\n');
  const app = new App(await loadConfig(configPath));
  const server = createMcpServer(app);
  const client = new Client({ name: 'error-recovery-protocol-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
    await app.close();
    const actual = await fs.realpath(base);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('webcodex-error-recovery-'));
    await fs.rm(actual, { recursive: true, force: true });
  });
  const call = (name: string, input: Record<string, unknown>) => client.callTool({ name, arguments: input });
  const owner = { workspace_id: 'default', expected_device_id: raw.device.id };
  return { base, root, offline, app, client, call, owner };
}

function rejected(result: any, code: string) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.ok, false);
  const error = result.structuredContent.error;
  assert.equal(error.code, code);
  assert.equal(error.retryable, false);
  assert.equal(typeof error.recovery.action, 'string');
  assert.equal(typeof error.recovery.instruction, 'string');
  assert.ok(Array.isArray(error.recovery.tools));
  const text = result.content.find((item: any) => item.type === 'text').text;
  assert.deepEqual(JSON.parse(text).error.recovery, error.recovery);
  return error;
}

test('unclassified native errors do not guess missing parents or export paths and diagnostics', () => {
  const privateMarker = 'SYNTHETIC_PRIVATE_PATH_AND_TOKEN';
  for (const nativeCode of ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'unknown', '__proto__', 'constructor', 'toString']) {
    const native = Object.assign(new Error(privateMarker), { code: nativeCode, path: 'C:\\' + privateMarker, details: { reason: 'parent_not_found', privateMarker } });
    const result = errorResult(native);
    assert.equal(result.error.reason, undefined, 'Generic errors cannot claim path traversal evidence.');
    assert.equal(result.error.retryable, false);
    assert.ok(!JSON.stringify(result).includes(privateMarker));
    if (nativeCode === 'ENOENT') assert.equal(result.error.code, 'NOT_FOUND');
    if (['__proto__', 'constructor', 'toString'].includes(nativeCode)) assert.equal(result.error.code, 'INTERNAL_ERROR');
  }
  const result = errorResult(new AppError('VERSION_CONFLICT', 'File version changed.', { expected_sha256: null, actual_sha256: 'a'.repeat(64) }));
  assert.equal(result.error.code, 'VERSION_CONFLICT');
  assert.equal(result.error.message, 'File version changed.');
  assert.deepEqual(result.error.details, { expected_sha256: null, actual_sha256: 'a'.repeat(64) });
  assert.equal(result.error.recovery.action, 'reread_and_replan');
});

test('path resolution preserves native ENOENT while distinguishing a checked missing parent and target', async t => {
  const f = await fixture(t);
  const parentError = await f.app.ctx.paths.resolve('default', 'missing-parent/new.txt', { write: true, allowMissing: true }).then(() => assert.fail('Expected missing parent'), error => error);
  assert.equal(parentError.code, 'ENOENT', 'Internal filesystem callers retain the native error contract.');
  const parent = errorResult(parentError).error;
  assert.equal(parent.code, 'NOT_FOUND');
  assert.equal(parent.reason, 'parent_not_found');
  assert.equal(parent.recovery.action, 'inspect_parent_directory');
  assert.ok(parent.recovery.tools.includes('fs_mkdir'));
  assert.ok(!JSON.stringify(parent).includes(f.base));
  assert.equal(parentError.code, 'ENOENT', 'Formatting a public result must not mutate the exception.');
  const targetError = await f.app.ctx.paths.resolve('default', 'missing.txt').then(() => assert.fail('Expected missing target'), error => error);
  assert.equal(targetError.code, 'ENOENT');
  assert.equal(errorResult(targetError).error.reason, 'target_not_found');
  assert.equal(await f.app.ctx.paths.resolve('default', 'allowed-new.txt', { write: true, allowMissing: true }), path.join(f.root, 'allowed-new.txt'));
  const protectedError = await f.app.ctx.paths.resolve('default', '.git/missing.txt').then(() => assert.fail('Expected protection'), error => error);
  assert.equal(errorResult(protectedError).error.code, 'PATH_DENIED');
  assert.equal(errorResult(protectedError).error.reason, undefined);
  await assert.rejects(fs.lstat(path.join(f.root, 'missing-parent')), { code: 'ENOENT' });
});

test('MCP missing-parent recovery can be followed by an authorized mkdir and retry without expanding paths', async t => {
  const f = await fixture(t);
  const tools = (await f.client.listTools()).tools;
  const errorSchema = (tools.find(tool => tool.name === 'fs_write')!.outputSchema as any).properties.error.properties;
  assert.ok(errorSchema.recovery && errorSchema.retryable && errorSchema.reason, 'Advertised error schema must include additive recovery fields.');
  for (const tool of tools) {
    assert.deepEqual((tool.outputSchema as any).properties.error.properties, errorSchema,
      tool.name + ' must advertise the same error contract, including component-only tools.');
  }
  const input = { ...f.owner, path: 'nested/new.txt', content: 'recovered write\n', expected_sha256: null, idempotency_key: 'missing-parent-write' };
  const parent = rejected(await f.call('fs_write', input), 'NOT_FOUND');
  assert.equal(parent.reason, 'parent_not_found');
  assert.equal(parent.recovery.action, 'inspect_parent_directory');
  await assert.rejects(fs.lstat(path.join(f.root, 'nested')), { code: 'ENOENT' });
  const readParent = rejected(await f.call('fs_read', { workspace_id: 'default', path: 'nested/new.txt' }), 'NOT_FOUND');
  assert.equal(readParent.reason, 'parent_not_found');
  assert.equal(readParent.recovery.action, 'verify_parent_path');
  assert.ok(!readParent.recovery.tools.includes('fs_mkdir'), 'A read failure should not instruct directory creation.');
  const target = rejected(await f.call('fs_read', { workspace_id: 'default', path: 'absent.txt' }), 'NOT_FOUND');
  assert.equal(target.reason, 'target_not_found');
  const made = await f.call('fs_mkdir', { ...f.owner, path: 'nested', idempotency_key: 'create-authorized-parent' });
  assert.equal(made.isError, undefined);
  const written = await f.call('fs_write', input);
  assert.equal(written.isError, undefined);
  assert.equal(await fs.readFile(path.join(f.root, 'nested/new.txt'), 'utf8'), 'recovered write\n');
  const conflict = rejected(await f.call('fs_write', { ...input, content: 'stale overwrite', idempotency_key: 'stale-create-only-write' }), 'VERSION_CONFLICT');
  assert.equal(conflict.recovery.action, 'reread_and_replan');
  assert.equal(await fs.readFile(path.join(f.root, 'nested/new.txt'), 'utf8'), 'recovered write\n');
});

test('MCP policy errors give scoped recovery without permissions or wrong-target retries', async t => {
  const f = await fixture(t);
  const write = { ...f.owner, path: 'new.txt', content: 'not written', expected_sha256: null, idempotency_key: 'policy-write' };
  const cases = [
    ['fs_write', { ...write, expected_device_id: randomUUID() }, 'DEVICE_MISMATCH', 'verify_device'],
    ['fs_read', { workspace_id: 'unknown', path: 'existing.txt' }, 'WORKSPACE_NOT_FOUND', 'select_authorized_workspace'],
    ['fs_read', { workspace_id: 'disabled', path: 'existing.txt' }, 'WORKSPACE_DISABLED', 'inspect_workspace_policy'],
    ['fs_write', { ...write, workspace_id: 'read-only' }, 'READ_ONLY', 'inspect_workspace_write_policy'],
    ['exec_start', { ...f.owner, executable: 'node', args: ['-e', 'process.exit(0)'], idempotency_key: 'execution-disabled' }, 'EXECUTION_DISABLED', 'inspect_execution_policy'],
  ] as const;
  for (const [tool, input, code, action] of cases) {
    const error = rejected(await f.call(tool, input), code);
    assert.equal(error.recovery.action, action);
    assert.equal(error.reason, undefined);
    assert.ok(!JSON.stringify(error).includes(f.base));
  }
  const actualOfflineRoot = await fs.realpath(f.offline);
  assert.equal(path.dirname(actualOfflineRoot), f.base);
  await fs.rmdir(actualOfflineRoot);
  const unavailable = rejected(await f.call('fs_read', { workspace_id: 'offline', path: 'missing-parent/new.txt' }), 'WORKSPACE_UNAVAILABLE');
  assert.equal(unavailable.recovery.action, 'inspect_workspace_health');
  assert.equal(unavailable.reason, undefined, 'An offline root is not a missing project parent directory.');
  const listedJobs = await f.call('exec_list', { workspace_id: 'default' });
  assert.equal((listedJobs.structuredContent as { ok: boolean } | undefined)?.ok, true);
  await assert.rejects(fs.lstat(path.join(f.root, 'new.txt')), { code: 'ENOENT' });
});
