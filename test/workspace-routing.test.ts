import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { serializeConfig, parseConfigText } from '../src/config-format.js';
import { migrateConfiguration } from '../src/config-migration.js';
import { addWorkspace, rebindWorkspace, removeWorkspace, renameDevice } from '../src/config-admin.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(path.join(parent, 'webcodex-workspace-routing-'));
  const roots = ['代码 project', '论文', '只读资料'].map(name => path.join(base, name));
  await Promise.all(roots.map(root => mkdir(root)));
  const configPath = path.join(base, 'config.json');
  const raw = { ...defaultUnifiedConfig(roots[0], configPath), workspaces: [roots[0], { root: './论文' }, { root: roots[2], readOnly: true }] };
  await writeFile(configPath, serializeConfig(raw, 'json'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(base)), parent);
    assert.ok(path.basename(base).startsWith('webcodex-workspace-routing-'));
    await rm(base, { recursive: true, force: true });
  });
  return { base, roots, configPath, raw };
}

async function connect(config: string) {
  const client = new Client({ name: 'workspace-routing-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--config', config], stderr: 'pipe' });
  await client.connect(transport);
  return client;
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })).structuredContent as any;

test('stdio routes shorthand workspaces independently and keeps receipts after reorder, restart and JSON/TOML migration', async t => {
  const f = await fixture(t);
  const config = await loadConfig(f.configPath);
  const [a, b, readOnly] = config.workspaces;
  const input = { path: 'result.txt', content: 'same payload', expected_sha256: null, idempotency_key: 'shared-key', expected_device_id: f.raw.device.id };
  let client = await connect(f.configPath);
  let aReceipt: any, bReceipt: any;
  try {
    const list = await call(client, 'workspace_list');
    assert.deepEqual(list.data.workspaces.map((w: any) => w.workspace_id), config.workspaces.map(w => w.id));
    aReceipt = await call(client, 'fs_write', { ...input, workspace_id: a.id });
    bReceipt = await call(client, 'fs_write', { ...input, workspace_id: b.id });
    assert.equal(aReceipt.ok, true); assert.equal(bReceipt.ok, true);
    assert.notEqual(aReceipt.data.change_id, bReceipt.data.change_id);
    assert.equal(await readFile(path.join(a.root, input.path), 'utf8'), input.content);
    assert.equal(await readFile(path.join(b.root, input.path), 'utf8'), input.content);
    assert.equal((await call(client, 'fs_write', { ...input, workspace_id: readOnly.id })).error.code, 'READ_ONLY');
    assert.equal((await call(client, 'fs_read', { workspace_id: a.id, path: '../论文/result.txt' })).error.code, 'PATH_DENIED');
    assert.equal((await call(client, 'changes_preview', { workspace_id: b.id, change_id: aReceipt.data.change_id })).error.code, 'CHANGE_NOT_FOUND');
    const opened = await call(client, 'workspace_open', { workspace_id: b.id });
    assert.equal(opened.data.root, b.root); assert.equal(opened.data.workspace_uid, b.uid);
  } finally { await client.close(); }
  f.raw.workspaces.reverse();
  await writeFile(f.configPath, serializeConfig(f.raw, 'json'));
  const migrated = path.join(f.base, 'config.toml');
  await migrateConfiguration({ source: f.configPath, output: migrated, apply: true });
  const after = await loadConfig(migrated);
  assert.deepEqual(after.workspaces, [...config.workspaces].reverse());
  client = await connect(migrated);
  try {
    const retry = await call(client, 'fs_write', { ...input, workspace_id: a.id });
    assert.equal(retry.data.change_id, aReceipt.data.change_id);
    const listA = await call(client, 'changes_list', { workspace_id: a.id });
    const listB = await call(client, 'changes_list', { workspace_id: b.id });
    assert.equal(listA.data.changes.length, 1); assert.equal(listB.data.changes.length, 1);
    assert.equal(listA.data.changes[0].id, aReceipt.data.change_id);
    assert.equal(listB.data.changes[0].id, bReceipt.data.change_id);
  } finally { await client.close(); }
});

test('workspace paths can span the temporary and repository volumes without resolving against cwd', async t => {
  const f = await fixture(t);
  const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const secondBase = await mkdtemp(path.join(repository, 'webcodex-cross-volume-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(secondBase)), repository);
    assert.ok(path.basename(secondBase).startsWith('webcodex-cross-volume-'));
    await rm(secondBase, { recursive: true, force: true });
  });
  await writeFile(f.configPath, serializeConfig({ ...f.raw, workspaces: [f.roots[0], secondBase] }, 'json'));
  const config = await loadConfig(f.configPath);
  assert.deepEqual(config.workspaces.map(w => w.root), [f.roots[0], await realpath(secondBase)]);
  assert.notEqual(config.workspaces[0].uid, config.workspaces[1].uid);
  // This checkout and TEMP are on different Windows drives locally; on CI the same test is valid on one volume.
  t.diagnostic('Distinct filesystem roots: ' + (path.parse(f.roots[0]).root !== path.parse(secondBase).root));
});

test('multiline TOML workspace arrays preserve comments through local edits and generated-ID rebind/remove', async t => {
  const f = await fixture(t);
  const configPath = path.join(f.base, 'array.toml');
  const { workspaces: _workspaces, ...rest } = f.raw;
  const prefix = '# projects\nworkspaces = [ # roots note\n  "./代码 project", # source\n  { root = "./论文", name = "Paper #1" }, # research\n] # end roots\n';
  const source = prefix + serializeConfig(rest, 'toml');
  await writeFile(configPath, source);
  const current = await loadConfig(configPath);
  await renameDevice(configPath, 'Multi workspace device');
  assert.ok((await readFile(configPath, 'utf8')).startsWith(prefix));
  await addWorkspace(configPath, { id: 'third', root: f.roots[2] });
  await removeWorkspace(configPath, current.workspaces[1].id);
  await rebindWorkspace(configPath, { id: current.workspaces[0].id, root: f.roots[1], name: 'moved' });
  const edited = await readFile(configPath, 'utf8');
  for (const comment of ['# projects', '# roots note', '# source', '# research', '# end roots']) assert.ok(edited.includes(comment), comment);
  const next = await loadConfig(configPath);
  assert.equal(next.workspaces[0].id, current.workspaces[0].id);
  assert.notEqual(next.workspaces[0].uid, current.workspaces[0].uid);
  assert.equal(next.workspaces[0].root, f.roots[1]);
  assert.equal(next.workspaces[1].id, 'third');
  assert.equal((parseConfigText(edited, 'toml') as any).workspaces[0].name, 'moved');
});
