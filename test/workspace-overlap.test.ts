import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { defaultUnifiedConfig, validateConfig } from '../src/config.js';
import { rebindWorkspace } from '../src/config-admin.js';
import type { WorkspaceConfig } from '../src/types.js';

async function fixture(t: TestContext) {
  const temporaryRoot = await realpath(tmpdir());
  const temp = await realpath(await mkdtemp(path.join(temporaryRoot, 'webcodex-overlap-')));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)), temporaryRoot);
    assert.match(path.basename(temp), /^webcodex-overlap-/);
    await rm(temp, { recursive: true, force: true });
  });
  const parent = path.join(temp, '项目 with spaces');
  const child = path.join(parent, '论文');
  const sibling = path.join(temp, '项目 with spaces-extra');
  await mkdir(child, { recursive: true });
  await mkdir(sibling);
  const configPath = path.join(temp, 'config.json');
  const raw = defaultUnifiedConfig(parent, configPath);
  const workspace = (id: string, root: string, readOnly: boolean): WorkspaceConfig & { uid: string } => ({ id, uid: randomUUID(), name: id, root, readOnly });
  return { raw, configPath, parent, child, sibling, workspace };
}

for (const parentReadOnly of [false, true]) {
  for (const childFirst of [false, true]) {
    test(`nested workspace access policies reject parent readOnly=${parentReadOnly}, childFirst=${childFirst}`, async t => {
      const f = await fixture(t);
      const entries = [f.workspace('parent', f.parent, parentReadOnly), f.workspace('child', f.child, !parentReadOnly)];
      const raw = { ...f.raw, workspaces: childFirst ? entries.reverse() : entries };
      await assert.rejects(validateConfig(raw, f.configPath), { code: 'CONFIG_ERROR', message: /Nested workspace roots must use the same readOnly setting/ });
    });
  }
}

for (const readOnly of [false, true]) {
  test(`nested workspace roots remain valid with shared readOnly=${readOnly}`, async t => {
    const f = await fixture(t);
    const raw = { ...f.raw, workspaces: [f.workspace('parent', f.parent, readOnly), f.workspace('child', f.child, readOnly)] };
    const validated = await validateConfig(raw, f.configPath);
    assert.equal(validated.workspaces.length, 2);
    assert.deepEqual(validated.workspaces.map(workspace => workspace.readOnly), [readOnly, readOnly]);
  });
}

test('similar workspace path prefixes are distinct; Windows path case cannot bypass overlap checks', async t => {
  const f = await fixture(t);
  const parentSpelling = process.platform === 'win32' ? f.parent.toUpperCase() : f.parent;
  const parent = f.workspace('parent', parentSpelling, false);
  const separate = await validateConfig({ ...f.raw, workspaces: [parent, f.workspace('sibling', f.sibling, true)] }, f.configPath);
  assert.equal(separate.workspaces.length, 2);
  await assert.rejects(validateConfig({ ...f.raw, workspaces: [parent, f.workspace('child', f.child, true)] }, f.configPath), { code: 'CONFIG_ERROR', message: /Nested workspace roots must use the same readOnly setting/ });
});

test('rebind validates the requested readOnly setting with the new root and leaves rejected edits untouched', async t => {
  const f = await fixture(t);
  const parent = f.workspace('parent', f.parent, true);
  const selected = f.workspace('selected', f.sibling, false);
  const original = JSON.stringify({ ...f.raw, workspaces: [parent, selected] }, null, 2) + '\n';
  await writeFile(f.configPath, original);
  await assert.rejects(rebindWorkspace(f.configPath, { id: selected.id, root: f.child }), { code: 'CONFIG_ERROR', message: /Nested workspace roots must use the same readOnly setting/ });
  assert.equal(await readFile(f.configPath, 'utf8'), original);
  await rebindWorkspace(f.configPath, { id: selected.id, root: f.child, readOnly: true });
  const after = await validateConfig(JSON.parse(await readFile(f.configPath, 'utf8')), f.configPath);
  assert.deepEqual(after.workspaces[0], parent);
  assert.equal(after.workspaces[1].id, selected.id);
  assert.notEqual(after.workspaces[1].uid, selected.uid);
  assert.equal(after.workspaces[1].root, f.child);
  assert.equal(after.workspaces[1].readOnly, true);
});
