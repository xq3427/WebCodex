import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultUnifiedConfig, loadConfig } from '../src/config.js';
import { checkLocalAccess } from '../src/local-access.js';
import { setFullLocalAccess } from '../src/config-admin.js';

test('full local access edit and probe distinguish local policy from operating-system write access', async t => {
  const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'webcodex-access-'));
  t.after(async () => { assert.ok(path.basename(base).startsWith('webcodex-access-')); await rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'workspace'), configPath = path.join(base, 'config.json'); await mkdir(root);
  const raw = defaultUnifiedConfig(root, configPath); raw.workspaces[0].readOnly = true; await writeFile(configPath, JSON.stringify(raw));
  const restricted = await checkLocalAccess(await loadConfig(configPath));
  assert.equal(restricted.ok, true); assert.equal(restricted.full_access_ready, false); assert.equal(restricted.execution.status, 'disabled'); assert.equal(restricted.workspaces[0].status, 'read-only');
  await setFullLocalAccess(configPath);
  const config = await loadConfig(configPath), checked = await checkLocalAccess(config);
  assert.equal(config.execution.mode, 'trusted-host'); assert.equal(config.execution.commandPolicy, 'all'); assert.equal(config.workspaces[0].readOnly, false);
  assert.equal(checked.ok, true); assert.equal(checked.full_access_ready, true); assert.equal(checked.execution.all_native_programs, true); assert.equal(checked.execution.process_probe, 'passed'); assert.equal(checked.privilege_scope, 'current_os_account'); assert.equal(checked.elevation, 'not_requested');
  assert.equal(checked.workspaces[0].status, 'passed'); assert.equal(checked.workspaces[0].write_probe, 'created-read-verified-deleted');
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('webcodex-access-check-')), []);
  assert.equal((await readFile(configPath, 'utf8')).includes('trusted-host'), true);
});
